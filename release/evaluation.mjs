import { z } from 'zod';

// Pure validation/scoring only: the caller must separately verify every capture
// and semantic-review file's bytes, bindings and agreement with these observations.
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
const Timestamp = z.iso.datetime();
const Status = z.enum(['complete', 'partial', 'needs_context', 'client_rejected']);
const Artifact = z.object({
  path: z.string().min(1).max(500).refine(value => {
    // Portable, project-relative POSIX paths; no URL, traversal or drive syntax.
    return !/[\\:\x00-\x1f\x7f?#%]/.test(value) && !value.startsWith('/')
      && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
  }),
  sha256: Hash,
}).strict();
const Attempt = z.object({
  kind: z.enum(['initial', 'clarification']),
  requestId: z.uuid().nullable(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  observedStatus: Status.nullable(),
  aiUsed: z.boolean().nullable(),
  errorCode: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:-]{0,99}$/).nullable(),
  questionId: Identifier.nullable(),
}).strict();
const CaseRecord = z.object({
  id: Identifier,
  cohort: Identifier,
  route: z.enum(['ai', 'local']),
  outcome: z.enum(['complete', 'expected_abstention', 'failed', 'not_attempted']),
  firstAttempt: z.literal(true),
  attempts: z.array(Attempt).max(2),
  artifact: Artifact.nullable(),
  semanticReview: Artifact.nullable(),
  reviewed: z.boolean(),
  workflowMatch: z.boolean().nullable(),
  criticalFindings: z.array(Identifier).max(100).nullable(),
}).strict();
const Evidence = z.object({
  schemaVersion: z.literal(1),
  candidateHash: Hash,
  policyHash: Hash,
  origin: z.literal('live'),
  startedAt: Timestamp,
  completedAt: Timestamp,
  reviewer: z.object({ name: z.string().trim().min(1).max(100), kind: z.enum(['ai', 'human']) }).strict(),
  cases: z.array(CaseRecord).max(10000),
}).strict();
const Clarification = z.object({
  policy: z.enum(['required', 'optional', 'forbidden']),
  allowedQuestionIds: z.array(Identifier).max(10),
  answer: z.literal('unsure').optional(),
}).passthrough();
const Manifest = z.object({
  cases: z.array(z.object({
    id: Identifier,
    cohort: Identifier,
    route: z.enum(['ai', 'local']),
    expectedTerminal: z.enum(['complete', 'expected_abstention', 'complete_or_expected_abstention']),
    // These are INITIAL statuses. A required question must subsequently complete.
    allowedStatuses: z.array(Status).min(1).max(4),
    clarification: Clarification.optional(),
  }).passthrough()).min(1).max(10000),
  thresholds: z.object({
    minCompletionRate: z.number().min(0.9).max(1),
    minWorkflowMatchRate: z.number().min(0.9).max(1),
    regressionMinCompletionRate: z.literal(1).optional(),
    regressionMinWorkflowMatchRate: z.literal(1).optional(),
    maxAgeHours: z.number().positive().max(168),
    requireAllCasesAttempted: z.literal(true).optional(),
    requireAllCasesReviewed: z.literal(true).optional(),
  }).strict(),
  criticalCategories: z.array(Identifier).min(1).max(100),
}).passthrough();

