import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckInput, Extraction } from '../shared/contracts';
import { RESERVATION_MICRO_USD } from '../server/ledger';
const sdk = vi.hoisted(() => ({ create: vi.fn(), count: vi.fn(), options: [] as Record<string, unknown>[] }));
vi.mock('openai', () => ({ default: class {
  responses = { create: sdk.create, inputTokens: { count: sdk.count } };
  constructor(options: Record<string, unknown>) { sdk.options.push(options); }
} }));
import {
  createModelGateway, usageCostMicroUsd, MODEL_LIMITS, IMAGE_TOKEN_PREFLIGHT_ENABLED,
  conservativeTextTokenBound,
} from '../server/openai';

const input: CheckInput = { mode: 'message', content: 'Please tell me your login code.', context: '', senderEmail: '', senderPhone: '', externalLookup: false };
const extraction: Extraction = { transcript: '', claimedOrganisation: null, urls: [], phoneNumbers: [], requestedActions: [{ action: 'share a code', quote: 'tell me your login code', source: 'content' }], unreadableDetails: [], screenshotIssues: [], missingContext: [] };
const { unreadableDetails: _legacyUnreadableDetails, ...modelExtraction } = extraction;
const review = { finding: 'credential_disclosure', evidenceIds: [], questionId: null,
  rationale: { relation: 'action_risk', anchors: [{ source: 'content', quote: 'tell me your login code' }], risks: [{ kind: 'account_access', anchorIndex: 0 }] },
};
const signal = () => new AbortController().signal;
const response = (model = 'gpt-5.4-mini-2026-03-17', value: unknown = modelExtraction) => ({ model, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }], usage: { input_tokens: 1000, output_tokens: 300, output_tokens_details: { reasoning_tokens: 100 } } });

