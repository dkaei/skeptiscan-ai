import { describe, expect, it, vi } from 'vitest';
import { QUESTIONS, type CheckInput, type Evidence, type Extraction } from '../shared/contracts';
import { runAnalysis, reviewClarification, type AnalysisDependencies } from '../server/analysis';
import { ModelGatewayError } from '../server/openai';
import { renderDecision, type ReviewDecision } from '../server/review-policy';

const id = '48809966-bf86-43b3-aa6b-bfa4976d0c1a';
const input = (content: string): CheckInput => ({ mode: 'message', content, context: '', senderEmail: '', senderPhone: '', externalLookup: false });
const extracted = (overrides: Partial<Extraction> = {}): Extraction => ({ transcript: '', claimedOrganisation: null, urls: [], phoneNumbers: [], requestedActions: [], unreadableDetails: [], missingContext: [], ...overrides });
const usage = { model: 'gpt-5.4-mini-2026-03-17' as const, inputTokens: 100, outputTokens: 20, costMicroUsd: 165 };
const decision = (finding: ReviewDecision['finding'], quotes: string[] = [], questionId: ReviewDecision['questionId'] = null): ReviewDecision => ({ finding, quotes, questionId, evidenceIds: [] });
const finding = (kind: Evidence['kind'], state: Evidence['state']): Evidence => ({ id: 'check-1', kind, state, title: 'Offline fixture', detail: 'Synthetic test evidence.', checkedAt: '2026-09-27T00:00:00.000Z' });

function harness(data: CheckInput, value = extracted(), reviewDecision = decision('identity_unknown'), evidence: Evidence[] = []) {
  const models = {
    extract: vi.fn().mockResolvedValue({ value, usage }),
    review: vi.fn().mockResolvedValue({ value: renderDecision(reviewDecision, data, evidence), usage: { ...usage, model: 'gpt-5.4-2026-03-05' } }),
  };
  const deps: AnalysisDependencies = {
    models, collectEvidence: vi.fn().mockResolvedValue(evidence), beforeCall: vi.fn().mockResolvedValue(undefined),
    afterCall: vi.fn().mockResolvedValue(undefined), signal: new AbortController().signal,
  };
  return { deps, models };
}

