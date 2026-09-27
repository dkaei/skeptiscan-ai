import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { sha256 } from './files.mjs';
import { validateArtifacts } from './artifacts.mjs';
import { evaluateLiveEvidence } from './evaluation.mjs';

// Offline review coordination only. Parallel reviewers own separate review
// files; one coordinator merges the returned records into the shared index.
// Nothing here sends requests, grades prose, fills decisions or writes files.
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const Reviewer = z.object({ name: z.string().trim().min(1).max(100), kind: z.enum(['ai', 'human']) }).strict();
const Decision = z.object({ passed: z.boolean(), rationale: z.string().trim().min(12).max(2000) }).strict();
const Review = z.object({
  schemaVersion: z.literal(1), caseId: ID, captureSha256: Hash, reviewer: Reviewer,
  workflowMatch: z.boolean(), criticalFindings: z.array(ID).max(30),
  criteria: z.array(Decision.extend({ kind: z.enum(['mustExplain', 'prohibitedOutcome', 'conditionalRequirement', 'outcomeCondition']), criterion: z.string().min(1).max(4000) })).max(200),
  criticalChecks: z.array(Decision.extend({ category: ID })).min(1).max(30),
  actionMapping: Decision,
}).strict();
const fail = code => { throw new Error(`review_workflow:${code}`); };
const assert = (condition, code) => { if (!condition) fail(code); };
const parse = (schema, value, code) => { const checked = schema.safeParse(value); if (!checked.success) fail(code); return checked.data; };

function criteriaFor(item) {
  const criteria = [];
  for (const criterion of item.expected?.mustExplain ?? []) criteria.push({ kind: 'mustExplain', criterion });
  for (const criterion of [...(item.globalProhibitedOutcomes ?? []), ...(item.expected?.prohibitedOutcomes ?? [])]) criteria.push({ kind: 'prohibitedOutcome', criterion });
  for (const [id, text] of Object.entries(item.expected?.conditionalActionRequirements ?? {})) criteria.push({ kind: 'conditionalRequirement', criterion: `${id}: ${text}` });
  for (const outcome of item.expected?.acceptableOutcomes ?? []) criteria.push({ kind: 'outcomeCondition', criterion: `${outcome.status}: ${outcome.condition}` });
  return [...new Map(criteria.map(item => [JSON.stringify(item), item])).values()];
}

/** Deliberately invalid as a completed semantic review: every judgment starts
 * null. Read the actual captured responses (and screenshot pixels/UI evidence)
 * before replacing any null. Never derive judgments from expected labels. */
export function buildReviewSkeleton({ manifestCase, capture, artifact, criticalCategories, reviewer = null }) {
  assert(manifestCase?.id === capture?.caseId && capture?.schemaVersion === 1, 'capture_case_mismatch');
  parse(Hash, artifact?.sha256, 'capture_hash_invalid');
  assert(Array.isArray(criticalCategories) && criticalCategories.length > 0
    && new Set(criticalCategories).size === criticalCategories.length && criticalCategories.every(item => ID.safeParse(item).success), 'critical_categories_invalid');
  if (reviewer !== null) parse(Reviewer, reviewer, 'reviewer_invalid');
  return { schemaVersion: 1, caseId: manifestCase.id, captureSha256: artifact.sha256,
    reviewer, workflowMatch: null, criticalFindings: null,
    criteria: criteriaFor(manifestCase).map(item => ({ ...item, passed: null, rationale: null })),
    criticalChecks: criticalCategories.map(category => ({ category, passed: null, rationale: null })),
    actionMapping: { passed: null, rationale: null } };
}

async function readBoundArtifact(root, ref, maxBytes) {
  assert(ref && Object.keys(ref).sort().join() === 'path,sha256' && Hash.safeParse(ref.sha256).success
    && typeof ref.path === 'string' && ref.path.length <= 500 && /^evaluation\/release-captures\/[A-Za-z0-9_./-]+\.json$/.test(ref.path)
    && ref.path.split('/').every(part => part && part !== '.' && part !== '..'), 'artifact_reference_invalid');
  const base = await realpath(root);
  let target = base;
  for (const part of ref.path.split('/')) {
    target = path.join(target, part);
    assert(!(await lstat(target)).isSymbolicLink(), 'artifact_symlink');
  }
  assert(await realpath(target) === target, 'artifact_redirected');
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await file.stat();
    assert(before.isFile() && before.size > 0 && before.size <= maxBytes, 'artifact_size_invalid');
    const bytes = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await file.read(bytes, count, bytes.length - count, null);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    const after = await file.stat();
    assert(count === before.size && count === after.size && before.mtimeMs === after.mtimeMs && count <= maxBytes, 'artifact_changed');
    const content = bytes.subarray(0, count);
    assert(sha256(content) === ref.sha256, 'artifact_hash_mismatch');
    try { return JSON.parse(content.toString('utf8')); } catch { return fail('artifact_json_invalid'); }
  } finally { await file.close(); }
}

// Operational outcome follows the release engine's rules. An expected
// abstention requires the reviewer's explicit full workflow pass, not merely
// a partial status or an expected reference label.
function outcomeFor(item, capture, review) {
  const last = capture.attempts.at(-1)?.observation;
  assert(last, 'capture_attempt_missing');
  const complete = last.observedStatus === 'complete' && last.questionId === null && last.errorCode === null
    && (item.route === 'ai' ? last.httpStatus === 200 && last.aiUsed === true : last.httpStatus === null && last.aiUsed === false);
  if (complete && item.expectedTerminal !== 'expected_abstention') return 'complete';
  const abstained = ['partial', 'client_rejected'].includes(last.observedStatus) && last.questionId === null
    && (item.route === 'ai' ? last.httpStatus === 200 && last.aiUsed === true && last.errorCode === null && last.observedStatus === 'partial'
      : last.httpStatus === null && last.aiUsed === false)
    && review.workflowMatch === true && review.criticalFindings.length === 0;
  return abstained && item.expectedTerminal !== 'complete' && item.allowedStatuses.includes(last.observedStatus) ? 'expected_abstention' : 'failed';
}

