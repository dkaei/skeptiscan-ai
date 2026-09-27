import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createScanner } from 'typescript/unstable/ast/scanner';
import { SyntaxKind } from 'typescript/unstable/ast';
import { z } from 'zod';
import { inputFingerprint } from './manifest.mjs';
import { capturedExtractionSchema as extractionSchema } from './result-extraction.mjs';

const HASH = z.string().regex(/^[a-f0-9]{64}$/);
const ID = z.string().min(1).max(100);
const TEXT = z.string().max(24000);
const RATIONALE = z.string().trim().min(12).max(2000);
const nullableId = ID.nullable();
const responseStatuses = ['complete', 'partial', 'needs_context'];
const observationSchema = z.object({
  kind: z.enum(['initial', 'clarification']), requestId: nullableId,
  httpStatus: z.number().int().min(100).max(599).nullable(),
  observedStatus: z.enum([...responseStatuses, 'client_rejected']).nullable(),
  aiUsed: z.boolean().nullable(), errorCode: nullableId, questionId: nullableId,
}).strict();
const evidenceSchema = z.object({
  id: ID, kind: z.enum(['domain', 'reputation', 'phone', 'guidance', 'input']),
  state: z.enum(['matched', 'no_match', 'not_checked', 'unavailable', 'unsupported', 'observation']),
  title: TEXT, detail: TEXT, sourceUrl: TEXT.optional(), checkedAt: z.iso.datetime(),
}).strict();
// Deliberately independent of CheckResultSchema: a capture must not retain the
// continuation bearer token accepted by the live API contract.
const resultSchema = z.object({
  requestId: ID, status: z.enum(responseStatuses), title: TEXT, nextStep: TEXT,
  reason: TEXT, uncertainty: TEXT, evidence: z.array(evidenceSchema).max(100),
  extraction: extractionSchema.nullable(),
  question: z.object({ id: z.enum(['initiated_request', 'sharing_code', 'asked_to_install', 'payment_expected']), text: TEXT, options: z.array(TEXT).max(3) }).strict().nullable(),
  checkedAt: z.iso.datetime(), aiUsed: z.boolean(), notice: TEXT.optional(),
  recovery: z.enum(['retry', 'edit_input', 'clearer_image', 'none']).optional(),
  hasContinuation: z.boolean().optional(),
}).strict();
const errorSchema = z.object({ error: z.object({ code: ID, message: TEXT, field: ID.optional() }).strict() }).strict();
const captureSchema = z.object({
  schemaVersion: z.literal(1), caseId: ID, candidateHash: HASH, policyHash: HASH,
  referenceSha256: HASH, inputSha256: HASH, capturedAt: z.iso.datetime(),
  // These are frozen synthetic fixture inputs, never arbitrary real user input.
  // Equality to the manifest also permits intentionally malformed test inputs.
  submittedInput: z.record(z.string(), z.unknown()), imageSha256: HASH.optional(), uploadImageSha256: HASH.optional(),
  attempts: z.array(z.object({
    observation: observationSchema, receivedAt: z.iso.datetime(),
    response: z.object({ httpStatus: z.number().int().min(100).max(599), body: z.union([resultSchema, errorSchema]) }).strict().nullable(),
    answer: z.enum(['yes', 'no', 'unsure']).optional(),
  }).strict()).min(1).max(3),
}).strict();
const reviewSchema = z.object({
  schemaVersion: z.literal(1), caseId: ID, captureSha256: HASH,
  reviewer: z.object({ name: z.string().trim().min(1).max(120), kind: z.enum(['human', 'ai']) }).strict(),
  workflowMatch: z.boolean(), criticalFindings: z.array(ID).max(30),
  criteria: z.array(z.object({
    kind: z.enum(['mustExplain', 'prohibitedOutcome', 'conditionalRequirement', 'outcomeCondition']), criterion: z.string().min(1).max(4000),
    passed: z.boolean(), rationale: RATIONALE,
  }).strict()).max(200),
  criticalChecks: z.array(z.object({ category: ID, passed: z.boolean(), rationale: RATIONALE }).strict()).min(1).max(30),
  actionMapping: z.object({ passed: z.boolean(), rationale: RATIONALE }).strict(),
}).strict();

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function boundedPath(value) {
  if (typeof value !== 'string' || value.length > 512 || isAbsolute(value) || win32.isAbsolute(value)
    || value.includes('\\') || !value.startsWith('evaluation/release-captures/') || !value.endsWith('.json')) return false;
  return value.split('/').every(part => part && part !== '.' && part !== '..' && /^[a-zA-Z0-9._-]+$/.test(part));
}
function inside(base, target) {
  const name = relative(base, target);
  return name !== '' && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
}
function stripJsonWhitespace(text) {
  let quoted = false, escaped = false, compact = '';
  for (const character of text) {
    if (quoted || !/\s/.test(character)) compact += character;
    if (quoted && escaped) escaped = false;
    else if (quoted && character === '\\') escaped = true;
    else if (character === '"') quoted = !quoted;
  }
  return compact;
}
async function readArtifact(root, ref, maxBytes) {
  if (!ref || !boundedPath(ref.path) || !HASH.safeParse(ref.sha256).success
    || Object.keys(ref).some(key => !['path', 'sha256'].includes(key))) throw new Error('invalid artifact reference');
  const realRoot = await realpath(root);
  let current = realRoot;
  for (const part of ref.path.split('/')) {
    current = resolve(current, part);
    if (!inside(realRoot, current)) throw new Error('artifact escapes root');
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('symlink artifact path');
  }
  if (!inside(resolve(realRoot, 'evaluation/release-captures'), current)) throw new Error('artifact escapes capture directory');
  const file = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maxBytes || before.size === 0) throw new Error('artifact is empty, non-file or too large');
    // Read a bounded buffer even if a concurrent writer grows the file.
    const buffer = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = await file.read(buffer, count, buffer.length - count, null);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await file.stat();
    if (count > maxBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || count !== after.size
      || await realpath(current) !== current) throw new Error('artifact changed while reading');
    const bytes = buffer.subarray(0, count);
    if (hash(bytes) !== ref.sha256) throw new Error('artifact digest mismatch');
    const text = bytes.toString('utf8'), parsed = JSON.parse(text);
    // A duplicate key could conceal excluded data behind a later allowed value.
    // Require normal JSON.stringify encoding (optional indentation/newline).
    if (JSON.stringify(parsed) !== stripJsonWhitespace(text)) throw new Error('ambiguous JSON encoding');
    return parsed;
  } finally { await file.close(); }
}

