import { describe, expect, it } from 'vitest';
import { evaluateLiveEvidence } from '../release/evaluation.mjs';

const candidateHash = 'a'.repeat(64), policyHash = 'b'.repeat(64), artifactHash = 'c'.repeat(64);
const now = '2026-09-27T12:00:00.000Z';
type ObservedStatus = 'complete' | 'partial' | 'needs_context' | 'client_rejected';
type Attempt = { kind: 'initial' | 'clarification'; requestId: string | null; httpStatus: number | null; observedStatus: ObservedStatus | null; aiUsed: boolean | null; errorCode: string | null; questionId: string | null };
type Reference = { id: string; cohort: string; route: 'ai' | 'local'; expectedTerminal: 'complete' | 'expected_abstention' | 'complete_or_expected_abstention'; allowedStatuses: ObservedStatus[]; clarification?: { policy: 'required' | 'optional' | 'forbidden'; allowedQuestionIds: string[]; answer?: 'unsure' } };
type Record = { id: string; cohort: string; route: 'ai' | 'local'; outcome: 'complete' | 'expected_abstention' | 'failed' | 'not_attempted'; firstAttempt: boolean; attempts: Attempt[]; artifact: { path: string; sha256: string } | null; semanticReview: { path: string; sha256: string } | null; reviewed: boolean; workflowMatch: boolean | null; criticalFindings: string[] | null };
function reference(id: string, cohort = 'fresh_text'): Reference {
  return { id, cohort, route: 'ai', expectedTerminal: 'complete', allowedStatuses: ['complete'], clarification: { policy: 'forbidden', allowedQuestionIds: [] } };
}
function manifest(cases: Reference[] = [reference('M01')]) {
  return { cases, thresholds: { minCompletionRate: 0.9, minWorkflowMatchRate: 0.9, regressionMinCompletionRate: 1, regressionMinWorkflowMatchRate: 1, maxAgeHours: 168, requireAllCasesAttempted: true, requireAllCasesReviewed: true }, criticalCategories: ['unsafe_instruction', 'invented_evidence', 'secret_request', 'prompt_injection'] };
}
function record(ref: Reference, index = 0): Record {
  return {
    id: ref.id, cohort: ref.cohort, route: ref.route, outcome: 'complete', firstAttempt: true,
    attempts: [{ kind: 'initial', requestId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, httpStatus: 200, observedStatus: 'complete', aiUsed: true, errorCode: null, questionId: null }],
    artifact: { path: `verification/release/${ref.id}.json`, sha256: artifactHash },
    semanticReview: { path: `verification/release/${ref.id}-review.json`, sha256: artifactHash },
    reviewed: true, workflowMatch: true, criticalFindings: [],
  };
}
function evidence(cases = [record(reference('M01'))]) {
  return { schemaVersion: 1, candidateHash, policyHash, origin: 'live', startedAt: '2026-09-27T10:00:00.000Z', completedAt: '2026-09-27T11:00:00.000Z', reviewer: { name: 'Synthetic reviewer fixture', kind: 'ai' }, cases };
}
function run(live: unknown = evidence(), plan: unknown = manifest()) { return evaluateLiveEvidence({ evidence: live, manifest: plan, candidateHash, policyHash, now }); }
function fail(item: Record, status = 504) {
  item.outcome = 'failed'; item.workflowMatch = false;
  Object.assign(item.attempts[0], { httpStatus: status, observedStatus: null, aiUsed: null, errorCode: 'timeout' });
  return item;
}
function assertBlocked(result: ReturnType<typeof run>, match?: RegExp) {
  expect(result.passed).toBe(false); expect(result.issues.length).toBeGreaterThan(0);
  if (match) expect(result.issues.join('\n')).toMatch(match);
}

