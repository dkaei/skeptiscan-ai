import { describe, expect, it } from 'vitest';
import type { CheckInput, Extraction, ScreenshotIssue } from '../shared/contracts';
import { getScreenshotIssueOutcome, validateScreenshotIssues } from '../server/screenshot-issues';

function input(overrides: Partial<CheckInput> = {}): CheckInput {
  return { mode: 'screenshot', content: '', context: '', senderEmail: '', senderPhone: '', externalLookup: false,
    image: { base64: 'synthetic-only', mimeType: 'image/png' }, ...overrides };
}
function extraction(transcript: string, screenshotIssues?: ScreenshotIssue[]): Extraction {
  return { transcript, claimedOrganisation: null, urls: [], phoneNumbers: [], requestedActions: [],
    unreadableDetails: [], missingContext: [], ...(screenshotIssues === undefined ? {} : { screenshotIssues }) };
}
function issue(overrides: Partial<ScreenshotIssue> = {}): ScreenshotIssue {
  return { kind: 'unreadable_region', target: 'link_destination', location: 'link', consequential: true,
    imageQuote: null, userQuote: null, userSource: null, ...overrides };
}
function conflict(imageQuote: string, userQuote: string, userSource: 'correction' | 'context' = 'correction') {
  return issue({ kind: 'conflicting_accounts', target: 'code_recipient', location: 'body', imageQuote, userQuote, userSource });
}

