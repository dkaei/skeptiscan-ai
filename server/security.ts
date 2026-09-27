import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import type { CheckInput, Evidence, Extraction, QuestionId } from '../shared/contracts';
import { EvidenceSchema, ExtractionSchema, QuestionIdSchema } from '../shared/contracts';
import { z } from 'zod';
import type { Env } from './types';
import { ServiceError } from './types';

const MAX_ACCESS_ISSUERS = 4;
const accessJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** The issuer is constructed only after validating the configured team domain. */
function accessKeys(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = accessJwks.get(issuer);
  if (existing) {
    accessJwks.delete(issuer);
    accessJwks.set(issuer, existing);
    return existing;
  }
  // Retain jose's own expiration, rotation and concurrent-fetch handling across
  // warm requests. Never take a key-set URL from an assertion or request header.
  const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 });
  if (accessJwks.size >= MAX_ACCESS_ISSUERS) {
    const oldest = accessJwks.keys().next().value;
    if (oldest !== undefined) accessJwks.delete(oldest);
  }
  accessJwks.set(issuer, keys);
  return keys;
}

/** Test isolation only; this function is not exposed by an HTTP route. */
export function resetAccessJwksCacheForTests(): void { accessJwks.clear(); }

export function isLocalDevelopment(request: Request, env: Env): boolean {
  return env.ENVIRONMENT === 'development' && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(request.url).hostname);
}
function signingKey(env: Env): Uint8Array<ArrayBuffer> {
  if (!env.CONTINUATION_SECRET || env.CONTINUATION_SECRET.length < 32) throw new ServiceError('configuration', 'Private checking is not configured yet.', 503);
  return new TextEncoder().encode(env.CONTINUATION_SECRET);
}
export async function authenticate(request: Request, env: Env): Promise<string> {
  if (isLocalDevelopment(request, env)) return 'local-developer';
  if (!env.ACCESS_TEAM_DOMAIN || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN) || !env.ACCESS_AUD) throw new ServiceError('access_unconfigured', 'The private pilot is not open yet.', 503);
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) throw new ServiceError('unauthorized', 'Sign in with your invited email to continue.', 401);
  try {
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    const jwks = accessKeys(issuer);
    const { payload } = await jwtVerify(jwt, jwks, { issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'] });
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    const allowed = (env.ALLOWED_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!email || allowed.length > 9 || !allowed.includes(email)) throw new Error('not invited');
    return await fingerprint(email, env);
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError('unauthorized', 'Sign in with your invited email to continue.', 401);
  }
}

export function verifyOrigin(request: Request, env: Env): void {
  const origin = request.headers.get('Origin');
  const expected = new URL(request.url).origin;
  const localAllowed = isLocalDevelopment(request, env) && ['http://127.0.0.1:5173', 'http://localhost:5173', expected].includes(origin ?? '');
  if (origin !== expected && !localAllowed) throw new ServiceError('origin_rejected', 'Open SkeptiScan directly to submit a check.', 403);
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new ServiceError('origin_rejected', 'Open SkeptiScan directly to submit a check.', 403);
}

export function assertPilotOpen(request: Request, env: Env): void {
  if (isLocalDevelopment(request, env)) return;
  const end = Date.parse(env.PILOT_END_AT ?? '');
  if (!Number.isFinite(end) || end <= Date.now()) throw new ServiceError('pilot_closed', 'This pilot is not currently accepting checks.', 503);
}

export async function readJsonLimited(request: Request, maxBytes = 3_000_000): Promise<unknown> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new ServiceError('content_type', 'This request format is not supported.', 415);
  const encoding = request.headers.get('Content-Encoding');
  if (encoding && encoding !== 'identity') throw new ServiceError('content_encoding', 'Compressed requests are not supported.', 415);
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new ServiceError('input_too_large', 'This input is too large. Use a smaller screenshot or a shorter message.', 413);
  if (!request.body) throw new ServiceError('empty_input', 'Add the details you want to check.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new ServiceError('input_too_large', 'This input is too large. Use a smaller screenshot or a shorter message.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)); }
  catch { throw new ServiceError('invalid_json', 'This input could not be read. Please try again.'); }
}

async function fingerprint(value: string, env: Env): Promise<string> {
  const key = await crypto.subtle.importKey('raw', signingKey(env), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

const ContinuationSchema = z.object({
  checkId: z.string(), userHash: z.string(), inputHash: z.string(),
  extraction: ExtractionSchema, evidence: z.array(EvidenceSchema), questionId: QuestionIdSchema,
});
export type Continuation = z.infer<typeof ContinuationSchema>;
export async function signContinuation(checkId: string, userHash: string, input: CheckInput, extraction: Extraction, evidence: Evidence[], questionId: QuestionId, env: Env): Promise<string> {
  const inputHash = await fingerprint(JSON.stringify(input), env);
  return new SignJWT({ checkId, userHash, inputHash, extraction, evidence, questionId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer('skeptiscan').setAudience('clarify').setIssuedAt().setExpirationTime('10m').sign(signingKey(env));
}
export async function verifyContinuation(token: string, checkId: string, userHash: string, input: CheckInput, env: Env): Promise<Continuation> {
  try {
    const { payload } = await jwtVerify(token, signingKey(env), { issuer: 'skeptiscan', audience: 'clarify', algorithms: ['HS256'] });
    const state = ContinuationSchema.parse(payload);
    if (state.checkId !== checkId || state.userHash !== userHash || state.inputHash !== await fingerprint(JSON.stringify(input), env)) throw new Error('changed request');
    // Envelope expires in ten minutes; evidence is rebuilt on the follow-up anyway.
    return state;
  } catch { throw new ServiceError('invalid_continuation', 'This question has expired or the input changed. Start a new check.', 409); }
}
