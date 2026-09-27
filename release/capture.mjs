import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { inputFingerprint } from './manifest.mjs';
import { capturedExtractionSchema as extraction } from './result-extraction.mjs';

// Offline observation serialization only. No fetch, environment/key access,
// provider calls, expected-answer synthesis, retries or semantic grading.
const HASH = z.string().regex(/^[a-f0-9]{64}$/);
const ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
const CODE = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:-]{0,99}$/);
const TEXT = z.string().max(24000);
const TIME = z.iso.datetime();
const HTTP = z.number().int().min(100).max(599);
const result = z.object({
  requestId: z.uuid(), status: z.enum(['complete', 'partial', 'needs_context']),
  title: TEXT, nextStep: TEXT, reason: TEXT, uncertainty: TEXT,
  evidence: z.array(z.object({
    id: z.string().min(1).max(100), kind: z.enum(['domain', 'reputation', 'phone', 'guidance', 'input']),
    state: z.enum(['matched', 'no_match', 'not_checked', 'unavailable', 'unsupported', 'observation']),
    title: TEXT, detail: TEXT, sourceUrl: TEXT.optional(), checkedAt: TIME,
  }).strict()).max(100),
  extraction: extraction.nullable(), question: z.object({
    id: z.enum(['initiated_request', 'sharing_code', 'asked_to_install', 'payment_expected']),
    text: TEXT, options: z.array(TEXT).max(3),
  }).strict().nullable(),
  checkedAt: TIME, aiUsed: z.boolean(), notice: TEXT.optional(),
  recovery: z.enum(['retry', 'edit_input', 'clearer_image', 'none']).optional(),
  hasContinuation: z.boolean().optional(),
}).strict();
const apiError = z.object({ error: z.object({ code: CODE, message: TEXT, field: ID.optional() }).strict() }).strict();
const observation = z.object({
  kind: z.enum(['initial', 'clarification']), requestId: z.uuid().nullable(), httpStatus: HTTP.nullable(),
  observedStatus: z.enum(['complete', 'partial', 'needs_context', 'client_rejected']).nullable(),
  aiUsed: z.boolean().nullable(), errorCode: CODE.nullable(), questionId: ID.nullable(),
}).strict();
const captureSchema = z.object({
  schemaVersion: z.literal(1), caseId: ID, candidateHash: HASH, policyHash: HASH,
  referenceSha256: HASH, inputSha256: HASH, capturedAt: TIME,
  submittedInput: z.record(z.string(), z.unknown()), imageSha256: HASH.optional(), uploadImageSha256: HASH.optional(),
  attempts: z.array(z.object({
    observation, receivedAt: TIME,
    response: z.object({ httpStatus: HTTP, body: z.union([result, apiError]) }).strict().nullable(),
    answer: z.literal('unsure').optional(),
  }).strict()).min(1).max(2),
}).strict();
const secretKey = /^(?:continuation(?:token)?|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|proxy[_-]?authorization|cookies?|set[_-]?cookie|api[_-]?key|x[_-]?goog[_-]?api[_-]?key|x[_-]?api[_-]?key|cf[_-]?access[_-]?(?:jwt[_-]?assertion|client[_-]?(?:id|secret))|password|secret)$/i;
const transportKey = /^(?:headers|requestHeaders|responseHeaders|rawHeaders|credentials)$/i;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(`release_capture:${code}`); };
const assert = (condition, code) => { if (!condition) fail(code); };
const parse = (schema, value, code) => {
  const checked = schema.safeParse(value);
  if (!checked.success) fail(code); // Never expose Zod values, raw headers or bodies.
  return checked.data;
};