describe('completed assessment limits follow the finding, not a generic missing-context warning', () => {
  it.each([
    ['payment_request', 'Transfer S$70 for this invoice.', 'recipient and purpose', 'Confirm the payment request'],
    ['own_login', 'I enter the code only in my own app.', 'app and sign-in request', 'Check through a trusted route'],
    ['remote_access', 'Install this app so I can control your phone.', 'software and the person requesting access', 'Pause the installation'],
    ['collection_code', 'Show your collection code when collecting your parcel.', 'collection arrangement and recipient', 'Check through a trusted route'],
  ] as const)('keeps the %s action while identifying its actual verification limit', async (type, text, limit, title) => {
    const data = input(text);
    // An extractor's unneeded question does not make a clear action unresolved.
    const h = harness(data, extracted({ missingContext: [QUESTIONS.initiated_request.text] }), decision(type, [text]));
    const result = (await runAnalysis(id, data, h.deps)).result;
    expect(result).toMatchObject({ status: 'complete', title, question: null });
    expect(result.uncertainty).toContain(limit);
    expect(result.uncertainty).toContain('have not been verified');
    expect(result.uncertainty).not.toMatch(/missing|unresolved|Your answer/);
    expect(result.recovery).toBeUndefined(); expect(result.notice).toBeUndefined();
  });

  it.each([
    ['information_only', 'Our event begins at noon.', 'details supplied'],
    ['quoted_example', 'Training example: someone might ask you to send a login code.', 'example as described'],
  ] as const)('bounds the %s interpretation without inventing a current sensitive request', (type, text, scope) => {
    const reviewed = renderDecision(decision(type, [text]), input(text), []);
    expect(reviewed.actionId).toBe('check_independently');
    expect(reviewed.uncertainty).toContain(scope);
    expect(reviewed.uncertainty).not.toMatch(/safe|genuine|fraud|missing context/i);
  });

  it('keeps domain-match limitations alongside screenshot transcription uncertainty', () => {
    const data: CheckInput = { ...input(''), mode: 'screenshot', image: { mimeType: 'image/png', base64: 'eA==' } };
    const review = renderDecision(decision('payment_request', ['Transfer S$70']), data, [finding('domain', 'matched')]);
    expect(review.actionId).toBe('verify_payment');
    expect(review.reason).toContain('does not authorise a separate payment');
    expect(review.uncertainty).toContain('does not authenticate');
    expect(review.uncertainty).toContain('machine-transcribed');
  });

  it('does not let screenshot wording turn a negative threat lookup into reassurance', () => {
    const data: CheckInput = { ...input(''), mode: 'screenshot', image: { mimeType: 'image/png', base64: 'eA==' } };
    const review = renderDecision(decision('link_only'), data, [finding('reputation', 'no_match')]);
    expect(review.uncertainty).toContain('does not establish that a link or request is safe');
    expect(review.uncertainty).toContain('machine-transcribed');
  });

  it('distinguishes an answerable question from uncertainty remaining after Not sure', async () => {
    const data = input('Someone asked for a code.');
    const extraction = extracted({ missingContext: [QUESTIONS.sharing_code.text] });
    const h = harness(data, extraction, decision('unclear_request', [], 'sharing_code'));
    const question = (await runAnalysis(id, data, h.deps)).result;
    expect(question.status).toBe('needs_context');
    expect(question.uncertainty).toContain('Your answer may change');
    expect(question.question?.id).toBe('sharing_code');
    h.models.review.mockResolvedValue({ value: renderDecision(decision('unclear_request'), data, []), usage });
    const final = (await reviewClarification(id, data, extraction, [], 'sharing_code', 'unsure', h.deps)).result;
    expect(final).toMatchObject({ status: 'complete', question: null, uncertainty: 'The requested action is still unclear.' });
    expect(final.nextStep).toContain('contact route you already trust');
    expect(final.recovery).toBeUndefined();
  });
});