/**
 * TypeScript 7's scanner supplies decoded string literals without executing the
 * module. Accept only this small constant-object grammar; changes require review.
 */
async function readActions(root) {
  const code = await readFile(resolve(root, 'shared/contracts.ts'), 'utf8');
  if (code.length > 256000) throw new Error('contract source too large');
  const scanner = createScanner(true, undefined, code), tokens = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (scanner.isUnterminated()) throw new Error('unterminated source token');
    tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue() });
  }
  const positions = tokens.flatMap((token, index) => token.kind === SyntaxKind.Identifier && token.text === 'ACTIONS' ? [index] : []);
  if (positions.length !== 1) throw new Error('missing, duplicated or subsequently mutated action declaration');
  let at = positions[0];
  if (tokens[at - 1]?.text !== 'const' || tokens[at - 2]?.text !== 'export') throw new Error('unsupported action declaration');
  const start = at++;
  while (tokens[at] && tokens[at].text !== '=') {
    if (at - start > 100 || ['export', 'const', 'function', '=>'].includes(tokens[at].text)) throw new Error('unsupported action type declaration');
    at++;
  }
  const take = text => { if (tokens[at++]?.text !== text) throw new Error('unsupported action literal'); };
  const name = () => {
    const token = tokens[at++];
    if (!token || ![SyntaxKind.Identifier, SyntaxKind.StringLiteral].includes(token.kind)) throw new Error('computed action key is unsupported');
    return token.kind === SyntaxKind.StringLiteral ? token.value : token.text;
  };
  take('='); take('{');
  const actions = Object.create(null);
  while (tokens[at]?.text !== '}') {
    const actionId = name();
    if (Object.hasOwn(actions, actionId)) throw new Error('duplicate action');
    take(':'); take('{');
    const action = Object.create(null);
    while (tokens[at]?.text !== '}') {
      const key = name(); take(':');
      const value = tokens[at++];
      if (!['title', 'nextStep'].includes(key) || Object.hasOwn(action, key) || value?.kind !== SyntaxKind.StringLiteral) throw new Error('action must use unique string-literal fields');
      action[key] = value.value;
      if (tokens[at]?.text !== '}') take(',');
    }
    take('}');
    if (!action.title || !action.nextStep) throw new Error('incomplete action');
    actions[actionId] = action;
    if (tokens[at]?.text !== '}') take(',');
  }
  take('}');
  if (tokens[at] && tokens[at].text !== ';') throw new Error('action initializer is not a literal object');
  if (Object.keys(actions).length === 0) throw new Error('empty action declaration');
  return actions;
}
function expectedCriteria(testCase) {
  const criteria = [];
  for (const criterion of testCase.expected?.mustExplain ?? []) criteria.push({ kind: 'mustExplain', criterion });
  for (const criterion of [...(testCase.globalProhibitedOutcomes ?? []), ...(testCase.expected?.prohibitedOutcomes ?? [])]) {
    criteria.push({ kind: 'prohibitedOutcome', criterion });
  }
  for (const [actionId, requirement] of Object.entries(testCase.expected?.conditionalActionRequirements ?? {})) {
    criteria.push({ kind: 'conditionalRequirement', criterion: `${actionId}: ${requirement}` });
  }
  for (const outcome of testCase.expected?.acceptableOutcomes ?? []) {
    criteria.push({ kind: 'outcomeCondition', criterion: `${outcome.status}: ${outcome.condition}` });
  }
  return [...new Map(criteria.map(item => [JSON.stringify(item), item])).values()];
}
function sameItems(actual, expected) {
  return actual.length === expected.length && new Set(actual).size === actual.length && actual.every(item => expected.includes(item));
}

