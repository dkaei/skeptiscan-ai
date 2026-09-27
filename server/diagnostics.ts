import { ServiceError } from './types';
import { RATIONALE_FAILURE_CODES } from './context-rationale';

export const DIAGNOSTIC_STAGES = [
  'admission', 'image', 'extraction', 'extraction_validation', 'evidence',
  'review', 'review_validation', 'continuation', 'deadline', 'settlement',
] as const;
export type DiagnosticStage = typeof DIAGNOSTIC_STAGES[number];
export interface CheckDiagnostic { requestId: string; stage: DiagnosticStage; code: string }
const FAILURE_CODES = new Set([
  ...RATIONALE_FAILURE_CODES,
  'MODEL_INPUT_TOO_LARGE', 'MODEL_IMAGE_INVALID', 'MODEL_TOKEN_COUNT_UNAVAILABLE', 'MODEL_TIMEOUT',
  'MODEL_CANCELLED', 'MODEL_AUTHENTICATION_FAILED', 'MODEL_RATE_LIMITED', 'MODEL_PROVIDER_UNAVAILABLE',
  'MODEL_CONNECTION_FAILED', 'BILLING_UNKNOWN', 'MODEL_CONFIGURATION_CHANGED', 'MODEL_USAGE_OUT_OF_BOUNDS',
  'MODEL_INCOMPLETE', 'MODEL_OUTPUT_INVALID', 'MODEL_REFUSAL', 'MODEL_DECISION_INVALID',
  'ungrounded_entity', 'ungrounded_quote', 'ungrounded_organisation', 'invented_evidence', 'invented_quote',
  'ungrounded_quote_whitespace', 'invalid_screenshot_issue', 'ungrounded_screenshot_issue',
  'screenshot_conflict', 'screenshot_missing_detail', 'ungrounded_rationale', 'invalid_rationale', 'missing_rationale',
  'question_state_mismatch', 'further_question', 'unnecessary_question', 'question_not_missing',
  'missing_action_quote', 'quote_projection_mismatch', 'action_reason_mismatch', 'unsupported_domain_match', 'unsupported_threat_lookup',
  'review_unreadable_image', 'unreadable_image', 'invalid_answer', 'too_many_evidence_items', 'duplicate_evidence_id',
  'call_admission', 'usage_accounting', 'analysis_deadline', 'stage_failed',
  'timeout', 'request_cancelled', 'invalid_image', 'image_processing', 'image_limit', 'images_unavailable',
  'duplicate_request', 'budget_configuration', 'budget_unavailable', 'busy', 'continuation_size',
  'continuation_unavailable', 'diagnostic_write_failed',
]);

/** Only bounded categories and a client-generated UUID can leave the request scope. */
export function diagnosticFor(requestId: string, stage: DiagnosticStage, error: unknown, signal?: AbortSignal): CheckDiagnostic {
  const candidate = error instanceof ServiceError ? error.code : error instanceof Error ? error.message : '';
  return {
    requestId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId) ? requestId : 'invalid',
    stage: DIAGNOSTIC_STAGES.includes(stage) ? stage : 'settlement',
    code: FAILURE_CODES.has(candidate) ? candidate : signal?.aborted ? 'analysis_deadline' : 'stage_failed',
  };
}

/** Used again at persistence boundaries; never trust a callback's runtime shape. */
export function sanitizeDiagnostic(value: CheckDiagnostic): CheckDiagnostic {
  return diagnosticFor(value.requestId, value.stage, new Error(value.code));
}

export function diagnosticCode(value: CheckDiagnostic): string {
  const safe = sanitizeDiagnostic(value);
  return `${safe.stage}:${safe.code}`;
}
