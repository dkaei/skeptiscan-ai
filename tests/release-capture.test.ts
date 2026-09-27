import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Directly executable Node ESM helper.
import { buildCapture, sanitizeResponseBody, writeCaptureOnce, writeFailedCaptureOnce } from '../release/capture.mjs';
// @ts-expect-error Directly executable Node ESM validation.
import { validateArtifacts } from '../release/artifacts.mjs';
// @ts-expect-error Directly executable Node ESM fingerprint.
import { inputFingerprint } from '../release/manifest.mjs';
import { ExtractionSchema } from '../shared/contracts';

type Json = Record<string, any>;
const requestId = 'c0d052b8-3aa0-4c09-b78e-5344e5366d8b';
const candidateHash = 'a'.repeat(64), policyHash = 'b'.repeat(64);
const time = '2026-09-27T04:00:00.000Z';
const receivedAt = '2026-09-27T04:00:02.000Z', capturedAt = '2026-09-27T04:00:04.000Z';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const networkGuard = vi.fn(() => { throw new Error('CAPTURE_MUST_NOT_SEND_REQUESTS'); });
let root: string, manifestCase: Json, body: Json, args: Json;

beforeEach(async () => {
  vi.stubGlobal('fetch', networkGuard); networkGuard.mockClear();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-27T05:00:00.000Z'));
  root = await mkdtemp(join(tmpdir(), 'skeptiscan-capture-'));
  const input = { mode: 'message', content: 'The fictional courier asks for a redelivery fee.', context: '', senderEmail: '', senderPhone: '', externalLookup: false };
  manifestCase = { id: 'M01', cohort: 'fresh_text', route: 'ai', expectedTerminal: 'complete', allowedStatuses: ['complete'],
    input, referenceSha256: 'c'.repeat(64), clarification: { policy: 'forbidden', allowedQuestionIds: [], answer: 'unsure' },
    expected: { allowedActionIds: ['verify_payment'], mustExplain: ['The recipient is unverified.'], prohibitedOutcomes: [] }, globalProhibitedOutcomes: [] };
  body = { requestId, status: 'complete', title: 'Confirm the payment request',
    nextStep: 'Verify who should receive the payment through a trusted, independent contact route.',
    reason: 'The recipient is unverified.', uncertainty: 'The caller has not been authenticated.',
    evidence: [], extraction: null, question: null, checkedAt: time, aiUsed: true };
  args = { manifestCase, candidateHash, policyHash, submittedInput: structuredClone(input), capturedAt,
    attempts: [{ kind: 'initial', requestBody: { requestId, input: structuredClone(input) }, receivedAt,
      response: { httpStatus: 200, body } }] };
});

