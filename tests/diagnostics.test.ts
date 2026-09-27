import { describe, expect, it, vi } from 'vitest';
import { diagnosticCode, diagnosticFor, sanitizeDiagnostic, type CheckDiagnostic } from '../server/diagnostics';
import { ServiceError } from '../server/types';
import { runAnalysis, type AnalysisDependencies } from '../server/analysis';
import { ModelGatewayError } from '../server/openai';
import type { CheckInput } from '../shared/contracts';
import { RATIONALE_FAILURE_CODES } from '../server/context-rationale';

const requestId = '1f210f38-617b-42e5-8517-1b63e0819787';
const input: CheckInput = { mode: 'message', content: 'Private synthetic message', context: '', senderPhone: '', senderEmail: '', externalLookup: false };
const usage = { model: 'gpt-5.4-mini-2026-03-17' as const, inputTokens: 100, outputTokens: 20, costMicroUsd: 200 };
function failing(error: unknown): AnalysisDependencies {
  return {
    models: { extract: vi.fn().mockRejectedValue(error), review: vi.fn() },
    beforeCall: vi.fn().mockResolvedValue(undefined), afterCall: vi.fn().mockResolvedValue(undefined),
    collectEvidence: vi.fn().mockResolvedValue([]), reportFailure: vi.fn(), signal: new AbortController().signal,
  };
}

describe('bounded diagnostic privacy and no-dispatch settlement', () => {
  it.each([...RATIONALE_FAILURE_CODES, 'quote_projection_mismatch'])('preserves the finite rationale branch %s without raw output', code => {
    const error = Object.assign(new ModelGatewayError(code), { body: 'private rationale and input', metadata: 'private' });
    expect(diagnosticFor(requestId, 'review', error)).toEqual({ requestId, stage: 'review', code });
    expect(diagnosticFor(requestId, 'review', new Error(code + ': private rationale')).code).toBe('stage_failed');
  });
  it.each([
    new Error('Private input, provider body, email and secret'),
    new ServiceError('private_dynamic_code', 'private body', 503),
    { message: 'MODEL_TIMEOUT', body: 'private body' },
  ])('drops unrecognized error content %#', error => {
    expect(diagnosticFor(requestId, 'extraction', error)).toEqual({ requestId, stage: 'extraction', code: 'stage_failed' });
  });

  it('revalidates runtime diagnostic fields before storage', () => {
    const bad = { requestId: 'private@example.test', stage: 'private body', code: 'secret\nMODEL_TIMEOUT', details: input } as unknown as CheckDiagnostic;
    expect(sanitizeDiagnostic(bad)).toEqual({ requestId: 'invalid', stage: 'settlement', code: 'stage_failed' });
    expect(diagnosticCode(bad)).toBe('settlement:stage_failed');
  });

  it('retains only a recognized code even if the provider attaches private fields', () => {
    const error = Object.assign(new ModelGatewayError('MODEL_RATE_LIMITED'), { body: input, headers: { authorization: 'private credential' } });
    expect(diagnosticFor(requestId, 'review', error)).toEqual({ requestId, stage: 'review', code: 'MODEL_RATE_LIMITED' });
  });

  it('classifies an aborted unknown failure without retaining the abort reason', () => {
    const signal = AbortSignal.abort('private caller reason');
    expect(diagnosticFor(requestId, 'review', new Error('private'), signal).code).toBe('analysis_deadline');
  });

  it('settles a certified pre-generation rejection as a zero-cost admitted attempt', async () => {
    const error = new ModelGatewayError('MODEL_INPUT_TOO_LARGE', undefined, { model: usage.model });
    const deps = failing(error);
    expect((await runAnalysis(requestId, input, deps)).result).toMatchObject({ status: 'partial', aiUsed: false });
    expect(deps.afterCall).toHaveBeenCalledExactlyOnceWith({ model: usage.model, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 });
    expect(deps.models!.review).not.toHaveBeenCalled();
    expect(deps.reportFailure).toHaveBeenCalledWith({ requestId, stage: 'extraction', code: 'MODEL_INPUT_TOO_LARGE' });
  });

  it('does not assume a dispatched rate-limited request has zero cost', async () => {
    const deps = failing(new ModelGatewayError('MODEL_RATE_LIMITED'));
    expect((await runAnalysis(requestId, input, deps)).result.status).toBe('partial');
    expect(deps.afterCall).not.toHaveBeenCalled();
    expect(deps.models!.review).not.toHaveBeenCalled();
  });

  it('records known usage before rejecting incomplete model output', async () => {
    const deps = failing(new ModelGatewayError('MODEL_INCOMPLETE', usage));
    await runAnalysis(requestId, input, deps);
    expect(deps.afterCall).toHaveBeenCalledExactlyOnceWith(usage);
  });

  it('does not replace accounting failure with an input or provider diagnosis', async () => {
    const deps = failing(new ModelGatewayError('MODEL_INPUT_TOO_LARGE', undefined, { model: usage.model }));
    vi.mocked(deps.afterCall).mockRejectedValue(new Error('database body contains private input'));
    await runAnalysis(requestId, input, deps);
    expect(deps.reportFailure).toHaveBeenCalledWith({ requestId, stage: 'extraction', code: 'usage_accounting' });
    expect(deps.collectEvidence).not.toHaveBeenCalled();
  });

  it('records unreadable screenshot separately from provider failures', async () => {
    const deps = failing(undefined);
    vi.mocked(deps.models!.extract).mockResolvedValue({ value: { transcript: '', claimedOrganisation: null, urls: [], phoneNumbers: [], requestedActions: [], unreadableDetails: ['too blurred'], missingContext: [] }, usage });
    const result = await runAnalysis(requestId, { ...input, mode: 'screenshot', image: { mimeType: 'image/png', base64: 'eA==' } }, deps);
    expect(result.result.status).toBe('partial');
    expect(deps.reportFailure).toHaveBeenCalledWith({ requestId, stage: 'extraction_validation', code: 'unreadable_image' });
    expect(deps.models!.review).not.toHaveBeenCalled();
  });

  it('returns an honest partial even when logging is unavailable', async () => {
    const deps = failing(new ModelGatewayError('MODEL_PROVIDER_UNAVAILABLE'));
    vi.mocked(deps.reportFailure!).mockImplementation(() => { throw new Error('log transport failed'); });
    expect((await runAnalysis(requestId, input, deps)).result.status).toBe('partial');
  });
});
