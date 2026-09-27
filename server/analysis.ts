import {
  ACTIONS, QUESTIONS, CheckResultSchema, EvidenceSchema, QuestionIdSchema, ReviewSchema,
  type CheckInput, type CheckResult, type Evidence, type Extraction, type QuestionId, type Review,
} from '../shared/contracts';
import { ValidatedExtractionSchema, ModelGatewayError } from './openai';
import type { ModelGateway, ModelOutput, ModelUsage } from './types';
import { renderDecision } from './review-policy';
import { diagnosticFor, type CheckDiagnostic } from './diagnostics';
import { findExactQuoteSpan, quoteSourcesFor, validateExactQuoteSpan } from './grounding';
import { validateScreenshotIssues, getScreenshotIssueOutcome, triageScreenshotIssues } from './screenshot-issues';
import { hasQuestionBasis } from './clarification-policy';

type AnalysisStage = 'extraction' | 'extraction_validation' | 'evidence' | 'review' | 'review_validation';
export type AnalysisDiagnostic = CheckDiagnostic;
function diagnose(deps: AnalysisDependencies, requestId: string, stage: AnalysisStage, error: unknown) {
  // Never forward errors, model output or user input to logs.
  try { deps.reportFailure?.(diagnosticFor(requestId, stage, error, deps.signal)); } catch { /* Logging cannot change the result. */ }
}

export interface AnalysisDependencies {
  models: ModelGateway | null;
  collectEvidence: (input: CheckInput, extraction: Extraction) => Promise<Evidence[]>;
  beforeCall: (stage: 'extract' | 'review') => Promise<void>;
  afterCall: (usage: ModelUsage) => Promise<void>;
  signal: AbortSignal;
  reportFailure?: (diagnostic: AnalysisDiagnostic) => void;
}
export interface AnalysisOutput { result: CheckResult; review?: Review; extraction?: Extraction }

function suppliedText(input: CheckInput, extraction?: Extraction): string {
  return [input.content, input.context, input.senderEmail, input.senderPhone,
    input.mode === 'screenshot' ? extraction?.transcript ?? '' : '',
  ].filter(Boolean).join('\n');
}

function literalPresent(literal: string, text: string, organisation = false): boolean {
  if (!literal) return false;
  let start = text.indexOf(literal);
  while (start >= 0) {
    const before = text[start - 1] ?? '';
    const end = start + literal.length;
    const next = text[end] ?? '';
    const terminalPunctuation = next === '.' || (organisation && /[:,;!?]/.test(next));
    const after = terminalPunctuation && (end + 1 === text.length || /\s/.test(text[end + 1])) ? '' : next;
    if (!/[\p{L}\p{N}._@:/?=&%+\-]/u.test(before) && !/[\p{L}\p{N}._@:/?=&%+\-]/u.test(after)) return true;
    start = text.indexOf(literal, start + 1);
  }
  return false;
}