describe('source-linked extraction capture compatibility', () => {
  function extractionWithMetadata(): Json {
    return {
      transcript: 'Pay the parcel fee.', claimedOrganisation: null, urls: [], phoneNumbers: [],
      requestedActions: [{ action: 'pay', quote: 'Pay the parcel fee.', source: 'transcript', span: { source: 'transcript', start: 0, end: 19 } }],
      unreadableDetails: [], missingContext: [],
      screenshotIssues: [{ kind: 'conflicting_accounts', target: 'payment_amount', location: 'body', consequential: true,
        imageQuote: 'Pay the parcel fee.', userQuote: 'No payment is requested.', userSource: 'correction' }],
    };
  }

  it('preserves approved action source/span and screenshot issue fields exactly', () => {
    body.extraction = extractionWithMetadata();
    const original = structuredClone(body);
    expect(ExtractionSchema.safeParse(body.extraction).success).toBe(true);
    expect(buildCapture(args).attempts[0].response.body).toEqual(original);
    expect(body).toEqual(original);
  });

  it.each(['source_only', 'span_only', 'neither', 'no_issues', 'empty_issues'])('retains backwards-compatible optional metadata: %s', variant => {
    body.extraction = extractionWithMetadata();
    if (variant === 'source_only' || variant === 'neither') delete body.extraction.requestedActions[0].span;
    if (variant === 'span_only' || variant === 'neither') delete body.extraction.requestedActions[0].source;
    if (variant === 'no_issues') delete body.extraction.screenshotIssues;
    if (variant === 'empty_issues') body.extraction.screenshotIssues = [];
    expect(ExtractionSchema.safeParse(body.extraction).success).toBe(true);
    expect(sanitizeResponseBody(body).extraction).toEqual(body.extraction);
  });

  it.each(['unreadable_region', 'missing_detail'])('preserves nullable anchors for %s without inventing quotations', kind => {
    body.extraction = extractionWithMetadata();
    body.extraction.screenshotIssues = [{ kind, target: 'link_destination', location: 'link', consequential: true,
      imageQuote: null, userQuote: null, userSource: null }];
    expect(ExtractionSchema.safeParse(body.extraction).success).toBe(true);
    expect(buildCapture(args).attempts[0].response.body.extraction.screenshotIssues).toEqual(body.extraction.screenshotIssues);
  });

  it.each([
    'unknown_action_field', 'unknown_span_field', 'unknown_issue_field', 'unknown_extraction_field',
    'invalid_source', 'null_source', 'negative_start', 'fractional_end', 'zero_end',
    'invalid_kind', 'invalid_target', 'invalid_location', 'invalid_user_source', 'null_consequential',
    'empty_image_quote', 'long_user_quote', 'missing_issue_field', 'too_many_issues',
  ])('rejects invented or malformed extraction metadata: %s', mutation => {
    body.extraction = extractionWithMetadata();
    const action = body.extraction.requestedActions[0], issue = body.extraction.screenshotIssues[0];
    if (mutation === 'unknown_action_field') action.policeVerified = true;
    if (mutation === 'unknown_span_field') action.span.repairedQuote = 'A fabricated replacement';
    if (mutation === 'unknown_issue_field') issue.resolvedByModel = true;
    if (mutation === 'unknown_extraction_field') body.extraction.verifiedScreenshot = true;
    if (mutation === 'invalid_source') action.source = 'model_guess';
    if (mutation === 'null_source') action.source = null;
    if (mutation === 'negative_start') action.span.start = -1;
    if (mutation === 'fractional_end') action.span.end = 2.5;
    if (mutation === 'zero_end') action.span.end = 0;
    if (mutation === 'invalid_kind') issue.kind = 'resolved_conflict';
    if (mutation === 'invalid_target') issue.target = 'predicted_sender';
    if (mutation === 'invalid_location') issue.location = 'inferred';
    if (mutation === 'invalid_user_source') issue.userSource = 'model';
    if (mutation === 'null_consequential') issue.consequential = null;
    if (mutation === 'empty_image_quote') issue.imageQuote = '';
    if (mutation === 'long_user_quote') issue.userQuote = 'x'.repeat(241);
    if (mutation === 'missing_issue_field') delete issue.userSource;
    if (mutation === 'too_many_issues') body.extraction.screenshotIssues = Array.from({ length: 5 }, () => ({ ...issue }));
    expect(ExtractionSchema.safeParse(body.extraction).success).toBe(false);
    expect(() => buildCapture(args)).toThrow('response_schema_invalid');
  });

  it.each(['action', 'span', 'issue'])('quarantines secret-bearing extra fields on %s metadata', location => {
    body.extraction = extractionWithMetadata();
    const target = location === 'action' ? body.extraction.requestedActions[0]
      : location === 'span' ? body.extraction.requestedActions[0].span : body.extraction.screenshotIssues[0];
    target.authorization = 'Bearer PRIVATE_TRANSPORT_VALUE';
    expect(() => buildCapture(args)).toThrow('secret_field_in_response');
  });

  it.each(['imageQuote', 'userQuote'])('rejects a transport secret echoed in the approved %s field', field => {
    body.extraction = extractionWithMetadata();
    args.attempts[0].requestBody.headers = { Authorization: 'Bearer PRIVATE_ACCESS_VALUE' };
    body.extraction.screenshotIssues[0][field] = 'Echo PRIVATE_ACCESS_VALUE';
    expect(() => buildCapture(args)).toThrow('secret_in_substantive_field');
  });

  it('still accepts the unchanged response bodies in all 69 historical captures', async () => {
    const directory = new URL('../evaluation/release-captures/candidate-83256009/', import.meta.url);
    const files = (await readdir(directory)).filter(name => name.endsWith('.capture.json'));
    expect(files).toHaveLength(69);
    let responses = 0;
    for (const file of files) {
      const raw = JSON.parse(await readFile(new URL(file, directory), 'utf8'));
      for (const attempt of raw.attempts) {
        if (attempt.response) {
          expect(sanitizeResponseBody(attempt.response.body), `${file}: historical response shape`).toEqual(attempt.response.body);
          responses++;
        }
      }
    }
    expect(responses).toBe(72);
  });
});
afterEach(async () => {
  expect(networkGuard).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  if (root && dirname(root) === resolve(tmpdir()) && basename(root).startsWith('skeptiscan-capture-')) await rm(root, { recursive: true, force: true });
});

