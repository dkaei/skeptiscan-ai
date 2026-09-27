import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRemoteJWKSet, generateKeyPair, SignJWT } from 'jose';
import type { CheckInput, Evidence, Extraction } from '../shared/contracts';
import type { Env } from '../server/types';
import { authenticate, assertPilotOpen, isLocalDevelopment, readJsonLimited, resetAccessJwksCacheForTests, signContinuation, verifyContinuation, verifyOrigin } from '../server/security';

// Exercise real signature verification. Only the network key resolver is replaced
// with a locally generated public key; no identity provider is contacted.
vi.mock('jose', async importOriginal => ({ ...await importOriginal<typeof import('jose')>(), createRemoteJWKSet: vi.fn() }));

const testSecret = 'offline-test-secret-not-used-for-deployment-0123456789';
const checkId = '0e5617c7-e847-48f8-96cc-8218f999fcf4';
const userHash = 'test-pseudonymous-user';
const input: CheckInput = { mode: 'message', content: 'Did you request this code?', context: '', senderEmail: '', senderPhone: '', externalLookup: false };
const extraction: Extraction = { transcript: '', claimedOrganisation: null, urls: [], phoneNumbers: [], requestedActions: [], unreadableDetails: [], missingContext: ['whether the user started the request'] };
const evidence: Evidence[] = [];
function env(overrides: Partial<Env> = {}): Env {
  return { DB: {} as D1Database, ENVIRONMENT: 'production', CONTINUATION_SECRET: testSecret,
    ACCESS_TEAM_DOMAIN: 'skeptiscan-test.cloudflareaccess.com', ACCESS_AUD: 'offline-pilot-audience',
    ALLOWED_EMAILS: 'tester@example.test', PILOT_END_AT: '2099-01-01T00:00:00.000Z', ...overrides };
}
function request(url = 'https://pilot.example.test/api/check', headers: HeadersInit = {}) {
  return new Request(url, { method: 'POST', headers });
}

describe('signed clarification binding', () => {
  afterEach(() => vi.useRealTimers());

  it('round-trips the approved question with a real HMAC signature', async () => {
    const token = await signContinuation(checkId, userHash, input, extraction, evidence, 'initiated_request', env());
    const state = await verifyContinuation(token, checkId, userHash, input, env());
    expect(state).toMatchObject({ checkId, userHash, questionId: 'initiated_request', extraction, evidence });
    expect(token.split('.')).toHaveLength(3);
    expect(state.inputHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects modified payload bytes and a token signed with a different secret', async () => {
    const token = await signContinuation(checkId, userHash, input, extraction, evidence, 'initiated_request', env());
    const [header, body, signature] = token.split('.');
    const changed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    changed.questionId = 'sharing_code';
    const tampered = [header, Buffer.from(JSON.stringify(changed)).toString('base64url'), signature].join('.');
    await expect(verifyContinuation(tampered, checkId, userHash, input, env())).rejects.toMatchObject({ code: 'invalid_continuation', status: 409 });
    await expect(verifyContinuation(token, checkId, userHash, input, env({ CONTINUATION_SECRET: 'a-different-test-secret-at-least-32-characters' }))).rejects.toMatchObject({ code: 'invalid_continuation' });
  });

  it('binds to check ID, user identity and every submitted input field', async () => {
    const token = await signContinuation(checkId, userHash, input, extraction, evidence, 'initiated_request', env());
    await expect(verifyContinuation(token, 'another-check', userHash, input, env())).rejects.toMatchObject({ code: 'invalid_continuation' });
    await expect(verifyContinuation(token, checkId, 'another-user', input, env())).rejects.toMatchObject({ code: 'invalid_continuation' });
    for (const changed of [
      { ...input, content: 'Replace the message' }, { ...input, context: 'Different context' },
      { ...input, externalLookup: true }, { ...input, senderEmail: 'other@example.test' },
      { ...input, senderPhone: '+6581234567' }, { ...input, mode: 'call' as const },
    ]) await expect(verifyContinuation(token, checkId, userHash, changed, env())).rejects.toMatchObject({ code: 'invalid_continuation' });
  });

  it('binds screenshot bytes and corrected text, not just the displayed question', async () => {
    const screenshot: CheckInput = { ...input, mode: 'screenshot', image: { mimeType: 'image/png', base64: 'b25l' } };
    const token = await signContinuation(checkId, userHash, screenshot, extraction, evidence, 'initiated_request', env());
    await expect(verifyContinuation(token, checkId, userHash, { ...screenshot, image: { mimeType: 'image/png', base64: 'dHdv' } }, env())).rejects.toMatchObject({ code: 'invalid_continuation' });
    await expect(verifyContinuation(token, checkId, userHash, { ...screenshot, content: 'Edited transcription' }, env())).rejects.toMatchObject({ code: 'invalid_continuation' });
  });

  it('expires after ten minutes and does not accept a signed token for a different audience', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-26T01:00:00Z'));
    const token = await signContinuation(checkId, userHash, input, extraction, evidence, 'initiated_request', env());
    vi.setSystemTime(new Date('2026-09-26T01:09:59Z'));
    await expect(verifyContinuation(token, checkId, userHash, input, env())).resolves.toBeDefined();
    vi.setSystemTime(new Date('2026-09-26T01:10:00Z'));
    await expect(verifyContinuation(token, checkId, userHash, input, env())).rejects.toMatchObject({ code: 'invalid_continuation' });
    const wrongAudience = await new SignJWT({ checkId, userHash }).setProtectedHeader({ alg: 'HS256' }).setIssuer('skeptiscan').setAudience('different-feature').setExpirationTime('10m').sign(new TextEncoder().encode(testSecret));
    await expect(verifyContinuation(wrongAudience, checkId, userHash, input, env())).rejects.toMatchObject({ code: 'invalid_continuation' });
  });

  it('requires a configured signing secret and rejects malformed tokens', async () => {
    await expect(signContinuation(checkId, userHash, input, extraction, evidence, 'initiated_request', env({ CONTINUATION_SECRET: 'too-short' }))).rejects.toMatchObject({ code: 'configuration', status: 503 });
    await expect(verifyContinuation('not.a.jwt', checkId, userHash, input, env())).rejects.toMatchObject({ code: 'invalid_continuation' });
  });
});