function schemaIssues(label, parsed) {
  // Never include submitted values, provider text or Zod's full error object.
  return parsed.error.issues.slice(0, 20).map(issue => `${label} schema invalid at ${issue.path.join('.') || 'root'} (${issue.code}).`);
}
function clockValue(value) {
  if (value === undefined) return Date.now();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return typeof value === 'string' && Timestamp.safeParse(value).success ? Date.parse(value) : NaN;
}
function cohortRows(manifest) {
  const rows = new Map();
  for (const item of manifest.cases) {
    if (!rows.has(item.cohort)) rows.set(item.cohort, {
      cohort: item.cohort, planned: 0, aiPlanned: 0, localPlanned: 0,
      attempted: 0, reviewed: 0, completed: 0, assessmentsCompleted: 0, expectedAbstentions: 0, workflowMatches: 0,
      localCompleted: 0, localAssessmentsCompleted: 0, localExpectedAbstentions: 0, localWorkflowMatches: 0,
      notAttempted: 0, failed: 0, criticalFindings: 0,
      completionRate: null, workflowMatchRate: null,
      minCompletionRate: ['regression_text', 'regressions'].includes(item.cohort) ? 1 : manifest.thresholds.minCompletionRate,
      minWorkflowMatchRate: ['regression_text', 'regressions'].includes(item.cohort) ? 1 : manifest.thresholds.minWorkflowMatchRate,
      passed: false,
    });
    const row = rows.get(item.cohort);
    row.planned++;
    row[item.route === 'ai' ? 'aiPlanned' : 'localPlanned']++;
  }
  return rows;
}
function finalizeCohorts(rows, issues) {
  for (const row of rows.values()) {
    row.notAttempted = row.planned - row.attempted;
    // Unattempted cases still count against the planned denominator, but are not
    // described as failed model executions.
    row.failed = row.attempted - row.completed - row.localCompleted;
    row.completionRate = row.aiPlanned ? row.completed / row.aiPlanned : null;
    row.workflowMatchRate = row.aiPlanned ? row.workflowMatches / row.aiPlanned : null;
    const enoughCompleted = !row.aiPlanned || row.completed >= Math.ceil(row.aiPlanned * row.minCompletionRate - 1e-12);
    const enoughMatched = !row.aiPlanned || row.workflowMatches >= Math.ceil(row.aiPlanned * row.minWorkflowMatchRate - 1e-12);
    row.passed = row.planned > 0 && row.attempted === row.planned && row.reviewed === row.planned
      && enoughCompleted && enoughMatched && row.localCompleted === row.localPlanned
      && row.localWorkflowMatches === row.localPlanned && row.criticalFindings === 0;
    if (row.attempted !== row.planned) issues.push(`${row.cohort}: only ${row.attempted}/${row.planned} planned cases were attempted.`);
    if (row.reviewed !== row.planned) issues.push(`${row.cohort}: only ${row.reviewed}/${row.planned} cases have completed critical review.`);
    if (!enoughCompleted) issues.push(`${row.cohort}: AI completion ${row.completed}/${row.aiPlanned} is below ${row.minCompletionRate * 100}%.`);
    if (!enoughMatched) issues.push(`${row.cohort}: AI workflow agreement ${row.workflowMatches}/${row.aiPlanned} is below ${row.minWorkflowMatchRate * 100}%.`);
    if (row.localCompleted !== row.localPlanned || row.localWorkflowMatches !== row.localPlanned) issues.push(`${row.cohort}: local control passed ${row.localWorkflowMatches}/${row.localPlanned}; all local controls must pass.`);
  }
  return [...rows.values()];
}

/**
 * Evaluate first-pass live evidence against an already-frozen candidate/manifest.
 * No fetch, filesystem access, inference, retry, or mutation of supplied objects.
 * An AI review is labelled as such; a pass is not population accuracy or safety.
 */
