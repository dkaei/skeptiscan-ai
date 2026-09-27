import { describe, expect, it, vi } from 'vitest';
import { runAnalysis, reviewClarification, type AnalysisDependencies } from '../server/analysis';
import { renderDecision, type ReviewDecision } from '../server/review-policy';
import { diagnosticFor } from '../server/diagnostics';
import type { CheckInput, Extraction, ScreenshotIssue } from '../shared/contracts';

// Pipeline regressions with injected interpretations, not live model performance.
const id = '9371c151-2ab5-4e52-860d-8e62ff2b22f8';
const input = (content: string, context = ''): CheckInput => ({ mode: 'message', content, context, senderEmail: '', senderPhone: '', externalLookup: false });
const shot = (content = '', context = ''): CheckInput => ({ ...input(content, context), mode: 'screenshot', image: { mimeType: 'image/png', base64: 'eA==' } });
const extraction = (overrides: Partial<Extraction> = {}): Extraction => ({ transcript: '', claimedOrganisation: null, urls: [], phoneNumbers: [], requestedActions: [], missingContext: [], unreadableDetails: [], screenshotIssues: [], ...overrides });
const anchor = (quote: string, source: 'content' | 'context' | 'transcript' = 'content') => ({ source, quote });
function harness(data: CheckInput, read: Extraction, decision?: ReviewDecision) {
  const usage = { model: 'gpt-5.4-mini-2026-03-17' as const, inputTokens: 100, outputTokens: 100, costMicroUsd: 525 };
  const deps: AnalysisDependencies = {
    models: {
      extract: vi.fn().mockResolvedValue({ value: read, usage }),
      review: vi.fn().mockImplementation(async () => ({ value: renderDecision(decision!, data, [], read), usage: { ...usage, model: 'gpt-5.4-2026-03-05', costMicroUsd: 1750 } })),
    },
    collectEvidence: vi.fn().mockResolvedValue([]), beforeCall: vi.fn(), afterCall: vi.fn(), reportFailure: vi.fn(), signal: new AbortController().signal,
  };
  return { deps, run: () => runAnalysis(id, data, deps) };
}
const decision = (finding: ReviewDecision['finding'], rationale: NonNullable<ReviewDecision['rationale']>, quote: string): ReviewDecision & { quotes: string[] } => ({ finding, rationale, quotes: [quote], evidenceIds: [], questionId: null });

