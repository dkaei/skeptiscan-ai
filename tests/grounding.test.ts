import { describe, expect, it, vi } from 'vitest';
import {
  findExactQuoteSpan, quoteSourcesFor, validateExactQuoteSpan,
  type QuoteSource, type QuoteSourceId, type QuoteSpan,
} from '../server/grounding';
import type { CheckInput } from '../shared/contracts';

const input: CheckInput = {
  mode: 'message', content: 'Do not tell anyone your login code.', context: '',
  senderEmail: '', senderPhone: '', externalLookup: false,
};
const transcript = 'Parcel notice\nPay S$2.00 at\nhttps://parcel.example/pay\nto arrange delivery.';
const screenshotSources: QuoteSource[] = [{ id: 'transcript', text: transcript }];

describe('exact source-linked quote grounding', () => {
  it('links literal screenshot text with line breaks, amount and URL unchanged', () => {
    const quote = 'Pay S$2.00 at\nhttps://parcel.example/pay';
    const result = findExactQuoteSpan(quote, screenshotSources, 'transcript');
    expect(result).toEqual({ matched: true, span: { source: 'transcript', start: 14, end: 54 } });
    if (!result.matched) throw new Error('Expected the exact screenshot span');
    expect(validateExactQuoteSpan(quote, screenshotSources, result.span)).toEqual(result);
  });

  it('keeps the typed correction and model-read screenshot as separate accounts', () => {
    const sources = quoteSourcesFor({ ...input, mode: 'screenshot', content: 'I enter it only in my own app.' }, {
      transcript: 'Tell the caller your login code.',
    });
    expect(findExactQuoteSpan('my own app', sources, 'content')).toMatchObject({ matched: true, span: { source: 'content' } });
    expect(findExactQuoteSpan('my own app', sources, 'transcript')).toEqual({ matched: false, code: 'quote_mismatch' });
    expect(findExactQuoteSpan('caller your login code', sources, 'transcript')).toMatchObject({ matched: true, span: { source: 'transcript' } });
    expect(findExactQuoteSpan('caller your login code', sources, 'content')).toEqual({ matched: false, code: 'quote_mismatch' });
  });

  it('does not promote a model-created transcript into evidence for text input', () => {
    const sources = quoteSourcesFor(input, { transcript: 'The user should share the code.' });
    expect(sources.map(source => source.id)).toEqual(['content']);
    expect(findExactQuoteSpan('should share the code', sources)).toEqual({ matched: false, code: 'quote_mismatch' });
    expect(findExactQuoteSpan(input.content, sources, 'transcript')).toEqual({ matched: false, code: 'quote_source_invalid' });
  });

  it('preserves contextual source identity instead of inventing a cross-field quote', () => {
    const sources = quoteSourcesFor({ ...input, content: 'Do not send', context: 'the login code.' });
    expect(findExactQuoteSpan('Do not send\nthe login code.', sources)).toEqual({ matched: false, code: 'quote_mismatch' });
    expect(findExactQuoteSpan('the login code.', sources, 'context')).toEqual({
      matched: true, span: { source: 'context', start: 0, end: 15 },
    });
  });

  it('supports exact sender fields without inferring a sender identity', () => {
    const sources = quoteSourcesFor({ ...input, senderEmail: 'name@example.org', senderPhone: '+65 6123 4567' });
    expect(findExactQuoteSpan('name@example.org', sources, 'senderEmail')).toEqual({ matched: true, span: { source: 'senderEmail', start: 0, end: 16 } });
    expect(findExactQuoteSpan('+65 6123 4567', sources, 'senderPhone')).toEqual({ matched: true, span: { source: 'senderPhone', start: 0, end: 13 } });
    expect(findExactQuoteSpan('Example Organisation', sources)).toEqual({ matched: false, code: 'quote_mismatch' });
  });

  it('retains literal negation and Unicode characters without canonicalisation', () => {
    const text = '🔒 不要透露验证码。 Do not send S$20.00.';
    const sources: QuoteSource[] = [{ id: 'content', text }];
    const quote = '不要透露验证码。';
    const result = findExactQuoteSpan(quote, sources);
    expect(result).toEqual({ matched: true, span: { source: 'content', start: 3, end: 11 } });
    expect(findExactQuoteSpan('Do send S$20.00.', sources)).toEqual({ matched: false, code: 'quote_mismatch' });
    if (result.matched) expect(text.slice(result.span.start, result.span.end)).toBe(quote);
  });

  it('grounds exact substrings without claiming that the interpretation preserves negation', () => {
    // Grounding establishes copying only; the reviewer still must read the full context.
    expect(findExactQuoteSpan('tell anyone your login code', quoteSourcesFor(input))).toMatchObject({ matched: true });
  });

  it('uses the first exact occurrence unless a precise alternate span is supplied', () => {
    const sources: QuoteSource[] = [{ id: 'context', text: 'code / code' }];
    expect(findExactQuoteSpan('code', sources)).toEqual({ matched: true, span: { source: 'context', start: 0, end: 4 } });
    expect(validateExactQuoteSpan('code', sources, { source: 'context', start: 7, end: 11 })).toEqual({ matched: true, span: { source: 'context', start: 7, end: 11 } });
    expect(validateExactQuoteSpan('code', sources, { source: 'context', start: 2, end: 6 })).toEqual({ matched: false, code: 'quote_mismatch' });
  });

  it.each([
    ['Pay S$2.00 at https://parcel.example/pay', 'quote_whitespace_mismatch'],
    ['Pay S$2.00 at\r\nhttps://parcel.example/pay', 'quote_whitespace_mismatch'],
    ['Pay S$2.00 at\t https://parcel.example/pay', 'quote_whitespace_mismatch'],
    ['Pay S$2.00 at\u00a0https://parcel.example/pay', 'quote_whitespace_mismatch'],
    ['Pay S$20.00 at\nhttps://parcel.example/pay', 'quote_mismatch'],
    ['Pay S$2.00 at\nhttps://parcel.example.com/pay', 'quote_mismatch'],
    ['Pay S$2.00 at\nhttps://parcel.example/Pay', 'quote_mismatch'],
    ['pay S$2.00 at\nhttps://parcel.example/pay', 'quote_mismatch'],
    ['Do not pay S$2.00 at\nhttps://parcel.example/pay', 'quote_mismatch'],
    ['Pay S$2,00 at\nhttps://parcel.example/pay', 'quote_mismatch'],
    ['Pay S＄2.00 at\nhttps://parcel.example/pay', 'quote_mismatch'],
    ['Pay S$2.00 at\nhttps://parcel.examp\u200ble/pay', 'quote_mismatch'],
    ['Pay S$2.00 at https://parcel.example/pay urgently', 'quote_mismatch'],
  ] as const)('rejects %s with a text-free %s category', (quote, code) => {
    expect(transcript.includes(quote)).toBe(false);
    expect(findExactQuoteSpan(quote, screenshotSources, 'transcript')).toEqual({ matched: false, code });
  });

  it('never accepts a normalised Unicode equivalent', () => {
    const sources: QuoteSource[] = [{ id: 'content', text: 'Café account' }];
    expect(findExactQuoteSpan('Cafe\u0301 account', sources)).toEqual({ matched: false, code: 'quote_mismatch' });
  });

  it('reports whitespace-only span disagreement but still rejects the span', () => {
    const sources: QuoteSource[] = [{ id: 'transcript', text: 'send\ncode' }];
    expect(validateExactQuoteSpan('send code', sources, { source: 'transcript', start: 0, end: 9 })).toEqual({ matched: false, code: 'quote_whitespace_mismatch' });
  });

  it('does not mislabel an oversized source span as only a whitespace difference', () => {
    const sources: QuoteSource[] = [{ id: 'content', text: 'Pay now' }];
    expect(validateExactQuoteSpan('Pay', sources, { source: 'content', start: 0, end: 7 })).toEqual({ matched: false, code: 'quote_mismatch' });
  });

  it.each(['', ' ', '\r\n\t', '\u00a0'])('rejects an empty or whitespace-only quote %j', quote => {
    expect(findExactQuoteSpan(quote, [{ id: 'content', text: quote }])).toEqual({ matched: false, code: 'quote_empty' });
    expect(validateExactQuoteSpan(quote, screenshotSources, { source: 'transcript', start: 0, end: 1 })).toEqual({ matched: false, code: 'quote_empty' });
  });

  it.each([
    [-1, 2], [0, 0], [2, 1], [0, 1000], [0.5, 2], [0, 2.5],
    [NaN, 2], [0, NaN], [Infinity, 2], [0, Infinity], [0, Number.MAX_SAFE_INTEGER + 1],
    ['0', 2], [0, '2'],
  ])('rejects malformed offsets %j / %j without searching elsewhere', (start, end) => {
    expect(validateExactQuoteSpan('Pay', screenshotSources, { source: 'transcript', start, end } as QuoteSpan)).toEqual({ matched: false, code: 'quote_span_invalid' });
  });

  it.each(['providerGuess', '__proto__', 'constructor', 'CONTENT'])('rejects undeclared source %s even if the text exists elsewhere', source => {
    expect(findExactQuoteSpan('Pay', screenshotSources, source as QuoteSourceId)).toEqual({ matched: false, code: 'quote_source_invalid' });
    expect(validateExactQuoteSpan('Pay', screenshotSources, { source, start: 14, end: 17 } as QuoteSpan)).toEqual({ matched: false, code: 'quote_source_invalid' });
  });

  it('rejects absent and ambiguous source references', () => {
    expect(findExactQuoteSpan('Pay', screenshotSources, 'content')).toEqual({ matched: false, code: 'quote_source_invalid' });
    expect(validateExactQuoteSpan('Pay', screenshotSources, { source: 'content', start: 14, end: 17 })).toEqual({ matched: false, code: 'quote_source_invalid' });
    expect(findExactQuoteSpan('Pay', [...screenshotSources, { id: 'transcript', text: 'Different account' }])).toEqual({ matched: false, code: 'quote_source_invalid' });
    expect(findExactQuoteSpan('Pay', [{ id: 'invented', text: 'Pay' }] as unknown as QuoteSource[])).toEqual({ matched: false, code: 'quote_source_invalid' });
  });

  it('returns finite metadata only and has no diagnostic or network side effects', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network permitted'));
    try {
      const sensitive = 'PRIVATE_PASSWORD_A7 and ACCOUNT_TOKEN_B8';
      const sources: QuoteSource[] = [{ id: 'content', text: `Sender says ${sensitive}` }];
      const success = findExactQuoteSpan(sensitive, sources);
      const mismatch = findExactQuoteSpan(`Different ${sensitive}`, sources);
      const whitespace = findExactQuoteSpan(sensitive.replace(' and ', '\nand '), sources);
      expect(success).toMatchObject({ matched: true });
      expect(mismatch).toEqual({ matched: false, code: 'quote_mismatch' });
      expect(whitespace).toEqual({ matched: false, code: 'quote_whitespace_mismatch' });
      const metadata = JSON.stringify([success, mismatch, whitespace]);
      expect(metadata).not.toContain('PRIVATE_PASSWORD');
      expect(metadata).not.toContain('ACCOUNT_TOKEN');
      expect(metadata).not.toContain('Sender says');
      expect(warn).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); log.mockRestore(); fetch.mockRestore(); }
  });
});