describe('separate provenance for screenshot issues', () => {
  it('requires correction for the S05 direction without preferring reassuring typed text', () => {
    const imageText = 'Send the login code to me in this chat.\nI will take care of the rest.';
    const typed = 'Enter the code in my own app. Nobody is asking me to send it to another person.';
    const issues = validateScreenshotIssues(input({ content: typed }), extraction(imageText, [conflict('Send the login code to me in this chat.', typed)]));
    const result = getScreenshotIssueOutcome(issues);
    expect(result).toMatchObject({ blocking: true, recovery: 'edit_input' });
    // Different wording/purpose is not server-proven opposition; still require
    // reconciliation rather than silently preferring the reassuring correction.
    expect(result.reason).toContain('possible difference');
    expect(result.reason).toContain('typed correction');
    expect(result.reason).toContain('where the account code would go');
    expect(result.nextStep).toBe('Compare the image with your typed correction and correct the difference. Keep account codes private.');
    expect(result.uncertainty).toBe('Neither version is assumed correct. The screenshot may have been misread.');
    expect(JSON.stringify(result)).not.toMatch(/definitely|authenticated|retry|fraud/);
  });

  it('also protects the reverse SS03 direction and preserves the visible negation', () => {
    const imageText = 'Enter the sign-in code only in this app.\nDo not send the code to this chat.\nNever tell it to a support agent.';
    const typed = 'The message asks me to send the sign-in code to the support agent in this chat.';
    const source = extraction(imageText, [conflict('Do not send the code to this chat.', typed)]);
    const checked = validateScreenshotIssues(input({ content: typed }), source);
    expect(checked[0].imageQuote).toBe('Do not send the code to this chat.');
    expect(getScreenshotIssueOutcome(checked)).toMatchObject({ blocking: true, recovery: 'edit_input' });
    expect(source.transcript).toBe(imageText);
  });

  it('validates added context independently instead of borrowing a matching correction', () => {
    const imageText = 'Send the account code to this chat.';
    const context = 'I enter it only in the app I opened.';
    const contextIssue = conflict(imageText, context, 'context');
    expect(validateScreenshotIssues(input({ context }), extraction(imageText, [contextIssue]))).toEqual([contextIssue]);
    expect(getScreenshotIssueOutcome([contextIssue]).reason).toContain('added context');
    expect(getScreenshotIssueOutcome([contextIssue]).nextStep).toBe('Compare the image with your added context and correct the difference. Keep account codes private.');
    expect(() => validateScreenshotIssues(input({ content: context }), extraction(imageText, [contextIssue]))).toThrow('ungrounded_screenshot_issue');
    expect(() => validateScreenshotIssues(input({ context }), extraction(imageText, [{ ...contextIssue, userSource: 'correction' }]))).toThrow('ungrounded_screenshot_issue');
  });

  it('does not ground the image-side quote in user text or a concatenated source', () => {
    const typed = 'Send the account code to this chat.';
    const imageText = 'Enter it only in your app.';
    const bad = conflict(typed, imageText);
    expect(() => validateScreenshotIssues(input({ content: `${typed}\n${imageText}` }), extraction('A different visible line.', [bad]))).toThrow('ungrounded_screenshot_issue');
  });

  it.each([
    ['Do not send the code to this chat.', 'send the code to this chat.'],
    ['Nobody is asking you to send the code.', 'send the code.'],
    ['This says https://bank.example.evil.example/', 'https://bank.example'],
  ])('rejects a misleading suffix or truncated destination within %s', (imageText, clipped) => {
    const typed = 'Enter the code in your app.';
    expect(() => validateScreenshotIssues(input({ content: typed }), extraction(imageText, [conflict(clipped, typed)]))).toThrow('ungrounded_screenshot_issue');
  });

  it('accepts a whole clause after a label without normalising its text', () => {
    const imageText = 'Instruction: Do not send the code.';
    const typed = 'Send the code to this chat.';
    expect(validateScreenshotIssues(input({ content: typed }), extraction(imageText, [conflict('Do not send the code.', typed)]))).toHaveLength(1);
    expect(() => validateScreenshotIssues(input({ content: typed }), extraction(imageText, [conflict('do not send the code.', typed)]))).toThrow('ungrounded_screenshot_issue');
  });

  it('rejects identical quotes, missing accounts, unsupported narrative and duplicates', () => {
    const imageText = 'Enter the code in the app.';
    const typed = 'Send the code to a person.';
    const valid = conflict(imageText, typed);
    expect(() => validateScreenshotIssues(input({ content: imageText }), extraction(imageText, [conflict(imageText, imageText)]))).toThrow('ungrounded_screenshot_issue');
    expect(() => validateScreenshotIssues(input({ content: typed }), extraction(imageText, [{ ...valid, userQuote: null }]))).toThrow('invalid_screenshot_issue');
    expect(() => validateScreenshotIssues(input({ content: typed }), extraction(imageText, [{ ...valid, explanation: 'A made-up verdict' } as ScreenshotIssue]))).toThrow('invalid_screenshot_issue');
    expect(() => validateScreenshotIssues(input({ content: typed }), extraction(imageText, [valid, valid]))).toThrow('invalid_screenshot_issue');
  });

  it('enforces count/quote bounds with content-free validation errors', () => {
    expect(() => validateScreenshotIssues(input(), extraction('', Array.from({ length: 5 }, () => issue())))).toThrow('invalid_screenshot_issue');
    const quote = 'PRIVATE-SYNTHETIC-CANARY '.repeat(12);
    expect(() => validateScreenshotIssues(input(), extraction(quote, [issue({ imageQuote: quote })]))).toThrow('invalid_screenshot_issue');
    try { validateScreenshotIssues(input(), extraction('', [issue({ imageQuote: 'PRIVATE-SYNTHETIC-CANARY' })])); }
    catch (error) { expect(String(error)).toBe('Error: ungrounded_screenshot_issue'); }
  });

  it('rejects a user account attached to an unreadable region and issues in text-only mode', () => {
    expect(() => validateScreenshotIssues(input({ content: 'A value.' }), extraction('', [issue({ userQuote: 'A value.', userSource: 'correction' })]))).toThrow('invalid_screenshot_issue');
    expect(() => validateScreenshotIssues(input({ mode: 'message', image: undefined }), extraction('', [issue()]))).toThrow('invalid_screenshot_issue');
  });
});

