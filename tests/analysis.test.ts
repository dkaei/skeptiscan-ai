import { describe, expect, it, vi } from 'vitest';
import { runAnalysis, reviewClarification, type AnalysisDependencies } from '../server/analysis';
import { ModelGatewayError } from '../server/openai';
import { renderDecision, FINDING_REASONS } from '../server/review-policy';
import type { CheckInput, Evidence, Extraction, Review } from '../shared/contracts';
import type { ModelGateway, ModelUsage } from '../server/types';

const requestId = '79072d73-e78c-4d81-881e-c477de550b90';
const input: CheckInput = { mode: 'message', content: 'Please tell me your login code.', context: '', senderEmail: '', senderPhone: '', externalLookup: false };
const extraction: Extraction = { transcript: '', claimedOrganisation: null, urls: [], phoneNumbers: [], requestedActions: [{ action: 'share a code', quote: 'tell me your login code' }], unreadableDetails: [], missingContext: [] };
const evidence: Evidence[] = [{ id: 'guidance-1', kind: 'guidance', state: 'observation', title: 'Account codes', detail: 'Keep account codes private.', checkedAt: '2026-09-26T00:00:00.000Z' }];
const review = renderDecision({ finding: 'credential_disclosure', evidenceIds: ['guidance-1'], quotes: ['tell me your login code'], questionId: null }, input, evidence);
const unclearReview = renderDecision({ finding: 'unclear_request', evidenceIds: [], quotes: [], questionId: 'sharing_code' }, input, evidence);
const unclearExtraction = { ...extraction, missingContext: ['Are they asking you to tell someone a login or account code?'] };
const usage = (model: ModelUsage['model']): ModelUsage => ({ model, inputTokens: 100, outputTokens: 100, costMicroUsd: model === 'gpt-5.4-mini-2026-03-17' ? 525 : 1750 });
function setup(extracted = extraction, reviewed = review) {
  const models: ModelGateway = {
    extract: vi.fn().mockResolvedValue({ value: structuredClone(extracted), usage: usage('gpt-5.4-mini-2026-03-17') }),
    review: vi.fn().mockResolvedValue({ value: structuredClone(reviewed), usage: usage('gpt-5.4-2026-03-05') }),
  };
  const deps: AnalysisDependencies = { models, collectEvidence: vi.fn().mockResolvedValue(evidence), beforeCall: vi.fn().mockResolvedValue(undefined), afterCall: vi.fn().mockResolvedValue(undefined), signal: new AbortController().signal };
  return { deps, models };
}

