import { describe, expect, it, vi } from 'vitest';
import { runAnalysis, type AnalysisDependencies } from '../server/analysis';
import { hasQuestionBasis } from '../server/clarification-policy';
import { renderDecision, type ReviewDecision } from '../server/review-policy';
import type { CheckInput, Extraction, Review } from '../shared/contracts';

const requestId = '310619c7-4fc6-4908-97ef-57e6e07c87e7';
const input = (content: string, context = ''): CheckInput => ({ mode: 'message', content, context, senderEmail: '', senderPhone: '', externalLookup: false });
const extraction = (text: string): Extraction => ({ transcript: '', claimedOrganisation: null, urls: [], phoneNumbers: [],
  requestedActions: [{ action: 'request', quote: text, source: 'content' }], unreadableDetails: [], missingContext: [] });
function harness(data: CheckInput, extracted: Extraction, decision: ReviewDecision) {
  const usage = { model: 'gpt-5.4-mini-2026-03-17' as const, inputTokens: 100, outputTokens: 50, costMicroUsd: 300 };
  const deps: AnalysisDependencies = {
    models: { extract: vi.fn().mockResolvedValue({ value: extracted, usage }), review: vi.fn().mockImplementation(async (_input, validated) => ({ value: renderDecision(decision, data, [], validated), usage: { ...usage, model: 'gpt-5.4-2026-03-05' } })) },
    beforeCall: vi.fn(), afterCall: vi.fn(), collectEvidence: vi.fn().mockResolvedValue([]), signal: new AbortController().signal, reportFailure: vi.fn(),
  };
  return deps;
}
const payment = (quote: string): ReviewDecision => ({ finding: 'payment_request', questionId: null, evidenceIds: [],
  rationale: { relation: 'action_risk', anchors: [{ source: 'content', quote }], risks: [{ kind: 'payment', anchorIndex: 0 }] },
});