describe('remaining blockers through the full analysis pipeline (offline)', () => {
  it('keeps a case-specific relationship instead of replacing it with a generic finding reason', async () => {
    const data = input('I expected a parcel. Pay S$1.99 to release it.');
    const value = decision('payment_request', { relation: 'context_not_authority', anchors: [anchor('I expected a parcel.'), anchor('Pay S$1.99 to release it.')], risks: [{ kind: 'payment', anchorIndex: 1 }] }, 'Pay S$1.99 to release it.');
    const h = harness(data, extraction({ requestedActions: [{ action: 'pay', quote: value.quotes[0], source: 'content' }] }), value);
    const { result, extraction: read } = await h.run();
    expect(result).toMatchObject({ status: 'complete', title: 'Confirm the payment request' });
    expect(result.reason).toContain('I expected a parcel.');
    expect(result.reason).toContain('does not authorise the separate request');
    expect(read?.requestedActions[0].span).toEqual({ source: 'content', start: 21, end: data.content.length });
    expect(h.deps.beforeCall).toHaveBeenCalledTimes(2);
    expect(h.deps.afterCall).toHaveBeenCalledTimes(2);
  });

  it('does not turn absence of a sensitive action into a decision about a policy claim', async () => {
    const text = 'A forward says every account closes tomorrow.';
    const h = harness(input(text), extraction(), decision('unverified_claim', { relation: 'claim_unverified', anchors: [anchor(text)], risks: [] }, text));
    const { result } = await h.run();
    expect(result.status).toBe('complete');
    expect(result.question).toBeNull();
    expect(result.reason).toContain('not been verified against a current official source');
    expect(result.uncertainty).toContain('No conclusion about this claim’s truth');
  });

  it('retains all three independently anchored risks behind a harmless preface', async () => {
    const clauses = ['Keep passwords private.', 'Install remote control.', 'Transfer S$450.', 'Read the bank login code aloud.'];
    const value = decision('credential_disclosure', { relation: 'context_not_authority', anchors: clauses.map(text => anchor(text)), risks: [{ kind: 'device_control', anchorIndex: 1 }, { kind: 'payment', anchorIndex: 2 }, { kind: 'account_access', anchorIndex: 3 }] }, clauses[3]);
    const h = harness(input(clauses.join(' ')), extraction(), value);
    const { result } = await h.run();
    expect(result.status).toBe('complete');
    expect(result.reason).toContain('Stop the requested sequence');
    expect(result.reason).toContain('operate your device');
    expect(result.reason).toContain('payment recipient still needs independent verification');
    expect(result.reason).toContain('account access');
  });

  it('rejects an exact quote assigned to the wrong account instead of falling back to the other source', async () => {
    const data = shot('Send your code.', 'Only enter it in your own app.');
    const read = extraction({ transcript: 'Only enter it in your own app.', requestedActions: [{ action: 'share', quote: 'Send your code.', source: 'transcript' }] });
    const h = harness(data, read);
    expect((await h.run()).result).toMatchObject({ status: 'partial', extraction: null, recovery: 'edit_input' });
    expect(h.deps.models!.review).not.toHaveBeenCalled();
    expect(h.deps.afterCall).toHaveBeenCalledTimes(1);
    expect(h.deps.reportFailure).toHaveBeenCalledWith({ requestId: id, stage: 'extraction_validation', code: 'ungrounded_quote' });
  });

  it('rejects whitespace-only screenshot quote drift, records a bounded category and offers correction', async () => {
    const h = harness(shot(), extraction({ transcript: 'Please pay\nS$1.99.', requestedActions: [{ action: 'pay', quote: 'Please pay S$1.99.', source: 'transcript' }] }));
    const { result } = await h.run();
    expect(result).toMatchObject({ status: 'partial', recovery: 'edit_input', extraction: null, evidence: [] });
    expect(result.reason).toContain('could not be linked to its exact source');
    expect(h.deps.models!.review).not.toHaveBeenCalled();
    expect(h.deps.reportFailure).toHaveBeenCalledWith({ requestId: id, stage: 'extraction_validation', code: 'ungrounded_quote_whitespace' });
    expect(JSON.stringify(vi.mocked(h.deps.reportFailure!).mock.calls)).not.toContain('1.99');
  });

  it('preserves exact screenshot line breaks, punctuation, currency and source spans', async () => {
    const text = 'Please pay\nS$1.99.';
    const read = extraction({ transcript: text, requestedActions: [{ action: 'pay', quote: text, source: 'transcript' }] });
    const h = harness(shot(), read, decision('payment_request', { relation: 'action_risk', anchors: [anchor(text, 'transcript')], risks: [{ kind: 'payment', anchorIndex: 0 }] }, text));
    const output = await h.run();
    expect(output.result.status).toBe('complete');
    expect(output.extraction?.requestedActions[0]).toMatchObject({ quote: text, source: 'transcript', span: { source: 'transcript', start: 0, end: text.length } });
    expect(output.result.reason).toContain(text);
  });

  it.each([
    ['Send your login code to this chat.', 'Do not send a code. Enter it only in your own app.'],
    ['Do not send a code. Enter it only in your own app.', 'Send your login code to this chat.'],
  ])('does not silently prefer the reassuring account in either conflict direction %#', async (pixels, correction) => {
    const issue: ScreenshotIssue = { kind: 'conflicting_accounts', target: 'code_recipient', location: 'body', consequential: true, imageQuote: pixels, userQuote: correction, userSource: 'correction' };
    const h = harness(shot(correction), extraction({ transcript: pixels, screenshotIssues: [issue] }));
    const { result } = await h.run();
    expect(result).toMatchObject({ status: 'partial', recovery: 'edit_input', question: null });
    // Differently worded code purposes remain unresolved without asserting a
    // proven contradiction from a shared keyword alone.
    expect(result.reason).toContain('possible difference');
    expect(result.reason).toContain('typed correction');
    expect(result.nextStep).toContain('Compare the image with your typed correction');
    expect(result.uncertainty).toContain('Neither version is assumed correct');
    expect(h.deps.models!.review).not.toHaveBeenCalled();
    expect(h.deps.afterCall).toHaveBeenCalledTimes(1);
    expect(h.deps.reportFailure).toHaveBeenCalledWith({ requestId: id, stage: 'extraction_validation', code: 'screenshot_conflict' });
  });

  it('distinguishes unreadable pixels from an absent button destination without guessing either', async () => {
    const baseIssue: ScreenshotIssue = { kind: 'unreadable_region', target: 'code_recipient', location: 'body', consequential: true, imageQuote: null, userQuote: null, userSource: null };
    const blurred = harness(shot(), extraction({ transcript: 'The recipient is [covered].', screenshotIssues: [baseIssue] }));
    const unreadable = (await blurred.run()).result;
    expect(unreadable).toMatchObject({ status: 'partial', recovery: 'clearer_image' });
    expect(unreadable.reason).toContain('could not read where the account code would go');
    const text = 'Open your known delivery app to view your parcel.';
    const read = extraction({ transcript: text, screenshotIssues: [{ ...baseIssue, kind: 'missing_detail', target: 'link_destination', location: 'button', consequential: false }] });
    const missing = harness(shot(), read, decision('information_only', { relation: 'routine_context', anchors: [anchor(text, 'transcript')], risks: [] }, text));
    const result = (await missing.run()).result;
    expect(result.status).toBe('complete');
    expect(result.uncertainty).toContain('does not show where the button goes');
    expect(result.uncertainty).toContain('cannot reveal the target URL');
    expect(result.recovery).toBeUndefined();
    expect(missing.deps.models!.review).toHaveBeenCalledOnce();
  });

  it('does not interpret an incidental covered reference as a reason to withhold protective advice', async () => {
    const text = 'Send me your bank login code.';
    const read = extraction({ transcript: text, screenshotIssues: [{ kind: 'unreadable_region', target: 'reference_number', location: 'header', consequential: true, imageQuote: null, userQuote: null, userSource: null }] });
    const h = harness(shot(), read, decision('credential_disclosure', { relation: 'action_risk', anchors: [anchor(text, 'transcript')], risks: [{ kind: 'account_access', anchorIndex: 0 }] }, text));
    expect((await h.run()).result).toMatchObject({ status: 'complete', title: 'Keep account codes private' });
  });

  it('finishes an unsure clarification with the specific unresolved capability and one final call', async () => {
    const data = input('One note says install remote control.', 'Another note says only restart the tablet.');
    const read = extraction();
    const value = decision('unclear_request', { relation: 'conflicting_accounts', anchors: [anchor(data.content), anchor(data.context, 'context')], risks: [{ kind: 'device_control', anchorIndex: 0 }] }, data.content);
    const h = harness(data, read, value);
    const { result } = await reviewClarification(id, data, read, [], 'asked_to_install', 'unsure', h.deps);
    expect(result).toMatchObject({ status: 'partial', question: null, title: 'Pause before acting', recovery: 'edit_input' });
    expect(result.reason).toContain('The accounts disagree');
    expect(result.reason).toContain('operate your device');
    expect(h.deps.models!.extract).not.toHaveBeenCalled();
    expect(h.deps.beforeCall).toHaveBeenCalledExactlyOnceWith('review');
    expect(h.deps.afterCall).toHaveBeenCalledTimes(1);
  });

  it('retains only allowlisted categories for new failure diagnostics', () => {
    for (const code of ['ungrounded_quote_whitespace', 'screenshot_conflict', 'screenshot_missing_detail', 'invalid_screenshot_issue', 'ungrounded_screenshot_issue', 'ungrounded_rationale']) {
      expect(diagnosticFor(id, 'extraction_validation', Object.assign(new Error(code), { body: 'private text' }))).toEqual({ requestId: id, stage: 'extraction_validation', code });
    }
  });

  it('rejects contradictory old and new issue metadata rather than letting an empty new list hide a warning', async () => {
    const h = harness(shot(), extraction({ transcript: 'A readable line.', unreadableDetails: ['Legacy consequential warning'], screenshotIssues: [] }));
    expect((await h.run()).result.status).toBe('partial');
    expect(h.deps.models!.review).not.toHaveBeenCalled();
    expect(h.deps.reportFailure).toHaveBeenCalledWith({ requestId: id, stage: 'extraction_validation', code: 'invalid_screenshot_issue' });
  });
});
