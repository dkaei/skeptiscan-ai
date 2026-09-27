import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModelGateway, ModelGatewayError } from '../server/openai';
import type { CheckInput, Extraction } from '../shared/contracts';

// Exercise the installed SDK, not a gateway/SDK mock. Every transport is
// replaced before constructing the client; no environment or real key is read.
const transport = vi.fn<typeof fetch>();
const mini = 'gpt-5.4-mini-2026-03-17';
const reviewer = 'gpt-5.4-2026-03-05';
const sensitive = 'synthetic-private-provider-body-or-key';
const input: CheckInput = { mode: 'message', content: 'Please share your login code.', context: '', senderEmail: '', senderPhone: '', externalLookup: false };
const image: CheckInput = { ...input, mode: 'screenshot', content: '', image: { mimeType: 'image/png', base64: 'eA==' } };
const extraction: Extraction = { transcript: '', claimedOrganisation: null, urls: [], phoneNumbers: [], requestedActions: [], unreadableDetails: [], screenshotIssues: [], missingContext: [] };
const { unreadableDetails: _legacyUnreadableDetails, ...modelExtraction } = extraction;
const signal = () => new AbortController().signal;
const gateway = () => createModelGateway('offline-synthetic-key');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const response = (output: unknown = modelExtraction) => ({
  id: 'resp_offline', object: 'response', model: mini, status: 'completed',
  output: [{ id: 'msg_offline', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(output), annotations: [] }] }],
  usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
});

async function failure(promise: Promise<unknown>): Promise<ModelGatewayError> {
  const result = await promise.then(() => null, error => error);
  expect(result).toBeInstanceOf(ModelGatewayError);
  return result as ModelGatewayError;
}

function expectPrivate(error: ModelGatewayError) {
  expect(error.message).toBe('The AI analysis could not be completed.');
  expect(JSON.stringify(error)).not.toContain(sensitive);
  expect(error.stack).not.toContain(sensitive);
  for (const key of ['cause', 'headers', 'requestID', 'error', 'param', 'type']) expect(error).not.toHaveProperty(key);
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) expect(console[method]).not.toHaveBeenCalled();
}

function pendingTransport() {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  transport.mockImplementation((_url, options) => new Promise<Response>((_resolve, reject) => {
    const requestSignal = options?.signal;
    const aborted = () => reject(new DOMException(sensitive, 'AbortError'));
    if (requestSignal?.aborted) aborted();
    else requestSignal?.addEventListener('abort', aborted, { once: true });
    started();
  }));
  return ready;
}

