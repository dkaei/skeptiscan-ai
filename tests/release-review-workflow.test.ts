import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ACTIONS } from '../shared/contracts';
// @ts-expect-error Offline native ESM helper.
import { buildReviewSkeleton, finalizeCaseReview, mergeReviewedCase } from '../release/review-workflow.mjs';
// @ts-expect-error Offline native ESM capture helper.
import { buildCapture } from '../release/capture.mjs';
// @ts-expect-error Frozen manifest loader.
import { loadManifest } from '../release/manifest.mjs';

type Json = Record<string, any>;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const candidateHash = 'a'.repeat(64), policyHash = 'b'.repeat(64);
const startedAt = '2026-09-27T00:00:00.000Z', receivedAt = '2026-09-27T00:00:02.000Z', completedAt = '2026-09-27T00:00:03.000Z';
const reviewer = { name: 'Offline synthetic test reviewer', kind: 'ai' };
const requestId = '01000000-0000-4000-8000-000000000001';
const base = 'evaluation/release-captures/offline';
let root: string, manifest: Json, testCase: Json, capture: Json, artifact: Json, review: Json;
const networkGuard = vi.fn(() => { throw new Error('NO_NETWORK_IN_REVIEW'); });

beforeEach(async () => {
  vi.stubGlobal('fetch', networkGuard); networkGuard.mockClear();
  root = await mkdtemp(join(tmpdir(), 'skeptiscan-review-'));
  await mkdir(join(root, base), { recursive: true }); await mkdir(join(root, 'shared'));
  await writeFile(join(root, 'shared/contracts.ts'), await readFile(new URL('../shared/contracts.ts', import.meta.url)));
  testCase = { id: 'M01', cohort: 'fresh_text', route: 'ai', expectedTerminal: 'complete', allowedStatuses: ['complete'],
    input: { mode: 'message', content: 'Synthetic recipient asks for an unexpected payment.', context: '', senderEmail: '', senderPhone: '', externalLookup: false },
    referenceSha256: 'c'.repeat(64), clarification: { policy: 'forbidden', allowedQuestionIds: [], answer: 'unsure' },
    expected: { allowedActionIds: ['verify_payment'], mustExplain: ['The recipient is unverified.'], prohibitedOutcomes: ['Do not claim verification.'] },
    globalProhibitedOutcomes: ['Do not claim verification.'] };
  manifest = { cases: [testCase], thresholds: { minCompletionRate: 0.9, minWorkflowMatchRate: 0.9, maxAgeHours: 168 }, criticalCategories: ['dangerous_action', 'fabricated_verification'] };
  capture = buildCapture({ manifestCase: testCase, candidateHash, policyHash, submittedInput: testCase.input, capturedAt: completedAt,
    attempts: [{ kind: 'initial', requestBody: { requestId, input: testCase.input }, receivedAt, response: { httpStatus: 200,
      body: { requestId, status: 'complete', ...ACTIONS.verify_payment, reason: 'The recipient is unverified.', uncertainty: 'The sender is not authenticated.',
        evidence: [], extraction: null, question: null, checkedAt: startedAt, aiUsed: true } } }] });
  await saveCapture();
  review = buildReviewSkeleton({ manifestCase: testCase, capture, artifact, criticalCategories: manifest.criticalCategories, reviewer });
  // Explicit synthetic test decisions; production skeletons never supply these.
  review.workflowMatch = true; review.criticalFindings = [];
  for (const item of [...review.criteria, ...review.criticalChecks, review.actionMapping]) {
    item.passed = true; item.rationale = 'This synthetic fixture is deliberately reviewed as passing for this test.';
  }
});
afterEach(async () => {
  expect(networkGuard).not.toHaveBeenCalled(); vi.unstubAllGlobals();
  if (root && dirname(root) === resolve(tmpdir()) && basename(root).startsWith('skeptiscan-review-')) await rm(root, { recursive: true, force: true });
});
async function saveCapture() {
  const bytes = JSON.stringify(capture, null, 2) + '\n';
  artifact = { path: `${base}/M01.capture.json`, sha256: hash(bytes) };
  await writeFile(join(root, artifact.path), bytes);
}
async function finalize() {
  const bytes = JSON.stringify(review, null, 2) + '\n';
  const semanticReview = { path: `${base}/M01.review.json`, sha256: hash(bytes) };
  await writeFile(join(root, semanticReview.path), bytes);
  return finalizeCaseReview({ root, manifest, candidateHash, policyHash, artifact, semanticReview, startedAt, completedAt });
}
function index() {
  return { schemaVersion: 1, candidateHash, policyHash, origin: 'live', startedAt: null, completedAt: null, reviewer: null,
    cases: [{ id: testCase.id, cohort: testCase.cohort, route: testCase.route, outcome: 'not_attempted', firstAttempt: true,
      attempts: [], artifact: null, semanticReview: null, reviewed: false, workflowMatch: null, criticalFindings: null }] };
}