describe('bounded two-model analysis', () => {
  it('runs extraction, evidence and review in order with both usages accounted', async () => {
    const { deps, models } = setup();
    const output = await runAnalysis(requestId, input, deps);
    expect(output.result).toMatchObject({ status: 'complete', aiUsed: true, title: 'Keep account codes private', reason: FINDING_REASONS.credential_disclosure });
    expect(deps.beforeCall).toHaveBeenNthCalledWith(1, 'extract');
    expect(deps.beforeCall).toHaveBeenNthCalledWith(2, 'review');
    expect(deps.afterCall).toHaveBeenNthCalledWith(1, usage('gpt-5.4-mini-2026-03-17'));
    expect(deps.afterCall).toHaveBeenNthCalledWith(2, usage('gpt-5.4-2026-03-05'));
    expect(models.review).toHaveBeenCalledWith(input, extraction, evidence, deps.signal);
  });

  it('shows local partial findings without fabricating an AI result when no models are connected', async () => {
    const { deps, models } = setup(); deps.models = null;
    const output = await runAnalysis(requestId, input, deps);
    expect(output.result).toMatchObject({ status: 'partial', aiUsed: false, extraction: null, evidence });
    expect(models.extract).not.toHaveBeenCalled();
    expect(deps.beforeCall).not.toHaveBeenCalled();
  });

  it('never uses a model-created text transcript as evidence', async () => {
    const { deps, models } = setup({ ...extraction, transcript: 'https://made-up.example', urls: ['https://made-up.example'] });
    const output = await runAnalysis(requestId, input, deps);
    expect(output.result.status).toBe('partial');
    expect(deps.collectEvidence).toHaveBeenCalledWith(input, expect.objectContaining({ urls: [], transcript: '', requestedActions: [] }));
    expect(models.review).not.toHaveBeenCalled();
    expect(deps.afterCall).toHaveBeenCalledTimes(1);
  });

  it('rejects an invented URL and a trusted-looking prefix inside a different hostname', async () => {
    const { deps } = setup({ ...extraction, requestedActions: [], urls: ['https://agency.gov.sg'] });
    const output = await runAnalysis(requestId, { ...input, content: 'Visit https://agency.gov.sg.attacker.example now' }, deps);
    expect(output.result.status).toBe('partial');
    expect(deps.collectEvidence).toHaveBeenCalledWith(expect.objectContaining({ externalLookup: false }), expect.objectContaining({ urls: ['https://agency.gov.sg.attacker.example'] }));
  });

  it('allows a literal URL followed by sentence punctuation', async () => {
    const { deps } = setup({ ...extraction, requestedActions: [], urls: ['https://agency.gov.sg'] }, renderDecision({ finding: 'link_only', evidenceIds: [], quotes: [], questionId: null }, input, evidence));
    const output = await runAnalysis(requestId, { ...input, content: 'Visit https://agency.gov.sg.' }, deps);
    expect(output.result.status).toBe('complete');
    expect(deps.collectEvidence).toHaveBeenCalled();
  });

  it.each([
    { ...review, evidenceIds: ['invented-database'] },
    { ...review, quotes: ['send money to this person'] },
    { ...review, reason: 'The number is on a police blacklist.' },
    { ...review, questionId: 'sharing_code' },
    { ...review, reason: FINDING_REASONS.payment_request },
    { ...review, quotes: [] },
  ] as Review[])('withholds ungrounded or inconsistent reviewer output %#', async invalid => {
    const { deps } = setup(extraction, invalid);
    const output = await runAnalysis(requestId, input, deps);
    expect(output.result.status).toBe('partial');
    expect(output.result.reason).not.toBe(invalid.reason);
    expect(deps.afterCall).toHaveBeenCalledTimes(2);
  });

  it('does not turn an empty threat lookup into reassurance', async () => {
    const reviewed = renderDecision({ finding: 'link_only', evidenceIds: ['url-check'], quotes: [], questionId: null }, input, []);
    const { deps } = setup(extraction, reviewed);
    deps.collectEvidence = vi.fn().mockResolvedValue([{ ...evidence[0], id: 'url-check', kind: 'reputation', state: 'no_match' }]);
    const output = await runAnalysis(requestId, input, deps);
    expect(output.result.status).toBe('complete');
    expect(output.result.uncertainty).toBe('No threat-list match does not establish that a link or request is safe.');
    expect(output.result.evidence[0].state).toBe('no_match');
  });

  it('preserves evidence with partial status when review fails and never retries', async () => {
    const { deps, models } = setup();
    vi.mocked(models.review).mockRejectedValue(new ModelGatewayError('BILLING_UNKNOWN'));
    const output = await runAnalysis(requestId, input, deps);
    expect(output.result).toMatchObject({ status: 'partial', evidence, question: null });
    expect(models.review).toHaveBeenCalledTimes(1);
    expect(deps.afterCall).toHaveBeenCalledTimes(1); // Caller retains the unknown second reservation.
  });

  it('accounts known incomplete-response usage and stops on accounting failure', async () => {
    const { deps, models } = setup();
    vi.mocked(models.extract).mockRejectedValue(new ModelGatewayError('MODEL_INCOMPLETE', usage('gpt-5.4-mini-2026-03-17')));
    expect((await runAnalysis(requestId, input, deps)).result.status).toBe('partial');
    expect(deps.afterCall).toHaveBeenCalledWith(usage('gpt-5.4-mini-2026-03-17'));
    expect(models.review).not.toHaveBeenCalled();
    vi.mocked(models.extract).mockResolvedValue({ value: extraction, usage: usage('gpt-5.4-mini-2026-03-17') });
    vi.mocked(deps.afterCall).mockRejectedValue(new Error('accounting unavailable'));
    expect((await runAnalysis(requestId, input, deps)).result.status).toBe('partial');
    expect(models.review).not.toHaveBeenCalled();
  });

  it('returns one approved question for root to sign as a continuation', async () => {
    const { deps } = setup(unclearExtraction, unclearReview);
    const output = await runAnalysis(requestId, input, deps);
    expect(output.result).toMatchObject({ status: 'needs_context', question: { id: 'sharing_code', options: ['Yes', 'No', 'Not sure'] } });
    expect(output.result.continuation).toBeUndefined();
  });
});

