import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckResultSchema } from '../shared/contracts';
import { testDatabase } from './d1';
import type { Env } from '../server/types';
import { renderDecision } from '../server/review-policy';

const model = vi.hoisted(() => ({ extract: vi.fn(), review: vi.fn() }));
vi.mock('../server/openai', async original => ({ ...await original<typeof import('../server/openai')>(), createModelGateway: () => model }));
import { app } from '../server/index';

let t: ReturnType<typeof testDatabase>;
let env: Env;
const payload = () => ({ requestId: crypto.randomUUID(), input: { mode: 'message', content: 'Someone asked me to confirm a request.', context: '', senderEmail: '', senderPhone: '', externalLookup: false } });
const extraction = { transcript: '', claimedOrganisation: null, urls: [], phoneNumbers: [], requestedActions: [], unreadableDetails: [], missingContext: ['Did you start this request yourself?'] };
const usage = { model: 'gpt-5.4-2026-03-05', inputTokens: 100, outputTokens: 50, costMicroUsd: 1000 };
function request(path: string, body?: unknown, origin = 'http://127.0.0.1:5173') {
  return app.fetch(new Request(`http://127.0.0.1:8787${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) }), env);
}
beforeEach(() => {
  t = testDatabase(); env = { DB: t.db, ENVIRONMENT: 'development', LIVE_AI_ENABLED: 'false', CONTINUATION_SECRET: 'test-only-private-signing-key-over-thirty-two' };
  vi.clearAllMocks();
  model.extract.mockResolvedValue({ value: extraction, usage });
  model.review.mockResolvedValue({ value: renderDecision({ finding: 'unclear_request', evidenceIds: [], quotes: [], questionId: 'initiated_request' }, { ...payload().input, mode: 'message' }, []), usage });
});
afterEach(() => { t.sqlite.close(); });

describe('API integration with offline model fakes', () => {
  it('advertises unavailable providers honestly and never calls a model in local-only mode', async () => {
    expect(await (await request('/api/capabilities')).json()).toMatchObject({ ai: false, screenshots: false, phoneReputation: false, linkReputation: false });
    const response = await request('/api/check', payload());
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(CheckResultSchema.parse(await response.json())).toMatchObject({ status: 'partial', aiUsed: false, question: null });
    expect(model.extract).not.toHaveBeenCalled(); expect(t.budget().reserved_micro).toBe(0);
  });
  it('rejects malformed input and cross-origin posts before model dispatch', async () => {
    env.LIVE_AI_ENABLED = 'true'; env.OPENAI_API_KEY = 'test-only';
    expect((await request('/api/check', { ...payload(), injection: 'unexpected' })).status).toBe(422);
    expect((await request('/api/check', payload(), 'https://unrelated.example')).status).toBe(403);
    expect(model.extract).not.toHaveBeenCalled();
  });
  it('fails closed for production without Access configuration even with a live key', async () => {
    env.ENVIRONMENT = 'production'; env.LIVE_AI_ENABLED = 'true'; env.OPENAI_API_KEY = 'test-only';
    expect((await request('/api/check', payload())).status).toBe(503); expect(model.extract).not.toHaveBeenCalled();
  });
  it('requires decoding support for screenshots before reserving or dispatching', async () => {
    env.LIVE_AI_ENABLED = 'true'; env.OPENAI_API_KEY = 'test-only'; const body = payload();
    const response = await request('/api/check', { ...body, input: { ...body.input, mode: 'screenshot', content: '', image: { base64: 'YQ==', mimeType: 'image/png' } } });
    expect(response.status).toBe(503); expect(model.extract).not.toHaveBeenCalled(); expect(t.budget().reserved_micro).toBe(0);
  });
  it('runs two models then one bound clarification, rejecting replay and changed inputs', async () => {
    env.LIVE_AI_ENABLED = 'true'; env.OPENAI_API_KEY = 'test-only'; const body = payload();
    const initial = CheckResultSchema.parse(await (await request('/api/check', body)).json());
    expect(initial.status).toBe('needs_context'); expect(initial.continuation).toBeTruthy(); expect(t.row(body.requestId).state).toBe('waiting');
    const next = { ...body, continuation: initial.continuation, answer: 'yes' };
    expect((await request('/api/clarify', { ...next, input: { ...body.input, content: 'Changed request' } })).status).toBe(409);
    expect(model.review).toHaveBeenCalledTimes(1);
    model.review.mockResolvedValue({ value: renderDecision({ finding: 'identity_unknown', evidenceIds: [], quotes: [], questionId: null }, { ...payload().input, mode: 'message' }, []), usage });
    const final = await request('/api/clarify', next); expect(final.status).toBe(200);
    expect(CheckResultSchema.parse(await final.json()).status).toBe('complete'); expect(model.extract).toHaveBeenCalledTimes(1); expect(model.review).toHaveBeenCalledTimes(2);
    expect(t.budget()).toMatchObject({ spent_micro: 3000, reserved_micro: 0, halted: 0 });
    expect((await request('/api/clarify', next)).status).toBe(409);
    expect((await request('/api/check', body)).status).toBe(409);
  });
  it('releases an abandoned clarification without submitting input again', async () => {
    env.LIVE_AI_ENABLED = 'true'; env.OPENAI_API_KEY = 'test-only'; const body = payload();
    const initial = CheckResultSchema.parse(await (await request('/api/check', body)).json());
    expect((await request('/api/cancel', { requestId: body.requestId })).status).toBe(200);
    expect(t.budget()).toMatchObject({ spent_micro: 2000, reserved_micro: 0 });
    expect((await request('/api/clarify', { ...body, continuation: initial.continuation, answer: 'no' })).status).toBe(409);
  });
  it('returns an honest partial result and charges unknown billed usage conservatively', async () => {
    env.LIVE_AI_ENABLED = 'true'; env.OPENAI_API_KEY = 'test-only'; model.extract.mockRejectedValue(new Error('Provider failed'));
    const response = await request('/api/check', payload());
    expect(CheckResultSchema.parse(await response.json())).toMatchObject({ status: 'partial', aiUsed: true, question: null });
    expect(model.review).not.toHaveBeenCalled(); expect(t.budget()).toMatchObject({ spent_micro: 250000, reserved_micro: 0 });
  });
  it('blocks paid work when the lifetime allowance cannot cover a reservation', async () => {
    env.LIVE_AI_ENABLED = 'true'; env.OPENAI_API_KEY = 'test-only'; t.sqlite.exec('UPDATE budget SET spent_micro=7800000');
    expect((await request('/api/check', payload())).status).toBe(503); expect(model.extract).not.toHaveBeenCalled();
  });
});