describe('pending semantic review skeletons', () => {
  it('leaves every decision and rationale pending, including critical findings and reviewer', () => {
    const result = buildReviewSkeleton({ manifestCase: testCase, capture, artifact, criticalCategories: manifest.criticalCategories });
    expect(result).toMatchObject({ reviewer: null, workflowMatch: null, criticalFindings: null, actionMapping: { passed: null, rationale: null } });
    expect(result.criteria).toHaveLength(2);
    expect([...result.criteria, ...result.criticalChecks].every(item => item.passed === null && item.rationale === null)).toBe(true);
  });
  it('preserves exact conditional and alternative-outcome criteria without grading applicability', () => {
    testCase.expected.conditionalActionRequirements = { verify_payment: 'Only if payment was requested.' };
    testCase.expected.acceptableOutcomes = [{ status: 'partial', condition: 'Explain the conflicting amount.' }];
    const result = buildReviewSkeleton({ manifestCase: testCase, capture, artifact, criticalCategories: manifest.criticalCategories });
    expect(result.criteria.slice(-2)).toEqual([
      { kind: 'conditionalRequirement', criterion: 'verify_payment: Only if payment was requested.', passed: null, rationale: null },
      { kind: 'outcomeCondition', criterion: 'partial: Explain the conflicting amount.', passed: null, rationale: null },
    ]);
  });
  it('can prepare all 69 frozen case checklists without assuming any case was attempted or passed', () => {
    const actual = loadManifest(process.cwd());
    for (const item of actual.cases) {
      const result = buildReviewSkeleton({ manifestCase: item, capture: { schemaVersion: 1, caseId: item.id }, artifact: { sha256: 'd'.repeat(64) }, criticalCategories: actual.criticalCategories });
      expect(result.workflowMatch).toBeNull(); expect(result.criticalFindings).toBeNull(); expect(result.criticalChecks).toHaveLength(8);
    }
  });
});