describe('incomplete checks offer recovery suited to the actual failure', () => {
  it('does not offer a futile AI retry when only available checks can run', async () => {
    const data = input('https://example.test/');
    const h = harness(data, extracted(), decision('link_only'), [finding('domain', 'no_match')]);
    h.deps.models = null;
    const result = (await runAnalysis(id, data, h.deps)).result;
    expect(result).toMatchObject({ status: 'partial', aiUsed: false, recovery: 'none', reason: 'AI analysis is not connected.' });
    expect(result.uncertainty).toContain('do not assess the whole request');
    expect(h.models.extract).not.toHaveBeenCalled(); expect(result.notice).toBeUndefined();
  });

  it('asks for a clearer screenshot after unreadable consequential details, without another call', async () => {
    const data: CheckInput = { ...input(''), mode: 'screenshot', image: { mimeType: 'image/png', base64: 'eA==' } };
    const h = harness(data, extracted({ transcript: 'Pay [unclear amount]', unreadableDetails: ['The amount is obscured.'] }));
    const result = (await runAnalysis(id, data, h.deps)).result;
    expect(result).toMatchObject({ status: 'partial', recovery: 'clearer_image', evidence: [], question: null });
    expect(result.reason).toContain('unclear or inconsistent');
    expect(result.uncertainty).toContain('could change the next step');
    expect(h.models.review).not.toHaveBeenCalled(); expect(h.deps.collectEvidence).not.toHaveBeenCalled();
  });

  it('asks for an edited excerpt after a certified no-generation size rejection', async () => {
    const data = input('Synthetic long excerpt'); const h = harness(data);
    h.models.extract.mockRejectedValue(new ModelGatewayError('MODEL_INPUT_TOO_LARGE', undefined, { model: usage.model }));
    const result = (await runAnalysis(id, data, h.deps)).result;
    expect(result).toMatchObject({ status: 'partial', aiUsed: false, recovery: 'edit_input' });
    expect(result.reason).toContain('shorter excerpt');
    expect(result.uncertainty).toContain('has not been assessed');
    expect(h.models.review).not.toHaveBeenCalled();
  });

  it.each(['MODEL_TIMEOUT', 'MODEL_PROVIDER_UNAVAILABLE', 'MODEL_CONNECTION_FAILED'])('offers a manual new attempt for %s without an automatic retry', async code => {
    const data = input('Please share your login code.'); const h = harness(data);
    h.models.extract.mockRejectedValue(new ModelGatewayError(code));
    const result = (await runAnalysis(id, data, h.deps)).result;
    expect(result).toMatchObject({ status: 'partial', recovery: 'retry', question: null });
    expect(result.uncertainty).toContain('No completed assessment');
    expect(result.nextStep).toContain('contact route you already trust');
    expect(h.models.extract).toHaveBeenCalledTimes(1); expect(h.models.review).not.toHaveBeenCalled();
  });

  it('does not invite an immediate repeated attempt when the provider rate limit is reached', async () => {
    const data = input('Please check this.'); const h = harness(data);
    h.models.extract.mockRejectedValue(new ModelGatewayError('MODEL_RATE_LIMITED'));
    const result = (await runAnalysis(id, data, h.deps)).result;
    expect(result).toMatchObject({ status: 'partial', recovery: 'none', reason: 'The AI service is busy. Try again later.' });
    expect(h.models.extract).toHaveBeenCalledTimes(1); expect(h.models.review).not.toHaveBeenCalled();
  });

  it('does not suggest repeated paid attempts for a provider authentication failure', async () => {
    const data = input('Please check this.'); const h = harness(data);
    h.models.extract.mockRejectedValue(new ModelGatewayError('MODEL_AUTHENTICATION_FAILED'));
    const result = (await runAnalysis(id, data, h.deps)).result;
    expect(result.recovery).toBe('none');
    expect(result.reason).toContain('unavailable');
    expect(result.reason).not.toMatch(/key|provider|authentication/);
  });

  it('preserves completed external evidence after reviewer timeout without calling it local-only', async () => {
    const data = { ...input('See https://example.test/'), externalLookup: true };
    const evidence = [finding('reputation', 'matched')];
    const h = harness(data, extracted(), decision('link_only'), evidence);
    h.models.review.mockRejectedValue(new ModelGatewayError('MODEL_TIMEOUT'));
    const result = (await runAnalysis(id, data, h.deps)).result;
    expect(result).toMatchObject({ status: 'partial', recovery: 'retry', evidence });
    expect(result.reason).toContain('too long');
    expect([result.reason, result.uncertainty, result.notice].join(' ')).not.toMatch(/local.only|Only available local/i);
    expect(h.models.review).toHaveBeenCalledTimes(1);
  });

  it('keeps earlier findings subordinate to a failed final review', async () => {
    const data = input('Please check this request.'); const h = harness(data);
    h.models.review.mockRejectedValue(new ModelGatewayError('MODEL_OUTPUT_INVALID', usage));
    const result = (await runAnalysis(id, data, h.deps)).result;
    expect(result).toMatchObject({ status: 'partial', recovery: 'retry' });
    expect(result.reason).toContain('final AI review');
    expect(result.uncertainty).toContain('do not replace a completed assessment');
    expect(result.notice).toBeUndefined();
  });

  it('returns to editing after clarification failure instead of resubmitting the spent continuation', async () => {
    const data = input('Someone asked for a code.'); const h = harness(data);
    h.models.review.mockRejectedValue(new ModelGatewayError('MODEL_TIMEOUT'));
    const result = (await reviewClarification(id, data, extracted(), [], 'sharing_code', 'unsure', h.deps)).result;
    expect(result).toMatchObject({ status: 'partial', recovery: 'edit_input', question: null });
    expect(result.reason).toContain('answer could not be assessed');
    expect(result.uncertainty).toContain('question remains unresolved');
    expect(result.continuation).toBeUndefined();
    expect(h.models.review).toHaveBeenCalledTimes(1); expect(h.models.extract).not.toHaveBeenCalled();
  });
});