describe('private pilot authentication (offline keys)', () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  beforeAll(async () => { keys = await generateKeyPair('RS256'); });
  beforeEach(() => {
    resetAccessJwksCacheForTests();
    vi.mocked(createRemoteJWKSet).mockReset();
    vi.mocked(createRemoteJWKSet).mockReturnValue((async () => keys.publicKey) as unknown as ReturnType<typeof createRemoteJWKSet>);
  });
  async function assertion(payload: Record<string, unknown> = { email: 'tester@example.test' }, issuer = 'https://skeptiscan-test.cloudflareaccess.com', audience = 'offline-pilot-audience', expiry = '5m') {
    return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'offline-key' }).setIssuer(issuer).setAudience(audience).setExpirationTime(expiry).sign(keys.privateKey);
  }

  it('allows only an explicit loopback development environment to bypass Access', async () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const local = request(`http://${host}:8787/api/check`);
      expect(isLocalDevelopment(local, env({ ENVIRONMENT: 'development' }))).toBe(true);
      await expect(authenticate(local, env({ ENVIRONMENT: 'development', ACCESS_AUD: '' }))).resolves.toBe('local-developer');
      expect(isLocalDevelopment(local, env())).toBe(false);
    }
    expect(isLocalDevelopment(request('https://localhost.evil.example/api/check'), env({ ENVIRONMENT: 'development' }))).toBe(false);
    expect(isLocalDevelopment(request('https://pilot.example.test/api/check', { 'X-Forwarded-Host': 'localhost' }), env({ ENVIRONMENT: 'development' }))).toBe(false);
    expect(createRemoteJWKSet).not.toHaveBeenCalled();
  });

  it('fails closed on production configuration gaps and missing assertions', async () => {
    await expect(authenticate(request(), env({ ACCESS_TEAM_DOMAIN: '' }))).rejects.toMatchObject({ code: 'access_unconfigured', status: 503 });
    await expect(authenticate(request(), env({ ACCESS_TEAM_DOMAIN: 'https://attacker.example' }))).rejects.toMatchObject({ code: 'access_unconfigured' });
    await expect(authenticate(request(), env({ ACCESS_AUD: '' }))).rejects.toMatchObject({ code: 'access_unconfigured' });
    await expect(authenticate(request(), env())).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    await expect(authenticate(request('http://localhost:8787/api/check'), env())).rejects.toMatchObject({ code: 'unauthorized' });
    expect(createRemoteJWKSet).not.toHaveBeenCalled();
  });

  it('verifies issuer, audience and signature then returns an HMAC pseudonym for an allowlisted email', async () => {
    const token = await assertion({ email: 'TESTER@EXAMPLE.TEST' });
    const identity = await authenticate(request(undefined, { 'Cf-Access-Jwt-Assertion': token }), env());
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    expect(identity).not.toContain('tester');
    expect(createRemoteJWKSet).toHaveBeenCalledWith(new URL('https://skeptiscan-test.cloudflareaccess.com/cdn-cgi/access/certs'), { timeoutDuration: 5000 });
    expect(await authenticate(request(undefined, { 'Cf-Access-Jwt-Assertion': await assertion() }), env())).toBe(identity);
  });

  it('reuses the issuer key resolver across warm requests while rechecking audience and invites', async () => {
    const token = await assertion();
    const signedRequest = request(undefined, { 'Cf-Access-Jwt-Assertion': token });
    await expect(authenticate(signedRequest, env())).resolves.toMatch(/^[a-f0-9]{64}$/);
    await expect(authenticate(signedRequest, env())).resolves.toMatch(/^[a-f0-9]{64}$/);
    await expect(authenticate(signedRequest, env({ ALLOWED_EMAILS: 'different@example.test' }))).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(authenticate(signedRequest, env({ ACCESS_AUD: 'changed-audience' }))).rejects.toMatchObject({ code: 'unauthorized' });
    expect(createRemoteJWKSet).toHaveBeenCalledTimes(1);
  });

  it('isolates configured issuers and evicts the least recently used resolver at four entries', async () => {
    async function authenticateTeam(team: number) {
      const domain = `team-${team}.cloudflareaccess.com`;
      const token = await assertion(undefined, `https://${domain}`);
      return authenticate(request(undefined, { 'Cf-Access-Jwt-Assertion': token }), env({ ACCESS_TEAM_DOMAIN: domain }));
    }
    for (let i = 0; i < 4; i++) await authenticateTeam(i);
    expect(createRemoteJWKSet).toHaveBeenCalledTimes(4);
    await authenticateTeam(0); // Refresh its recency before adding another issuer.
    await authenticateTeam(4); // Evicts team 1, not the recently used team 0.
    await authenticateTeam(0);
    expect(createRemoteJWKSet).toHaveBeenCalledTimes(5);
    await authenticateTeam(1);
    expect(createRemoteJWKSet).toHaveBeenCalledTimes(6);
    expect(vi.mocked(createRemoteJWKSet).mock.calls[5][0]).toEqual(new URL('https://team-1.cloudflareaccess.com/cdn-cgi/access/certs'));
  });

  it('rejects non-invited/missing identities, an overfull invite list, wrong issuer/audience and expired assertions', async () => {
    for (const token of [await assertion({ email: 'other@example.test' }), await assertion({}),
      await assertion(undefined, 'https://other.cloudflareaccess.com'),
      await assertion(undefined, undefined, 'wrong-audience'), await assertion(undefined, undefined, undefined, '-1s'),
    ]) await expect(authenticate(request(undefined, { 'Cf-Access-Jwt-Assertion': token }), env())).rejects.toMatchObject({ code: 'unauthorized' });
    const token = await assertion();
    await expect(authenticate(request(undefined, { 'Cf-Access-Jwt-Assertion': token }), env({ ALLOWED_EMAILS: ['tester@example.test', ...Array.from({ length: 9 }, (_, i) => `${i}@example.test`)].join(',') }))).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(authenticate(request(undefined, { 'Cf-Access-Jwt-Assertion': token }), env({ ALLOWED_EMAILS: '' }))).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('rejects a forged signature and never exposes JWT verification details', async () => {
    const other = await generateKeyPair('RS256');
    const token = await new SignJWT({ email: 'tester@example.test' }).setProtectedHeader({ alg: 'RS256' }).setIssuer('https://skeptiscan-test.cloudflareaccess.com').setAudience('offline-pilot-audience').setExpirationTime('5m').sign(other.privateKey);
    await expect(authenticate(request(undefined, { 'Cf-Access-Jwt-Assertion': token }), env())).rejects.toMatchObject({ code: 'unauthorized', message: 'Sign in with your invited email to continue.' });
  });
});