/**
 * Validate integrity and completeness, not truth of a reviewer's judgement.
 * Local captures are not signed server attestations and can be fabricated by
 * someone who controls both the files and their hashes.
 */
export async function validateArtifacts({ root, evidence, manifest, candidateHash, policyHash }) {
  const issues = [];
  const add = (id, message) => issues.push(`${id}: ${message}`);
  const startedAt = Date.parse(evidence?.startedAt), completedAt = Date.parse(evidence?.completedAt);
  if (!HASH.safeParse(candidateHash).success || !HASH.safeParse(policyHash).success
    || !Array.isArray(evidence?.cases) || !Array.isArray(manifest?.cases)
    || !Array.isArray(manifest?.criticalCategories) || manifest.criticalCategories.length === 0
    || new Set(manifest.criticalCategories).size !== manifest.criticalCategories.length
    || !Number.isFinite(startedAt) || !Number.isFinite(completedAt) || startedAt > completedAt || completedAt > Date.now()) {
    return { passed: false, issues: ['Invalid artifact-validation context.'] };
  }
  let actions;
  try { actions = await readActions(root); }
  catch { return { passed: false, issues: ['Cannot validate the current action mapping.'] }; }
  const cases = new Map(manifest.cases.map(item => [item.id, item]));
  const seen = new Set();
  for (const record of evidence.cases) {
    const id = typeof record?.id === 'string' ? record.id : 'unknown-case';
    if (seen.has(id)) { add(id, 'duplicate case record'); continue; }
    seen.add(id);
    const testCase = cases.get(id);
    if (!testCase) { add(id, 'case is absent from the frozen manifest'); continue; }
    if (!Array.isArray(record.attempts)) { add(id, 'attempt list missing'); continue; }
    if (record.attempts.length === 0) {
      if (record.artifact || record.semanticReview || record.reviewed) add(id, 'unattempted case has capture or review claims');
      continue;
    }
    let capture;
    try {
      capture = captureSchema.parse(await readArtifact(root, record.artifact, 1024 * 1024));
    } catch { add(id, 'capture missing, unsafe, corrupt or outside the strict capture schema'); continue; }
    if (capture.caseId !== id || capture.candidateHash !== candidateHash || capture.policyHash !== policyHash) add(id, 'capture identity or fingerprint differs');
    const capturedAt = Date.parse(capture.capturedAt);
    if (capturedAt < startedAt || capturedAt > completedAt) add(id, 'capture timestamp is outside the evidence run');
    if (capture.referenceSha256 !== testCase.referenceSha256) add(id, 'capture reference digest differs');
    const fixtureHash = testCase.fixture?.sha256;
    if (!isDeepStrictEqual(capture.submittedInput, testCase.input) || capture.imageSha256 !== fixtureHash
      || capture.inputSha256 !== inputFingerprint(testCase.input, fixtureHash)) add(id, 'capture is not the frozen submitted input');
    if (!isDeepStrictEqual(capture.attempts.map(attempt => attempt.observation), record.attempts)) add(id, 'inline observations differ from the captured attempt sequence');

    let previousReceivedAt = startedAt, actionMappingPassed = true, evidenceRequirementsPassed = true;
    for (let index = 0; index < capture.attempts.length; index++) {
      const { observation, response, answer, receivedAt: receivedText } = capture.attempts[index];
      const label = `${id} attempt ${index + 1}`;
      const receivedAt = Date.parse(receivedText);
      if (receivedAt < previousReceivedAt || receivedAt > capturedAt || receivedAt > completedAt) add(label, 'response timestamp is outside the run or out of order');
      previousReceivedAt = receivedAt;
      if (observation.kind === 'clarification') {
        if (answer !== testCase.clarification?.answer || !answer) add(label, 'clarification answer differs from the frozen policy');
      } else if (answer !== undefined) add(label, 'initial attempt includes a clarification answer');
      if (!response) {
        if (observation.httpStatus !== null || observation.questionId !== null || !observation.errorCode
          || (observation.observedStatus !== null && observation.observedStatus !== 'client_rejected')
          || (observation.aiUsed !== null && observation.aiUsed !== false)) add(label, 'missing response is represented as a successful result');
        continue;
      }
      if (response.httpStatus !== observation.httpStatus) add(label, 'HTTP status differs from the captured response');
      if ('error' in response.body) {
        if (response.httpStatus < 400 || observation.errorCode !== response.body.error.code || observation.observedStatus !== null
          || observation.aiUsed !== null || observation.questionId !== null) add(label, 'error response is misrepresented by the observation');
        continue;
      }
      const body = response.body;
      const checkedAt = Date.parse(body.checkedAt);
      if (checkedAt < startedAt || checkedAt > receivedAt || checkedAt > completedAt) add(label, 'result timestamp is outside the captured response window');
      if (response.httpStatus < 200 || response.httpStatus >= 300 || body.requestId !== observation.requestId
        || body.status !== observation.observedStatus || body.aiUsed !== observation.aiUsed
        || (body.question?.id ?? null) !== observation.questionId || observation.errorCode !== null) add(label, 'result fields differ from the observation');
      if (body.status === 'needs_context' && (!body.question || body.hasContinuation !== true)) add(label, 'clarification response has no usable question or continuation-presence record');
      if (body.status !== 'needs_context' && (body.question !== null || body.hasContinuation === true)) add(label, 'terminal response retains a live clarification');
      if (testCase.route === 'ai' && response.httpStatus === 200) {
        const requirements = testCase.expected?.evidenceRequirements ?? [];
        // One compliant entry must not conceal a contradictory claim for the
        // same evidence kind. Unrelated kinds are not constrained by this rule.
        evidenceRequirementsPassed &&= Array.isArray(requirements) && requirements.every(requirement => {
          const entries = body.evidence.filter(item => item.kind === requirement?.kind);
          return Array.isArray(requirement?.allowedStates) && requirement.allowedStates.length > 0
            && entries.length > 0 && entries.every(item => requirement.allowedStates.includes(item.state));
        });
      }
      if (body.status !== 'partial') {
        const match = Object.entries(actions).find(([, action]) => action.title === body.title && action.nextStep === body.nextStep)?.[0];
        const allowed = observation.kind === 'clarification'
          ? testCase.expected?.clarification?.branches?.find(branch => branch.answer === answer)?.allowedActionIds
          : testCase.expected?.allowedActionIds;
        if (!match || !Array.isArray(allowed) || !allowed.includes(match)) actionMappingPassed = false;
      }
    }

    let review;
    try { review = reviewSchema.parse(await readArtifact(root, record.semanticReview, 256 * 1024)); }
    catch { add(id, 'semantic review missing, unsafe, corrupt or incomplete'); continue; }
    if (review.caseId !== id || review.captureSha256 !== record.artifact.sha256) add(id, 'semantic review is not bound to this capture');
    if (record.reviewed !== true || review.workflowMatch !== record.workflowMatch
      || !isDeepStrictEqual(review.criticalFindings, record.criticalFindings)) add(id, 'inline review claims differ from the signed-off review file');
    if (review.actionMapping.passed !== actionMappingPassed) add(id, 'review action mapping contradicts the rendered allowed action check');
    // Honest noncritical failures remain valid evidence. The engine applies the
    // declared per-cohort workflow threshold; this module must not turn 90% into 100%.
    if (review.workflowMatch && (!review.actionMapping.passed || review.criteria.some(item => !item.passed))) add(id, 'review claims a workflow match despite a failed criterion or action mapping');
    if (review.workflowMatch && !evidenceRequirementsPassed) add(id, 'review claims a workflow match despite missing or contradictory required evidence states');
    if (review.criticalFindings.length !== 0) add(id, 'review records critical findings');
    const required = expectedCriteria(testCase).map(item => JSON.stringify(item));
    const reviewed = review.criteria.map(({ kind, criterion }) => JSON.stringify({ kind, criterion }));
    if (!sameItems(reviewed, required)) add(id, 'review does not cover every exact frozen explanation, prohibition and conditional requirement');
    if (!sameItems(review.criticalChecks.map(item => item.category), manifest.criticalCategories)) add(id, 'review does not cover the complete critical checklist');
    if (review.criticalChecks.some(item => !item.passed)) add(id, 'review fails a critical checklist item');
  }
  return { passed: issues.length === 0, issues };
}