function localExtraction(input: CheckInput): Extraction {
  const text = suppliedText(input);
  const urls = [...text.matchAll(/https?:\/\/[^\s<>"']+|www\.[^\s<>"']+/g)].map(m => m[0].replace(/[),;!]+$/, '')).slice(0, 3);
  if (input.mode === 'link' && !urls.length && input.content.trim() && !/\s/.test(input.content.trim())) urls.push(input.content.trim());
  return { transcript: '', claimedOrganisation: null, urls, phoneNumbers: input.senderPhone ? [input.senderPhone] : [], requestedActions: [], unreadableDetails: [], missingContext: [] };
}

function validateExtraction(input: CheckInput, value: Extraction): Extraction {
  const extraction = ValidatedExtractionSchema.parse(value);
  // Text-model paraphrases cannot become a second, invented source of evidence.
  if (input.mode !== 'screenshot') extraction.transcript = '';
  if (extraction.screenshotIssues !== undefined && extraction.unreadableDetails.length) throw new Error('invalid_screenshot_issue');
  const text = suppliedText(input, extraction);
  if (extraction.urls.some(url => !literalPresent(url, text)) || extraction.phoneNumbers.some(phone => !literalPresent(phone, text))) {
    throw new Error('ungrounded_entity');
  }
  const sources = quoteSourcesFor(input, extraction);
  extraction.requestedActions = extraction.requestedActions.map(action => {
    const match = action.span ? validateExactQuoteSpan(action.quote, sources, action.span)
      : findExactQuoteSpan(action.quote, sources, action.source);
    if (!match.matched) throw new Error(match.code === 'quote_whitespace_mismatch' ? 'ungrounded_quote_whitespace' : 'ungrounded_quote');
    if (action.source && action.source !== match.span.source) throw new Error('ungrounded_quote');
    // Retain old fixture/capture shape, but live source-labelled quotes always
    // carry server-derived offsets, rechecked on the signed continuation.
    return action.source || action.span ? { ...action, source: match.span.source, span: match.span } : action;
  });
  if (extraction.claimedOrganisation && !literalPresent(extraction.claimedOrganisation.toLocaleLowerCase(), text.toLocaleLowerCase(), true)) {
    // Optional metadata is not evidence. Drop an unsupported name while keeping
    // independently grounded requests; never infer it from a hostname or role.
    extraction.claimedOrganisation = null;
  }
  validateScreenshotIssues(input, extraction);
  if (input.mode === 'screenshot' && extraction.screenshotIssues !== undefined) {
    extraction.screenshotIssues = triageScreenshotIssues(input, extraction).effectiveIssues;
  }
  return extraction;
}

function validateEvidence(evidence: Evidence[]): Evidence[] {
  if (evidence.length > 30) throw new Error('too_many_evidence_items');
  const parsed = evidence.map(item => EvidenceSchema.parse(item));
  if (new Set(parsed.map(item => item.id)).size !== parsed.length) throw new Error('duplicate_evidence_id');
  return parsed;
}

function validateReview(input: CheckInput, extraction: Extraction, evidence: Evidence[], value: Review, final: boolean): Review {
  const review = ReviewSchema.parse(value);
  const ids = new Set(evidence.map(item => item.id));
  if (review.evidenceIds.some(id => !ids.has(id))) throw new Error('invented_evidence');
  if (review.quotes.some(quote => !findExactQuoteSpan(quote, quoteSourcesFor(input, extraction)).matched)) throw new Error('invented_quote');
  if ((review.actionId === 'need_context') !== (review.questionId !== null)) throw new Error('question_state_mismatch');
  if (final && review.questionId !== null) throw new Error('further_question');
  if (review.finding === 'unreadable_image') throw new Error('review_unreadable_image');
  if (review.questionId && !hasQuestionBasis(review, input, extraction)) throw new Error('question_not_missing');
  if (!['identity_unknown', 'link_only', 'unclear_request'].includes(review.finding) && !review.quotes.length) throw new Error('missing_action_quote');
  const rendered = renderDecision({ finding: review.finding, questionId: review.questionId, evidenceIds: review.evidenceIds, quotes: review.quotes,
    ...(review.rationale !== undefined ? { rationale: review.rationale } : {}),
  }, input, evidence, extraction);
  if (review.rationale !== undefined && (review.quotes.length !== rendered.quotes.length
    || review.quotes.some((quote, index) => quote !== rendered.quotes[index]))) throw new Error('quote_projection_mismatch');
  if (review.actionId !== rendered.actionId || review.reason !== rendered.reason) throw new Error('action_reason_mismatch');
  return rendered;
}

const PARTIAL_COPY = {
  ai_unavailable: {
    reason: 'AI analysis is not connected.',
    uncertainty: 'Available checks do not assess the whole request.',
    recovery: 'none',
  },
  input_limit: {
    reason: 'This input exceeds the analysis limit. Use a shorter excerpt or crop the screenshot.',
    uncertainty: 'The full request has not been assessed.',
    recovery: 'edit_input',
  },
  unreadable_image: {
    reason: 'Some screenshot details are unclear or inconsistent.',
    uncertainty: 'Unclear or conflicting details could change the next step.',
    recovery: 'clearer_image',
  },
  ungrounded_image: {
    reason: 'A detail read from the screenshot could not be linked to its exact source text.',
    nextStep: 'Review the screenshot or add text you can verify before checking again.',
    uncertainty: 'The image has not been assessed reliably. Uncertain details have not been accepted as evidence.',
    recovery: 'edit_input',
  },
  timeout: {
    reason: 'The AI took too long to respond.',
    uncertainty: 'No completed assessment is available.',
    recovery: 'retry',
  },
  analysis_failed: {
    reason: 'The check could not analyse these details reliably.',
    uncertainty: 'No completed assessment is available.',
    recovery: 'retry',
  },
  review_failed: {
    reason: 'The final AI review could not be completed.',
    uncertainty: 'Earlier findings do not replace a completed assessment.',
    recovery: 'retry',
  },
  checking_unavailable: {
    reason: 'Checking is unavailable right now.',
    uncertainty: 'No completed assessment is available.',
    recovery: 'none',
  },
  service_busy: {
    reason: 'The AI service is busy. Try again later.',
    uncertainty: 'No completed assessment is available.',
    recovery: 'none',
  },
  clarification_failed: {
    reason: 'The answer could not be assessed reliably.',
    uncertainty: 'The earlier question remains unresolved.',
    recovery: 'edit_input',
  },
} as const satisfies Record<string, Pick<CheckResult, 'reason' | 'uncertainty' | 'recovery'> & Partial<Pick<CheckResult, 'nextStep'>>>;

function partial(requestId: string, evidence: Evidence[], extraction: Extraction | undefined, aiUsed: boolean, kind: keyof typeof PARTIAL_COPY): AnalysisOutput {
  return {
    result: CheckResultSchema.parse({
      requestId, status: 'partial', title: 'Check incomplete',
      nextStep: ACTIONS.pause_and_verify.nextStep,
      ...PARTIAL_COPY[kind],
      evidence, extraction: extraction ?? null, question: null,
      checkedAt: new Date().toISOString(), aiUsed,
    }),
    ...(extraction ? { extraction } : {}),
  };
}

function completed(requestId: string, extraction: Extraction, evidence: Evidence[], review: Review): AnalysisOutput {
  const issues = getScreenshotIssueOutcome(extraction.screenshotIssues ?? []);
  const unresolvedConflict = review.finding === 'unclear_request' && review.rationale?.relation === 'conflicting_accounts';
  return {
    result: CheckResultSchema.parse({
      requestId, status: unresolvedConflict ? 'partial' : review.questionId ? 'needs_context' : 'complete', ...ACTIONS[review.actionId],
      reason: review.reason, uncertainty: [review.uncertainty, ...issues.notes].join(' '),
      evidence, extraction,
      question: review.questionId ? { id: review.questionId, ...QUESTIONS[review.questionId] } : null,
      checkedAt: new Date().toISOString(), aiUsed: true,
      ...(unresolvedConflict ? { recovery: 'edit_input' } : {}),
    }), extraction, review,
  };
}

function screenshotPartial(requestId: string, extraction: Extraction): AnalysisOutput | undefined {
  if (extraction.screenshotIssues !== undefined) {
    const issue = getScreenshotIssueOutcome(extraction.screenshotIssues);
    if (issue.blocking) {
      const output = partial(requestId, [], extraction, true, 'unreadable_image');
      output.result = CheckResultSchema.parse({ ...output.result,
        reason: issue.reason, nextStep: issue.nextStep, uncertainty: issue.uncertainty,
        recovery: issue.recovery,
      });
      return output;
    }
  }
  if (!extraction.transcript.trim() || (extraction.screenshotIssues === undefined && extraction.unreadableDetails.length)) {
    return partial(requestId, [], extraction, true, 'unreadable_image');
  }
}

async function modelCall<T>(stage: 'extract' | 'review', deps: AnalysisDependencies, call: () => Promise<ModelOutput<T>>): Promise<T> {
  deps.signal.throwIfAborted();
  try { await deps.beforeCall(stage); } catch { throw new Error('call_admission'); }
  let output: ModelOutput<T>;
  try { output = await call(); }
  catch (error) {
    if (error instanceof ModelGatewayError && error.usage) {
      try { await deps.afterCall(error.usage); } catch { throw new Error('usage_accounting'); }
    } else if (error instanceof ModelGatewayError && error.notDispatched) {
      // Settle the admitted attempt, not fabricated provider usage. Only the gateway
      // can certify that generation was never invoked; dispatched failures stay reserved.
      try { await deps.afterCall({ model: error.notDispatched.model, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 }); }
      catch { throw new Error('usage_accounting'); }
    }
    throw error;
  }
  // Persist billing before interpreting the returned data, even if it is invalid.
  try { await deps.afterCall(output.usage); } catch { throw new Error('usage_accounting'); }
  deps.signal.throwIfAborted();
  return output.value;
}

export async function runAnalysis(requestId: string, input: CheckInput, deps: AnalysisDependencies): Promise<AnalysisOutput> {
  let extraction: Extraction | undefined;
  let evidence: Evidence[] = [];
  let aiUsed = false;
  let stage: AnalysisStage = 'extraction';
  if (!deps.models) {
    try { evidence = validateEvidence(await deps.collectEvidence(input, localExtraction(input))); } catch { /* Explicit partial state below. */ }
    return partial(requestId, evidence, undefined, false, 'ai_unavailable');
  }
  try {
    aiUsed = true;
    const extracted = await modelCall('extract', deps, () => deps.models!.extract(input, deps.signal));
    stage = 'extraction_validation';
    extraction = validateExtraction(input, extracted);
    if (input.mode === 'screenshot') {
      const stopped = screenshotPartial(requestId, extraction);
      if (stopped) {
        const issue = extraction.screenshotIssues?.find(item => item.consequential);
        diagnose(deps, requestId, stage, new Error(issue?.kind === 'conflicting_accounts' ? 'screenshot_conflict'
          : issue?.kind === 'missing_detail' ? 'screenshot_missing_detail' : 'unreadable_image'));
        return stopped;
      }
    }
    stage = 'evidence';
    evidence = validateEvidence(await deps.collectEvidence(input, extraction));
    stage = 'review';
    const reviewed = await modelCall('review', deps, () => deps.models!.review(input, extraction!, evidence, deps.signal));
    stage = 'review_validation';
    const review = validateReview(input, extraction, evidence, reviewed, false);
    return completed(requestId, extraction, evidence, review);
  } catch (error) {
    if (stage === 'extraction' && ((error instanceof ModelGatewayError && error.notDispatched)
      || (error instanceof Error && error.message === 'call_admission'))) aiUsed = false;
    diagnose(deps, requestId, stage, error);
    // Salvage deterministic observations from original TEXT, never rejected entities
    // or an unreadable image. Explicitly prevent a new external lookup on failure.
    if (!input.image && !evidence.length && !deps.signal.aborted && !(error instanceof Error && ['usage_accounting', 'call_admission'].includes(error.message))) {
      try { evidence = validateEvidence(await deps.collectEvidence({ ...input, externalLookup: false }, localExtraction(input))); }
      catch { /* Preserve the original stage failure without another provider call. */ }
    }
    const kind = error instanceof ModelGatewayError && error.code === 'MODEL_INPUT_TOO_LARGE'
      ? 'input_limit'
      : error instanceof ModelGatewayError && error.code === 'MODEL_TIMEOUT'
      ? 'timeout'
      : error instanceof ModelGatewayError && error.code === 'MODEL_RATE_LIMITED'
      ? 'service_busy'
      : input.mode === 'screenshot' && error instanceof Error && error.message === 'review_unreadable_image'
      ? 'unreadable_image'
      : input.mode === 'screenshot' && error instanceof Error && ['ungrounded_quote', 'ungrounded_quote_whitespace', 'ungrounded_screenshot_issue'].includes(error.message)
      ? 'ungrounded_image'
      : (error instanceof ModelGatewayError && ['MODEL_AUTHENTICATION_FAILED', 'MODEL_CONFIGURATION_CHANGED'].includes(error.code))
        || (error instanceof Error && ['call_admission', 'usage_accounting'].includes(error.message))
      ? 'checking_unavailable'
      : stage === 'review' || stage === 'review_validation'
      ? 'review_failed'
      : 'analysis_failed';
    return partial(requestId, evidence, extraction, aiUsed, kind);
  }
}

export async function reviewClarification(
  requestId: string, input: CheckInput, extraction: Extraction, evidence: Evidence[],
  questionId: QuestionId, answer: 'yes' | 'no' | 'unsure', deps: AnalysisDependencies,
): Promise<AnalysisOutput> {
  if (!deps.models) return partial(requestId, evidence, extraction, false, 'ai_unavailable');
  let stage: AnalysisStage = 'extraction_validation';
  try {
    QuestionIdSchema.parse(questionId);
    if (!['yes', 'no', 'unsure'].includes(answer)) throw new Error('invalid_answer');
    const validExtraction = validateExtraction(input, extraction);
    const validEvidence = validateEvidence(evidence);
    if (input.mode === 'screenshot') {
      const stopped = screenshotPartial(requestId, validExtraction);
      if (stopped) return stopped;
    }
    stage = 'review';
    const reviewed = await modelCall('review', deps, () => deps.models!.review(input, validExtraction, validEvidence, deps.signal, { questionId, answer }));
    stage = 'review_validation';
    const review = validateReview(input, validExtraction, validEvidence, reviewed, true);
    return completed(requestId, validExtraction, validEvidence, review);
  } catch (error) {
    diagnose(deps, requestId, stage, error);
    return partial(requestId, evidence, extraction, true, 'clarification_failed');
  }
}