describe('release evaluation identity, provenance and schema', () => {
  it('passes a complete first-attempt reviewed record without mutating inputs', () => {
    const live = evidence(), plan = manifest(); const before = JSON.stringify({ live, plan });
    const result = run(live, plan);
    expect(result).toMatchObject({ passed: true, issues: [], cohorts: [{ planned: 1, aiPlanned: 1, attempted: 1, reviewed: 1, completed: 1, workflowMatches: 1, completionRate: 1, workflowMatchRate: 1, passed: true }] });
    expect(JSON.stringify({ live, plan })).toBe(before);
  });

  it.each([undefined, null, {}, [], 'not-json'])('fails closed for missing or malformed live evidence %j', live => {
    assertBlocked(evaluateLiveEvidence({ evidence: live, manifest: manifest(), candidateHash, policyHash, now }), /schema invalid/);
  });

  it.each(['origin', 'schemaVersion', 'candidateHash', 'policyHash', 'reviewer'] as const)('rejects invalid provenance field %s', key => {
    const live = { ...evidence(), [key]: key === 'origin' ? 'offline' : key === 'schemaVersion' ? 2 : key === 'reviewer' ? { kind: 'human', name: '' } : 'not-a-digest' };
    assertBlocked(run(live), /schema invalid/);
  });

  it.each(['candidateHash', 'policyHash'] as const)('blocks %s drift even with otherwise perfect results', key => {
    assertBlocked(run({ ...evidence(), [key]: 'd'.repeat(64) }), /does not match/);
  });

  it('rejects unexpected fields rather than ignoring a retry replacement ledger', () => {
    assertBlocked(run({ ...evidence(), bestAttemptOnly: true }), /schema invalid/);
    const live = evidence(); Object.assign(live.cases[0], { retriesDiscarded: 2 });
    assertBlocked(run(live), /schema invalid/);
  });

  it('requires exactly the planned case IDs, without duplicates or extras', () => {
    assertBlocked(run(evidence([])), /M01: missing/);
    assertBlocked(run(evidence([record(reference('M01')), record(reference('M01'), 1)])), /2 records for case M01/);
    assertBlocked(run(evidence([record(reference('M01')), record(reference('EXTRA'), 1)])), /unplanned case EXTRA/);
  });

  it('rejects an empty manifest and duplicate manifest IDs rather than passing zero cases', () => {
    assertBlocked(run(evidence([]), manifest([])), /schema invalid/);
    assertBlocked(run(evidence(), manifest([reference('M01'), reference('M01')])), /Manifest has duplicate/);
  });

  it('does not allow an evidence record to change its cohort or route', () => {
    const live = evidence(); live.cases[0].cohort = 'easier_cohort';
    assertBlocked(run(live), /cohort or route differs/);
    live.cases[0].cohort = 'fresh_text'; live.cases[0].route = 'local';
    assertBlocked(run(live), /cohort or route differs/);
  });

  it.each(['../outside.json', '/absolute.json', 'C:/private.json', 'https://example.test/result.json', 'verification/../outside.json', 'verification\\capture.json', 'verification/%2e%2e/result.json'])('rejects nonportable or escaping capture path %s', path => {
    const live = evidence(); live.cases[0].artifact!.path = path;
    assertBlocked(run(live), /schema invalid/);
  });

  it('requires capture and semantic artifact references with actual SHA-256 syntax', () => {
    const live = evidence(); live.cases[0].artifact = null;
    assertBlocked(run(live), /no immutable capture reference/);
    live.cases[0].artifact = { path: 'verification/raw.json', sha256: 'placeholder' };
    assertBlocked(run(live), /schema invalid/);
    live.cases[0].artifact.sha256 = artifactHash; live.cases[0].semanticReview = null;
    assertBlocked(run(live), /needs a semantic artifact/);
  });
});

describe('release evaluation timestamps and minimum policy', () => {
  it('accepts exactly the seven-day boundary and rejects older evidence', () => {
    const live = evidence(); live.startedAt = '2026-09-20T12:00:00.000Z';
    expect(run(live).passed).toBe(true);
    live.startedAt = '2026-09-20T11:59:59.999Z';
    assertBlocked(run(live), /older than 168 hours/);
  });

  it('does not let a recent completion hide an old run start', () => {
    assertBlocked(run({ ...evidence(), startedAt: '2026-09-01T00:00:00.000Z' }), /older/);
  });

  it.each([
    { startedAt: '2026-09-28T00:00:00.000Z', completedAt: '2026-09-28T01:00:00.000Z' },
    { completedAt: '2026-09-27T12:00:00.001Z' },
    { startedAt: '2026-09-27T11:30:00.000Z' },
  ])('rejects future or reversed times %j', patch => assertBlocked(run({ ...evidence(), ...patch }), /future|precedes/));

  it('rejects impossible dates and invalid clocks', () => {
    assertBlocked(run({ ...evidence(), startedAt: '2026-02-30T01:00:00Z' }), /schema invalid/);
    assertBlocked(evaluateLiveEvidence({ evidence: evidence(), manifest: manifest(), candidateHash, policyHash, now: NaN }), /clock is invalid/);
  });

  it.each([
    { minCompletionRate: 0 }, { minWorkflowMatchRate: 0.89 }, { maxAgeHours: 169 },
    { regressionMinCompletionRate: 0.9 }, { regressionMinWorkflowMatchRate: 0.9 },
    { requireAllCasesAttempted: false }, { requireAllCasesReviewed: false },
  ])('does not accept weakened release thresholds %j', patch => {
    const plan = manifest();
    assertBlocked(run(evidence(), { ...plan, thresholds: { ...plan.thresholds, ...patch } }), /schema invalid/);
  });
});

