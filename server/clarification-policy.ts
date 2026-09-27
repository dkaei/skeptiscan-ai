import { QUESTIONS, type CheckInput, type Extraction, type Review } from '../shared/contracts';
import { findExactQuoteSpan, quoteSourcesFor } from './grounding';

// These terms establish the subject of an approved question, not its answer or
// the truth of a model's interpretation. No arbitrary question text is accepted.
const TOPIC = {
  sharing_code: /\b(?:code|otp|pin|password|(?:six|6)[ -]?digits?)\b/i,
  asked_to_install: /\b(?:apps?|applications?|software|install(?:s|ed|ing|ation)?|access|control|support|restart)\b/i,
  payment_expected: /\b(?:pay|pays|paid|paying|payments?|transfer(?:s|red|ring)?|invoices?|fees?|deposits?|refunds?|money)\b/i,
  initiated_request: /\b(?:request(?:s|ed|ing)?|contact(?:s|ed|ing)?|call(?:s|ed|ing)?|messages?|sign[ -]?in|log[ -]?in|account)\b/i,
};

/** An extractor omission must not veto a separately grounded reviewer question. */
export function hasQuestionBasis(review: Review, input: CheckInput, extraction: Extraction): boolean {
  if (!review.questionId) return true;
  if (review.finding !== 'unclear_request') return false;
  // Older injected fixtures have no rationale. They retain the previous gate.
  if (review.rationale === undefined) return extraction.missingContext.includes(QUESTIONS[review.questionId].text);
  const rationale = review.rationale;
  if (!rationale || rationale.relation !== 'unclear_context' || rationale.risks.length) return false;
  const sources = quoteSourcesFor(input, extraction);
  if (rationale.anchors.some(anchor => !findExactQuoteSpan(anchor.quote, sources, anchor.source).matched)) return false;
  return rationale.anchors.some(anchor => TOPIC[review.questionId!].test(anchor.quote));
}