describe('origin and pilot lifetime', () => {
  it('requires an exact same origin in production and rejects explicit cross-site submission', () => {
    expect(() => verifyOrigin(request(undefined, { Origin: 'https://pilot.example.test' }), env())).not.toThrow();
    for (const origin of ['', 'null', 'https://other.example.test', 'http://pilot.example.test', 'https://pilot.example.test.attacker.example']) {
      expect(() => verifyOrigin(request(undefined, origin ? { Origin: origin } : {}), env())).toThrow();
    }
    expect(() => verifyOrigin(request(undefined, { Origin: 'https://pilot.example.test', 'Sec-Fetch-Site': 'cross-site' }), env())).toThrow();
  });
  it('allows the development UI port only for loopback development', () => {
    const local = request('http://127.0.0.1:8787/api/check', { Origin: 'http://127.0.0.1:5173' });
    expect(() => verifyOrigin(local, env({ ENVIRONMENT: 'development' }))).not.toThrow();
    expect(() => verifyOrigin(local, env())).toThrow();
    expect(() => verifyOrigin(request(undefined, { Origin: 'http://127.0.0.1:5173' }), env({ ENVIRONMENT: 'development' }))).toThrow();
  });
  it('closes production mutations at the configured end and rejects missing dates', () => {
    expect(() => assertPilotOpen(request(), env())).not.toThrow();
    expect(() => assertPilotOpen(request(), env({ PILOT_END_AT: '' }))).toThrow();
    expect(() => assertPilotOpen(request(), env({ PILOT_END_AT: '2000-01-01' }))).toThrow();
    expect(() => assertPilotOpen(request('http://localhost:8787/api/check'), env({ ENVIRONMENT: 'development', PILOT_END_AT: '' }))).not.toThrow();
  });
});

