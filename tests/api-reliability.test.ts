import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckResultSchema, QUESTIONS, type CheckInput, type Extraction, type Review } from '../shared/contracts';
import { BudgetLedger } from '../server/ledger';
import { ModelGatewayError } from '../server/openai';
import { renderDecision } from '../server/review-policy';
import type { Env, ModelOutput, ModelUsage } from '../server/types';
import { testDatabase } from './d1';

const model = vi.hoisted(() => ({ extract: vi.fn(), review: vi.fn() }));
vi.mock('../server/openai', async original => ({
  ...await original<typeof import('../server/openai')>(), createModelGateway: () => model,
}));
import { app } from '../server/index';

// Real SQLite transactions and the real Hono handlers; only model generation is faked.
// These token counts use the configured uncached input/output prices, not live usage.
const extractUsage: ModelUsage = { model: 'gpt-5.4-mini-2026-03-17', inputTokens: 1000, outputTokens: 100, costMicroUsd: 1200 };
const reviewUsage: ModelUsage = { model: 'gpt-5.4-2026-03-05', inputTokens: 1000, outputTokens: 100, costMicroUsd: 4000 };
const normalCost = 5200;
const clarifiedCost = 9200;
const reservation = 250000;
let t: ReturnType<typeof testDatabase>;
let env: Env;
let network: ReturnType<typeof vi.fn>;
let warnings: ReturnType<typeof vi.spyOn>;

