import { Hono } from 'hono';
import { z } from 'zod';
import { CheckRequestSchema, ClarifyRequestSchema, CheckResultSchema, type CheckInput, type Capabilities } from '../shared/contracts';
import type { Env } from './types';
import { ServiceError } from './types';
import { authenticate, isLocalDevelopment, verifyOrigin, assertPilotOpen, readJsonLimited, signContinuation, verifyContinuation } from './security';
import { BudgetLedger } from './ledger';
import { normalizeImage } from './images';
import { collectEvidence } from './evidence';
import { createModelGateway, IMAGE_TOKEN_PREFLIGHT_ENABLED } from './openai';
import { runAnalysis, reviewClarification, type AnalysisDependencies } from './analysis';
import { diagnosticFor, diagnosticCode, sanitizeDiagnostic, type CheckDiagnostic, type DiagnosticStage } from './diagnostics';

const app = new Hono<{ Bindings: Env; Variables: { userHash: string } }>();
function aiReady(env: Env): boolean { return env.LIVE_AI_ENABLED === 'true' && !!env.OPENAI_API_KEY && (env.CONTINUATION_SECRET?.length ?? 0) >= 32; }

app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  c.set('userHash', await authenticate(c.req.raw, c.env));
  if (c.req.method !== 'GET') { verifyOrigin(c.req.raw, c.env); assertPilotOpen(c.req.raw, c.env); }
  await next();
});

app.get('/api/capabilities', c => {
  const ai = aiReady(c.env);
  const response: Capabilities = {
    mode: isLocalDevelopment(c.req.raw, c.env) ? 'local' : 'pilot', ai,
    screenshots: ai && !!c.env.IMAGES && IMAGE_TOKEN_PREFLIGHT_ENABLED,
    linkReputation: c.env.WEB_RISK_ENABLED === 'true' && !!c.env.GOOGLE_WEB_RISK_API_KEY,
    phoneReputation: false,
    message: ai ? 'AI checking is connected. Results may still be incomplete.' : 'AI is not connected. You can explore the app and run local link checks.',
  };
  return c.json(response);
});

function dependencies(c: { env: Env }, ledger: BudgetLedger, id: string, userHash: string, signal: AbortSignal, modelsEnabled: boolean, reportFailure: (value: CheckDiagnostic) => void): AnalysisDependencies {
  return {
    models: modelsEnabled ? createModelGateway(c.env.OPENAI_API_KEY!) : null,
    beforeCall: () => ledger.beforeCall(id, userHash),
    afterCall: usage => ledger.recordUsage(id, userHash, usage),
    signal,
    reportFailure,
    collectEvidence: (input, extraction) => collectEvidence(input, extraction, {
      webRiskKey: c.env.GOOGLE_WEB_RISK_API_KEY,
      webRiskEnabled: c.env.WEB_RISK_ENABLED === 'true',
      reserveLookup: () => ledger.reserveLookup(), signal,
    }),
  };
}

function requestDiagnostics(requestId: string) {
  let first: CheckDiagnostic | undefined;
  let closed = false;
  const report = (value: CheckDiagnostic) => {
    if (closed || first) return;
    first = sanitizeDiagnostic({ ...value, requestId });
    try { console.warn({ event: 'analysis_incomplete', ...first }); } catch { /* Diagnostics never alter an assessment. */ }
  };
  return {
    report,
    capture: (stage: DiagnosticStage, error: unknown) => report(diagnosticFor(requestId, stage, error)),
    async persist(ledger: BudgetLedger, userHash: string, admitted: boolean) {
      closed = true; // A late provider completion cannot replace the request's first failure.
      if (!first || !admitted) return;
      try { await ledger.recordDiagnostic(requestId, userHash, diagnosticCode(first)); }
      catch {
        try { console.warn({ event: 'diagnostic_unavailable', ...diagnosticFor(requestId, 'settlement', new Error('diagnostic_write_failed')) }); } catch { /* Best effort, no content. */ }
      }
    },
  };
}

// A deadline prevents work from continuing into further calls after a timeout.
async function withDeadline<T>(parent: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(45_000)]);
  const abortError = () => parent.aborted
    ? new ServiceError('request_cancelled', 'This check was interrupted. No complete result is available.', 499)
    : new ServiceError('timeout', 'This check took too long. No complete result is available.', 504);
  if (signal.aborted) throw abortError();
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(abortError());
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try { return await Promise.race([task(signal), aborted]); }
  finally { if (rejectAbort) signal.removeEventListener('abort', rejectAbort); }
}