describe('capture fidelity and secret removal', () => {
  it('derives observations from the actual response without changing or grading it', () => {
    body.status = 'partial'; body.title = 'Check incomplete'; body.aiUsed = false;
    const before = structuredClone(args);
    const capture = buildCapture(args);
    expect(capture.attempts[0].observation).toEqual({ kind: 'initial', requestId, httpStatus: 200, observedStatus: 'partial', aiUsed: false, errorCode: null, questionId: null });
    expect(capture.attempts[0].response.body).toEqual(body);
    expect(capture.inputSha256).toBe(inputFingerprint(manifestCase.input));
    expect(args).toEqual(before);
  });

  it('removes continuation and observer transport headers without removing evidence', () => {
    body.status = 'needs_context'; body.question = { id: 'payment_expected', text: 'Did you expect this payment?', options: ['Yes', 'No', 'Not sure'] };
    body.continuation = 'CONTINUATION_PRIVATE_VALUE';
    args.attempts[0].response.headers = { Authorization: 'Bearer AUTHORIZATION_PRIVATE_VALUE', Cookie: 'CF_Authorization=COOKIE_PRIVATE_VALUE' };
    body.extraction = { transcript: 'Synthetic screenshot text', claimedOrganisation: null, urls: [], phoneNumbers: [], requestedActions: [], unreadableDetails: [], missingContext: [] };
    args.attempts[0].requestBody.headers = { 'X-Api-Key': 'API_KEY_PRIVATE_VALUE' };
    const capture = buildCapture(args);
    expect(capture.attempts[0].response.body.hasContinuation).toBe(true);
    expect(capture.attempts[0].response.body.extraction.transcript).toBe('Synthetic screenshot text');
    expect(JSON.stringify(capture)).not.toMatch(/PRIVATE_VALUE|Authorization|headers|"cookie"|"continuation"/);
  });

  it('accepts a continuation-presence Boolean actually recorded by a secret-withholding observer', () => {
    expect(sanitizeResponseBody({ ...body, hasContinuation: false })).toEqual({ ...body, hasContinuation: false });
  });

  it.each(['reason', 'uncertainty', 'title'])('stops rather than rewrite a transport secret echoed in %s', field => {
    body.continuation = 'PRIVATE_CONTINUATION_VALUE'; body[field] = 'The value is PRIVATE_CONTINUATION_VALUE';
    expect(() => buildCapture(args)).toThrow('release_capture:secret_in_substantive_field');
  });

  it('also catches request-header secrets echoed by a response', () => {
    args.attempts[0].requestBody.headers = { Authorization: 'Bearer PRIVATE_ACCESS_TOKEN_VALUE' };
    body.reason = 'Echo PRIVATE_ACCESS_TOKEN_VALUE';
    expect(() => buildCapture(args)).toThrow('secret_in_substantive_field');
  });

  it('removes a Set-Cookie header without treating cookie attributes as secrets', () => {
    args.attempts[0].response.headers = { 'Set-Cookie': 'CF_Authorization=COOKIE_PRIVATE_VALUE; Path=/; Secure; HttpOnly' };
    body.reason = 'See the recipient/merchant details first.';
    expect(buildCapture(args).attempts[0].response.body.reason).toBe(body.reason);
  });

  it.each(['password', 'secret', 'headers', 'nested_cookie', 'nested_continuation'])('quarantines an unexpected actual API body field: %s', field => {
    if (field === 'nested_cookie' || field === 'nested_continuation') {
      body.extraction = { transcript: 'Synthetic text', claimedOrganisation: null, urls: [], phoneNumbers: [], requestedActions: [], unreadableDetails: [], missingContext: [],
        [field === 'nested_cookie' ? 'cookie' : 'continuation']: 'UNEXPECTED_PRIVATE_VALUE' };
    } else body[field] = 'UNEXPECTED_PRIVATE_VALUE';
    expect(() => buildCapture(args)).toThrow('secret_field_in_response');
  });

  it('rejects unknown substantive response fields instead of silently discarding them', () => {
    body.inventedVerification = true;
    expect(() => buildCapture(args)).toThrow('response_schema_invalid');
  });

  it.each(['submittedInput', 'request'])('binds the %s text to the frozen manifest', location => {
    if (location === 'submittedInput') args.submittedInput.content = 'Different easier input';
    else args.attempts[0].requestBody.input.content = 'Different easier input';
    expect(() => buildCapture(args)).toThrow('input_differs_from_manifest');
  });

  it('keeps API and transport failures rather than fabricate result fields', () => {
    args.attempts[0].response = { httpStatus: 429, body: { error: { code: 'RATE_LIMITED', message: 'Try again later.' } } };
    const api = buildCapture(args).attempts[0];
    expect(api.observation).toEqual({ kind: 'initial', requestId, httpStatus: 429, observedStatus: null, aiUsed: null, errorCode: 'RATE_LIMITED', questionId: null });
    args.attempts[0].response = null; args.attempts[0].failure = { kind: 'transport', code: 'network_error' };
    expect(buildCapture(args).attempts[0]).toMatchObject({ response: null, observation: { httpStatus: null, observedStatus: null, aiUsed: null, errorCode: 'network_error' } });
  });

  it('retains an unexpected client rejection without pretending an API request was sent', () => {
    args.attempts[0] = { kind: 'initial', requestBody: null, receivedAt, response: null, failure: { kind: 'client_rejected', code: 'invalid_url' } };
    expect(buildCapture(args).attempts[0].observation).toEqual({ kind: 'initial', requestId: null, httpStatus: null, observedStatus: 'client_rejected', aiUsed: false, errorCode: 'invalid_url', questionId: null });
  });

  it('preserves local control without AI or upload metadata', () => {
    manifestCase.route = 'local'; manifestCase.expectedTerminal = 'expected_abstention';
    args.attempts[0] = { kind: 'initial', requestBody: null, receivedAt, response: null, failure: { kind: 'client_rejected', code: 'invalid_url' } };
    expect(buildCapture(args).attempts[0].observation.aiUsed).toBe(false);
  });

  it('separately hashes original fixture and observed upload, and never stores image bytes', () => {
    const bytes = Buffer.from('Synthetic upload bytes, not a real image decoder test');
    manifestCase.input.mode = 'screenshot'; manifestCase.input.content = '';
    manifestCase.fixture = { sha256: 'd'.repeat(64), path: 'evaluation/fixtures/S02.png', mimeType: 'image/png' };
    args.imageSha256 = manifestCase.fixture.sha256; args.submittedInput = structuredClone(manifestCase.input);
    args.attempts[0].requestBody.input = { ...manifestCase.input, image: { base64: bytes.toString('base64'), mimeType: 'image/jpeg' } };
    const capture = buildCapture(args);
    expect(capture.imageSha256).toBe(manifestCase.fixture.sha256);
    expect(capture.uploadImageSha256).toBe(hash(bytes));
    expect(capture.inputSha256).toBe(inputFingerprint(manifestCase.input, manifestCase.fixture.sha256));
    expect(JSON.stringify(capture)).not.toContain('base64');
    expect(JSON.stringify(capture)).not.toContain(bytes.toString('base64'));
    args.imageSha256 = 'e'.repeat(64);
    expect(() => buildCapture(args)).toThrow('source_image_hash_differs');
  });
});