export function evaluateLiveEvidence({ evidence, candidateHash, policyHash, manifest, now } = {}) {
  const issues = [];
  const planned = Manifest.safeParse(manifest);
  if (!planned.success) return { passed: false, issues: schemaIssues('Manifest', planned), cohorts: [] };
  const plan = planned.data;
  const rows = cohortRows(plan);
  const planIds = new Set();
  for (const item of plan.cases) {
    if (planIds.has(item.id)) issues.push(`Manifest has duplicate case ${item.id}.`);
    planIds.add(item.id);
    if (new Set(item.allowedStatuses).size !== item.allowedStatuses.length) issues.push(`${item.id}: manifest has duplicate allowed statuses.`);
    const clarification = item.clarification;
    if (clarification) {
      if (new Set(clarification.allowedQuestionIds).size !== clarification.allowedQuestionIds.length) issues.push(`${item.id}: manifest has duplicate question IDs.`);
      if (clarification.policy !== 'forbidden' && (!clarification.allowedQuestionIds.length || clarification.answer !== 'unsure')) issues.push(`${item.id}: permitted clarification needs question IDs and the predeclared unsure answer.`);
      if (clarification.policy === 'required' && !item.allowedStatuses.includes('needs_context')) issues.push(`${item.id}: required clarification lacks an initial needs_context status.`);
      if (clarification.policy === 'forbidden' && clarification.allowedQuestionIds.length) issues.push(`${item.id}: forbidden clarification lists permitted questions.`);
    } else if (item.allowedStatuses.includes('needs_context')) issues.push(`${item.id}: needs_context requires a frozen clarification policy.`);
  }
  if (new Set(plan.criticalCategories).size !== plan.criticalCategories.length) issues.push('Manifest has duplicate critical categories.');
  if (!Hash.safeParse(candidateHash).success || !Hash.safeParse(policyHash).success) issues.push('Expected candidate/policy hashes must be SHA-256 digests.');
  const current = clockValue(now);
  if (!Number.isFinite(current)) issues.push('The evaluation clock is invalid.');
  const parsed = Evidence.safeParse(evidence);
  if (!parsed.success) {
    issues.push(...schemaIssues('Live evidence', parsed));
    return { passed: false, issues, cohorts: finalizeCohorts(rows, issues) };
  }
  const data = parsed.data;
  if (data.candidateHash !== candidateHash) issues.push('Live evidence candidateHash does not match the current source candidate.');
  if (data.policyHash !== policyHash) issues.push('Live evidence policyHash does not match the current release policy.');
  const started = Date.parse(data.startedAt), completed = Date.parse(data.completedAt);
  if (started > completed) issues.push('Live evidence completedAt precedes startedAt.');
  if (started > current || completed > current) issues.push('Live evidence timestamps are in the future.');
  if (current - started > plan.thresholds.maxAgeHours * 3600000 || current - completed > plan.thresholds.maxAgeHours * 3600000) issues.push(`Live evidence is older than ${plan.thresholds.maxAgeHours} hours.`);
  const occurrences = new Map();
  for (const item of data.cases) {
    occurrences.set(item.id, (occurrences.get(item.id) || 0) + 1);
    if (!planIds.has(item.id)) issues.push(`Live evidence has unplanned case ${item.id}.`);
  }
  for (const [id, count] of occurrences) if (count !== 1) issues.push(`Live evidence has ${count} records for case ${id}; retries cannot replace the first attempt.`);
  const records = new Map(data.cases.map(item => [item.id, item]));
  const requestIds = new Map();
  const criticalCategories = new Set(plan.criticalCategories);
  for (const expected of plan.cases) {
    const row = rows.get(expected.cohort);
    const item = records.get(expected.id);
    if (!item || occurrences.get(expected.id) !== 1) {
      if (!item) issues.push(`${expected.id}: missing first-attempt record.`);
      continue;
    }
    let valid = true;
    const invalid = message => { valid = false; issues.push(`${expected.id}: ${message}`); };
    if (item.cohort !== expected.cohort || item.route !== expected.route) invalid('cohort or route differs from the frozen manifest.');
    const attempted = item.attempts.length > 0;
    if (attempted) row.attempted++;
    if (!attempted) {
      if (item.outcome !== 'not_attempted' || item.artifact !== null || item.semanticReview !== null || item.reviewed || item.workflowMatch !== null || item.criticalFindings !== null) invalid('an unattempted case cannot claim a result, artifact or semantic review.');
      continue;
    }
    if (item.outcome === 'not_attempted') invalid('observed attempts contradict the not_attempted outcome.');
    if (!item.artifact) invalid('attempted case has no immutable capture reference.');
    if (item.reviewed) {
      if (!item.semanticReview || typeof item.workflowMatch !== 'boolean' || !Array.isArray(item.criticalFindings)) invalid('reviewed case needs a semantic artifact, workflow decision and critical findings array.');
      else row.reviewed++;
    } else {
      if (item.semanticReview !== null || item.workflowMatch !== null || item.criticalFindings !== null) invalid('unreviewed findings must be null, never an empty asserted critical review.');
    }
    if (Array.isArray(item.criticalFindings)) {
      if (new Set(item.criticalFindings).size !== item.criticalFindings.length) invalid('critical findings contain duplicate categories.');
      for (const category of item.criticalFindings) {
        row.criticalFindings++;
        if (!criticalCategories.has(category)) invalid(`unknown critical category ${category}.`);
        else issues.push(`${expected.id}: critical finding ${category} blocks release.`);
      }
    }
    const first = item.attempts[0], last = item.attempts.at(-1);
    if (first.kind !== 'initial') invalid('the first captured attempt must be initial.');
    if (item.attempts.length === 2) {
      if (item.attempts[1].kind !== 'clarification' || first.observedStatus !== 'needs_context' || first.httpStatus !== 200 || first.errorCode !== null) invalid('a second attempt must answer the first successful clarification, never replace it.');
      if (!first.requestId || first.requestId !== last.requestId) invalid('clarification must retain the initial request ID.');
    }
    if (first.requestId) {
      if (requestIds.has(first.requestId)) invalid(`request ID was already used by ${requestIds.get(first.requestId)}.`);
      else requestIds.set(first.requestId, expected.id);
    }
    for (const attempt of item.attempts) {
      if (item.route === 'ai' && !attempt.requestId) invalid('AI-route attempts require an observed request ID.');
      if (attempt.observedStatus === 'needs_context' ? !attempt.questionId : attempt.questionId !== null) invalid('question ID does not agree with the observed status.');
      if (item.route === 'ai' && attempt.observedStatus !== null && (attempt.httpStatus !== 200 || attempt.observedStatus === 'client_rejected')) invalid('an AI result requires HTTP 200; client rejection is not an AI result.');
      if (item.route === 'ai' && ['complete', 'needs_context'].includes(attempt.observedStatus) && attempt.aiUsed !== true) invalid('a completed AI stage cannot be claimed without observed AI use.');
      if (item.route === 'local' && (attempt.aiUsed !== false || attempt.httpStatus !== null || attempt.kind !== 'initial')) invalid('local control must remain a single local observation without an AI/API response.');
      if (item.route === 'ai' && attempt.observedStatus !== null && attempt.errorCode !== null) invalid('a successful API result cannot simultaneously claim a transport/API error.');
    }
    if (item.route === 'local' && item.attempts.length !== 1) invalid('local control cannot include a clarification chain.');
    const terminalComplete = last.observedStatus === 'complete' && last.questionId === null && last.errorCode === null
      && (item.route === 'ai' ? last.httpStatus === 200 && last.aiUsed === true : last.httpStatus === null && last.aiUsed === false);
    const terminalAbstention = ['partial', 'client_rejected'].includes(last.observedStatus) && last.questionId === null
      && (item.route === 'ai' ? last.httpStatus === 200 && last.aiUsed === true && last.errorCode === null && last.observedStatus === 'partial'
        : last.httpStatus === null && last.aiUsed === false)
      && item.reviewed && item.workflowMatch === true && Array.isArray(item.criticalFindings) && item.criticalFindings.length === 0;
    const permitsComplete = expected.expectedTerminal !== 'expected_abstention';
    const permitsAbstention = expected.expectedTerminal !== 'complete';
    const complete = terminalComplete && permitsComplete;
    const abstained = terminalAbstention && permitsAbstention && expected.allowedStatuses.includes(last.observedStatus);
    const outcome = complete ? 'complete' : abstained ? 'expected_abstention' : 'failed';
    if (item.outcome !== outcome) invalid(`claimed outcome ${item.outcome} contradicts observed/reviewed terminal outcome ${outcome}.`);
    let workflow = expected.allowedStatuses.includes(first.observedStatus);
    const question = expected.clarification;
    if (first.observedStatus === 'needs_context') {
      workflow &&= !!question && question.policy !== 'forbidden' && question.allowedQuestionIds.includes(first.questionId)
        && item.attempts.length === 2 && last.observedStatus !== 'needs_context' && last.questionId === null;
    } else if (question?.policy === 'required') workflow = false;
    if (item.attempts.length === 2 && last.observedStatus === 'needs_context') invalid('a second clarification is not permitted.');
    if (item.workflowMatch === true && (!workflow || !(complete || abstained))) invalid('workflowMatch claims success contrary to observed statuses, clarification or terminal requirement.');
    if (valid && (complete || abstained)) {
      if (expected.route === 'ai') { row.completed++; row[complete ? 'assessmentsCompleted' : 'expectedAbstentions']++; }
      else { row.localCompleted++; row[complete ? 'localAssessmentsCompleted' : 'localExpectedAbstentions']++; }
      if (item.reviewed && item.workflowMatch === true && workflow && item.criticalFindings?.length === 0) {
        if (expected.route === 'ai') row.workflowMatches++;
        else row.localWorkflowMatches++;
      }
    }
  }
  const cohorts = finalizeCohorts(rows, issues);
  return { passed: issues.length === 0 && cohorts.length > 0 && cohorts.every(row => row.passed), issues, cohorts };
}
