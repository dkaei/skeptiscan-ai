import type { CheckInput, Extraction } from '../shared/contracts';

export const QUOTE_SOURCE_IDS = ['content', 'context', 'senderEmail', 'senderPhone', 'transcript'] as const;
export type QuoteSourceId = typeof QUOTE_SOURCE_IDS[number];
export interface QuoteSource { readonly id: QuoteSourceId; readonly text: string }
/** Offsets are half-open JavaScript UTF-16 positions in one identified source. */
export interface QuoteSpan { readonly source: QuoteSourceId; readonly start: number; readonly end: number }
export const QUOTE_FAILURE_CODES = [
  'quote_empty', 'quote_source_invalid', 'quote_span_invalid',
  'quote_whitespace_mismatch', 'quote_mismatch',
] as const;
export type QuoteFailureCode = typeof QUOTE_FAILURE_CODES[number];
export type QuoteGroundingResult =
  | { matched: true; span: QuoteSpan }
  | { matched: false; code: QuoteFailureCode };

const sourceIds = new Set<string>(QUOTE_SOURCE_IDS);
const fail = (code: QuoteFailureCode): QuoteGroundingResult => ({ matched: false, code });

/**
 * Keep original accounts separate. A text-model transcript is never a source.
 * A screenshot transcript is model-read material, not independently verified
 * pixels; a matching span establishes copying only, not reading accuracy.
 */
export function quoteSourcesFor(
  input: Pick<CheckInput, 'mode' | 'content' | 'context' | 'senderEmail' | 'senderPhone'>,
  extraction?: Pick<Extraction, 'transcript'>,
): QuoteSource[] {
  const sources: QuoteSource[] = [
    { id: 'content', text: input.content },
    { id: 'context', text: input.context },
    { id: 'senderEmail', text: input.senderEmail },
    { id: 'senderPhone', text: input.senderPhone },
  ];
  if (input.mode === 'screenshot') sources.push({ id: 'transcript', text: extraction?.transcript ?? '' });
  return sources.filter(source => typeof source.text === 'string' && source.text.length > 0);
}

function selectSources(sources: readonly QuoteSource[], sourceId?: QuoteSourceId): readonly QuoteSource[] | null {
  if (!Array.isArray(sources) || sources.length > QUOTE_SOURCE_IDS.length) return null;
  const seen = new Set<string>();
  for (const source of sources) {
    if (!source || !sourceIds.has(source.id) || typeof source.text !== 'string' || seen.has(source.id)) return null;
    seen.add(source.id);
  }
  if (sourceId === undefined) return sources;
  if (!sourceIds.has(sourceId) || !seen.has(sourceId)) return null;
  return sources.filter(source => source.id === sourceId);
}

/**
 * Diagnostic only: collapse whitespace runs, preserving every non-whitespace
 * character, its case and order. Do not use this result to accept, repair or
 * display a quote. This classification does not establish semantic equivalence.
 */
function mismatchCode(quote: string, texts: readonly string[], wholeSpan = false): QuoteFailureCode {
  const diagnosticQuote = quote.replace(/\s+/gu, ' ');
  return texts.some(text => {
    const diagnosticSource = text.replace(/\s+/gu, ' ');
    return wholeSpan ? diagnosticSource === diagnosticQuote : diagnosticSource.includes(diagnosticQuote);
  })
    ? 'quote_whitespace_mismatch'
    : 'quote_mismatch';
}

/**
 * Resolve an exact quote to a single source. A requested source cannot fall
 * back to another account. Never concatenate sources or normalise a match.
 * Results contain only finite categories or an identified span, never text.
 */
export function findExactQuoteSpan(
  quote: string,
  sources: readonly QuoteSource[],
  sourceId?: QuoteSourceId,
): QuoteGroundingResult {
  if (typeof quote !== 'string') return fail('quote_mismatch');
  if (!quote.trim()) return fail('quote_empty');
  const selected = selectSources(sources, sourceId);
  if (!selected) return fail('quote_source_invalid');
  for (const source of selected) {
    const start = source.text.indexOf(quote);
    if (start >= 0) return { matched: true, span: { source: source.id, start, end: start + quote.length } };
  }
  return fail(mismatchCode(quote, selected.map(source => source.text)));
}

/** Validate supplied span linkage without searching for a better location. */
export function validateExactQuoteSpan(
  quote: string,
  sources: readonly QuoteSource[],
  span: QuoteSpan,
): QuoteGroundingResult {
  if (typeof quote !== 'string') return fail('quote_mismatch');
  if (!quote.trim()) return fail('quote_empty');
  if (!span || typeof span !== 'object') return fail('quote_span_invalid');
  if (!sourceIds.has(span.source)) return fail('quote_source_invalid');
  const selected = selectSources(sources, span.source);
  if (!selected) return fail('quote_source_invalid');
  const source = selected[0];
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
    || span.start < 0 || span.end <= span.start || span.end > source.text.length) {
    return fail('quote_span_invalid');
  }
  const actual = source.text.slice(span.start, span.end);
  if (actual === quote) return { matched: true, span: { source: span.source, start: span.start, end: span.end } };
  return fail(mismatchCode(quote, [actual], true));
}