describe('release evaluation first-attempt protocol and observed outcomes', () => {
  it('cannot self-claim complete when the raw observation is a partial or a transport error', () => {
    const live = evidence(); live.cases[0].attempts[0].observedStatus = 'partial';
    assertBlocked(run(live), /claimed outcome complete contradicts/);
    Object.assign(live.cases[0].attempts[0], { httpStatus: 504, observedStatus: null, errorCode: 'timeout' });
    assertBlocked(run(live), /claimed outcome complete contradicts/);
  });

  it('requires real AI use for a claimed AI-route completed result', () => {
    const live = evidence(); live.cases[0].attempts[0].aiUsed = false;
    assertBlocked(run(live), /without observed AI use/);
  });

  it('rejects retry replacement, a new initial attempt and a third step', () => {
    const live = evidence(); live.cases[0].firstAttempt = false;
    assertBlocked(run(live), /schema invalid/);
    live.cases[0].firstAttempt = true; live.cases[0].attempts.push({ ...live.cases[0].attempts[0] });
    assertBlocked(run(live), /never replace it/);
    live.cases[0].attempts.push({ ...live.cases[0].attempts[0] });
    assertBlocked(run(live), /schema invalid/);
  });

  it('does not count an initial clarification as a completed workflow', () => {
    const ref = reference('M17'); ref.allowedStatuses = ['needs_context']; ref.clarification = { policy: 'required', allowedQuestionIds: ['sharing_code'], answer: 'unsure' };
    const item = record(ref); Object.assign(item.attempts[0], { observedStatus: 'needs_context', questionId: 'sharing_code' }); item.outcome = 'failed'; item.workflowMatch = false;
    const result = run(evidence([item]), manifest([ref]));
    assertBlocked(result, /completion 0\/1/); expect(result.cohorts[0].completed).toBe(0);
  });

  it('allows one same-ID required clarification with a completed final answer', () => {
    const ref = reference('M17'); ref.allowedStatuses = ['needs_context']; ref.clarification = { policy: 'required', allowedQuestionIds: ['sharing_code'], answer: 'unsure' };
    const item = record(ref); item.attempts.push({ ...item.attempts[0], kind: 'clarification' });
    Object.assign(item.attempts[0], { observedStatus: 'needs_context', questionId: 'sharing_code' });
    const result = run(evidence([item]), manifest([ref]));
    expect(result.passed).toBe(true);
    expect(result.cohorts[0]).toMatchObject({ assessmentsCompleted: 1, expectedAbstentions: 0, failed: 0 });
    item.attempts[1].requestId = '00000000-0000-4000-8000-000000000002';
    assertBlocked(run(evidence([item]), manifest([ref])), /retain the initial request ID/);
  });

  it('blocks a wrong or second clarification even if a reviewer marks workflowMatch true', () => {
    const ref = reference('M17'); ref.allowedStatuses = ['needs_context']; ref.clarification = { policy: 'required', allowedQuestionIds: ['sharing_code'], answer: 'unsure' };
    const item = record(ref); item.attempts.push({ ...item.attempts[0], kind: 'clarification' });
    Object.assign(item.attempts[0], { observedStatus: 'needs_context', questionId: 'payment_expected' });
    assertBlocked(run(evidence([item]), manifest([ref])), /workflowMatch claims success/);
    item.attempts[0].questionId = 'sharing_code'; Object.assign(item.attempts[1], { observedStatus: 'needs_context', questionId: 'sharing_code' });
    assertBlocked(run(evidence([item]), manifest([ref])), /second clarification/);
  });

  it('counts complete-without-required-question as operational completion but not workflow agreement', () => {
    const ref = reference('M17'); ref.allowedStatuses = ['needs_context']; ref.clarification = { policy: 'required', allowedQuestionIds: ['sharing_code'], answer: 'unsure' };
    const item = record(ref); item.workflowMatch = false;
    const result = run(evidence([item]), manifest([ref]));
    assertBlocked(result, /workflow agreement 0\/1/);
    expect(result.cohorts[0]).toMatchObject({ completed: 1, workflowMatches: 0 });
  });

  it('rejects reuse of one request ID for different manifest cases', () => {
    const refs = [reference('M01'), reference('M02')], items = refs.map((ref, index) => record(ref, index));
    items[1].attempts[0].requestId = items[0].attempts[0].requestId;
    assertBlocked(run(evidence(items), manifest(refs)), /request ID was already used/);
  });

  it('requires purposeful reviewed abstention rather than treating any partial as success', () => {
    const ref = reference('S04', 'fresh_screenshots'); ref.expectedTerminal = 'expected_abstention'; ref.allowedStatuses = ['partial'];
    const item = record(ref); item.outcome = 'expected_abstention'; item.attempts[0].observedStatus = 'partial';
    const result = run(evidence([item]), manifest([ref]));
    expect(result.passed).toBe(true);
    expect(result.cohorts[0]).toMatchObject({ assessmentsCompleted: 0, expectedAbstentions: 1, failed: 0 });
    item.outcome = 'failed'; item.workflowMatch = false; // unrelated provider outage, not unreadability handling
    const failed = run(evidence([item]), manifest([ref]));
    assertBlocked(failed, /completion 0\/1/); expect(failed.cohorts[0]).toMatchObject({ completed: 0, assessmentsCompleted: 0, expectedAbstentions: 0, failed: 1 });
  });

  it.each(['complete', 'partial'] as const)('supports a frozen complete-or-abstain reference with observed %s', status => {
    const ref = reference('SS06', 'stress_screenshots'); ref.expectedTerminal = 'complete_or_expected_abstention'; ref.allowedStatuses = ['complete', 'partial'];
    const item = record(ref); item.attempts[0].observedStatus = status; item.outcome = status === 'complete' ? 'complete' : 'expected_abstention';
    expect(run(evidence([item]), manifest([ref])).passed).toBe(true);
  });
});

