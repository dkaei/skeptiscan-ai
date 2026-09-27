import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure, cancelWaitingCheck, checkInput, getCapabilities } from './api';
import type { CheckInput } from '../shared/contracts';

const originalId = 'bfd8ae11-8c95-4db1-86f5-d1daee6e8a8c';
const input: CheckInput = { mode: 'message', content: 'Private message text', context: '', senderEmail: '', senderPhone: '', externalLookup: false };
const response = () => new Response(JSON.stringify({ requestId: originalId, status: 'complete', title: 'Pause before acting', nextStep: 'Confirm the request.', reason: 'The requested action needs confirmation.', uncertainty: 'The sender is unknown.', evidence: [], extraction: null, question: null, checkedAt: '2026-09-26T00:00:00Z', aiUsed: true }), { headers: { 'Content-Type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('check lifecycle transport', () => {
  it('binds clarification to the original request ID and original input', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response());
    vi.stubGlobal('fetch', fetchMock);
    await checkInput(input, new AbortController().signal, { requestId: originalId, continuation: 'signed-state', answer: 'unsure' });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/clarify');
    expect(JSON.parse(options!.body as string)).toEqual({ requestId: originalId, input, continuation: 'signed-state', answer: 'unsure' });
    expect(options).toMatchObject({ redirect: 'manual', credentials: 'same-origin', cache: 'no-store' });
  });
  it('creates a distinct request ID for a new check', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response());
    vi.stubGlobal('fetch', fetchMock);
    await checkInput(input, new AbortController().signal);
    const [url, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options!.body as string);
    expect(url).toBe('/api/check');
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.requestId).not.toBe(originalId);
    expect(body.input).toEqual(input);
  });
  it('cancels only by opaque ID, without sending the message or blocking unload', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"cancelled":true}'));
    vi.stubGlobal('fetch', fetchMock);
    await cancelWaitingCheck(originalId);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/cancel');
    expect(JSON.parse(options!.body as string)).toEqual({ requestId: originalId });
    expect(options!.keepalive).toBe(true);
    expect(options!.credentials).toBe('same-origin');
    expect(options!.cache).toBe('no-store');
    expect(options!.redirect).toBe('manual');
  });
  it('does not make navigation depend on cancellation network success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Offline'); }));
    await expect(cancelWaitingCheck(originalId)).resolves.toBeUndefined();
  });
});

const serverError = (status: number, code: unknown, field?: unknown) => new Response(JSON.stringify({
  error: { code, message: '<html>PRIVATE PROVIDER BODY: refresh and send the request again</html>', field },
}), { status, headers: { 'Content-Type': 'application/json' } });
async function caughtCheck(result: Response, clarification = false) {
  const fetchMock = vi.fn(async () => result); vi.stubGlobal('fetch', fetchMock);
  const error = await checkInput(input, new AbortController().signal, clarification
    ? { requestId: originalId, continuation: 'signed-state', answer: 'unsure' } : undefined).catch(value => value);
  expect(error).toBeInstanceOf(ApiFailure);
  expect(error.message).not.toMatch(/PRIVATE PROVIDER|<html>|refresh/i);
  expect(fetchMock).toHaveBeenCalledTimes(1); // Never an automatic retry or a new check.
  return error as ApiFailure;
}

