import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckResult, Evidence, Extraction, ScreenshotIssue } from '../shared/contracts';
import CheckResultView from '../src/CheckResultView';
import { correctionText, evidenceStateLabel, getResultPresentation } from '../src/resultPresentation';

const checkedAt = '2026-09-27T04:00:00.000Z';
function result(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    requestId: 'result-presentation-offline', status: 'complete', title: 'Confirm the request',
    nextStep: 'Use a contact route you already trust.', reason: 'The message asks for a payment.',
    uncertainty: 'The sender has not been verified.', evidence: [], extraction: null,
    question: null, checkedAt, aiUsed: true, ...overrides,
  };
}
function extraction(overrides: Partial<Extraction> = {}): Extraction {
  return { transcript: '', claimedOrganisation: null, urls: [], phoneNumbers: [], requestedActions: [], unreadableDetails: [], missingContext: [], ...overrides };
}
function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return { id: 'evidence-1', kind: 'domain', state: 'unsupported', title: 'Private address', detail: 'This address cannot be checked externally.', checkedAt, ...overrides };
}
function callbacks() {
  return { onAnswer: vi.fn(), onCancel: vi.fn(), onEdit: vi.fn(), onCorrectText: vi.fn(), onRetry: vi.fn(), onClearerImage: vi.fn() };
}
function screenshotIssue(overrides: Partial<ScreenshotIssue> = {}): ScreenshotIssue {
  return { kind: 'conflicting_accounts', target: 'code_recipient', location: 'body', consequential: true,
    imageQuote: 'Do not send the code to this chat.', userQuote: 'Send the code to the support agent.',
    userSource: 'correction', ...overrides };
}
function render(value: CheckResult, overrides: Partial<ComponentProps<typeof CheckResultView>> = {}) {
  return renderToStaticMarkup(createElement(CheckResultView, { result: value, busy: false, ...callbacks(), ...overrides }));
}
const fetchGuard = vi.fn(() => { throw new Error('Result presentation must not request the network.'); });
beforeEach(() => { fetchGuard.mockClear(); vi.stubGlobal('fetch', fetchGuard); });
afterEach(() => { expect(fetchGuard).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('result hierarchy and useful disclosure content', () => {
  it.each([null, extraction(), extraction({ transcript: ' \n\t' })])('omits empty Evidence and read-details disclosures (%j)', value => {
    const valueResult = result({ extraction: value });
    const html = render(valueResult);
    expect(getResultPresentation(valueResult)).toMatchObject({ hasEvidence: false, hasReadDetails: false });
    expect(html).not.toContain('<details');
    expect(html).not.toContain('<summary>Evidence');
    expect(html).not.toContain('Details read from your input');
  });

  it('preserves unsupported evidence, its reason and honest status timestamp', () => {
    const item = evidence();
    const html = render(result({ evidence: [item] }));
    expect(getResultPresentation(result({ evidence: [item] })).hasEvidence).toBe(true);
    expect(html).toContain('<summary>Evidence');
    expect(html).toContain(item.title);
    expect(html).toContain(item.detail);
    expect(html).toContain('Not supported');
    expect(html).toContain('Status as of');
    expect(html).not.toMatch(/>Checked /);
  });

  it.each([
    extraction({ transcript: 'Pay a fee to release the parcel.' }),
    extraction({ claimedOrganisation: 'A parcel company' }),
    extraction({ urls: ['https://parcel.example/'] }),
    extraction({ phoneNumbers: ['+65 6000 0000'] }),
    extraction({ requestedActions: [{ action: 'Pay a fee', quote: 'Please pay $2.' }] }),
    extraction({ unreadableDetails: ['The last digit is blurred'] }),
  ])('keeps a read-details disclosure when a useful extracted field is present (%j)', value => {
    expect(getResultPresentation(result({ extraction: value })).hasReadDetails).toBe(true);
    expect(render(result({ extraction: value }))).toContain('Details read from your input');
  });

  it('places the next step before explanation and evidence for a finished check', () => {
    const value = result({ evidence: [evidence()] });
    const html = render(value);
    expect(html.indexOf('Your next step')).toBeLessThan(html.indexOf('<h2>Why</h2>'));
    expect(html.indexOf(value.nextStep)).toBeLessThan(html.indexOf(value.reason));
    expect(html.indexOf(value.reason)).toBeLessThan(html.indexOf('<summary>Evidence'));
    expect(html).toMatch(/<h1[^>]*tabindex="-1"/);
  });

  it('labels incomplete results as incomplete and preserves their explanation', () => {
    const value = result({ status: 'partial', aiUsed: false, reason: 'The reading service did not respond.' });
    const html = render(value);
    expect(html).toContain('Local checks only');
    expect(html).toContain('Incomplete');
    expect(html).toContain('<h2>What happened</h2>');
    expect(html).toContain('<h2>What this means</h2>');
    expect(html).toContain(value.reason);
    expect(html).not.toContain('AI-assisted check');
  });

  it('omits an empty uncertainty section but retains a specific uncertainty', () => {
    expect(render(result({ uncertainty: ' \n ' }))).not.toContain('Keep in mind');
    const html = render(result({ uncertainty: 'A directory match does not authenticate the message.' }));
    expect(html).toContain('Keep in mind');
    expect(html).toContain('A directory match does not authenticate the message.');
  });

  it.each(['The message asks for a payment.', 'The sender has not been verified.'])('does not repeat a notice already used in the result: %s', notice => {
    const value = result({ notice: `  ${notice}\n` });
    expect(getResultPresentation(value).notice).toBeUndefined();
    expect(render(value).split(notice)).toHaveLength(2);
  });

  it('retains a distinct notice once and discards a blank one', () => {
    const notice = 'The number-report service is unavailable.';
    expect(render(result({ notice: ` ${notice} ` })).split(notice)).toHaveLength(2);
    expect(getResultPresentation(result({ notice: '\n ' })).notice).toBeUndefined();
  });
});

describe('contextual evidence labels and source access', () => {
  it.each([
    ['domain', 'matched', 'Address matches reference'],
    ['domain', 'no_match', 'Outside reference list'],
    ['reputation', 'matched', 'Threat-list match'],
    ['reputation', 'no_match', 'No listed threat found'],
    ['guidance', 'observation', 'Reference guidance'],
    ['phone', 'unavailable', 'Unavailable'],
    ['reputation', 'not_checked', 'Not checked'],
    ['domain', 'unsupported', 'Not supported'],
  ] as const)('distinguishes %s %s without claiming safety', (kind, state, label) => {
    const item = evidence({ kind, state });
    expect(evidenceStateLabel(item)).toBe(label);
    expect(evidenceStateLabel(item)).not.toMatch(/\bsafe\b/i);
    expect(render(result({ evidence: [item] }))).toContain(label);
  });

  it('gives source links distinct accessible context and an external-tab warning', () => {
    const items = [
      evidence({ id: 'a', title: 'Organisation directory', sourceUrl: 'https://www.gov.sg/' }),
      evidence({ id: 'b', kind: 'guidance', title: 'Payment guidance', sourceUrl: 'https://www.scamshield.gov.sg/' }),
    ];
    const html = render(result({ evidence: items }));
    for (const item of items) {
      expect(html).toContain(`href="${item.sourceUrl}"`);
      expect(html).toContain(`for ${item.title} (opens in a new tab)`);
    }
    expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
  });

  it.each(['javascript:alert(1)', 'data:text/html,test', 'https://user:secret@source.example/', 'not a URL'])('does not make an invalid or credential-bearing source clickable: %s', sourceUrl => {
    const html = render(result({ evidence: [evidence({ sourceUrl })] }));
    expect(html).not.toContain('<a ');
    expect(html).toContain('Private address');
  });

  it('renders suspicious input as text instead of making it an active link or markup', () => {
    const html = render(result({ extraction: extraction({ transcript: '<script>alert(1)</script>', urls: ['https://untrusted.example/pay'] }) }));
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('https://untrusted.example/pay');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<a ');
  });
});

describe('clarification and recovery remain deliberate user actions', () => {
  const question = { id: 'payment_expected' as const, text: 'Were you expecting this payment request?', options: ['Yes, expected', 'No, unexpected', 'Not sure'] };

  it('puts a live clarification before explanation with a labelled answer group', () => {
    const html = render(result({ status: 'needs_context', question, continuation: 'opaque-test-continuation' }));
    expect(html.indexOf(question.text)).toBeLessThan(html.indexOf('<h2>Why</h2>'));
    expect(html).toContain('<h2 id="clarification-title">');
    expect(html).toContain('role="group" aria-labelledby="clarification-title"');
    for (const option of question.options) expect(html).toContain(`>${option}</button>`);
    expect(html).not.toContain('Your next step');
    expect(html).not.toContain('Try again');
    expect(html).not.toContain('opaque-test-continuation');
  });

  it.each([
    { status: 'needs_context' as const, continuation: undefined },
    { status: 'complete' as const, continuation: 'expired-test-context' },
  ])('does not offer an unusable or stale clarification (%j)', state => {
    const html = render(result({ ...state, question }));
    expect(html).not.toContain('role="group"');
    expect(html).not.toContain(question.text);
    expect(html).toContain('Your next step');
  });

  it('disables answer buttons while busy and keeps cancellation available', () => {
    const html = render(result({ status: 'needs_context', question, continuation: 'opaque' }), { busy: true });
    for (const option of question.options) expect(html).toContain(`disabled="">${option}</button>`);
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Cancel check<\/button>/);
  });

  it.each([
    ['retry', 'Try again'], ['edit_input', 'Edit input'], ['clearer_image', 'Choose clearer screenshot'], ['none', 'Back to input'],
  ] as const)('uses the recovery appropriate to an incomplete result: %s', (recovery, label) => {
    const value = result({ status: 'partial', recovery });
    expect(getResultPresentation(value)).toMatchObject({ recovery, recoveryLabel: label });
    const html = render(value);
    expect(html).toContain(`>${label}</button>`);
    expect(html.includes('>Try again</button>')).toBe(recovery === 'retry');
    if (recovery === 'retry') expect(html).toContain('>Edit input</button>');
  });

  it('defaults older partial responses to editing rather than suggesting another paid check', () => {
    const html = render(result({ status: 'partial' }));
    expect(html).toContain('>Edit input</button>');
    expect(html).not.toContain('Try again');
  });

  it('does not offer retry on a completed result even if a stale recovery field is present', () => {
    const html = render(result({ status: 'complete', recovery: 'retry' }));
    expect(html).toContain('>Edit input</button>');
    expect(html).not.toContain('Try again');
  });

  it('rendering and rerendering recovery or clarification never invokes callbacks', () => {
    const handlers = callbacks();
    const values = [result({ status: 'partial', recovery: 'retry' }), result({ status: 'needs_context', question, continuation: 'opaque' })];
    for (const value of values) {
      render(value, handlers);
      render(value, { ...handlers, busy: true });
    }
    // SSR checks the real component's render path; it does not simulate hydrated browser interaction.
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  });

  it('shows supplied failure recovery without adding a second retry control', () => {
    const failure = createElement('div', { role: 'alert' }, createElement('p', null, 'Your input is still here.'), createElement('button', null, 'Retry saved input'));
    const html = render(result({ status: 'partial', recovery: 'retry' }), { failure });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Retry saved input');
    expect(html).not.toContain('>Try again</button>');
    expect(html).toContain('The message asks for a payment.');
  });

  it('disables a repeated retry during a pending check and exposes cancel', () => {
    const html = render(result({ status: 'partial', recovery: 'retry' }), { busy: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Checking…<\/button>/);
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Cancel check<\/button>/);
    expect(html).not.toContain('>Try again</button>');
  });

  it('offers screenshot text review without requiring a replacement upload', () => {
    const html = render(result({ extraction: extraction({ transcript: 'Please pay a parcel fee.' }) }), { mode: 'screenshot' });
    expect(html).toContain('>Review screenshot text</button>');
    expect(html).not.toContain('Choose clearer screenshot');
  });

  it('offers one visible correction route for ambiguous screenshots without claiming every issue is unreadable', () => {
    const html = render(result({ status: 'partial', recovery: 'clearer_image',
      extraction: extraction({ transcript: 'Send the code.', unreadableDetails: ['Added text disagrees with the screenshot.'] }),
    }), { mode: 'screenshot' });
    expect(html).toContain('Unclear or conflicting details: Added text disagrees with the screenshot.');
    expect(html).not.toContain('Could not read:');
    expect(html.match(/>Review screenshot text<\/button>/g)).toHaveLength(1);
    expect(html.indexOf('>Review screenshot text</button>')).toBeLessThan(html.indexOf('<details'));
    expect(html).not.toContain('>Try again</button>');
  });

  it('allows text correction after screenshot abstention even when no extraction is available', () => {
    const html = render(result({ status: 'partial', recovery: 'clearer_image', extraction: null }), { mode: 'screenshot' });
    expect(html).toContain('>Choose clearer screenshot</button>');
    expect(html).toContain('>Review screenshot text</button>');
    expect(html).not.toContain('<details');
  });

  it('makes reconciliation the primary action and labels each account without calling it unreadable', () => {
    const value = result({ status: 'partial', recovery: 'edit_input', extraction: extraction({ screenshotIssues: [screenshotIssue()] }) });
    const html = render(value, { mode: 'screenshot' });
    expect(getResultPresentation(value)).toMatchObject({ hasReadDetails: true, reviewConflict: true, recoveryLabel: 'Review screenshot text' });
    expect(html.match(/>Review screenshot text<\/button>/g)).toHaveLength(1);
    expect(html.indexOf('>Review screenshot text</button>')).toBeLessThan(html.indexOf('<details'));
    expect(html).toContain('Conflicting details');
    expect(html).toContain('Image reading');
    expect(html).toContain('Your typed correction');
    expect(html).toContain('Do not send the code to this chat.');
    expect(html).toContain('Send the code to the support agent.');
    expect(html).not.toMatch(/Choose clearer screenshot|Not readable in the image|>Try again<|>Edit input<\/button>/);
  });

  it('distinguishes a conflicting added context from screenshot transcription', () => {
    const value = result({ status: 'partial', recovery: 'edit_input', extraction: extraction({ screenshotIssues: [screenshotIssue({ userSource: 'context' })] }) });
    const html = render(value, { mode: 'screenshot' });
    expect(getResultPresentation(value)).toMatchObject({ reviewConflict: true, recoveryLabel: 'Review added context' });
    expect(html).toContain('>Review added context</button>');
    expect(html).toContain('Your added context');
    expect(html).not.toContain('Your typed correction');
  });

  it('shows absent and unreadable screenshot details separately while escaping quoted content', () => {
    const value = result({ extraction: extraction({ screenshotIssues: [
      screenshotIssue({ kind: 'missing_detail', target: 'link_destination', location: 'button', consequential: false,
        imageQuote: '<a href="https://untrusted.example">View details</a>', userQuote: null, userSource: null }),
      screenshotIssue({ kind: 'unreadable_region', target: 'reference_number', consequential: false,
        imageQuote: null, userQuote: null, userSource: null }),
    ] }) });
    const html = render(value, { mode: 'screenshot' });
    expect(html).toContain('Not shown in the image');
    expect(html).toContain('Not readable in the image');
    expect(html).toContain('Link destination (button)');
    expect(html).toContain('&lt;a href=');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('Conflicting details');
  });

  it('uses typed issues as authoritative while preserving absent-field legacy rendering', () => {
    const legacy = extraction({ unreadableDetails: ['A legacy ambiguity note'] });
    expect(render(result({ extraction: legacy }))).toContain('A legacy ambiguity note');
    const typed = result({ extraction: { ...legacy, screenshotIssues: [] } });
    expect(getResultPresentation(typed).hasReadDetails).toBe(false);
    expect(render(typed)).not.toContain('A legacy ambiguity note');
  });
});

describe('correction drafts', () => {
  it.each(['I already paid the merchant.', '  Keep my exact spacing.\n', '验证码不要发给他'])('preserves populated user corrections exactly: %s', current => {
    expect(correctionText(current, 'A different model transcript.')).toBe(current);
  });

  it('uses model text only when no populated correction exists', () => {
    expect(correctionText('', 'The visible text.')).toBe('The visible text.');
    expect(correctionText(' \n ', 'The visible text.')).toBe('The visible text.');
    expect(correctionText('My correction.', undefined)).toBe('My correction.');
  });

  it('keeps the current draft when no transcript is available', () => {
    expect(correctionText('')).toBe('');
    expect(correctionText(' \n ')).toBe(' \n ');
  });
});