describe('first attempt and clarification sequence', () => {
  function clarification() {
    manifestCase.clarification = { policy: 'optional', allowedQuestionIds: ['payment_expected'], answer: 'unsure' };
    body.status = 'needs_context'; body.question = { id: 'payment_expected', text: 'Were you expecting this payment?', options: ['Yes', 'No', 'Not sure'] }; body.continuation = 'SYNTHETIC_CONTINUATION_VALUE';
    args.attempts.push({ kind: 'clarification', requestBody: { requestId, input: structuredClone(manifestCase.input), continuation: body.continuation, answer: 'unsure' },
      receivedAt: '2026-09-27T04:00:03.000Z', response: { httpStatus: 200, body: { ...body, status: 'complete', question: null, continuation: undefined } } });
    delete args.attempts[1].response.body.continuation;
  }
  it('preserves both observed stages and the frozen unsure answer with the same UUID', () => {
    clarification();
    const capture = buildCapture(args);
    expect(capture.attempts.map((attempt: Json) => attempt.observation.observedStatus)).toEqual(['needs_context', 'complete']);
    expect(capture.attempts[1].answer).toBe('unsure');
    expect(capture.attempts[0].response.body.hasContinuation).toBe(true);
    expect(JSON.stringify(capture)).not.toContain('SYNTHETIC_CONTINUATION_VALUE');
  });
  it('cannot replace a first HTTP failure with a successful retry', () => {
    clarification();
    args.attempts[0].response = { httpStatus: 503, body: { error: { code: 'UNAVAILABLE', message: 'Could not complete the check.' } } };
    expect(() => buildCapture(args)).toThrow('second_attempt_is_not_clarification');
  });
  it.each(['changed_uuid', 'changed_input', 'changed_answer', 'third_attempt'])('rejects %s', mutation => {
    clarification();
    if (mutation === 'changed_uuid') { args.attempts[1].requestBody.requestId = '5a46d4be-2f01-4487-ac53-64dcb9474d53'; args.attempts[1].response.body.requestId = args.attempts[1].requestBody.requestId; }
    if (mutation === 'changed_input') args.attempts[1].requestBody.input.context = 'New information';
    if (mutation === 'changed_answer') args.attempts[1].requestBody.answer = 'yes';
    if (mutation === 'third_attempt') args.attempts.push(structuredClone(args.attempts[1]));
    expect(() => buildCapture(args)).toThrow('release_capture:');
  });
  it('does not silently fix a wrong response request ID or timestamp', () => {
    body.requestId = '5a46d4be-2f01-4487-ac53-64dcb9474d53';
    expect(() => buildCapture(args)).toThrow('result_identity_or_http_conflict');
    body.requestId = requestId; body.checkedAt = '2026-09-27T04:00:03.000Z';
    expect(() => buildCapture(args)).toThrow('result_after_receipt');
  });
});