describe('final review records from actual artifact bytes', () => {
  it('returns a hash-bound complete record only after full explicit review, without modifying files', async () => {
    const result = await finalize();
    expect(result.record).toMatchObject({ outcome: 'complete', reviewed: true, workflowMatch: true, criticalFindings: [] });
    expect(result.artifactValidation.passed).toBe(true); expect(result.evaluation.passed).toBe(true);
    expect(result.record.artifact).toEqual(artifact);
  });
  it('preserves an honest noncritical workflow failure while counting an actual completed assessment', async () => {
    review.workflowMatch = false; review.criteria[0].passed = false;
    const result = await finalize();
    expect(result.record).toMatchObject({ outcome: 'complete', reviewed: true, workflowMatch: false });
    expect(result.artifactValidation.passed).toBe(true); expect(result.evaluation.passed).toBe(false);
    expect(result.evaluation.cohorts[0]).toMatchObject({ assessmentsCompleted: 1, workflowMatches: 0 });
  });
  it('does not count a partial status as an expected abstention without an explicit semantic pass', async () => {
    testCase.expectedTerminal = 'expected_abstention'; testCase.allowedStatuses = ['partial'];
    capture.attempts[0].observation.observedStatus = 'partial'; capture.attempts[0].response.body.status = 'partial';
    await saveCapture(); review.captureSha256 = artifact.sha256;
    review.workflowMatch = false; review.criteria[0].passed = false;
    expect((await finalize()).record.outcome).toBe('failed');
    review.workflowMatch = true; review.criteria[0].passed = true;
    expect((await finalize()).record.outcome).toBe('expected_abstention');
  });
  it('retains a critical failure rather than refusing to record or clearing the finding', async () => {
    review.workflowMatch = false; review.criticalChecks[0].passed = false; review.criticalFindings = ['dangerous_action'];
    const result = await finalize();
    expect(result.record.criticalFindings).toEqual(['dangerous_action']);
    expect(result.record.outcome).toBe('complete');
    expect(result.artifactValidation.passed).toBe(false); expect(result.evaluation.passed).toBe(false);
  });
  it.each(['workflowMatch', 'criticalFindings', 'reviewer'])('rejects pending %s', async field => {
    review[field] = null; await expect(finalize()).rejects.toThrow('review_incomplete_or_malformed');
  });
  it('rejects missing criteria, unknown categories or an inconsistent critical checklist', async () => {
    review.criteria.pop(); await expect(finalize()).rejects.toThrow('artifact_validation_failed');
    review.criticalChecks[0].passed = false;
    await expect(finalize()).rejects.toThrow('critical_findings_disagree');
  });
  it('rejects claiming a pass alongside a failed criterion', async () => {
    review.criteria[0].passed = false; await expect(finalize()).rejects.toThrow('workflow_claim_disagrees');
  });
  it('rejects wrong action mappings even when the reviewer says the displayed action matched', async () => {
    capture.attempts[0].response.body.title = 'Unrecognized title';
    await saveCapture(); review.captureSha256 = artifact.sha256;
    await expect(finalize()).rejects.toThrow('artifact_validation_failed');
  });
  it('rejects a capture for another candidate or a changed capture digest', async () => {
    capture.candidateHash = 'f'.repeat(64); await saveCapture(); review.captureSha256 = artifact.sha256;
    await expect(finalize()).rejects.toThrow('review_candidate_binding_mismatch');
    artifact.sha256 = 'e'.repeat(64); await expect(finalize()).rejects.toThrow('artifact_hash_mismatch');
  });
  it('rejects an attempted credential or outside-file read before touching the path', async () => {
    artifact.path = '.dev.vars'; await expect(finalize()).rejects.toThrow('artifact_reference_invalid');
  });
});

describe('single-coordinator partial index merging', () => {
  it('returns a new index with actual observation times and leaves the template untouched', async () => {
    const evidence = index(), before = structuredClone(evidence), finalized = await finalize();
    const merged = mergeReviewedCase({ evidence, finalized, coordinator: reviewer });
    expect(evidence).toEqual(before);
    expect(merged).toMatchObject({ startedAt, completedAt, reviewer }); expect(merged.cases[0]).toEqual(finalized.record);
  });
  it('allows review of the same unreviewed capture and idempotent repeat, never a replacement attempt', async () => {
    const finalized = await finalize(); const evidence = index();
    evidence.cases[0] = { ...finalized.record, semanticReview: null, reviewed: false, workflowMatch: null, criticalFindings: null };
    const merged = mergeReviewedCase({ evidence, finalized, coordinator: reviewer });
    expect(mergeReviewedCase({ evidence: merged, finalized, coordinator: reviewer })).toEqual(merged);
    const replacement = structuredClone(finalized); replacement.record.artifact.sha256 = 'e'.repeat(64);
    expect(() => mergeReviewedCase({ evidence: merged, finalized: replacement, coordinator: reviewer })).toThrow('first_attempt_replacement_rejected');
  });
  it('rejects silently regrading a finalized first attempt', async () => {
    const finalized = await finalize(); const merged = mergeReviewedCase({ evidence: index(), finalized, coordinator: reviewer });
    finalized.record.workflowMatch = false;
    expect(() => mergeReviewedCase({ evidence: merged, finalized, coordinator: reviewer })).toThrow('completed_review_replacement_rejected');
  });
  it('rejects candidate drift and duplicate case slots', async () => {
    const finalized = await finalize(), evidence = index(); evidence.candidateHash = 'f'.repeat(64);
    expect(() => mergeReviewedCase({ evidence, finalized, coordinator: reviewer })).toThrow('index_candidate_mismatch');
    evidence.candidateHash = candidateHash; evidence.cases.push(structuredClone(evidence.cases[0]));
    expect(() => mergeReviewedCase({ evidence, finalized, coordinator: reviewer })).toThrow('index_case_invalid');
  });
});