describe('official model gateway (mocked, no external calls)', () => {
  beforeEach(() => { sdk.create.mockReset(); sdk.count.mockReset(); sdk.options.length = 0; });
  afterEach(() => { vi.restoreAllMocks(); });

  it('fixes endpoint, disables logging/retries/redirects and requests strict stateless extraction', async () => {
    sdk.create.mockResolvedValue(response());
    const result = await createModelGateway('test-key').extract(input, signal());
    expect(sdk.options[0]).toMatchObject({ baseURL: 'https://api.openai.com/v1', maxRetries: 0, logLevel: 'off', fetchOptions: { redirect: 'manual' } });
    const [body, options] = sdk.create.mock.calls[0];
    expect(body).toMatchObject({ model: 'gpt-5.4-mini-2026-03-17', store: false, background: false, stream: false, service_tier: 'default', tools: [], reasoning: { effort: 'none' }, max_output_tokens: 800 });
    expect(options).toMatchObject({ maxRetries: 0, timeout: 15000 });
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
    expect(body.text.format.schema.additionalProperties).toBe(false);
    expect(body.text.format.schema.required).toContain('screenshotIssues');
    expect(body.text.format.schema.properties).not.toHaveProperty('unreadableDetails');
    expect(body.text.format.schema.properties.requestedActions.items.required).toContain('source');
    expect(body).not.toHaveProperty('previous_response_id');
    expect(result.usage.costMicroUsd).toBe(2100);
    expect(result.value).toEqual(extraction);
    expect(conservativeTextTokenBound(body)).toBeLessThanOrEqual(MODEL_LIMITS['gpt-5.4-mini-2026-03-17'].inputTokens);
  });

  async function checkFinalReview(answer: 'yes' | 'no' | 'unsure') {
    sdk.create.mockResolvedValue(response('gpt-5.4-2026-03-05', review));
    const result = await createModelGateway('test-key').review(input, extraction, [], signal(), { questionId: 'sharing_code', answer });
    const [request, options] = sdk.create.mock.calls[0];
    // Check what is sent over the wire, using the actual SDK schema helper.
    const body = JSON.parse(JSON.stringify(request));
    expect(body).toMatchObject({ model: 'gpt-5.4-2026-03-05', reasoning: { effort: 'low' }, max_output_tokens: 2000, store: false, tools: [] });
    expect(options.timeout).toBe(25000);
    expect(options.maxRetries).toBe(0);
    expect(body.text.format).toMatchObject({ name: 'skeptiscan_final_review', strict: true });
    expect(body.text.format.schema).toMatchObject({ additionalProperties: false, required: ['finding', 'evidenceIds', 'questionId', 'rationale'] });
    expect(Object.keys(body.text.format.schema.properties).sort()).toEqual(['evidenceIds', 'finding', 'questionId', 'rationale']);
    expect(body.text.format.schema.properties.questionId).toEqual({ type: 'null' });
    const data = JSON.parse(body.input[0].content[0].text);
    expect(data.original.text).toBe(input.content);
    expect(data.clarification).toEqual({ questionId: 'sharing_code', answer });
    // output_tokens already includes reasoning: do not add its detail twice.
    expect(result.usage.costMicroUsd).toBe(7000);
    expect(result.value).toMatchObject({ finding: 'credential_disclosure', actionId: 'protect_credentials', questionId: null });
    expect(conservativeTextTokenBound(body)).toBeLessThanOrEqual(MODEL_LIMITS['gpt-5.4-2026-03-05'].inputTokens);
    expect(sdk.create).toHaveBeenCalledTimes(1);
  }

  it('uses GPT-5.4 low reasoning with original, evidence and clarification and a total output cap', () => checkFinalReview('yes'));

  it.each(['no', 'unsure'] as const)('requires a null final question for %s while preserving original input and call limits', checkFinalReview);

  it('still permits an approved question in the initial review schema', async () => {
    sdk.create.mockResolvedValue(response('gpt-5.4-2026-03-05', { ...review, finding: 'unclear_request', questionId: 'sharing_code', rationale: { ...review.rationale, relation: 'unclear_context' } }));
    const result = await createModelGateway('test-key').review(input, extraction, [], signal());
    const body = JSON.parse(JSON.stringify(sdk.create.mock.calls[0][0]));
    expect(body.text.format.name).toBe('skeptiscan_review');
    expect(body.text.format.schema.properties.questionId).toEqual({ anyOf: [
      { type: 'string', enum: ['initiated_request', 'sharing_code', 'asked_to_install', 'payment_expected'] },
      { type: 'null' },
    ] });
    expect(JSON.parse(body.input[0].content[0].text).clarification).toBeNull();
    expect(result.value).toMatchObject({ actionId: 'need_context', questionId: 'sharing_code' });
  });

  it.each(['initiated_request', 'sharing_code', 'asked_to_install', 'payment_expected', undefined])('rejects invalid final question %s without erasing it, retrying or losing billing', async questionId => {
    sdk.create.mockResolvedValue(response('gpt-5.4-2026-03-05', { ...review, finding: 'unclear_request', questionId }));
    await expect(createModelGateway('test-key').review(input, extraction, [], signal(), { questionId: 'sharing_code', answer: 'unsure' })).rejects.toMatchObject({
      code: 'MODEL_OUTPUT_INVALID', usage: { costMicroUsd: 7000 },
    });
    expect(sdk.create).toHaveBeenCalledTimes(1);
  });

  it('bounds the complete serialized payload before dispatch', async () => {
    await expect(createModelGateway('test-key').extract({ ...input, content: '中'.repeat(3000) }, signal())).rejects.toMatchObject({ code: 'MODEL_INPUT_TOO_LARGE' });
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it('preflights the exact image input and schema once before generation', async () => {
    expect(IMAGE_TOKEN_PREFLIGHT_ENABLED).toBe(true);
    sdk.count.mockResolvedValue({ object: 'response.input_tokens', input_tokens: 5800 });
    sdk.create.mockResolvedValue(response());
    await createModelGateway('test-key').extract({ ...input, mode: 'screenshot', image: { mimeType: 'image/png', base64: 'eA==' } }, signal());
    expect(sdk.count).toHaveBeenCalledTimes(1);
    expect(sdk.create).toHaveBeenCalledTimes(1);
    const [countBody, countOptions] = sdk.count.mock.calls[0];
    const [body, options] = sdk.create.mock.calls[0];
    for (const key of ['model', 'input', 'instructions', 'text', 'reasoning', 'tools']) expect(countBody[key]).toEqual(body[key]);
    expect(countOptions.signal).toBe(options.signal);
    expect(countOptions.maxRetries).toBe(0);
    expect(body.input[0].content[1]).toEqual({ type: 'input_image', detail: 'high', image_url: 'data:image/png;base64,eA==' });
  });

  it.each([6001, -1, NaN, 1.5])('does not generate an image response after an invalid or over-budget count: %s', async count => {
    sdk.count.mockResolvedValue({ object: 'response.input_tokens', input_tokens: count });
    await expect(createModelGateway('test-key').extract({ ...input, mode: 'screenshot', image: { mimeType: 'image/png', base64: 'eA==' } }, signal())).rejects.toBeDefined();
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sdk.count).toHaveBeenCalledTimes(1);
  });

  it('fails closed without generation or retry when image counting fails', async () => {
    sdk.count.mockRejectedValue(new Error('provider unavailable'));
    await expect(createModelGateway('test-key').extract({ ...input, mode: 'screenshot', image: { mimeType: 'image/png', base64: 'eA==' } }, signal())).rejects.toMatchObject({ code: 'MODEL_TOKEN_COUNT_UNAVAILABLE' });
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sdk.count).toHaveBeenCalledTimes(1);
  });

  it('counts images again for GPT-5.4 including extraction, evidence and corrected text', async () => {
    sdk.count.mockResolvedValue({ object: 'response.input_tokens', input_tokens: 11000 });
    sdk.create.mockResolvedValue(response('gpt-5.4-2026-03-05', review));
    await createModelGateway('test-key').review({ ...input, mode: 'screenshot', image: { mimeType: 'image/png', base64: 'eA==' } }, extraction, [], signal());
    const data = JSON.parse(sdk.count.mock.calls[0][0].input[0].content[0].text);
    expect(data.original).toMatchObject({ text: '', userCorrectedScreenshotText: input.content });
    expect(data.extraction).toEqual(extraction);
    expect(sdk.count).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, {}, { input_tokens: -1, output_tokens: 1 }, { input_tokens: 1.5, output_tokens: 1 }])('does not invent usage when billing is missing or invalid: %j', async usage => {
    sdk.create.mockResolvedValue({ ...response(), usage });
    await expect(createModelGateway('test-key').extract(input, signal())).rejects.toMatchObject({ code: 'BILLING_UNKNOWN', usage: undefined });
  });

  it('preserves known billing on incomplete output', async () => {
    sdk.create.mockResolvedValue({ ...response(), status: 'incomplete' });
    await expect(createModelGateway('test-key').extract(input, signal())).rejects.toMatchObject({ code: 'MODEL_INCOMPLETE', usage: { costMicroUsd: 2100 } });
  });

  it('rejects structurally invalid JSON output with its known usage', async () => {
    sdk.create.mockResolvedValue(response('gpt-5.4-mini-2026-03-17', null));
    await expect(createModelGateway('test-key').extract(input, signal())).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID', usage: { costMicroUsd: 2100 } });
  });

  it.each(['{"transcript":', '', 'sensitive provider output '.repeat(1100)])('preserves known usage when output text cannot be parsed or exceeds its bound', async text => {
    sdk.create.mockResolvedValue({ ...response(), output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
    await expect(createModelGateway('test-key').extract(input, signal())).rejects.toMatchObject({
      code: 'MODEL_OUTPUT_INVALID', message: 'The AI analysis could not be completed.', usage: { costMicroUsd: 2100 },
    });
    expect(sdk.create).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, [{ type: 'message', content: null }]])('preserves known usage when the provider output envelope is malformed', async output => {
    sdk.create.mockResolvedValue({ ...response(), output });
    await expect(createModelGateway('test-key').extract(input, signal())).rejects.toMatchObject({
      code: 'MODEL_OUTPUT_INVALID', message: 'The AI analysis could not be completed.', usage: { costMicroUsd: 2100 },
    });
    expect(sdk.create).toHaveBeenCalledTimes(1);
  });

  it('preserves known usage on an explicit refusal, even if valid text is also present', async () => {
    sdk.create.mockResolvedValue({ ...response(), output: [{ type: 'message', content: [
      { type: 'output_text', text: JSON.stringify(modelExtraction) },
      { type: 'refusal', refusal: 'Sensitive provider refusal details' },
    ] }] });
    await expect(createModelGateway('test-key').extract(input, signal())).rejects.toMatchObject({
      code: 'MODEL_REFUSAL', message: 'The AI analysis could not be completed.', usage: { costMicroUsd: 2100 },
    });
    expect(sdk.create).toHaveBeenCalledTimes(1);
  });

  it('does not retry transport failures and omits sensitive error text', async () => {
    sdk.create.mockRejectedValue(new Error('secret input and provider request body'));
    await expect(createModelGateway('test-key').extract(input, signal())).rejects.toMatchObject({ code: 'BILLING_UNKNOWN', message: 'The AI analysis could not be completed.' });
    expect(sdk.create).toHaveBeenCalledTimes(1);
  });

  it('rejects unexpected models and usage outside the reserved envelope', async () => {
    const gateway = createModelGateway('test-key');
    sdk.create.mockResolvedValue(response('another-model'));
    await expect(gateway.extract(input, signal())).rejects.toMatchObject({ code: 'MODEL_CONFIGURATION_CHANGED', usage: undefined });
    sdk.create.mockResolvedValue({ ...response(), usage: { input_tokens: 6001, output_tokens: 100 } });
    await expect(gateway.extract(input, signal())).rejects.toMatchObject({ code: 'MODEL_USAGE_OUT_OF_BOUNDS' });
  });

  it('rejects free-form reviewer claims despite structurally valid JSON', async () => {
    sdk.create.mockResolvedValue(response('gpt-5.4-2026-03-05', { ...review, reason: 'This sender is verified safe by the police database.' }));
    await expect(createModelGateway('test-key').review(input, extraction, [], signal())).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID', usage: { costMicroUsd: 7000 } });
  });

  it('preserves known billing when a finding contradicts its clarification', async () => {
    sdk.create.mockResolvedValue(response('gpt-5.4-2026-03-05', { ...review, questionId: 'sharing_code' }));
    await expect(createModelGateway('test-key').review(input, extraction, [], signal())).rejects.toMatchObject({
      code: 'MODEL_DECISION_INVALID', usage: { costMicroUsd: 7000 },
    });
    expect(sdk.create).toHaveBeenCalledTimes(1);
  });

  it('rejects an extraction that suggests collecting an actual account code', async () => {
    sdk.create.mockResolvedValue(response('gpt-5.4-mini-2026-03-17', {
      ...modelExtraction, missingContext: ['The exact one-time code or message contents.'],
    }));
    await expect(createModelGateway('test-key').extract(input, signal())).rejects.toMatchObject({
      code: 'MODEL_OUTPUT_INVALID', usage: { costMicroUsd: 2100 },
    });
  });

  it('does not send a request when the round is already cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createModelGateway('test-key').extract(input, controller.signal)).rejects.toBeDefined();
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it('classifies a stage deadline without inventing usage or retrying', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    sdk.create.mockImplementation((_body, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('Sensitive timeout detail')), { once: true });
    }));
    const pending = createModelGateway('test-key').extract(input, signal());
    deadline.abort(new DOMException('Stage time elapsed', 'TimeoutError'));
    await expect(pending).rejects.toMatchObject({ code: 'MODEL_TIMEOUT', message: 'The AI analysis could not be completed.', usage: undefined });
    expect(sdk.create).toHaveBeenCalledTimes(1);
  });

  it('does not generate after image counting exhausts the same stage deadline', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    sdk.count.mockImplementation(async () => {
      deadline.abort(new DOMException('Stage time elapsed', 'TimeoutError'));
      return { object: 'response.input_tokens', input_tokens: 5800 };
    });
    await expect(createModelGateway('test-key').extract({ ...input, mode: 'screenshot', image: { mimeType: 'image/png', base64: 'eA==' } }, signal())).rejects.toBeDefined();
    expect(sdk.count).toHaveBeenCalledTimes(1);
    expect(sdk.create).not.toHaveBeenCalled();
  });
});