describe('bounded JSON ingress', () => {
  function json(body: BodyInit | null, headers: HeadersInit = {}) {
    return new Request('https://pilot.example.test/api/check', { method: 'POST', body, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
  }
  it('accepts valid JSON within the byte limit', async () => {
    await expect(readJsonLimited(json('{"value":"ok"}'), 14)).resolves.toEqual({ value: 'ok' });
  });
  it('rejects unsupported type, compression, malformed lengths, empty and malformed JSON', async () => {
    await expect(readJsonLimited(json('{}', { 'Content-Type': 'text/plain' }))).rejects.toMatchObject({ code: 'content_type', status: 415 });
    await expect(readJsonLimited(json('{}', { 'Content-Encoding': 'gzip' }))).rejects.toMatchObject({ code: 'content_encoding', status: 415 });
    await expect(readJsonLimited(json('{}', { 'Content-Length': '1000' }), 100)).rejects.toMatchObject({ code: 'input_too_large', status: 413 });
    await expect(readJsonLimited(json('{}', { 'Content-Length': 'invalid' }))).rejects.toMatchObject({ code: 'input_too_large' });
    await expect(readJsonLimited(json(null))).rejects.toMatchObject({ code: 'empty_input' });
    await expect(readJsonLimited(json('{bad}'))).rejects.toMatchObject({ code: 'invalid_json' });
  });
  it('measures received bytes rather than trusting a short Content-Length or character count', async () => {
    await expect(readJsonLimited(json('"中文"', { 'Content-Length': '2' }), 7)).rejects.toMatchObject({ code: 'input_too_large' });
    await expect(readJsonLimited(json('"中文"'), 8)).resolves.toBe('中文');
  });
  it('cancels an oversized streamed body before buffering further chunks', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(9)); }, cancel });
    const streamed = new Request('https://pilot.example.test/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' });
    await expect(readJsonLimited(streamed, 8)).rejects.toMatchObject({ code: 'input_too_large' });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects malformed UTF-8 instead of silently replacing bytes', async () => {
    await expect(readJsonLimited(json(new Uint8Array([0x22, 0xc3, 0x28, 0x22])))).rejects.toMatchObject({ code: 'invalid_json' });
  });
});