describe('screenshots with injected models', () => {
  const imageInput: CheckInput = { ...input, mode: 'screenshot', image: { mimeType: 'image/png', base64: 'eA==' } };
  it('withholds entities read from an image when its transcript is missing', async () => {
    const { deps, models } = setup({ ...extraction, transcript: '', urls: ['www.parcel.example'], requestedActions: [] });
    const output = await runAnalysis(requestId, { ...imageInput, content: '' }, deps);
    expect(output.result).toMatchObject({ status: 'partial', extraction: null });
    expect(deps.collectEvidence).not.toHaveBeenCalled();
    expect(models.review).not.toHaveBeenCalled();
    expect(deps.afterCall).toHaveBeenCalledTimes(1);
  });
  it('passes the same original and user corrected text to both models, labels uncertainty', async () => {
    const { deps, models } = setup({ ...extraction, transcript: input.content });
    const output = await runAnalysis(requestId, imageInput, deps);
    expect(models.extract).toHaveBeenCalledWith(imageInput, deps.signal);
    expect(vi.mocked(models.review).mock.calls[0][0]).toBe(imageInput);
    expect(output.result.uncertainty).toContain('Screenshot text is machine-transcribed and may contain mistakes.');
    expect(output.result.uncertainty).toContain('identity and intentions have not been verified');
  });
  it.each([['phone digits unclear'], ['corrected text conflicts with the image']])('does not proceed with consequential unreadable or conflicting details: %s', async detail => {
    const { deps, models } = setup({ ...extraction, transcript: input.content, unreadableDetails: [detail] });
    expect((await runAnalysis(requestId, imageInput, deps)).result.status).toBe('partial');
    expect(models.review).not.toHaveBeenCalled();
    expect(deps.collectEvidence).not.toHaveBeenCalled();
  });
});

describe('one final clarification review', () => {
  it('uses only one reviewer call with the answer, without re-extraction or evidence lookup', async () => {
    const { deps, models } = setup();
    const output = await reviewClarification(requestId, input, extraction, evidence, 'sharing_code', 'yes', deps);
    expect(output.result.status).toBe('complete');
    expect(models.extract).not.toHaveBeenCalled();
    expect(deps.collectEvidence).not.toHaveBeenCalled();
    expect(models.review).toHaveBeenCalledTimes(1);
    expect(models.review).toHaveBeenCalledWith(input, extraction, evidence, deps.signal, { questionId: 'sharing_code', answer: 'yes' });
    expect(deps.beforeCall).toHaveBeenCalledWith('review');
  });
  it('refuses a second question or a root-denied call budget', async () => {
    const { deps, models } = setup(unclearExtraction, unclearReview);
    expect((await reviewClarification(requestId, input, extraction, evidence, 'sharing_code', 'unsure', deps)).result).toMatchObject({ status: 'partial', question: null });
    vi.mocked(models.review).mockClear();
    vi.mocked(deps.beforeCall).mockRejectedValue(new Error('call budget spent'));
    expect((await reviewClarification(requestId, input, extraction, evidence, 'sharing_code', 'yes', deps)).result.status).toBe('partial');
    expect(models.review).not.toHaveBeenCalled();
  });
});