/** Review files must already contain explicit human/AI judgments and rationales.
 * Structural contradictions throw; honest negative/critical reviews return a
 * record with blocking validation results so failures remain in the index.
 * startedAt/completedAt are the actual observation window, not review time. */
export async function finalizeCaseReview({ root, manifest, candidateHash, policyHash, artifact, semanticReview, startedAt, completedAt, now = Date.now() }) {
  parse(Hash, candidateHash, 'candidate_hash_invalid'); parse(Hash, policyHash, 'policy_hash_invalid');
  parse(z.iso.datetime(), startedAt, 'run_time_invalid'); parse(z.iso.datetime(), completedAt, 'run_time_invalid');
  assert(Date.parse(startedAt) <= Date.parse(completedAt) && Date.parse(completedAt) <= now, 'run_time_invalid');
  const capture = await readBoundArtifact(root, artifact, 1024 * 1024);
  const review = parse(Review, await readBoundArtifact(root, semanticReview, 256 * 1024), 'review_incomplete_or_malformed');
  const item = manifest.cases.find(item => item.id === capture.caseId);
  assert(item && capture.schemaVersion === 1 && capture.candidateHash === candidateHash && capture.policyHash === policyHash
    && review.caseId === item.id && review.captureSha256 === artifact.sha256, 'review_candidate_binding_mismatch');
  assert(Array.isArray(capture.attempts) && capture.attempts.length >= 1 && capture.attempts.length <= 2, 'capture_attempt_invalid');
  const failedCritical = review.criticalChecks.filter(item => !item.passed).map(item => item.category).sort();
  assert(new Set(review.criticalFindings).size === review.criticalFindings.length
    && isDeepStrictEqual([...review.criticalFindings].sort(), failedCritical), 'critical_findings_disagree');
  assert(!review.workflowMatch || (review.criticalFindings.length === 0 && review.actionMapping.passed && review.criteria.every(item => item.passed)), 'workflow_claim_disagrees');
  const record = { id: item.id, cohort: item.cohort, route: item.route,
    outcome: outcomeFor(item, capture, review), firstAttempt: true,
    attempts: capture.attempts.map(item => structuredClone(item.observation)), artifact: structuredClone(artifact),
    semanticReview: structuredClone(semanticReview), reviewed: true,
    workflowMatch: review.workflowMatch, criticalFindings: [...review.criticalFindings] };
  const evidence = { schemaVersion: 1, candidateHash, policyHash, origin: 'live', startedAt, completedAt, reviewer: review.reviewer, cases: [record] };
  const artifactValidation = await validateArtifacts({ root, evidence, manifest, candidateHash, policyHash });
  // These two findings are valid negative reviews, not malformed artifacts.
  const permittedFailures = new Set([`${item.id}: review records critical findings`, `${item.id}: review fails a critical checklist item`]);
  assert(artifactValidation.issues.every(issue => permittedFailures.has(issue)), 'artifact_validation_failed');
  const evaluation = evaluateLiveEvidence({ evidence, candidateHash, policyHash, manifest: { ...manifest, cases: [item] }, now });
  return { candidateHash, policyHash, startedAt, completedAt, record, artifactValidation, evaluation };
}

/** Pure merge: the single coordinator writes the result. Parallel reviewers
 * must never race to rewrite the shared evidence index. Existing first attempts
 * and completed reviews cannot be replaced by retries or silent regrading. */
export function mergeReviewedCase({ evidence, finalized, coordinator }) {
  parse(Reviewer, coordinator, 'coordinator_invalid');
  assert(evidence?.schemaVersion === 1 && evidence.origin === 'live' && evidence.candidateHash === finalized?.candidateHash
    && evidence.policyHash === finalized.policyHash && Array.isArray(evidence.cases), 'index_candidate_mismatch');
  const record = finalized.record;
  const positions = evidence.cases.map((item, index) => item.id === record?.id ? index : -1).filter(index => index >= 0);
  assert(positions.length === 1 && record?.reviewed === true, 'index_case_invalid');
  const previous = evidence.cases[positions[0]];
  assert(previous.cohort === record.cohort && previous.route === record.route, 'index_case_mismatch');
  assert(Array.isArray(previous.attempts), 'index_case_invalid');
  if (previous.attempts.length > 0) {
    assert(isDeepStrictEqual(previous.attempts, record.attempts) && isDeepStrictEqual(previous.artifact, record.artifact), 'first_attempt_replacement_rejected');
    assert(!previous.reviewed || isDeepStrictEqual(previous, record), 'completed_review_replacement_rejected');
  } else assert(previous.outcome === 'not_attempted' && previous.artifact === null && !previous.reviewed, 'index_case_invalid');
  const result = structuredClone(evidence);
  result.cases[positions[0]] = structuredClone(record);
  for (const field of ['startedAt', 'completedAt']) {
    parse(z.iso.datetime(), finalized[field], 'run_time_invalid');
    if (result[field] !== null) parse(z.iso.datetime(), result[field], 'run_time_invalid');
  }
  result.startedAt = result.startedAt === null || Date.parse(finalized.startedAt) < Date.parse(result.startedAt) ? finalized.startedAt : result.startedAt;
  result.completedAt = result.completedAt === null || Date.parse(finalized.completedAt) > Date.parse(result.completedAt) ? finalized.completedAt : result.completedAt;
  result.reviewer = structuredClone(coordinator);
  return result;
}
