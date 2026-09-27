export interface EvaluationCohort {
  cohort: string;
  planned: number;
  aiPlanned: number;
  localPlanned: number;
  attempted: number;
  reviewed: number;
  completed: number;
  assessmentsCompleted: number;
  expectedAbstentions: number;
  workflowMatches: number;
  localCompleted: number;
  localAssessmentsCompleted: number;
  localExpectedAbstentions: number;
  localWorkflowMatches: number;
  notAttempted: number;
  failed: number;
  criticalFindings: number;
  completionRate: number | null;
  workflowMatchRate: number | null;
  minCompletionRate: number;
  minWorkflowMatchRate: number;
  passed: boolean;
}
export interface EvaluationResult { passed: boolean; issues: string[]; cohorts: EvaluationCohort[] }
export function evaluateLiveEvidence(options?: {
  evidence?: unknown;
  candidateHash?: string;
  policyHash?: string;
  manifest?: unknown;
  now?: string | number | Date;
}): EvaluationResult;