function collectSecrets(value, secrets, depth = 0, state = { count: 0 }) {
  assert(depth < 25 && ++state.count < 10000, 'observation_too_complex');
  if (Array.isArray(value)) value.forEach(item => collectSecrets(item, secrets, depth + 1, state));
  else if (plainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (secretKey.test(key) && typeof item === 'string' && item.length) {
        secrets.add(item);
        if (/^(?:Bearer|Basic)\s+\S+$/i.test(item)) secrets.add(item.replace(/^\S+\s+/, ''));
        if (/^(?:cookies?|set[_-]?cookie)$/i.test(key)) {
          const pairs = /^set[_-]?cookie$/i.test(key) ? item.split(';').slice(0, 1) : item.split(';');
          for (const part of pairs) {
            const at = part.indexOf('=');
            if (at >= 0 && part.slice(at + 1).trim()) secrets.add(part.slice(at + 1).trim());
          }
        }
      } else collectSecrets(item, secrets, depth + 1, state);
    }
  }
}

function stripSecrets(value, secrets, depth = 0, state = { count: 0 }) {
  assert(depth < 25 && ++state.count < 10000, 'observation_too_complex');
  if (typeof value === 'string') {
    // Never silently rewrite substantive explanation/extraction text. If a
    // transport secret was echoed there, stop and preserve the failed attempt
    // separately for investigation rather than manufacture sanitized success.
    for (const secret of secrets) if (value.includes(secret)) fail('secret_in_substantive_field');
    if (/\b(?:Bearer\s+[A-Za-z0-9._~-]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/.test(value)) fail('secret_like_substantive_field');
    return value;
  }
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return value.map(item => stripSecrets(item, secrets, depth + 1, state));
  assert(plainObject(value), 'non_json_observation');
  const cleaned = {};
  for (const [key, item] of Object.entries(value)) {
    if (secretKey.test(key) || transportKey.test(key)) {
      if (depth === 0 && key === 'continuation') continue;
      // A secret-bearing extra field in the actual API body may itself be a
      // privacy failure. Do not turn it into a conforming response by omission.
      fail('secret_field_in_response');
    }
    assert(!['__proto__', 'prototype', 'constructor'].includes(key), 'unsafe_object_key');
    cleaned[key] = stripSecrets(item, secrets, depth + 1, state);
  }
  return cleaned;
}

/** Preserve contract fields and remove the legitimate continuation token.
 * Unexpected secret-bearing fields at any other depth require quarantine.
 * Observer headers belong on request/response envelopes, outside the API body.
 * A CUA observer may already have replaced continuation with hasContinuation;
 * that Boolean must be an actual presence observation, never an expected value.
 * Unknown/substantively malformed response fields fail closed rather than being
 * silently discarded. Error messages expose bounded codes only. */
export function sanitizeResponseBody(body, { observedSecrets = [] } = {}) {
  assert(plainObject(body) && Array.isArray(observedSecrets) && observedSecrets.every(item => typeof item === 'string'), 'invalid_response_body');
  const secrets = new Set(observedSecrets.filter(Boolean));
  collectSecrets(body, secrets);
  const cleaned = stripSecrets(body, secrets);
  if (Object.hasOwn(body, 'continuation')) {
    assert(typeof body.continuation === 'string', 'invalid_continuation_presence');
    const present = body.continuation.length > 0;
    if (Object.hasOwn(body, 'hasContinuation')) assert(body.hasContinuation === present, 'continuation_presence_disagrees');
    cleaned.hasContinuation = present;
  }
  return parse(Object.hasOwn(cleaned, 'error') ? apiError : result, cleaned, 'response_schema_invalid');
}

function submittedFields(raw, manifestCase) {
  assert(plainObject(raw), 'input_missing');
  const { image, ...fields } = raw;
  assert(isDeepStrictEqual(fields, manifestCase.input), 'input_differs_from_manifest');
  if (image === undefined) return { fields };
  assert(manifestCase.fixture && fields.mode === 'screenshot' && plainObject(image)
    && Object.keys(image).every(key => ['base64', 'mimeType'].includes(key))
    && ['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)
    && typeof image.base64 === 'string' && image.base64.length > 0 && image.base64.length <= 2800000
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.base64), 'upload_image_invalid');
  const bytes = Buffer.from(image.base64, 'base64');
  assert(bytes.toString('base64') === image.base64 && bytes.length <= 2 * 1024 * 1024, 'upload_image_invalid');
  return { fields, uploadImageSha256: digest(bytes) };
}

/**
 * Serialize actual observations; never sends a check or retries a failure.
 * attempts: [{kind, requestBody: {requestId,input,continuation?,answer?}|null,
 * receivedAt, response: {httpStatus,body}|null,
 * failure?: {kind:'transport'|'client_rejected',code}}].
 * imageSha256 is the observed original fixture hash, not the reencoded upload.
 * requestBody.input may omit image bytes when CUA already withheld them; pass
 * uploadImageSha256 only when independently hashed from the observed upload.
 */
export function buildCapture({ manifestCase, candidateHash, policyHash, submittedInput, capturedAt, attempts, imageSha256, uploadImageSha256 }) {
  assert(plainObject(manifestCase) && ['ai', 'local'].includes(manifestCase.route), 'manifest_case_invalid');
  parse(ID, manifestCase.id, 'manifest_case_invalid');
  parse(HASH, manifestCase.referenceSha256, 'reference_hash_invalid');
  parse(HASH, candidateHash, 'candidate_hash_invalid'); parse(HASH, policyHash, 'policy_hash_invalid');
  parse(TIME, capturedAt, 'capture_time_invalid');
  assert(Array.isArray(attempts) && attempts.length >= 1 && attempts.length <= 2, 'attempt_count_invalid');
  assert(imageSha256 === manifestCase.fixture?.sha256, 'source_image_hash_differs');
  if (imageSha256 !== undefined) parse(HASH, imageSha256, 'source_image_hash_invalid');
  if (uploadImageSha256 !== undefined) parse(HASH, uploadImageSha256, 'upload_image_hash_invalid');
  const submitted = submittedFields(submittedInput, manifestCase);
  let observedUploadHash = submitted.uploadImageSha256 ?? uploadImageSha256;
  if (submitted.uploadImageSha256 && uploadImageSha256) assert(submitted.uploadImageSha256 === uploadImageSha256, 'upload_image_hash_differs');
  assert(!observedUploadHash || manifestCase.fixture, 'unexpected_upload_hash');
  const secrets = new Set();
  collectSecrets(attempts, secrets);
  let previousTime = -Infinity;
  const recorded = attempts.map((attempt, index) => {
    assert(plainObject(attempt) && attempt.kind === (index === 0 ? 'initial' : 'clarification'), 'attempt_order_invalid');
    parse(TIME, attempt.receivedAt, 'received_time_invalid');
    const receivedTime = Date.parse(attempt.receivedAt);
    assert(receivedTime >= previousTime && receivedTime <= Date.parse(capturedAt), 'attempt_time_order_invalid');
    previousTime = receivedTime;
    let requestId = null, answer;
    if (attempt.requestBody !== null) {
      assert(plainObject(attempt.requestBody), 'request_body_missing');
      requestId = parse(z.uuid(), attempt.requestBody.requestId, 'request_id_invalid');
      const requestInput = submittedFields(attempt.requestBody.input, manifestCase);
      if (requestInput.uploadImageSha256) {
        assert(!observedUploadHash || observedUploadHash === requestInput.uploadImageSha256, 'upload_changed_between_attempts');
        observedUploadHash = requestInput.uploadImageSha256;
      }
      if (index === 0) assert(attempt.requestBody.answer === undefined && attempt.requestBody.continuation === undefined, 'initial_contains_clarification');
      else {
        answer = attempt.requestBody.answer;
        assert(answer === 'unsure' && answer === manifestCase.clarification?.answer, 'clarification_answer_differs');
      }
    }
    const clientRejected = attempt.response === null && attempt.failure?.kind === 'client_rejected';
    assert(manifestCase.route !== 'ai' || requestId !== null || clientRejected, 'ai_request_id_missing');
    if (manifestCase.route === 'local') assert(attempt.requestBody === null && index === 0, 'local_case_dispatched');
    let response = null, observation;
    if (attempt.response !== null) {
      assert(plainObject(attempt.response) && attempt.failure === undefined, 'response_failure_conflict');
      const httpStatus = parse(HTTP, attempt.response.httpStatus, 'http_status_invalid');
      const body = sanitizeResponseBody(attempt.response.body, { observedSecrets: [...secrets] });
      response = { httpStatus, body };
      assert(manifestCase.route === 'ai', 'local_case_has_response');
      if (Object.hasOwn(body, 'error')) {
        assert(httpStatus >= 400, 'error_http_status_conflict');
        observation = { kind: attempt.kind, requestId, httpStatus, observedStatus: null, aiUsed: null, errorCode: body.error.code, questionId: null };
      } else {
        assert(httpStatus >= 200 && httpStatus < 300 && body.requestId === requestId, 'result_identity_or_http_conflict');
        assert(Date.parse(body.checkedAt) <= receivedTime, 'result_after_receipt');
        observation = { kind: attempt.kind, requestId, httpStatus, observedStatus: body.status, aiUsed: body.aiUsed, errorCode: null, questionId: body.question?.id ?? null };
      }
    } else {
      assert(plainObject(attempt.failure) && ['transport', 'client_rejected'].includes(attempt.failure.kind), 'missing_failure_observation');
      const errorCode = parse(CODE, attempt.failure.code, 'failure_code_invalid');
      const rejected = attempt.failure.kind === 'client_rejected';
      assert(!rejected || attempt.requestBody === null, 'client_rejection_has_dispatched_request');
      observation = { kind: attempt.kind, requestId, httpStatus: null, observedStatus: rejected ? 'client_rejected' : null, aiUsed: rejected ? false : null, errorCode, questionId: null };
    }
    return { observation, receivedAt: attempt.receivedAt, response, ...(answer === undefined ? {} : { answer }) };
  });
  if (recorded.length === 2) {
    const first = recorded[0].observation, next = recorded[1].observation;
    assert(first.httpStatus === 200 && first.observedStatus === 'needs_context' && first.errorCode === null
      && first.questionId && recorded[0].response.body.hasContinuation === true, 'second_attempt_is_not_clarification');
    assert(first.requestId === next.requestId, 'clarification_request_id_changed');
  }
  const capture = {
    schemaVersion: 1, caseId: manifestCase.id, candidateHash, policyHash,
    referenceSha256: manifestCase.referenceSha256, inputSha256: inputFingerprint(submitted.fields, imageSha256),
    capturedAt, submittedInput: structuredClone(submitted.fields),
    ...(imageSha256 === undefined ? {} : { imageSha256 }),
    ...(observedUploadHash === undefined ? {} : { uploadImageSha256: observedUploadHash }), attempts: recorded,
  };
  assert(Buffer.byteLength(JSON.stringify(capture)) <= 1024 * 1024, 'capture_too_large');
  return parse(captureSchema, capture, 'capture_schema_invalid');
}

function inside(base, target) {
  const path = relative(base, target);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function writeBytesOnce({ root, runId, caseId, bytes }) {
  parse(ID, runId, 'run_id_invalid'); parse(ID, caseId, 'case_id_invalid');
  assert(bytes.length <= 1024 * 1024, 'capture_too_large');
  const realRoot = await realpath(root);
  let directory = realRoot;
  for (const part of ['evaluation', 'release-captures', runId]) {
    directory = resolve(directory, part);
    assert(inside(realRoot, directory), 'output_escapes_root');
    try { await mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') fail('output_directory_unavailable'); }
    const stat = await lstat(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(directory) === directory, 'unsafe_output_directory');
  }
  const path = `evaluation/release-captures/${runId}/${caseId}.capture.json`;
  let file;
  try { file = await open(resolve(realRoot, path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600); }
  catch (error) { fail(error.code === 'EEXIST' ? 'capture_already_exists' : 'capture_open_failed'); }
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  return { path, sha256: digest(bytes) };
}

/** For an observed response that cannot safely fit EVIDENCE.md (for example a
 * non-JSON HTTP body or a secret echoed in substantive prose). Preserve only
 * already-normalized observations and a bounded capture failure code. This is
 * deliberately NOT a valid result artifact: it blocks release and occupies the
 * same exclusive case path, preventing a successful retry from replacing it.
 * Do not pass raw exception messages, headers, input or response bodies here. */
export async function writeFailedCaptureOnce({ root, runId, manifestCase, candidateHash, policyHash, capturedAt, observations, failureCode }) {
  parse(ID, manifestCase?.id, 'case_id_invalid');
  parse(HASH, candidateHash, 'candidate_hash_invalid'); parse(HASH, policyHash, 'policy_hash_invalid');
  parse(TIME, capturedAt, 'capture_time_invalid');
  const safeCode = parse(z.enum(['response_schema_invalid', 'secret_in_substantive_field', 'secret_like_substantive_field', 'secret_field_in_response',
    'response_failure_conflict', 'result_identity_or_http_conflict', 'result_after_receipt',
    'invalid_response_body', 'non_json_response', 'observation_too_complex']), failureCode, 'failure_code_invalid');
  const attempts = parse(z.array(observation).min(1).max(2), observations, 'failure_observations_invalid');
  assert(attempts[0].kind === 'initial' && (attempts.length === 1 || (attempts[1].kind === 'clarification'
    && attempts[0].observedStatus === 'needs_context' && attempts[0].requestId === attempts[1].requestId)), 'attempt_order_invalid');
  const note = { schemaVersion: 'capture-quarantine-v1', caseId: manifestCase.id, candidateHash, policyHash,
    capturedAt, failureCode: safeCode, inputFidelityValidated: false, observations: attempts,
    notice: 'The first attempt could not be safely represented as result evidence. Raw bodies and transport secrets were not saved. This unresolved capture blocks release; do not replace it with a retry.' };
  const artifact = await writeBytesOnce({ root, runId, caseId: manifestCase.id, bytes: Buffer.from(`${JSON.stringify(note, null, 2)}\n`) });
  return { artifact, record: { id: manifestCase.id, cohort: manifestCase.cohort, route: manifestCase.route,
    outcome: 'failed', firstAttempt: true, attempts, artifact, semanticReview: null,
    reviewed: false, workflowMatch: null, criticalFindings: null } };
}

/** Exclusive immutable case file. The caller must wait for an allowed
 * clarification before finalizing; an existing initial failure cannot be
 * replaced with a retry. The returned index record remains unreviewed. */
export async function writeCaptureOnce({ root, runId, manifestCase, capture }) {
  parse(ID, runId, 'run_id_invalid'); parse(ID, manifestCase?.id, 'case_id_invalid');
  capture = parse(captureSchema, capture, 'capture_schema_invalid');
  assert(capture?.caseId === manifestCase.id && capture.schemaVersion === 1, 'capture_case_invalid');
  // Recheck the privacy boundary before writing even if a caller modified a
  // previously built capture. Extra fields cannot carry headers/images/tokens.
  assert(isDeepStrictEqual(capture.submittedInput, manifestCase.input)
    && capture.referenceSha256 === manifestCase.referenceSha256
    && capture.imageSha256 === manifestCase.fixture?.sha256
    && capture.inputSha256 === inputFingerprint(manifestCase.input, manifestCase.fixture?.sha256), 'capture_binding_changed');
  for (const attempt of capture.attempts) if (attempt.response) {
    assert(isDeepStrictEqual(sanitizeResponseBody(attempt.response.body), attempt.response.body), 'capture_contains_transport_secret');
  }
  const bytes = Buffer.from(`${JSON.stringify(capture, null, 2)}\n`);
  const artifact = await writeBytesOnce({ root, runId, caseId: manifestCase.id, bytes });
  const last = capture.attempts.at(-1).observation;
  // Expected abstention requires a later semantic review; it is not assumed.
  const complete = last.observedStatus === 'complete' && last.httpStatus === 200 && last.aiUsed === true
    && last.questionId === null && last.errorCode === null && manifestCase.expectedTerminal !== 'expected_abstention';
  return { artifact, record: {
    id: manifestCase.id, cohort: manifestCase.cohort, route: manifestCase.route,
    outcome: complete ? 'complete' : 'failed', firstAttempt: true,
    attempts: capture.attempts.map(attempt => structuredClone(attempt.observation)), artifact,
    semanticReview: null, reviewed: false, workflowMatch: null, criticalFindings: null,
  } };
}