describe('issue-specific abstention and honest omissions', () => {
  it('SS01 does not let a separate clear government guide hide an unreadable action target', () => {
    const imageText = 'Read the public guide:\nhttps://www.gov.sg/\nTo update your account, use this link:\nhttps://[covered].example.org/review';
    const ext = extraction(imageText, [issue({ imageQuote: 'To update your account, use this link:' })]);
    ext.urls = ['https://www.gov.sg/'];
    const checked = validateScreenshotIssues(input(), ext);
    const outcome = getScreenshotIssueOutcome(checked);
    expect(outcome).toMatchObject({ blocking: true, recovery: 'clearer_image' });
    expect(outcome.reason).toMatch(/link destination.*reliably/);
    expect(outcome.uncertainty).toMatch(/separate readable link does not/);
    expect(outcome.nextStep).toMatch(/Do not guess hidden characters/);
    expect(ext.urls).toEqual(['https://www.gov.sg/']);
  });

  it('SS02 missing button target and irrelevant reference redaction do not force partial', () => {
    const transcript = 'Your item is ready for collection.\nOrder reference: [covered]\nView collection details';
    const value = extraction(transcript, [
      issue({ kind: 'missing_detail', target: 'link_destination', location: 'button', consequential: false, imageQuote: 'View collection details' }),
      issue({ target: 'reference_number', location: 'body', consequential: false, imageQuote: 'Order reference:' }),
    ]);
    const outcome = getScreenshotIssueOutcome(validateScreenshotIssues(input({ context: 'I do not need the order number.' }), value));
    expect(outcome.blocking).toBe(false);
    expect(outcome.recovery).toBeUndefined();
    expect(outcome.notes.join(' ')).toMatch(/does not show where the button goes/);
    expect(outcome.notes.join(' ')).toMatch(/label cannot reveal the target URL/);
    expect(outcome.notes.join(' ')).not.toMatch(/clearer|blurred|order number/);
  });

  it('ordinary absent contacts and irrelevant redactions cannot alone block protective advice', () => {
    for (const target of ['sender_identity', 'reference_number'] as const) {
      for (const kind of ['missing_detail', 'unreadable_region'] as const) {
        expect(getScreenshotIssueOutcome([issue({ target, kind, consequential: true })]).blocking).toBe(false);
      }
    }
    expect(getScreenshotIssueOutcome([issue({ kind: 'missing_detail', target: 'payment_amount', consequential: false })]).blocking).toBe(false);
  });

  it('a consequential absent action or destination requires input, not better OCR', () => {
    for (const target of ['requested_action', 'link_destination'] as const) {
      const outcome = getScreenshotIssueOutcome([issue({ kind: 'missing_detail', target })]);
      expect(outcome).toMatchObject({ blocking: true, recovery: 'edit_input' });
      expect(outcome.uncertainty).toMatch(/Absent information cannot be recovered/);
      expect(outcome.nextStep).not.toMatch(/clearer|guess/);
    }
  });

  it('an unknown code recipient asks for its purpose, never the code value', () => {
    const outcome = getScreenshotIssueOutcome([issue({ kind: 'missing_detail', target: 'code_recipient' })]);
    expect(outcome).toMatchObject({ blocking: true, recovery: 'edit_input' });
    expect(outcome.nextStep).toBe('Explain where the code would be entered or sent. Do not include the code itself.');
  });

  it('describes verification limits without claiming the provider never guessed missing content', () => {
    const missingAddress = getScreenshotIssueOutcome([issue({ kind: 'missing_detail', consequential: false })]);
    const missingAmount = getScreenshotIssueOutcome([issue({ kind: 'missing_detail', target: 'payment_amount', consequential: false })]);
    const unreadableAmount = getScreenshotIssueOutcome([issue({ target: 'payment_amount' })]);
    expect(missingAddress.notes.join(' ')).toContain('The missing address is not verified.');
    expect(missingAmount.notes.join(' ')).toContain('The missing detail is not verified.');
    expect(unreadableAmount.uncertainty).toContain('could change the assessment and is not verified');
    for (const outcome of [missingAddress, missingAmount, unreadableAmount]) {
      expect(JSON.stringify(outcome)).not.toMatch(/No .*(?:inferred|reconstructed)|never guessed/i);
    }
  });

  it('reconciliation wins over an additional unreadable region and never selects either account', () => {
    const outcome = getScreenshotIssueOutcome([issue(), conflict('Send the code.', 'Do not send the code.')]);
    expect(outcome.recovery).toBe('edit_input');
    expect(outcome.uncertainty).toContain('Neither version is assumed correct');
    expect(outcome).not.toHaveProperty('retry');
  });

  it('keeps benign disagreements nonblocking and missing legacy fields compatible', () => {
    expect(getScreenshotIssueOutcome([{ ...conflict('Reference A.', 'Reference B.'), consequential: false, target: 'reference_number' }]).blocking).toBe(false);
    const legacy = extraction('A readable line.'); legacy.unreadableDetails = ['Legacy reading limitation'];
    expect(validateScreenshotIssues(input(), legacy)).toEqual([]);
    expect(legacy.unreadableDetails).toEqual(['Legacy reading limitation']);
    expect(getScreenshotIssueOutcome([])).toEqual({ blocking: false, notes: [] });
  });
});