describe('bounded API failure recovery', () => {
  it('preserves the two-argument ApiFailure constructor and exposes additive details', () => {
    const failure = new ApiFailure('Review this field.', 'content');
    expect(failure).toMatchObject({ message: 'Review this field.', field: 'content', kind: 'unavailable', code: 'http_error', status: null, recovery: 'wait' });
    expect(new ApiFailure('Review input.', 'arbitrary-private-field').field).toBeUndefined();
  });

  it.each([
    [401, 'unauthorized', 'sign_in', 'sign_in'],
    [429, 'busy', 'busy', 'wait'],
    [503, 'budget_unavailable', 'unavailable', 'wait'],
    [503, 'ai_unavailable', 'unavailable', 'wait'],
    [503, 'MODEL_PROVIDER_UNAVAILABLE', 'unavailable', 'wait'],
    [504, 'timeout', 'timeout', 'return_to_form'],
    [422, 'invalid_input', 'invalid_input', 'edit_input'],
    [422, 'invalid_image', 'invalid_input', 'edit_input'],
    [409, 'invalid_continuation', 'clarification_expired', 'return_to_form'],
    [409, 'continuation_unavailable', 'clarification_expired', 'return_to_form'],
    [409, 'duplicate_request', 'duplicate', 'return_to_form'],
    [499, 'request_cancelled', 'cancelled', 'return_to_form'],
    [403, 'origin_rejected', 'invalid_input', 'return_to_form'],
  ] as const)('maps HTTP %s / %s to bounded recovery', async (status, code, kind, recovery) => {
    expect(await caughtCheck(serverError(status, code))).toMatchObject({ status, code, kind, recovery });
  });

  it('keeps an allowlisted field only for editable input failures', async () => {
    expect(await caughtCheck(serverError(422, 'invalid_input', 'senderEmail'))).toMatchObject({ field: 'senderEmail' });
    expect((await caughtCheck(serverError(422, 'invalid_input', '<private-field>'))).field).toBeUndefined();
    expect((await caughtCheck(serverError(503, 'budget_unavailable', 'content'))).field).toBeUndefined();
  });

  it.each(['__proto__', 'constructor', '<html>PRIVATE PROVIDER BODY</html>', { code: 'unauthorized' }, null])('discards unrecognized error code %j instead of copying it', async code => {
    const failure = await caughtCheck(serverError(503, code, 'private-secret'));
    expect(failure).toMatchObject({ code: 'http_error', kind: 'unavailable', status: 503, recovery: 'wait' });
    expect(failure.field).toBeUndefined();
  });

  it.each([401, 403, 429, 504, 503, 422])('uses HTTP %s recovery when an upstream error body is HTML', async status => {
    const failure = await caughtCheck(new Response('<html>PRIVATE PROVIDER BODY</html>', { status, headers: { 'Content-Type': 'text/html' } }));
    const expected = status === 401 || status === 403 ? 'sign_in' : status === 429 ? 'busy' : status === 504 ? 'timeout' : status === 422 ? 'invalid_input' : 'unavailable';
    expect(failure).toMatchObject({ kind: expected, status });
  });

  it('recognizes an Access redirect without following a login URL or exposing its body', async () => {
    const redirected = new Response('<html>PRIVATE PROVIDER BODY</html>', { status: 302, headers: { Location: 'https://login.example.test/private-token' } });
    const failure = await caughtCheck(redirected);
    expect(failure).toMatchObject({ kind: 'sign_in', code: 'session_redirect', status: 302, recovery: 'sign_in' });
    expect(failure.message).not.toContain('login.example.test');
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('recognizes a browser opaque redirect without inventing an unavailable HTTP status', async () => {
    const opaque = new Response(null);
    Object.defineProperties(opaque, { type: { value: 'opaqueredirect' }, status: { value: 0 } });
    expect(await caughtCheck(opaque)).toMatchObject({ kind: 'sign_in', code: 'session_redirect', status: null, recovery: 'sign_in' });
  });

  it.each([
    '<html>PRIVATE PROVIDER BODY</html>',
    '{"broken":',
    JSON.stringify({ status: 'complete', reason: 'Private shape mismatch' }),
    'null',
  ])('maps an unreadable successful response to malformed_response', async body => {
    const failure = await caughtCheck(new Response(body, { headers: { 'Content-Type': 'application/json' } }));
    expect(failure).toMatchObject({ kind: 'malformed_response', code: 'malformed_response', status: 200, recovery: 'return_to_form' });
    expect(failure.message).not.toContain('Private shape mismatch');
  });

  it('does not infer an ended session from an ordinary HTML 200 response', async () => {
    const failure = await caughtCheck(new Response('<html>Unexpected page</html>', { headers: { 'Content-Type': 'text/html' } }));
    expect(failure.kind).toBe('malformed_response');
  });

  it('normalizes malformed capability responses rather than leaking a schema error', async () => {
    const fetchMock = vi.fn(async () => new Response('{"mode":"PRIVATE PROVIDER VALUE"}', { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getCapabilities(new AbortController().signal)).rejects.toMatchObject({ name: 'ApiFailure', code: 'malformed_response', kind: 'malformed_response', status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a rejected fetch as an uncertain network failure without replaying the request', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('PRIVATE PROVIDER BODY and sensitive URL'); });
    vi.stubGlobal('fetch', fetchMock);
    const failure = await checkInput(input, new AbortController().signal).catch(value => value);
    expect(failure).toMatchObject({ kind: 'network', code: 'network_error', status: null, recovery: 'return_to_form' });
    expect(failure.message).toBe('The connection ended before a result arrived. Your input is still here.');
    expect(failure.message).not.toContain('PRIVATE PROVIDER'); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a broken response stream as a network failure without retaining its error detail', async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new TypeError('PRIVATE STREAM FAILURE')); } });
    const failure = await caughtCheck(new Response(body, { headers: { 'Content-Type': 'application/json' } }));
    expect(failure).toMatchObject({ kind: 'network', code: 'network_error', status: 200 });
    expect(failure.message).not.toContain('PRIVATE STREAM');
  });

  it('preserves native AbortError so intentional local cancellation stays quiet', async () => {
    const aborted = new DOMException('Cancelled by user', 'AbortError');
    const fetchMock = vi.fn(async () => { throw aborted; }); vi.stubGlobal('fetch', fetchMock);
    await expect(checkInput(input, new AbortController().signal)).rejects.toBe(aborted);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves intentional cancellation when the browser rejects fetch with a different error type', async () => {
    const controller = new AbortController(); controller.abort();
    const fetchMock = vi.fn(async () => { throw new TypeError('Network request cancelled'); }); vi.stubGlobal('fetch', fetchMock);
    await expect(getCapabilities(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([[422, 'invalid_input'], [429, 'busy'], [503, 'budget_unavailable'], [409, 'invalid_continuation']] as const)('returns a failed clarification (%s / %s) to the input without suggesting continuation retry', async (status, code) => {
    const failure = await caughtCheck(serverError(status, code, 'content'), true);
    expect(failure.recovery).toBe('return_to_form'); expect(failure.field).toBeUndefined();
    expect(failure.message).not.toMatch(/retry|refresh|submit again/i);
  });

  it('retains sign-in recovery for a clarification blocked by an expired session', async () => {
    expect(await caughtCheck(serverError(401, 'unauthorized'), true)).toMatchObject({ recovery: 'sign_in', kind: 'sign_in' });
  });

  it('returns a valid partial assessment unchanged instead of treating it as transport failure', async () => {
    const value = await response().json() as Record<string, unknown>;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...value, status: 'partial', title: 'The check is incomplete' }))));
    await expect(checkInput(input, new AbortController().signal)).resolves.toMatchObject({ status: 'partial', title: 'The check is incomplete' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