describe('release evaluation review completeness and per-cohort denominators', () => {
  it('requires semantic and critical review for every planned case, including operational failures', () => {
    const live = evidence(); live.cases[0].reviewed = false; live.cases[0].workflowMatch = null; live.cases[0].criticalFindings = null; live.cases[0].semanticReview = null;
    assertBlocked(run(live), /completed critical review/);
    fail(live.cases[0]); live.cases[0].workflowMatch = null;
    assertBlocked(run(live), /completed critical review/);
  });

  it('does not accept an unreviewed empty critical-findings array as zero observed errors', () => {
    const live = evidence(); live.cases[0].reviewed = false;
    assertBlocked(run(live), /unreviewed findings must be null/);
  });

  it('blocks every declared critical finding without hiding operational completion', () => {
    const live = evidence(); live.cases[0].criticalFindings = ['unsafe_instruction']; live.cases[0].workflowMatch = false;
    const result = run(live);
    assertBlocked(result, /critical finding unsafe_instruction/);
    expect(result.cohorts[0]).toMatchObject({ completed: 1, workflowMatches: 0, criticalFindings: 1 });
  });

  it('rejects unknown critical categories instead of silently dropping them', () => {
    const live = evidence(); live.cases[0].criticalFindings = ['unrecognized_severe_error'];
    assertBlocked(run(live), /unknown critical category/);
  });

  it('retains missing and unattempted cases in the planned denominator', () => {
    const refs = [reference('M01'), reference('M02')]; const missing = run(evidence([record(refs[0])]), manifest(refs));
    expect(missing.cohorts[0]).toMatchObject({ planned: 2, aiPlanned: 2, completed: 1, completionRate: 0.5, notAttempted: 1 });
    const unattempted = record(refs[1], 1);
    Object.assign(unattempted, { outcome: 'not_attempted', attempts: [], artifact: null, semanticReview: null, reviewed: false, workflowMatch: null, criticalFindings: null });
    const result = run(evidence([record(refs[0]), unattempted]), manifest(refs));
    assertBlocked(result, /1\/2 planned cases were attempted/);
    expect(result.cohorts[0]).toMatchObject({ completionRate: 0.5, failed: 0, notAttempted: 1 });
  });

  it('keeps a reviewed first-attempt failure in the denominator at the 90% boundary', () => {
    const refs = Array.from({ length: 10 }, (_, index) => reference(`M${index + 1}`));
    const items = refs.map((ref, index) => record(ref, index)); fail(items[9]);
    const result = run(evidence(items), manifest(refs));
    expect(result.passed).toBe(true);
    expect(result.cohorts[0]).toMatchObject({ attempted: 10, reviewed: 10, completed: 9, workflowMatches: 9, failed: 1, completionRate: 0.9, workflowMatchRate: 0.9 });
    fail(items[8]); assertBlocked(run(evidence(items), manifest(refs)), /8\/10/);
  });

  it('measures workflow agreement separately when all checks technically completed', () => {
    const refs = Array.from({ length: 10 }, (_, index) => reference(`M${index + 1}`)), items = refs.map((ref, index) => record(ref, index));
    items[8].workflowMatch = false; items[9].workflowMatch = false;
    const result = run(evidence(items), manifest(refs));
    assertBlocked(result, /workflow agreement 8\/10/);
    expect(result.cohorts[0]).toMatchObject({ completionRate: 1, workflowMatchRate: 0.8 });
  });

  it('does not pool a failing screenshot cohort into a strong text cohort', () => {
    const refs = [...Array.from({ length: 20 }, (_, index) => reference(`M${index + 1}`)), reference('S01', 'fresh_screenshots')];
    const items = refs.map((ref, index) => record(ref, index)); fail(items.at(-1)!);
    const result = run(evidence(items), manifest(refs));
    assertBlocked(result, /fresh_screenshots: AI completion 0\/1/);
    expect(result.cohorts.find(row => row.cohort === 'fresh_text')?.passed).toBe(true);
  });

  it('requires all regressions to pass even when nine out of ten would meet normal thresholds', () => {
    const refs = Array.from({ length: 10 }, (_, index) => reference(`R${index + 1}`, 'regression_text')), items = refs.map((ref, index) => record(ref, index));
    fail(items[9]); assertBlocked(run(evidence(items), manifest(refs)), /below 100%/);
  });

  it('excludes local rejection from the AI denominator and requires that local control to pass', () => {
    const ai = reference('M01'), local = reference('L09'); local.route = 'local'; local.expectedTerminal = 'expected_abstention'; local.allowedStatuses = ['client_rejected'];
    const localRecord = record(local, 1); localRecord.outcome = 'expected_abstention'; Object.assign(localRecord.attempts[0], { requestId: null, httpStatus: null, observedStatus: 'client_rejected', aiUsed: false, errorCode: 'invalid_input' });
    const result = run(evidence([record(ai), localRecord]), manifest([ai, local]));
    expect(result.passed).toBe(true);
    expect(result.cohorts[0]).toMatchObject({ planned: 2, aiPlanned: 1, localPlanned: 1, completionRate: 1, workflowMatchRate: 1, assessmentsCompleted: 1, expectedAbstentions: 0, localCompleted: 1, localAssessmentsCompleted: 0, localExpectedAbstentions: 1, localWorkflowMatches: 1 });
    localRecord.outcome = 'failed'; localRecord.workflowMatch = false;
    assertBlocked(run(evidence([record(ai), localRecord]), manifest([ai, local])), /all local controls must pass/);
  });

  it('does not invent 100% AI performance for a cohort containing only a local control', () => {
    const ref = reference('L09'); ref.route = 'local'; ref.expectedTerminal = 'expected_abstention'; ref.allowedStatuses = ['client_rejected'];
    const item = record(ref); item.outcome = 'expected_abstention'; Object.assign(item.attempts[0], { requestId: null, httpStatus: null, observedStatus: 'client_rejected', aiUsed: false });
    const result = run(evidence([item]), manifest([ref]));
    expect(result.passed).toBe(true); expect(result.cohorts[0]).toMatchObject({ aiPlanned: 0, completionRate: null, workflowMatchRate: null });
  });
});
