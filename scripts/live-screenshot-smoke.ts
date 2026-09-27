import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { BudgetLedger } from '../server/ledger';
import { normalizeImage } from '../server/images';
import { runAnalysis } from '../server/analysis';
import { collectEvidence } from '../server/evidence';
import { createModelGateway, MODEL_LIMITS } from '../server/openai';
import { ServiceError, type Env, type ModelGateway, type ModelOutput } from '../server/types';
import type { CheckInput } from '../shared/contracts';

// Exact local synthetic fixtures only. Regeneration requires an intentional hash update.
const fixtures = {
  'screenshot.png': { mimeType: 'image/png', sha256: 'e37d67b8635e7c86b0506e0f21394aca195f72d9e68d61f5e49e9f0e7abde5df' },
  'screenshot.jpg': { mimeType: 'image/jpeg', sha256: '7daae927390efad8c17b8db86c6fda1313dd4883aec3adbdc726f15abf049ca2' },
  'screenshot-obscured.png': { mimeType: 'image/png', sha256: '655a33472051f04945a815b20c0f3767c3f411f47ceedf4b728d2ac1ddc83fe2' },
} as const;
type FixtureName = keyof typeof fixtures;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const errorCode = (error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  return typeof code === 'string' && /^[a-zA-Z0-9_]{1,80}$/.test(code) ? code : 'diagnostic_error';
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const short = (value: unknown, length = 120) => typeof value === 'string' ? value.slice(0, length) : null;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Retain only synthetic provider output and numeric usage, never requests or headers. */
function providerFields(raw: unknown) {
  const body = object(raw), usage = object(body.usage), error = object(body.error);
  return {
    model: short(body.model), status: short(body.status),
    usage: {
      input_tokens: number(usage.input_tokens), output_tokens: number(usage.output_tokens), total_tokens: number(usage.total_tokens),
      cached_tokens: number(object(usage.input_tokens_details).cached_tokens),
      reasoning_tokens: number(object(usage.output_tokens_details).reasoning_tokens),
    },
    output: Array.isArray(body.output) ? body.output.filter(item => object(item).type === 'message').slice(0, 4).map(item => {
      const message = object(item);
      return { type: 'message', status: short(message.status), content: Array.isArray(message.content) ? message.content.flatMap(part => {
        const content = object(part);
        return content.type === 'output_text' ? [{ type: 'output_text', text: short(content.text, 24000) }]
          : content.type === 'refusal' ? [{ type: 'refusal', text: short(content.refusal, 24000) }] : [];
      }).slice(0, 4) : [] };
    }) : [],
    error: body.error ? { type: short(error.type), code: short(error.code), param: short(error.param) } : null,
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256_000) { await reader.cancel(); throw new ServiceError('diagnostic_response_limit', ''); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function runLiveScreenshotSmoke(args: string[], appDirectory: string): Promise<void> {
  // Refuse before accessing local credentials, bindings or any provider.
  if (args.length !== 3 || args[0] !== '--run-live' || args[1] !== '--fixture' || !Object.hasOwn(fixtures, args[2])) {
    throw new ServiceError('explicit_run_required', 'Use --run-live --fixture screenshot.png (or screenshot.jpg / screenshot-obscured.png).');
  }
  const fixtureName = args[2] as FixtureName, fixture = fixtures[fixtureName];
  const appRoot = await realpath(appDirectory), fixtureRoot = await realpath(resolve(appRoot, 'tests/fixtures'));
  const fixturePath = await realpath(resolve(fixtureRoot, fixtureName));
  if (fixturePath !== resolve(fixtureRoot, fixtureName)) throw new ServiceError('fixture_path_rejected', '');
  const bytes = await readFile(fixturePath), fixtureHash = hash(bytes);
  if (fixtureHash !== fixture.sha256) throw new ServiceError('fixture_hash_mismatch', '');
  const requestId = randomUUID(), userHash = 'local-developer', startedAt = new Date().toISOString(), start = performance.now();
  const reportPath = resolve(appRoot, 'verification', `live-screenshot-smoke-${startedAt.replace(/[:.]/g, '-')}-${requestId}.json`);
  const report: Record<string, unknown> = {
    kind: 'deliberate-synthetic-live-screenshot-diagnostic', requestId, startedAt,
    fixture: { name: fixtureName, sha256: fixtureHash, bytes: bytes.length },
    input: { mode: 'screenshot', content: '', context: '', senderEmail: '', senderPhone: '', externalLookup: false, image: { mimeType: fixture.mimeType, bytes: bytes.length, sha256: fixtureHash } },
    models: Object.keys(MODEL_LIMITS), gatewayStages: [], providerResponses: [],
    notes: ['Synthetic-only report. No base64, keys, request headers or raw errors are recorded.', 'Local persistent D1 and Images. Provider requests are paid.', 'No clarification continuation is created; finish releases only unused allowance.'],
  };
  let reportCreated = false;
  const persistReport = async () => {
    await mkdir(resolve(appRoot, 'verification'), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: reportCreated ? 'w' : 'wx' });
    reportCreated = true;
  };
  const proxy = await getPlatformProxy<Env>({ configPath: resolve(appRoot, 'wrangler.jsonc'), persist: true, remoteBindings: false });
  const env = proxy.env;
  let ledger: BudgetLedger | undefined, reserved = false;
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let work: Promise<Awaited<ReturnType<typeof runAnalysis>>> | undefined;
  const snapshot = () => env.DB.prepare('SELECT spent_micro,reserved_micro,halted,image_count,lookup_count,pricing_version FROM budget WHERE id=1').first();
  try {
    const live = env.LIVE_AI_ENABLED ?? process.env.LIVE_AI_ENABLED;
    const apiKey = env.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
    const secret = env.CONTINUATION_SECRET ?? process.env.CONTINUATION_SECRET;
    if (live !== 'true' || !apiKey || (secret?.length ?? 0) < 32) throw new ServiceError('live_ai_not_configured', '');
    if (env.ENVIRONMENT !== 'development') throw new ServiceError('local_development_required', '');
    if (!env.DB || !env.IMAGES) throw new ServiceError('local_bindings_required', '');
    try {
      report.ledgerBefore = await snapshot();
      if (!report.ledgerBefore) throw new Error();
      await env.DB.prepare('SELECT id,state,calls,settled_calls,reserved_micro,spent_micro FROM checks LIMIT 1').all();
    } catch { throw new ServiceError('ledger_not_migrated', ''); }
    ledger = new BudgetLedger(env.DB, env.BUDGET_LIMIT_MICRO_USD);
    await persistReport();
    await ledger.reserve(requestId, userHash);
    reserved = true;
    await ledger.reserveImage();
    globalThis.fetch = async (...fetchArgs: Parameters<typeof fetch>) => {
      const [resource, options] = fetchArgs;
      const url = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
      const method = options?.method ?? (typeof resource === 'object' && 'method' in resource ? resource.method : 'GET');
      const response = await originalFetch(...fetchArgs);
      if (url === 'https://api.openai.com/v1/responses' && method.toUpperCase() === 'POST') {
        try {
          (report.providerResponses as unknown[]).push({ elapsedMs: Math.round(performance.now() - start), httpStatus: response.status, ...providerFields(await boundedJson(response.clone())) });
          await persistReport();
        } catch (error) { report.providerCaptureError = errorCode(error); }
      }
      return response;
    };
    const gateway = createModelGateway(apiKey);
    const record = async <T>(stage: 'extract' | 'review', call: () => Promise<ModelOutput<T>>): Promise<ModelOutput<T>> => {
      const stageStart = performance.now();
      try {
        const output = await call();
        (report.gatewayStages as unknown[]).push({ stage, durationMs: Math.round(performance.now() - stageStart), value: structuredClone(output.value), usage: structuredClone(output.usage) });
        await persistReport(); // Snapshot before runAnalysis applies grounding validation.
        return output;
      } catch (error) {
        (report.gatewayStages as unknown[]).push({ stage, durationMs: Math.round(performance.now() - stageStart), errorCode: errorCode(error) });
        await persistReport();
        throw error;
      }
    };
    const models: ModelGateway = {
      extract: (input, signal) => record('extract', () => gateway.extract(input, signal)),
      review: (input, extraction, evidence, signal, clarification) => record('review', () => gateway.review(input, extraction, evidence, signal, clarification)),
    };
    const input: CheckInput = { mode: 'screenshot', content: '', context: '', senderEmail: '', senderPhone: '', externalLookup: false, image: { base64: Buffer.from(bytes).toString('base64'), mimeType: fixture.mimeType } };
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(new ServiceError('diagnostic_aborted', ''));
      controller.signal.addEventListener('abort', abortListener, { once: true });
      if (controller.signal.aborted) abortListener();
      else timeout = setTimeout(() => controller.abort(), 45_000);
    });
    work = (async () => {
      const normalized = await normalizeImage(input, env, controller.signal);
      controller.signal.throwIfAborted();
      const prepared = Buffer.from(normalized.image!.base64, 'base64');
      report.normalizedImage = { mimeType: normalized.image!.mimeType, bytes: prepared.length, sha256: hash(prepared) };
      return runAnalysis(requestId, normalized, {
        models, beforeCall: () => ledger!.beforeCall(requestId, userHash),
        afterCall: usage => ledger!.recordUsage(requestId, userHash, usage), signal: controller.signal,
        collectEvidence: (content, extraction) => collectEvidence(content, extraction, { webRiskEnabled: false, signal: controller.signal }),
      });
    })();
    report.outcome = await Promise.race([aborted, work]);
  } catch (error) {
    report.errorCode = errorCode(error);
    process.exitCode = 1;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    // Promise.race does not cancel its losing task. Drain it before finishing the
    // reservation or disposing D1 so an in-flight usage write cannot race cleanup.
    // The 45-second limit signals cancellation; local image/ledger RPCs must still
    // settle. Preserve response capture until the gateway has fully unwound.
    if (work) {
      if (report.errorCode) controller.abort();
      try {
        const settled = await work;
        report.outcome ??= settled;
      } catch (error) { report.workErrorCode = errorCode(error); }
      report.workSettledAfterAbort = controller.signal.aborted;
    }
    globalThis.fetch = originalFetch;
    if (reserved && ledger) {
      try { await ledger.finish(requestId, userHash, !!report.errorCode); }
      catch (error) {
        report.finalizationError = errorCode(error); process.exitCode = 1;
        try { await ledger.halt(); } catch { report.haltFailed = true; }
      }
    }
    try {
      report.ledgerAfter = env.DB ? await snapshot() : null;
      report.check = reserved ? await env.DB.prepare('SELECT id,state,calls,settled_calls,reserved_micro,spent_micro,error_code FROM checks WHERE id=?').bind(requestId).first() : null;
    } catch { report.ledgerReadError = 'ledger_unavailable'; }
    report.finishedAt = new Date().toISOString();
    report.durationMs = Math.round(performance.now() - start);
    try { await persistReport(); }
    finally {
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      await proxy.dispose();
    }
  }
  console.log(JSON.stringify({ report: reportPath, requestId, errorCode: report.errorCode ?? null }));
}
