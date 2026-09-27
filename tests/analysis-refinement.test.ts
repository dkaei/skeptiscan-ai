import { describe, expect, it, vi } from 'vitest';
import { runAnalysis, type AnalysisDependencies } from '../server/analysis';
import { ModelGatewayError } from '../server/openai';
import { collectEvidence } from '../server/evidence';
import { renderDecision, type ReviewDecision } from '../server/review-policy';
import type { CheckInput, Evidence, Extraction } from '../shared/contracts';

const id = '0b237585-ef71-4614-982f-945cf061b4f3';
const input = (content: string): CheckInput => ({ mode: 'message', content, context: '', senderPhone: '', senderEmail: '', externalLookup: false });
const extracted = (quote = ''): Extraction => ({ transcript: '', claimedOrganisation: null, urls: [], phoneNumbers: [], requestedActions: quote ? [{ action: 'request', quote }] : [], unreadableDetails: [], missingContext: [] });
const usage = { model: 'gpt-5.4-mini-2026-03-17' as const, inputTokens: 100, outputTokens: 50, costMicroUsd: 300 };
function harness(data: CheckInput, extraction: Extraction, decision: ReviewDecision, evidence: Evidence[] = []) {
  const reviewed = renderDecision(decision, data, evidence);
  const models = { extract: vi.fn().mockResolvedValue({ value: extraction, usage }), review: vi.fn().mockResolvedValue({ value: reviewed, usage: { ...usage, model: 'gpt-5.4-2026-03-05' } }) };
  const deps: AnalysisDependencies = { models, beforeCall: vi.fn().mockResolvedValue(undefined), afterCall: vi.fn().mockResolvedValue(undefined), collectEvidence: vi.fn().mockResolvedValue(evidence), reportFailure: vi.fn(), signal: new AbortController().signal };
  return { deps, models, reviewed };
}
const decision = (finding: ReviewDecision['finding'], quotes: string[] = []): ReviewDecision => ({ finding, quotes, evidenceIds: [], questionId: null });

