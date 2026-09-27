import { CapabilitiesSchema, CheckResultSchema, type CheckInput, type CheckResult, type Capabilities } from '../shared/contracts';

export type ApiFailureKind = 'sign_in' | 'busy' | 'unavailable' | 'timeout' | 'invalid_input' | 'clarification_expired' | 'malformed_response' | 'network' | 'cancelled' | 'duplicate';
export type ApiRecovery = 'edit_input' | 'return_to_form' | 'wait' | 'sign_in';
interface FailureDefinition { kind: ApiFailureKind; recovery: ApiRecovery; message: string }
const signIn: FailureDefinition = { kind: 'sign_in', recovery: 'sign_in', message: 'Sign in to reconnect. Your input will stay in this tab.' };
const unavailable: FailureDefinition = { kind: 'unavailable', recovery: 'wait', message: 'Checking is paused. Your input is still here.' };
const invalidInput: FailureDefinition = { kind: 'invalid_input', recovery: 'edit_input', message: 'This input could not be accepted. Review its details.' };
const closedQuestion: FailureDefinition = { kind: 'clarification_expired', recovery: 'return_to_form', message: 'This question has closed. You can edit your input.' };
const cancelled: FailureDefinition = { kind: 'cancelled', recovery: 'return_to_form', message: 'The check was interrupted. Your input is still here.' };
const timeout: FailureDefinition = { kind: 'timeout', recovery: 'return_to_form', message: 'The check took too long. Your input is still here.' };
const busy: FailureDefinition = { kind: 'busy', recovery: 'wait', message: 'A check is still open, or the daily limit has been reached. Try later.' };

// These are local messages and a closed set of codes. Never show a server error
// message, provider body, redirect location or validation details to the user.
const FAILURE_DEFINITIONS = {
  unauthorized: signIn,
  session_redirect: signIn,
  busy,
  budget_unavailable: unavailable,
  budget_configuration: unavailable,
  budget_reconciliation: unavailable,
  usage_invalid: unavailable,
  configuration: unavailable,
  access_unconfigured: unavailable,
  pilot_closed: { ...unavailable, message: 'This pilot is not accepting checks.' },
  ai_unavailable: unavailable,
  unavailable,
  lookup_limit: unavailable,
  image_limit: { ...unavailable, recovery: 'edit_input', message: 'Screenshot checking is paused. You can use text instead.' },
  images_unavailable: { ...unavailable, recovery: 'edit_input', message: 'Screenshot checking is paused. You can use text instead.' },
  invalid_input: invalidInput,
  empty_input: { ...invalidInput, message: 'Add the message, call details or link you want to check.' },
  invalid_json: invalidInput,
  input_too_large: { ...invalidInput, message: 'This input is too large. Shorten the text or crop the screenshot.' },
  content_type: invalidInput,
  content_encoding: invalidInput,
  invalid_image: { ...invalidInput, message: 'Choose a valid, still PNG, JPG or WebP screenshot, or crop a smaller image.' },
  image_processing: { ...invalidInput, message: 'This screenshot could not be prepared. Choose a clearer crop or enter its text.' },
  continuation_size: { ...invalidInput, recovery: 'return_to_form', message: 'This check could not continue. You can edit the input to use a shorter excerpt.' },
  origin_rejected: { ...invalidInput, recovery: 'return_to_form', message: 'This page could not submit a check. Keep your input and open SkeptiScan directly in another tab.' },
  invalid_continuation: closedQuestion,
  continuation_unavailable: closedQuestion,
  call_limit: { ...closedQuestion, message: 'This check cannot continue. You can edit your input.' },
  duplicate_request: { kind: 'duplicate', recovery: 'return_to_form', message: 'This check was already submitted. Your input is still here.' },
  timeout,
  request_cancelled: cancelled,
  MODEL_TIMEOUT: timeout,
  MODEL_CANCELLED: cancelled,
  MODEL_AUTHENTICATION_FAILED: unavailable,
  MODEL_RATE_LIMITED: unavailable,
  MODEL_PROVIDER_UNAVAILABLE: unavailable,
  MODEL_CONNECTION_FAILED: unavailable,
  network_error: { kind: 'network', recovery: 'return_to_form', message: 'The connection ended before a result arrived. Your input is still here.' },
  malformed_response: { kind: 'malformed_response', recovery: 'return_to_form', message: 'The result could not be read. Your input is still here.' },
  http_error: unavailable,
} as const satisfies Record<string, FailureDefinition>;
export type ApiFailureCode = keyof typeof FAILURE_DEFINITIONS;
export interface ApiFailureDetails { kind: ApiFailureKind; recovery: ApiRecovery; code: ApiFailureCode; status: number | null }
const FIELDS = new Set(['content', 'context', 'senderEmail', 'senderPhone', 'image']);
function knownField(value: unknown): string | undefined { return typeof value === 'string' && FIELDS.has(value) ? value : undefined; }

