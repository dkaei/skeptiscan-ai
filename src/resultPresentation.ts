import type { CheckResult, Evidence } from '../shared/contracts';

export function getResultPresentation(result: CheckResult) {
  const extraction = result.extraction;
  const hasReadDetails = !!extraction && Boolean(extraction.transcript.trim() || extraction.claimedOrganisation
    || extraction.urls.length || extraction.phoneNumbers.length || extraction.requestedActions.length
    || (extraction.screenshotIssues === undefined ? extraction.unreadableDetails.length : extraction.screenshotIssues.length));
  const notice = result.notice?.trim();
  const recovery = result.status === 'partial' ? result.recovery : undefined;
  const conflicts = extraction?.screenshotIssues?.filter(issue => issue.kind === 'conflicting_accounts' && issue.consequential) ?? [];
  const reviewConflict = recovery === 'edit_input' && conflicts.length > 0;
  const reviewTextLabel = conflicts.length > 0 && conflicts.every(issue => issue.userSource === 'context')
    ? 'Review added context' : 'Review screenshot text';
  return {
    hasEvidence: result.evidence.length > 0,
    hasReadDetails,
    notice: notice && notice !== result.reason.trim() && notice !== result.uncertainty.trim() ? notice : undefined,
    recovery: recovery ?? 'edit_input',
    reviewConflict,
    reviewTextLabel,
    recoveryLabel: reviewConflict ? reviewTextLabel : recovery === 'retry' ? 'Try again' : recovery === 'clearer_image' ? 'Choose clearer screenshot' : recovery === 'none' ? 'Back to input' : 'Edit input',
  };
}

export function evidenceStateLabel(evidence: Evidence): string {
  if (evidence.kind === 'domain' && evidence.state === 'matched') return 'Address matches reference';
  if (evidence.kind === 'domain' && evidence.state === 'no_match') return 'Outside reference list';
  if (evidence.kind === 'reputation' && evidence.state === 'matched') return 'Threat-list match';
  if (evidence.kind === 'reputation' && evidence.state === 'no_match') return 'No listed threat found';
  if (evidence.kind === 'guidance' && evidence.state === 'observation') return 'Reference guidance';
  return { matched: 'Match found', no_match: 'No match', not_checked: 'Not checked', unavailable: 'Unavailable', unsupported: 'Not supported', observation: 'From your input' }[evidence.state];
}

/** Opening an editor must not replace an existing user correction with model text. */
export function correctionText(current: string, transcript?: string): string {
  return current.trim() ? current : transcript ?? current;
}