describe('conservative billing', () => {
  it('charges standard uncached input and rounds upward to micro dollars', () => {
    expect(usageCostMicroUsd('gpt-5.4-mini-2026-03-17', 2000, 600)).toBe(4200);
    expect(usageCostMicroUsd('gpt-5.4-2026-03-05', 4000, 1000)).toBe(25000);
    expect(usageCostMicroUsd('gpt-5.4-mini-2026-03-17', 1, 0)).toBe(1);
  });
  it('fits one maximum extraction and two maximum reviews inside the whole-check reservation', () => {
    const extraction = MODEL_LIMITS['gpt-5.4-mini-2026-03-17'];
    const review = MODEL_LIMITS['gpt-5.4-2026-03-05'];
    const extractCost = usageCostMicroUsd('gpt-5.4-mini-2026-03-17', extraction.inputTokens, extraction.outputTokens);
    const reviewCost = usageCostMicroUsd('gpt-5.4-2026-03-05', review.inputTokens, review.outputTokens);
    expect(extractCost).toBe(8100);
    expect(reviewCost).toBe(60000);
    expect(extractCost + 2 * reviewCost).toBe(128100);
    expect(extractCost + 2 * reviewCost).toBeLessThanOrEqual(RESERVATION_MICRO_USD);
  });
  it('rejects non-finite or unsafe token counts', () => {
    expect(() => usageCostMicroUsd('gpt-5.4-2026-03-05', Infinity, 1)).toThrow();
    expect(() => usageCostMicroUsd('gpt-5.4-2026-03-05', 1, Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});