function input(): CheckInput {
  return { mode: 'message', content: 'Someone asked me to confirm a request.', context: '', senderEmail: '', senderPhone: '', externalLookup: false };
}
function payload() { return { requestId: crypto.randomUUID(), input: input() }; }
function extraction(ask = false): Extraction {
  return { transcript: '', claimedOrganisation: null, urls: [], phoneNumbers: [], requestedActions: [], unreadableDetails: [], missingContext: ask ? [QUESTIONS.initiated_request.text] : [] };
}
function review(value = input(), ask = false): Review {
  return renderDecision({ finding: ask ? 'unclear_request' : 'identity_unknown', evidenceIds: [], quotes: [], questionId: ask ? 'initiated_request' : null }, value, []);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function request(path: string, body: unknown, signal?: AbortSignal) {
  return app.fetch(new Request(`http://127.0.0.1:8787${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' }, body: JSON.stringify(body), signal,
  }), env);
}
async function initialQuestion(body: ReturnType<typeof payload>) {
  model.extract.mockResolvedValueOnce({ value: extraction(true), usage: extractUsage });
  model.review.mockResolvedValueOnce({ value: review(body.input, true), usage: reviewUsage });
  const response = await request('/api/check', body);
  expect(response.status).toBe(200);
  const result = CheckResultSchema.parse(await response.json());
  expect(result.status).toBe('needs_context');
  expect(result.continuation).toBeTruthy();
  return { ...body, continuation: result.continuation!, answer: 'no' as const };
}
function holdExtraction() {
  const entered = deferred<void>();
  const result = deferred<ModelOutput<Extraction>>();
  model.extract.mockImplementationOnce(() => { entered.resolve(); return result.promise; });
  return { entered, result };
}
function holdReview() {
  const entered = deferred<void>();
  const result = deferred<ModelOutput<Review>>();
  model.review.mockImplementationOnce(() => { entered.resolve(); return result.promise; });
  return { entered, result };
}
function deadline() {
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  return { timeout, expire: () => controller.abort(new DOMException('Synthetic deadline', 'TimeoutError')) };
}
function usageCompletion() {
  const finished = deferred<void>();
  const original = BudgetLedger.prototype.recordUsage;
  vi.spyOn(BudgetLedger.prototype, 'recordUsage').mockImplementation(async function (this: BudgetLedger, ...args) {
    try { return await original.apply(this, args); } finally { finished.resolve(); }
  });
  return finished;
}
function containsSql(statements: D1PreparedStatement[], text: string) {
  return statements.some(statement => (statement as unknown as { sql: string }).sql.includes(text));
}

beforeEach(() => {
  vi.resetAllMocks();
  t = testDatabase();
  env = {
    DB: t.db, ENVIRONMENT: 'development', LIVE_AI_ENABLED: 'true',
    OPENAI_API_KEY: 'synthetic-key-never-sent', CONTINUATION_SECRET: 'synthetic-signing-secret-over-thirty-two-characters',
  };
  model.extract.mockResolvedValue({ value: extraction(), usage: extractUsage });
  model.review.mockImplementation(async (value: CheckInput) => ({ value: review(value), usage: reviewUsage }));
  network = vi.fn(() => { throw new Error('This offline suite must not access the network'); });
  vi.stubGlobal('fetch', network);
  warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  t.sqlite.close();
});

describe('API reliability with real transactional bookkeeping and offline providers', () => {
  it('admits only one concurrent submission of the same request ID', async () => {
    const body = payload(); const pending = holdExtraction();
    const first = request('/api/check', body); await pending.entered.promise;
    expect((await request('/api/check', body)).status).toBe(409);
    expect(model.extract).toHaveBeenCalledTimes(1);
    expect(t.budget()).toMatchObject({ spent_micro: 0, reserved_micro: reservation });
    pending.result.resolve({ value: extraction(), usage: extractUsage });
    expect((await first).status).toBe(200);
    expect(t.budget()).toMatchObject({ spent_micro: normalCost, reserved_micro: 0, halted: 0 });
    expect(t.row(body.requestId)).toMatchObject({ calls: 2, settled_calls: 2 });
  });

  it('rejects a completed request ID without generating or spending again', async () => {
    const body = payload(); await request('/api/check', body);
    expect((await request('/api/check', body)).status).toBe(409);
    expect(model.extract).toHaveBeenCalledTimes(1); expect(model.review).toHaveBeenCalledTimes(1);
    expect(t.budget()).toMatchObject({ spent_micro: normalCost, reserved_micro: 0 });
  });

  it('blocks a different ID for the same active user, then admits it after completion', async () => {
    const firstBody = payload(); const secondBody = payload(); const pending = holdExtraction();
    const first = request('/api/check', firstBody); await pending.entered.promise;
    expect((await request('/api/check', secondBody)).status).toBe(429);
    expect(t.row(secondBody.requestId)).toBeUndefined();
    pending.result.resolve({ value: extraction(), usage: extractUsage }); await first;
    expect((await request('/api/check', secondBody)).status).toBe(200);
    expect(model.extract).toHaveBeenCalledTimes(2);
    expect(t.budget()).toMatchObject({ spent_micro: 2 * normalCost, reserved_micro: 0, halted: 0 });
  });

  it('holds the user slot while a clarification is waiting and releases it on cancellation', async () => {
    const firstBody = payload(); const secondBody = payload(); await initialQuestion(firstBody);
    expect((await request('/api/check', secondBody)).status).toBe(429);
    expect(t.budget()).toMatchObject({ spent_micro: normalCost, reserved_micro: reservation - normalCost });
    expect((await request('/api/cancel', { requestId: firstBody.requestId })).status).toBe(200);
    expect((await request('/api/check', secondBody)).status).toBe(200);
    expect(t.budget()).toMatchObject({ spent_micro: 2 * normalCost, reserved_micro: 0, halted: 0 });
  });

  it('admits only one simultaneous clarification and never makes a fourth model call', async () => {
    const body = payload(); const answer = await initialQuestion(body); const pending = holdReview();
    const first = request('/api/clarify', answer); await pending.entered.promise;
    expect((await request('/api/clarify', answer)).status).toBe(409);
    pending.result.resolve({ value: review(), usage: reviewUsage });
    expect(CheckResultSchema.parse(await (await first).json()).status).toBe('complete');
    expect((await request('/api/clarify', answer)).status).toBe(409);
    expect(model.extract).toHaveBeenCalledTimes(1); expect(model.review).toHaveBeenCalledTimes(2);
    expect(t.row(body.requestId)).toMatchObject({ calls: 3, settled_calls: 3 });
    expect(t.budget()).toMatchObject({ spent_micro: clarifiedCost, reserved_micro: 0, halted: 0 });
  });

  it('makes repeated waiting cancellation idempotent and rejects the cancelled continuation', async () => {
    const body = payload(); const answer = await initialQuestion(body);
    await request('/api/cancel', { requestId: body.requestId });
    await request('/api/cancel', { requestId: body.requestId });
    expect((await request('/api/clarify', answer)).status).toBe(409);
    expect(model.review).toHaveBeenCalledTimes(1);
    expect(t.budget()).toMatchObject({ spent_micro: normalCost, reserved_micro: 0, halted: 0 });
  });

  it('does not release an in-flight clarification reservation when cancellation arrives late', async () => {
    const body = payload(); const answer = await initialQuestion(body); const pending = holdReview();
    const active = request('/api/clarify', answer); await pending.entered.promise;
    await request('/api/cancel', { requestId: body.requestId });
    expect(t.row(body.requestId)).toMatchObject({ state: 'active', calls: 3, settled_calls: 2, reserved_micro: reservation - normalCost });
    pending.result.resolve({ value: review(), usage: reviewUsage }); await active;
    expect(t.budget()).toMatchObject({ spent_micro: clarifiedCost, reserved_micro: 0, halted: 0 });
  });

  it('settles known extraction usage even when the provider output is incomplete', async () => {
    const body = payload(); model.extract.mockRejectedValueOnce(new ModelGatewayError('MODEL_INCOMPLETE', extractUsage));
    const response = await request('/api/check', body);
    expect(CheckResultSchema.parse(await response.json())).toMatchObject({ status: 'partial', extraction: null, question: null });
    expect(model.review).not.toHaveBeenCalled();
    expect(t.row(body.requestId)).toMatchObject({ calls: 1, settled_calls: 1, error_code: 'extraction:MODEL_INCOMPLETE' });
    expect(t.budget()).toMatchObject({ spent_micro: extractUsage.costMicroUsd, reserved_micro: 0, halted: 0 });
    expect((await request('/api/check', body)).status).toBe(409);
    expect(t.row(body.requestId).error_code).toBe('extraction:MODEL_INCOMPLETE');
    expect(model.extract).toHaveBeenCalledTimes(1);
  });

  it('settles known reviewer usage and keeps a partial result after invalid provider output', async () => {
    const body = payload(); model.review.mockRejectedValueOnce(new ModelGatewayError('MODEL_OUTPUT_INVALID', reviewUsage));
    const response = await request('/api/check', body);
    const result = CheckResultSchema.parse(await response.json());
    expect(result.status).toBe('partial'); expect(result.extraction).not.toBeNull(); expect(result.question).toBeNull();
    expect(t.row(body.requestId)).toMatchObject({ calls: 2, settled_calls: 2, error_code: 'review:MODEL_OUTPUT_INVALID' });
    expect(t.budget()).toMatchObject({ spent_micro: normalCost, reserved_micro: 0, halted: 0 });
  });

  it('charges the full reservation for an extraction timeout with unknown provider usage', async () => {
    const body = payload(); model.extract.mockRejectedValueOnce(new ModelGatewayError('MODEL_TIMEOUT'));
    const result = CheckResultSchema.parse(await (await request('/api/check', body)).json());
    expect(result.status).toBe('partial'); expect(result.reason).toContain('too long'); expect(result.recovery).toBe('retry');
    expect(model.extract).toHaveBeenCalledTimes(1); expect(model.review).not.toHaveBeenCalled();
    expect(t.row(body.requestId)).toMatchObject({ calls: 1, settled_calls: 0, error_code: 'extraction:MODEL_TIMEOUT' });
    expect(t.budget()).toMatchObject({ spent_micro: reservation, reserved_micro: 0, halted: 0 });
  });

  it('releases generation funds when the gateway proves extraction was never dispatched', async () => {
    const body = payload();
    model.extract.mockRejectedValueOnce(new ModelGatewayError('MODEL_TOKEN_COUNT_UNAVAILABLE', undefined, { model: extractUsage.model }));
    const result = CheckResultSchema.parse(await (await request('/api/check', body)).json());
    expect(result.status).toBe('partial'); expect(result.question).toBeNull();
    expect(model.review).not.toHaveBeenCalled();
    expect(t.row(body.requestId)).toMatchObject({ calls: 1, settled_calls: 1, error_code: 'extraction:MODEL_TOKEN_COUNT_UNAVAILABLE' });
    expect(t.budget()).toMatchObject({ spent_micro: 0, reserved_micro: 0, halted: 0 });
  });

  it('does not refund unknown review usage merely because extraction usage was settled', async () => {
    const body = payload(); model.review.mockRejectedValueOnce(new Error('Synthetic provider connection lost'));
    expect(CheckResultSchema.parse(await (await request('/api/check', body)).json()).status).toBe('partial');
    expect(t.row(body.requestId)).toMatchObject({ calls: 2, settled_calls: 1, error_code: 'review:stage_failed' });
    expect(t.budget()).toMatchObject({ spent_micro: reservation, reserved_micro: 0, halted: 0 });
  });

  it('finalizes at the request deadline and ignores late known extraction usage without a new call', async () => {
    const body = payload(); const pending = holdExtraction(); const timer = deadline();
    const active = request('/api/check', body); await pending.entered.promise;
    timer.expire(); expect((await active).status).toBe(504); expect(timer.timeout).toHaveBeenCalledWith(45000);
    expect(t.budget()).toMatchObject({ spent_micro: reservation, reserved_micro: 0, halted: 0 });
    const settled = usageCompletion(); pending.result.resolve({ value: extraction(), usage: extractUsage }); await settled.promise;
    expect(model.review).not.toHaveBeenCalled();
    expect(t.budget()).toMatchObject({ spent_micro: reservation, reserved_micro: 0, halted: 0 });
    expect(t.row(body.requestId)).toMatchObject({ calls: 1, settled_calls: 0, error_code: 'deadline:timeout' });
  });

  it('keeps the full charge after a review completes beyond the request deadline', async () => {
    const body = payload(); const pending = holdReview(); const timer = deadline();
    const active = request('/api/check', body); await pending.entered.promise;
    timer.expire(); expect((await active).status).toBe(504);
    const settled = usageCompletion(); pending.result.resolve({ value: review(), usage: reviewUsage }); await settled.promise;
    expect(model.review).toHaveBeenCalledTimes(1);
    expect(t.budget()).toMatchObject({ spent_micro: reservation, reserved_micro: 0, halted: 0 });
    expect(t.row(body.requestId)).toMatchObject({ calls: 2, settled_calls: 1, error_code: 'deadline:timeout' });
  });

  it('identifies an already-cancelled client request without generation or spending', async () => {
    const body = payload(); const client = new AbortController(); client.abort();
    const response = await request('/api/check', body, client.signal);
    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({ error: { code: 'request_cancelled' } });
    expect(model.extract).not.toHaveBeenCalled(); expect(model.review).not.toHaveBeenCalled();
    expect(t.budget()).toMatchObject({ spent_micro: 0, reserved_micro: 0, halted: 0 });
  });

  it('distinguishes client cancellation during dispatch from a deadline and retains unknown billing', async () => {
    const body = payload(); const pending = holdExtraction(); const client = new AbortController();
    const active = request('/api/check', body, client.signal); await pending.entered.promise;
    client.abort(); const response = await active;
    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({ error: { code: 'request_cancelled' } });
    const settled = usageCompletion(); pending.result.resolve({ value: extraction(), usage: extractUsage }); await settled.promise;
    expect(model.review).not.toHaveBeenCalled();
    expect(t.budget()).toMatchObject({ spent_micro: reservation, reserved_micro: 0, halted: 0 });
  });

  it('survives finalization winning a race against an already-started usage transaction', async () => {
    const body = payload(); const timer = deadline(); const entered = deferred<void>(); const release = deferred<void>();
    const originalBatch = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementation(async statements => {
      if (containsSql(statements, 'settled_calls=settled_calls+1')) { entered.resolve(); await release.promise; }
      return originalBatch(statements);
    });
    const settled = usageCompletion(); const active = request('/api/check', body); await entered.promise;
    timer.expire(); expect((await active).status).toBe(504);
    expect(t.budget()).toMatchObject({ spent_micro: reservation, reserved_micro: 0 });
    release.resolve(); await settled.promise;
    expect(model.review).not.toHaveBeenCalled();
    expect(t.budget()).toMatchObject({ spent_micro: reservation, reserved_micro: 0, halted: 0 });
  });

  it('halts further paid work after a usage transaction fails before committing', async () => {
    const body = payload(); const originalBatch = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementation(async statements => {
      if (containsSql(statements, 'settled_calls=settled_calls+1')) throw new Error('Synthetic uncommitted storage failure');
      return originalBatch(statements);
    });
    expect(CheckResultSchema.parse(await (await request('/api/check', body)).json()).status).toBe('partial');
    expect(t.budget()).toMatchObject({ spent_micro: reservation, reserved_micro: 0, halted: 1 });
    expect((await request('/api/check', payload())).status).toBe(503);
    expect(model.extract).toHaveBeenCalledTimes(1); expect(model.review).not.toHaveBeenCalled();
  });

  it('retains unfinalized funds and halts rather than permitting extra spending after finish fails', async () => {
    const body = payload(); const originalBatch = t.db.batch.bind(t.db); let fail = true;
    vi.spyOn(t.db, 'batch').mockImplementation(async statements => {
      if (fail && containsSql(statements, 'reserved_micro=0,state=?')) { fail = false; throw new Error('Synthetic finalization failure'); }
      return originalBatch(statements);
    });
    await request('/api/check', body);
    expect(t.budget()).toMatchObject({ spent_micro: normalCost, reserved_micro: reservation - normalCost, halted: 1 });
    expect((await request('/api/check', payload())).status).toBe(503);
    expect(model.extract).toHaveBeenCalledTimes(1); expect(model.review).toHaveBeenCalledTimes(1);
  });

  it('reaps an expired waiting check without charging unused calls or allowing its continuation', async () => {
    const body = payload(); const answer = await initialQuestion(body);
    const afterLease = Number(t.row(body.requestId).lease_until) + 1;
    vi.spyOn(Date, 'now').mockReturnValue(afterLease);
    expect((await request('/api/check', payload())).status).toBe(200);
    expect((await request('/api/clarify', answer)).status).toBe(409);
    expect(t.row(body.requestId)).toMatchObject({ state: 'failed', error_code: 'expired', reserved_micro: 0, spent_micro: normalCost });
    expect(t.budget()).toMatchObject({ spent_micro: 2 * normalCost, reserved_micro: 0, halted: 0 });
    expect(model.extract).toHaveBeenCalledTimes(2); expect(model.review).toHaveBeenCalledTimes(2);
  });

  it('keeps raw provider errors, personal input and credentials out of logs, errors and D1 rows', async () => {
    const marker = 'PRIVATE-SYNTHETIC-CONTENT-DO-NOT-PERSIST'; const email = 'synthetic-person@example.test';
    const body = payload(); body.input.content = `Someone asked me about ${marker}.`; body.input.senderEmail = email;
    const error = new Error(`${marker}; email=${email}; key=${env.OPENAI_API_KEY}; signing=${env.CONTINUATION_SECRET}`);
    Object.assign(error, { response: { body: body.input }, headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` } });
    model.extract.mockRejectedValueOnce(error);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const response = await request('/api/check', body); const publicResult = await response.text();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(CheckResultSchema.parse(JSON.parse(publicResult)).status).toBe('partial');
    const database = JSON.stringify({ checks: t.sqlite.prepare('SELECT * FROM checks').all(), budget: t.budget() });
    const logOutput = JSON.stringify([warnings.mock.calls, errors.mock.calls, logs.mock.calls, info.mock.calls]);
    for (const privateValue of [marker, email, env.OPENAI_API_KEY!, env.CONTINUATION_SECRET!]) {
      expect(publicResult).not.toContain(privateValue); expect(database).not.toContain(privateValue); expect(logOutput).not.toContain(privateValue);
    }
    expect(warnings).toHaveBeenCalled();
  });

  it('treats diagnostic storage failure as best effort without changing assessment or accounting', async () => {
    const body = payload(); const storageDetail = 'PRIVATE-DIAGNOSTIC-STORAGE-DETAIL';
    model.extract.mockRejectedValueOnce(new ModelGatewayError('MODEL_INCOMPLETE', extractUsage));
    const prepare = t.db.prepare.bind(t.db);
    vi.spyOn(t.db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (sql.startsWith('UPDATE checks SET error_code=?')) {
        const bind = statement.bind.bind(statement);
        vi.spyOn(statement, 'bind').mockImplementation((...values) => {
          const bound = bind(...values);
          vi.spyOn(bound, 'run').mockRejectedValue(new Error(storageDetail));
          return bound;
        });
      }
      return statement;
    });
    const response = await request('/api/check', body); const result = CheckResultSchema.parse(await response.json());
    expect(response.status).toBe(200); expect(result.status).toBe('partial');
    expect(t.row(body.requestId)).toMatchObject({ calls: 1, settled_calls: 1, error_code: null });
    expect(t.budget()).toMatchObject({ spent_micro: extractUsage.costMicroUsd, reserved_micro: 0, halted: 0 });
    expect(warnings.mock.calls).toContainEqual([{
      event: 'diagnostic_unavailable', requestId: body.requestId, stage: 'settlement', code: 'diagnostic_write_failed',
    }]);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(storageDetail);
    expect(JSON.stringify(result)).not.toContain(storageDetail);
  });

  it.each(['invalid_image', 'image_processing'] as const)('records %s before dispatch and releases the unused AI reservation', async code => {
    const body = payload();
    const info = vi.fn().mockRejectedValue(new Error('PRIVATE-SYNTHETIC-IMAGE-SERVICE-ERROR'));
    env.IMAGES = { info } as unknown as NonNullable<Env['IMAGES']>;
    body.input = {
      ...body.input, mode: 'screenshot', content: '', image: {
        base64: code === 'invalid_image' ? 'YQ==' : Buffer.from(readFileSync(new URL('./fixtures/screenshot.png', import.meta.url))).toString('base64'),
        mimeType: 'image/png',
      },
    };
    const response = await request('/api/check', body); const result = await response.json();
    expect(response.status).toBe(422); expect(result).toMatchObject({ error: { code, field: 'image' } });
    expect(t.row(body.requestId)).toMatchObject({ state: 'failed', calls: 0, settled_calls: 0, error_code: `image:${code}` });
    expect(t.budget()).toMatchObject({ spent_micro: 0, reserved_micro: 0, halted: 0, image_count: 1 });
    expect(model.extract).not.toHaveBeenCalled(); expect(model.review).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(code === 'invalid_image' ? 0 : 1);
    expect(JSON.stringify([result, warnings.mock.calls, t.row(body.requestId)])).not.toContain('PRIVATE-SYNTHETIC-IMAGE-SERVICE-ERROR');
  });

  it('enforces the daily admission count across manual fresh attempts even when every result is partial', async () => {
    model.extract.mockRejectedValue(new ModelGatewayError('MODEL_INCOMPLETE', extractUsage));
    for (let index = 0; index < 20; index++) {
      expect(CheckResultSchema.parse(await (await request('/api/check', payload())).json()).status).toBe('partial');
    }
    expect((await request('/api/check', payload())).status).toBe(429);
    expect(model.extract).toHaveBeenCalledTimes(20); expect(model.review).not.toHaveBeenCalled();
    expect(t.budget()).toMatchObject({ spent_micro: 20 * extractUsage.costMicroUsd, reserved_micro: 0, halted: 0 });
    expect(t.sqlite.prepare('SELECT COUNT(*) AS count FROM checks').get()).toMatchObject({ count: 20 });
  });
});