describe('contextual review and failure regressions (no live AI)', () => {
  it('preserves the own-app distinction and refuses an internally contradictory disclosure action', async () => {
    const data = input('I opened my usual app and enter its sign-in code there. Nobody receives the code from me.');
    const h = harness(data, extracted(data.content), decision('own_login', [data.content]));
    expect((await runAnalysis(id, data, h.deps)).result).toMatchObject({ status: 'complete', title: 'Check through a trusted route', reason: 'Entering a code in the app you opened differs from sending it to another person.' });
    h.models.review.mockResolvedValue({ value: { ...h.reviewed, actionId: 'protect_credentials' }, usage });
    expect((await runAnalysis(id, data, h.deps)).result.status).toBe('partial');
  });

  it('cannot attach a clarification to an explicit payment decision', () => {
    expect(() => renderDecision({ ...decision('payment_request', ['Transfer S$75']), questionId: 'payment_expected' }, input('Transfer S$75'), [])).toThrow('unnecessary_question');
  });

  it('requires the extractor to identify an unanswered context dimension before asking', async () => {
    const data = input('Someone asked for a code.');
    const h = harness(data, extracted(data.content), { ...decision('unclear_request'), questionId: 'sharing_code' });
    expect((await runAnalysis(id, data, h.deps)).result).toMatchObject({ status: 'partial', question: null });
    expect(h.deps.reportFailure).toHaveBeenCalledWith({ requestId: id, stage: 'review_validation', code: 'question_not_missing' });
    expect(h.models.review).toHaveBeenCalledTimes(1);
  });

  it('grounds the contextual explanation and does not accept a fabricated own-app quote', async () => {
    const data = input('Please send your login code to my agent.');
    const h = harness(data, extracted(data.content), decision('own_login', ['I enter it only in my own app.']));
    expect((await runAnalysis(id, data, h.deps)).result.status).toBe('partial');
    expect(h.deps.reportFailure).toHaveBeenCalledWith({ requestId: id, stage: 'review_validation', code: 'invented_quote' });
  });

  it('renders caution from actual domain state without discarding valid local findings', async () => {
    const data = { ...input('https://bank.example.org/'), mode: 'link' as const };
    const evidence: Evidence[] = [{ id: 'domain-0', kind: 'domain', state: 'observation', title: 'Different host', detail: 'Actual host: bank.example.org.', checkedAt: '2026-09-26T00:00:00Z' }];
    const h = harness(data, { ...extracted(), urls: [data.content] }, decision('link_only'), evidence);
    h.models.review.mockResolvedValue({ value: { ...h.reviewed, uncertainty: 'A matching domain does not authenticate the sender or the requested action.' }, usage });
    const result = (await runAnalysis(id, data, h.deps)).result;
    expect(result.status).toBe('complete');
    expect(result.uncertainty).toBe('The website’s content and owner have not been verified.');
    expect(result.evidence).toEqual(evidence);
  });

  it('keeps independent-payment advice when a genuine host is present', async () => {
    const data = input('See https://www.gov.sg/ then transfer S$70 to me.');
    const evidence: Evidence[] = [{ id: 'domain-0', kind: 'domain', state: 'matched', title: 'Host matches record', detail: 'No sender identity claim.', checkedAt: '2026-09-26T00:00:00Z' }];
    const h = harness(data, extracted('transfer S$70 to me'), decision('payment_request', ['transfer S$70 to me']), evidence);
    expect((await runAnalysis(id, data, h.deps)).result).toMatchObject({ status: 'complete', title: 'Confirm the payment request', reason: 'A matching website address does not authorise a separate payment request.', question: null });
  });

  it('retains original local evidence after extraction timeout without another external lookup', async () => {
    const data = { ...input('Missed call about https://www.gov.sg/'), mode: 'call' as const, senderPhone: '+65 8*** 1234', externalLookup: true };
    const h = harness(data, extracted(), decision('identity_unknown'));
    h.models.extract.mockRejectedValue(new ModelGatewayError('MODEL_TIMEOUT'));
    const reserveLookup = vi.fn();
    h.deps.collectEvidence = vi.fn((original, extraction) => collectEvidence(original, extraction, { webRiskEnabled: true, webRiskKey: 'never-send-test-key', reserveLookup, now: new Date('2026-09-26T00:00:00Z') }));
    const result = (await runAnalysis(id, data, h.deps)).result;
    expect(result.status).toBe('partial');
    expect(result.extraction).toBeNull();
    expect(result.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'phone', state: 'unsupported' }), expect.objectContaining({ kind: 'domain', state: 'matched' })]));
    expect(reserveLookup).not.toHaveBeenCalled();
    expect(h.models.review).not.toHaveBeenCalled();
    expect(h.deps.collectEvidence).toHaveBeenCalledWith(expect.objectContaining({ externalLookup: false }), expect.objectContaining({ urls: ['https://www.gov.sg/'] }));
    expect(h.deps.reportFailure).toHaveBeenCalledWith({ requestId: id, stage: 'extraction', code: 'MODEL_TIMEOUT' });
  });

  it('never logs model/input text and never guesses evidence from a failed screenshot', async () => {
    const data: CheckInput = { ...input('private corrected text'), mode: 'screenshot', image: { mimeType: 'image/png', base64: 'eA==' } };
    const h = harness(data, extracted(), decision('identity_unknown'));
    h.models.extract.mockRejectedValue(new Error('secret provider body and private corrected text'));
    const result = (await runAnalysis(id, data, h.deps)).result;
    expect(result).toMatchObject({ status: 'partial', extraction: null, evidence: [] });
    expect(h.deps.collectEvidence).not.toHaveBeenCalled();
    expect(h.deps.reportFailure).toHaveBeenCalledWith({ requestId: id, stage: 'extraction', code: 'stage_failed' });
    expect(JSON.stringify(vi.mocked(h.deps.reportFailure!).mock.calls)).not.toMatch(/secret|private|provider body/);
  });

  it('withholds an image assessment when the reviewer sees unreadability missed by extraction', async () => {
    const data: CheckInput = { ...input(''), mode: 'screenshot', image: { mimeType: 'image/png', base64: 'eA==' } };
    const h = harness(data, { ...extracted(), transcript: 'Contact us at [obscured]' }, decision('unreadable_image'));
    expect((await runAnalysis(id, data, h.deps)).result).toMatchObject({ status: 'partial', question: null, reason: 'Some screenshot details are unclear or inconsistent.', recovery: 'clearer_image' });
  });
});