beforeEach(() => {
  transport.mockReset().mockRejectedValue(new Error('Offline test transport has no response configured.'));
  vi.stubGlobal('fetch', transport);
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('pre-generation failures can explicitly settle an admitted attempt at zero generation cost', () => {
  it('rejects oversized text before any provider request', async () => {
    const error = await failure(gateway().extract({ ...input, content: '中'.repeat(3000) }, signal()));
    expect(error).toMatchObject({ code: 'MODEL_INPUT_TOO_LARGE', usage: undefined, notDispatched: { model: mini } });
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects malformed image encoding before token counting', async () => {
    const error = await failure(gateway().extract({ ...image, image: { mimeType: 'image/png', base64: 'invalid!' } }, signal()));
    expect(error).toMatchObject({ code: 'MODEL_IMAGE_INVALID', usage: undefined, notDispatched: { model: mini } });
    expect(transport).not.toHaveBeenCalled();
  });

  it('marks a caller cancellation before dispatch without leaking its reason', async () => {
    const controller = new AbortController(); controller.abort(new Error(sensitive));
    const error = await failure(gateway().extract(input, controller.signal));
    expect(error).toMatchObject({ code: 'MODEL_CANCELLED', usage: undefined, notDispatched: { model: mini } });
    expect(transport).not.toHaveBeenCalled(); expectPrivate(error);
  });

  it.each([
    ['extract', 6001, mini], ['review', 12001, reviewer],
  ] as const)('uses the %s model identity when the image token count exceeds its bound', async (stage, count, model) => {
    transport.mockResolvedValue(json({ object: 'response.input_tokens', input_tokens: count }));
    const client = gateway();
    const error = await failure(stage === 'extract' ? client.extract(image, signal()) : client.review(image, extraction, [], signal()));
    expect(error).toMatchObject({ code: 'MODEL_INPUT_TOO_LARGE', usage: undefined, notDispatched: { model } });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(String(transport.mock.calls[0][0])).toBe('https://api.openai.com/v1/responses/input_tokens');
  });

  it.each([null, {}, { object: 'response.input_tokens', input_tokens: 1.5 }])('rejects an unusable image count without generation: %j', async body => {
    transport.mockResolvedValue(json(body));
    const error = await failure(gateway().extract(image, signal()));
    expect(error).toMatchObject({ code: 'MODEL_TOKEN_COUNT_UNAVAILABLE', usage: undefined, notDispatched: { model: mini } });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([[401, 'MODEL_AUTHENTICATION_FAILED'], [429, 'MODEL_RATE_LIMITED'], [503, 'MODEL_PROVIDER_UNAVAILABLE']] as const)('classifies preflight HTTP %s while proving no generation was invoked', async (status, code) => {
    transport.mockResolvedValue(json({ error: { message: sensitive, code: sensitive, param: sensitive } }, status));
    const error = await failure(gateway().extract(image, signal()));
    expect(error).toMatchObject({ code, usage: undefined, notDispatched: { model: mini } });
    expect(transport).toHaveBeenCalledTimes(1); expectPrivate(error);
  });

  it('does not turn a token-count connection failure into unknown generation billing', async () => {
    transport.mockRejectedValue(new TypeError(sensitive));
    const error = await failure(gateway().extract(image, signal()));
    expect(error).toMatchObject({ code: 'MODEL_CONNECTION_FAILED', usage: undefined, notDispatched: { model: mini } });
    expect(transport).toHaveBeenCalledTimes(1); expectPrivate(error);
  });

  it('does not start generation when the shared stage deadline expires during token counting', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const ready = pendingTransport();
    const pending = failure(gateway().extract(image, signal()));
    await ready; deadline.abort();
    const error = await pending;
    expect(error).toMatchObject({ code: 'MODEL_TIMEOUT', usage: undefined, notDispatched: { model: mini } });
    expect(transport).toHaveBeenCalledTimes(1); expectPrivate(error);
  });
});

describe('generation failures retain unknown billing and never retry', () => {
  it.each([[401, 'MODEL_AUTHENTICATION_FAILED'], [429, 'MODEL_RATE_LIMITED'], [500, 'MODEL_PROVIDER_UNAVAILABLE'], [503, 'MODEL_PROVIDER_UNAVAILABLE'], [599, 'MODEL_PROVIDER_UNAVAILABLE']] as const)('classifies HTTP %s without treating an error response as proof of zero billing', async (status, code) => {
    transport.mockResolvedValue(new Response(JSON.stringify({ error: { message: sensitive, type: sensitive, code: sensitive, param: sensitive } }), {
      status, headers: { 'Content-Type': 'application/json', 'Retry-After': '30', 'x-request-id': sensitive },
    }));
    const error = await failure(gateway().extract(input, signal()));
    expect(error).toMatchObject({ code, usage: undefined, notDispatched: undefined });
    expect(transport).toHaveBeenCalledTimes(1); expectPrivate(error);
  });

  it('classifies a fetch connection failure but does not infer whether the request reached the provider', async () => {
    transport.mockRejectedValue(new TypeError(sensitive));
    const error = await failure(gateway().extract(input, signal()));
    expect(error).toMatchObject({ code: 'MODEL_CONNECTION_FAILED', usage: undefined, notDispatched: undefined });
    expect(transport).toHaveBeenCalledTimes(1); expectPrivate(error);
  });

  it.each(['caller', 'deadline'] as const)('cancels one pending generation for a %s abort while retaining its reservation', async source => {
    const controller = new AbortController();
    if (source === 'deadline') vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const ready = pendingTransport();
    const pending = failure(gateway().extract(input, source === 'caller' ? controller.signal : signal()));
    await ready; controller.abort(new Error(sensitive));
    const error = await pending;
    expect(error).toMatchObject({ code: source === 'caller' ? 'MODEL_CANCELLED' : 'MODEL_TIMEOUT', usage: undefined, notDispatched: undefined });
    expect(transport).toHaveBeenCalledTimes(1); expectPrivate(error);
  });

  it('retains unknown billing when a successful HTTP response has unreadable JSON', async () => {
    transport.mockResolvedValue(new Response(`{"${sensitive}":`, { headers: { 'Content-Type': 'application/json' } }));
    const error = await failure(gateway().extract(input, signal()));
    expect(error).toMatchObject({ code: 'BILLING_UNKNOWN', usage: undefined, notDispatched: undefined });
    expect(transport).toHaveBeenCalledTimes(1); expectPrivate(error);
  });

  it('preserves known usage even when completed model text fails the output schema', async () => {
    transport.mockResolvedValue(json(response({ sensitive })));
    const error = await failure(gateway().extract(input, signal()));
    expect(error).toMatchObject({ code: 'MODEL_OUTPUT_INVALID', usage: { model: mini, inputTokens: 100, outputTokens: 100, costMicroUsd: 525 }, notDispatched: undefined });
    expect(transport).toHaveBeenCalledTimes(1); expectPrivate(error);
  });

  it('uses manual redirects and a single stateless bounded generation with the actual SDK', async () => {
    transport.mockResolvedValue(json(response()));
    const result = await gateway().extract(input, signal());
    expect(result.usage.costMicroUsd).toBe(525);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, options] = transport.mock.calls[0];
    expect(String(url)).toBe('https://api.openai.com/v1/responses');
    expect(options).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(JSON.parse(String(options?.body))).toMatchObject({ model: mini, store: false, background: false, stream: false, tools: [], max_output_tokens: 800 });
  });

  it('never follows or retries an untrusted redirect', async () => {
    transport.mockResolvedValue(new Response('{}', { status: 302, headers: { 'Content-Type': 'application/json', Location: 'https://must-not-follow.invalid/' } }));
    const error = await failure(gateway().extract(input, signal()));
    expect(error).toMatchObject({ code: 'BILLING_UNKNOWN', usage: undefined, notDispatched: undefined });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(String(transport.mock.calls[0][0])).toBe('https://api.openai.com/v1/responses');
    expect(transport.mock.calls[0][1]?.redirect).toBe('manual');
  });
});