app.post('/api/check', async c => {
  const parsed = CheckRequestSchema.safeParse(await readJsonLimited(c.req.raw));
  if (!parsed.success) { const issue = parsed.error.issues[0]; throw new ServiceError('invalid_input', issue.message, 422, String(issue.path.at(-1) ?? 'content')); }
  const { requestId, input } = parsed.data;
  const userHash = c.get('userHash');
  const live = aiReady(c.env);
  if (input.image && (!live || !c.env.IMAGES)) throw new ServiceError('images_unavailable', 'Screenshot analysis is not connected yet. Paste the message to run available checks.', 503, 'image');
  const ledger = new BudgetLedger(c.env.DB, c.env.BUDGET_LIMIT_MICRO_USD);
  const diagnostics = requestDiagnostics(requestId);
  let reserved = false;
  let waiting = false;
  let failed = false;
  let stage: DiagnosticStage = 'admission';
  try {
    // Local-only checks cost nothing. Live external lookups are still globally metered.
    if (live) { await ledger.reserve(requestId, userHash); reserved = true; }
    const output = await withDeadline(c.req.raw.signal, async signal => {
      stage = 'image';
      if (input.image) await ledger.reserveImage();
      const normalized = await normalizeImage(input, c.env, signal);
      signal.throwIfAborted();
      stage = 'extraction';
      return runAnalysis(requestId, normalized, dependencies(c, ledger, requestId, userHash, signal, live, diagnostics.report));
    });
    if (output.result.status === 'needs_context' && output.result.question && output.extraction && reserved) {
      stage = 'continuation';
      const continuation = await signContinuation(requestId, userHash, input, output.extraction, output.result.evidence, output.result.question.id, c.env);
      if (continuation.length > 24000) throw new ServiceError('continuation_size', 'This check needs more context. Try a shorter excerpt.', 422);
      await ledger.waitForAnswer(requestId, userHash);
      output.result.continuation = continuation;
      waiting = true;
    }
    return c.json(CheckResultSchema.parse(output.result));
  } catch (error) {
    failed = true;
    diagnostics.capture(error instanceof ServiceError && ['timeout', 'request_cancelled'].includes(error.code) ? 'deadline' : stage, error);
    throw error;
  } finally {
    try {
      if (reserved && !waiting) {
        try { await ledger.finish(requestId, userHash, failed); }
        catch { diagnostics.capture('settlement', new Error('usage_accounting')); await ledger.halt(); }
      }
    } finally { await diagnostics.persist(ledger, userHash, reserved); }
  }
});

app.post('/api/clarify', async c => {
  const parsed = ClarifyRequestSchema.safeParse(await readJsonLimited(c.req.raw));
  if (!parsed.success) throw new ServiceError('invalid_input', 'This answer could not be read. Start a new check.', 422);
  if (!aiReady(c.env)) throw new ServiceError('ai_unavailable', 'AI checking is not connected.', 503);
  const { requestId, input, continuation, answer } = parsed.data;
  const userHash = c.get('userHash');
  const state = await verifyContinuation(continuation, requestId, userHash, input, c.env);
  const ledger = new BudgetLedger(c.env.DB, c.env.BUDGET_LIMIT_MICRO_USD);
  const diagnostics = requestDiagnostics(requestId);
  let resumed = false;
  let failed = false;
  let stage: DiagnosticStage = 'admission';
  try {
    await ledger.resume(requestId, userHash);
    resumed = true;
    const output = await withDeadline(c.req.raw.signal, async signal => {
      stage = 'image';
      if (input.image) await ledger.reserveImage();
      const normalized = await normalizeImage(input, c.env, signal);
      signal.throwIfAborted();
      const deps = dependencies(c, ledger, requestId, userHash, signal, true, diagnostics.report);
      stage = 'evidence';
      const evidence = await deps.collectEvidence(normalized, state.extraction);
      signal.throwIfAborted();
      stage = 'review';
      return reviewClarification(requestId, normalized, state.extraction, evidence, state.questionId, answer, deps);
    });
    return c.json(CheckResultSchema.parse(output.result));
  } catch (error) {
    failed = true;
    diagnostics.capture(error instanceof ServiceError && ['timeout', 'request_cancelled'].includes(error.code) ? 'deadline' : stage, error);
    throw error;
  } finally {
    try {
      if (resumed) {
        try { await ledger.finish(requestId, userHash, failed); }
        catch { diagnostics.capture('settlement', new Error('usage_accounting')); await ledger.halt(); }
      }
    } finally { await diagnostics.persist(ledger, userHash, resumed); }
  }
});

app.post('/api/cancel', async c => {
  const parsed = z.object({ requestId: z.uuid() }).strict().safeParse(await readJsonLimited(c.req.raw, 1024));
  if (!parsed.success) throw new ServiceError('invalid_input', 'This check could not be cancelled.', 422);
  await new BudgetLedger(c.env.DB, c.env.BUDGET_LIMIT_MICRO_USD).cancelWaiting(parsed.data.requestId, c.get('userHash'));
  return c.json({ cancelled: true });
});

app.all('/api/*', c => c.json({ error: { code: 'not_found', message: 'This action is not available.' } }, 404));
app.get('*', async c => c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Run the app with npm run dev.', 404));
app.onError((error, c) => {
  const safe = error instanceof ServiceError ? error : new ServiceError('unavailable', 'Checking is temporarily unavailable. Please try again later.', 503);
  // Do not log the error object: provider and validation errors may contain user input.
  return new Response(JSON.stringify({ error: { code: safe.code, message: safe.message, ...(safe.field ? { field: safe.field } : {}) } }), { status: safe.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
});

export { app };
export default app;