describe('completion fixes preserve independent validation (offline)', () => {
  it('drops an unsupported optional organisation without losing a grounded payment warning', async () => {
    const data = input('Transfer S$75 to this personal account.');
    const deps = harness(data, { ...extraction(data.content), claimedOrganisation: 'A bank never named in the input' }, payment(data.content));
    const result = await runAnalysis(requestId, data, deps);
    expect(result.result).toMatchObject({ status: 'complete', title: 'Confirm the payment request', extraction: { claimedOrganisation: null } });
    expect(deps.models!.review).toHaveBeenCalledTimes(1);
    expect(deps.afterCall).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain('A bank never named');
  });

  it('retains a literally supplied organisation while still treating it as a claim', async () => {
    const data = input('Example Bank: Transfer S$75 to this personal account.');
    const deps = harness(data, { ...extraction(data.content), claimedOrganisation: 'Example Bank' }, payment(data.content));
    const result = await runAnalysis(requestId, data, deps);
    expect(result.result.extraction?.claimedOrganisation).toBe('Example Bank');
    expect(result.result.uncertainty).toContain('not been verified');
  });

  it('still rejects invented actionable entities before review even when optional metadata is also wrong', async () => {
    const data = input('Transfer S$75 to this personal account.');
    const deps = harness(data, { ...extraction(data.content), claimedOrganisation: 'Invented bank', urls: ['https://invented.example/'] }, payment(data.content));
    expect((await runAnalysis(requestId, data, deps)).result.status).toBe('partial');
    expect(deps.models!.review).not.toHaveBeenCalled();
    expect(deps.afterCall).toHaveBeenCalledTimes(1);
  });

  it('allows a grounded purpose question even when the extractor missed that context dimension', async () => {
    const data = input('Tell me the six digits from the message on your phone. I do not know what they are for.');
    const decision: ReviewDecision = { finding: 'unclear_request', questionId: 'sharing_code', evidenceIds: [],
      rationale: { relation: 'unclear_context', anchors: [{ source: 'content', quote: data.content }], risks: [] } };
    const deps = harness(data, extraction(data.content), decision);
    const result = await runAnalysis(requestId, data, deps);
    expect(result.result).toMatchObject({ status: 'needs_context', question: { id: 'sharing_code', options: ['Yes', 'No', 'Not sure'] } });
    expect(result.result.question?.text).not.toMatch(/what is.*code|enter.*code/i);
    expect(deps.models!.review).toHaveBeenCalledTimes(1);
  });

  it('does not let extractor suggestions substitute for a live grounded question basis', () => {
    const data = input('Meet at noon.');
    const extracted = { ...extraction(data.content), missingContext: ['Are they asking you to tell someone a login or account code?'] };
    const review: Review = { finding: 'unclear_request', actionId: 'need_context', reason: '', uncertainty: '', evidenceIds: [], quotes: [], questionId: 'sharing_code',
      rationale: { relation: 'unclear_context', anchors: [{ source: 'content', quote: data.content }], risks: [] } };
    expect(hasQuestionBasis(review, data, extracted)).toBe(false);
    expect(hasQuestionBasis({ ...review, rationale: { ...review.rationale!, anchors: [{ source: 'context', quote: 'Unknown code purpose' }] } }, data, extracted)).toBe(false);
    expect(hasQuestionBasis({ ...review, rationale: null }, data, extracted)).toBe(false);
  });

  it('does not ask a question instead of acting on an explicitly classified sensitive request', () => {
    const data = input('Tell me your login code.');
    const review: Review = { finding: 'unclear_request', actionId: 'need_context', reason: '', uncertainty: '', evidenceIds: [], quotes: [], questionId: 'sharing_code',
      rationale: { relation: 'unclear_context', anchors: [{ source: 'content', quote: data.content }], risks: [{ kind: 'account_access', anchorIndex: 0 }] } };
    expect(hasQuestionBasis(review, data, extraction(data.content))).toBe(false);
  });

  it.each(['The payload is a small JSON object.', 'The payphone is beside the library.'])('does not infer a payment topic from unrelated word prefixes: %s', content => {
    const data = input(content);
    const review: Review = { finding: 'unclear_request', actionId: 'need_context', reason: '', uncertainty: '', evidenceIds: [], quotes: [], questionId: 'payment_expected',
      rationale: { relation: 'unclear_context', anchors: [{ source: 'content', quote: content }], risks: [] } };
    expect(hasQuestionBasis(review, data, extraction(content))).toBe(false);
  });

  it('labels an unresolved consequential disagreement as abstention rather than a completed assessment', async () => {
    const data = input('Tell me your login code.', 'They said not to share any code.');
    const decision: ReviewDecision = { finding: 'unclear_request', questionId: null, evidenceIds: [],
      rationale: { relation: 'conflicting_accounts', anchors: [{ source: 'content', quote: data.content }, { source: 'context', quote: data.context }], risks: [] } };
    const result = await runAnalysis(requestId, data, harness(data, extraction(data.content), decision));
    expect(result.result).toMatchObject({ status: 'partial', title: 'Pause before acting', question: null, recovery: 'edit_input', aiUsed: true });
    expect(result.result.reason).toContain('unresolved');
    expect(result.result.uncertainty).not.toContain('safe');
  });

  it('rejects even literal public quotes when they differ from the validated rationale', async () => {
    const quote = 'Transfer S$75 to this personal account.';
    const data = input(`${quote} Good morning.`);
    const extracted = extraction(quote);
    const deps = harness(data, extracted, payment(quote));
    const rendered = renderDecision(payment(quote), data, [], extracted);
    vi.mocked(deps.models!.review).mockResolvedValue({ value: { ...rendered, quotes: ['Good morning.'] },
      usage: { model: 'gpt-5.4-2026-03-05', inputTokens: 100, outputTokens: 50, costMicroUsd: 300 } });
    expect((await runAnalysis(requestId, data, deps)).result.status).toBe('partial');
    expect(deps.reportFailure).toHaveBeenCalledWith(expect.objectContaining({ stage: 'review_validation', code: 'quote_projection_mismatch' }));
    expect(deps.afterCall).toHaveBeenCalledTimes(2);
  });

  it('reviews a readable screenshot payment request while preserving missing recipient uncertainty', async () => {
    const quote = 'Transfer S$45 to my personal account.';
    const data: CheckInput = { ...input(''), mode: 'screenshot' };
    const extracted: Extraction = { ...extraction(quote), transcript: quote,
      requestedActions: [{ action: 'payment', quote, source: 'transcript' }],
      screenshotIssues: [{ kind: 'missing_detail', target: 'payment_recipient', location: 'body', consequential: true, imageQuote: null, userQuote: null, userSource: null }] };
    const decision: ReviewDecision = { finding: 'payment_request', questionId: null, evidenceIds: [],
      rationale: { relation: 'action_risk', anchors: [{ source: 'transcript', quote }], risks: [{ kind: 'payment', anchorIndex: 0 }] } };
    const deps = harness(data, extracted, decision);
    const result = await runAnalysis(requestId, data, deps);
    expect(result.result).toMatchObject({ status: 'complete', title: 'Confirm the payment request' });
    expect(result.result.uncertainty).toContain('not verified');
    expect(result.extraction?.screenshotIssues?.[0].consequential).toBe(false);
    expect(deps.models!.review).toHaveBeenCalledTimes(1);
    expect(deps.afterCall).toHaveBeenCalledTimes(2);
  });

  it('does not confuse an unperformed installation with an instruction conflict in a screenshot', async () => {
    const quote = 'Install the support app and allow screen control.';
    const data: CheckInput = { ...input('', 'I have not installed anything.'), mode: 'screenshot' };
    const extracted: Extraction = { ...extraction(quote), transcript: quote,
      requestedActions: [{ action: 'installation', quote, source: 'transcript' }],
      screenshotIssues: [{ kind: 'conflicting_accounts', target: 'requested_action', location: 'body', consequential: true,
        imageQuote: quote, userQuote: data.context, userSource: 'context' }] };
    const decision: ReviewDecision = { finding: 'remote_access', questionId: null, evidenceIds: [],
      rationale: { relation: 'action_risk', anchors: [{ source: 'transcript', quote }], risks: [{ kind: 'device_control', anchorIndex: 0 }] } };
    const deps = harness(data, extracted, decision);
    const result = await runAnalysis(requestId, data, deps);
    expect(result.result.status).toBe('complete');
    expect(result.extraction?.screenshotIssues).toEqual([]);
    expect(deps.models!.review).toHaveBeenCalledTimes(1);
    expect(deps.afterCall).toHaveBeenCalledTimes(2);
  });
});