/** The first two arguments remain compatible with existing form error callers. */
export class ApiFailure extends Error {
  public field?: string;
  readonly kind: ApiFailureKind;
  readonly recovery: ApiRecovery;
  readonly code: ApiFailureCode;
  readonly status: number | null;
  constructor(message: string, field?: string, details: Partial<ApiFailureDetails> = {}) {
    super(message); this.name = 'ApiFailure'; this.field = knownField(field);
    this.code = details.code ?? 'http_error';
    this.kind = details.kind ?? FAILURE_DEFINITIONS[this.code].kind;
    this.recovery = details.recovery ?? FAILURE_DEFINITIONS[this.code].recovery;
    this.status = typeof details.status === 'number' && Number.isInteger(details.status) && details.status >= 100 && details.status <= 599 ? details.status : null;
  }
}
type Operation = 'capabilities' | 'check' | 'clarify';
function failure(code: ApiFailureCode, status: number | null, field?: unknown, operation?: Operation): ApiFailure {
  const definition = FAILURE_DEFINITIONS[code];
  // A failed follow-up is never retried with its signed continuation. The UI can
  // return to the preserved input without automatically starting another check.
  const recovery = operation === 'clarify' && definition.recovery !== 'sign_in'
    ? 'return_to_form' : definition.recovery;
  const message = code === 'invalid_input' && operation === 'clarify' ? closedQuestion.message : definition.message;
  return new ApiFailure(message, definition.recovery === 'edit_input' && operation !== 'clarify' ? knownField(field) : undefined, { code, status, kind: definition.kind, recovery });
}
function knownCode(value: unknown): value is ApiFailureCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FAILURE_DEFINITIONS, value);
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function statusCode(status: number): ApiFailureCode {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'busy';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 499) return 'request_cancelled';
  if (status === 413) return 'input_too_large';
  if ([400, 415, 422].includes(status)) return 'invalid_input';
  return 'http_error';
}
async function jsonResponse(response: Response, operation: Operation): Promise<unknown> {
  // Manual redirects avoid following Access into a login HTML response. A browser
  // may expose only opaqueredirect/status 0, so never depend on reading Location.
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400) || response.redirected) {
    throw failure('session_redirect', response.status || null, undefined, operation);
  }
  let value: unknown;
  try { value = await response.json(); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (error instanceof TypeError) throw failure('network_error', response.status, undefined, operation);
    throw failure(response.ok ? 'malformed_response' : statusCode(response.status), response.status, undefined, operation);
  }
  if (!response.ok) {
    const error = record(record(value)?.error);
    const code = knownCode(error?.code) ? error.code : statusCode(response.status);
    throw failure(code, response.status, error?.field, operation);
  }
  return value;
}
async function fetchApi(path: string, options: RequestInit, operation: Operation): Promise<{ value: unknown; status: number }> {
  let response: Response;
  try { response = await fetch(path, { ...options, redirect: 'manual', cache: 'no-store', credentials: 'same-origin' }); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (options.signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError');
    throw failure('network_error', null, undefined, operation);
  }
  return { value: await jsonResponse(response, operation), status: response.status };
}
export async function getCapabilities(signal: AbortSignal): Promise<Capabilities> {
  const response = await fetchApi('/api/capabilities', { signal }, 'capabilities');
  const parsed = CapabilitiesSchema.safeParse(response.value);
  if (!parsed.success) throw failure('malformed_response', response.status);
  return parsed.data;
}
export async function checkInput(input: CheckInput, signal: AbortSignal, clarification?: { requestId: string; continuation: string; answer: 'yes' | 'no' | 'unsure' }): Promise<CheckResult> {
  const body = { requestId: clarification?.requestId ?? crypto.randomUUID(), input, ...clarification };
  const operation = clarification ? 'clarify' : 'check';
  const response = await fetchApi(clarification ? '/api/clarify' : '/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }, operation);
  const parsed = CheckResultSchema.safeParse(response.value);
  if (!parsed.success) throw failure('malformed_response', response.status, undefined, operation);
  return parsed.data;
}

/** Release a waiting check without delaying navigation or sending any user content. */
export async function cancelWaitingCheck(requestId: string): Promise<void> {
  try {
    await fetch('/api/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId }), redirect: 'manual', cache: 'no-store', credentials: 'same-origin', keepalive: true });
  } catch { /* Best effort: the server's expiry remains the backstop. */ }
}