describe('immutable capture files and artifact compatibility', () => {
  it('durably quarantines a malformed first response and prohibits replacing it with a successful retry', async () => {
    const observations = [{ kind: 'initial', requestId, httpStatus: 502, observedStatus: null, aiUsed: null, errorCode: null, questionId: null }];
    const saved = await writeFailedCaptureOnce({ root, runId: 'malformed', manifestCase, candidateHash, policyHash, capturedAt, observations, failureCode: 'non_json_response' });
    expect(saved.record).toMatchObject({ outcome: 'failed', reviewed: false, attempts: observations });
    const note = JSON.parse(await readFile(join(root, saved.artifact.path), 'utf8'));
    expect(note.schemaVersion).toBe('capture-quarantine-v1');
    expect(note.inputFidelityValidated).toBe(false);
    expect(note).not.toHaveProperty('body');
    await expect(writeCaptureOnce({ root, runId: 'malformed', manifestCase, capture: buildCapture(args) })).rejects.toThrow('capture_already_exists');
    await expect(writeFailedCaptureOnce({ root, runId: 'other', manifestCase, candidateHash, policyHash, capturedAt, observations, failureCode: 'raw error with PRIVATE_SECRET' })).rejects.toThrow('failure_code_invalid');
  });
  it('writes once with an exact-byte digest and no invented review', async () => {
    const capture = buildCapture(args);
    const written = await writeCaptureOnce({ root, runId: 'offline-fixture', manifestCase, capture });
    const bytes = await readFile(join(root, written.artifact.path));
    expect(hash(bytes)).toBe(written.artifact.sha256);
    expect(JSON.parse(bytes.toString())).toEqual(capture);
    expect(written.record).toMatchObject({ firstAttempt: true, reviewed: false, semanticReview: null, workflowMatch: null, criticalFindings: null });
    body.reason = 'A different later attempt.';
    await expect(writeCaptureOnce({ root, runId: 'offline-fixture', manifestCase, capture: buildCapture(args) })).rejects.toThrow('capture_already_exists');
    expect(await readFile(join(root, written.artifact.path))).toEqual(bytes);
  });
  it('blocks transport fields added after build and a symlink output directory', async () => {
    const capture = buildCapture(args); capture.attempts[0].cookies = 'PRIVATE_COOKIE';
    await expect(writeCaptureOnce({ root, runId: 'unsafe', manifestCase, capture })).rejects.toThrow('capture_schema_invalid');
    delete capture.attempts[0].cookies;
    await mkdir(join(root, 'outside')); await mkdir(join(root, 'evaluation/release-captures'), { recursive: true });
    await symlink(join(root, 'outside'), join(root, 'evaluation/release-captures/unsafe'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(writeCaptureOnce({ root, runId: 'unsafe', manifestCase, capture })).rejects.toThrow('unsafe_output_directory');
  });
  it.each(['../outside', '/outside', 'a/b', 'a\\b', 'a:stream'])('rejects unsafe run ID %s', async runId => {
    await expect(writeCaptureOnce({ root, runId, manifestCase, capture: buildCapture(args) })).rejects.toThrow('run_id_invalid');
  });
  it('produces a capture accepted by the independent artifact validator after a real explicit test review', async () => {
    const capture = buildCapture(args);
    const written = await writeCaptureOnce({ root, runId: 'compatible', manifestCase, capture });
    await mkdir(join(root, 'shared'));
    await writeFile(join(root, 'shared/contracts.ts'), await readFile(new URL('../shared/contracts.ts', import.meta.url)));
    const review = { schemaVersion: 1, caseId: manifestCase.id, captureSha256: written.artifact.sha256,
      reviewer: { name: 'Offline test fixture reviewer', kind: 'ai' }, workflowMatch: true, criticalFindings: [],
      criteria: [{ kind: 'mustExplain', criterion: 'The recipient is unverified.', passed: true, rationale: 'The captured fixture states that the recipient is unverified.' }],
      criticalChecks: [{ category: 'dangerous_action', passed: true, rationale: 'The fixture advises independent confirmation before any payment.' }],
      actionMapping: { passed: true, rationale: 'The exact title and next step match the allowed verify_payment action.' } };
    const reviewBytes = JSON.stringify(review), reviewPath = 'evaluation/release-captures/compatible/M01.review.json';
    await writeFile(join(root, reviewPath), reviewBytes);
    const record = { ...written.record, reviewed: true, workflowMatch: true, criticalFindings: [], semanticReview: { path: reviewPath, sha256: hash(reviewBytes) } };
    const checked = await validateArtifacts({ root, candidateHash, policyHash,
      manifest: { cases: [manifestCase], criticalCategories: ['dangerous_action'] },
      evidence: { startedAt: time, completedAt: capturedAt, cases: [record] } });
    expect(checked).toEqual({ passed: true, issues: [] });
  });
});
