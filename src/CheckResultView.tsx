import type { ReactNode, Ref } from 'react';
import type { CheckResult, InputMode, ScreenshotIssue } from '../shared/contracts';
import { Icon } from './Icon';
import { evidenceStateLabel, getResultPresentation } from './resultPresentation';
import s from './App.module.css';

interface Props {
  result: CheckResult;
  mode?: InputMode;
  headingRef?: Ref<HTMLHeadingElement>;
  busy: boolean;
  failure?: ReactNode;
  onAnswer: (answer: 'yes' | 'no' | 'unsure') => void;
  onCancel: () => void;
  onEdit: () => void;
  onCorrectText: () => void;
  onRetry: () => void;
  onClearerImage: () => void;
}
function safeSource(value?: string) {
  if (!value) return undefined;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}
const issueTargets: Record<ScreenshotIssue['target'], string> = {
  requested_action: 'Requested action', code_recipient: 'Code recipient', link_destination: 'Link destination',
  payment_recipient: 'Payment recipient', payment_amount: 'Payment amount', sender_identity: 'Claimed sender',
  reference_number: 'Reference number', other: 'Request detail',
};
const issueKinds: Record<ScreenshotIssue['kind'], string> = {
  unreadable_region: 'Not readable in the image', missing_detail: 'Not shown in the image', conflicting_accounts: 'Conflicting details',
};

export default function CheckResultView({ result, mode, headingRef, busy, failure, onAnswer, onCancel, onEdit, onCorrectText, onRetry, onClearerImage }: Props) {
  const view = getResultPresentation(result);
  const question = result.status === 'needs_context' && result.continuation ? result.question : null;
  const extraction = result.extraction;
  const showTextRecovery = view.recovery === 'clearer_image' && !question && !failure;
  const recover = view.reviewConflict ? onCorrectText : view.recovery === 'retry' ? onRetry : view.recovery === 'clearer_image' ? onClearerImage : onEdit;
  return <>
    <div className={s.resultEyebrow}>{result.aiUsed ? 'AI-assisted check' : 'Local checks only'}{result.status === 'partial' && <span>Incomplete</span>}</div>
    <h1 ref={headingRef} tabIndex={-1} className={s.resultTitle}>{result.title}</h1>
    {question ? <section className={s.question} aria-labelledby="clarification-title">
      <h2 id="clarification-title">{question.text}</h2>
      <div role="group" aria-labelledby="clarification-title">{(['yes', 'no', 'unsure'] as const).map((answer, i) => <button key={answer} disabled={busy} onClick={() => onAnswer(answer)}>{question.options[i] || ['Yes', 'No', 'Not sure'][i]}</button>)}</div>
      {busy && <button className={s.textButton} onClick={onCancel}>Cancel check</button>}
    </section> : <div className={s.nextStep}><h2>Your next step</h2><p>{result.nextStep}</p></div>}
    <section className={s.resultSection}><h2>{result.status === 'partial' ? 'What happened' : 'Why'}</h2><p>{result.reason}</p></section>
    {result.uncertainty.trim() && <section className={s.uncertainty}><h2>{result.status === 'partial' ? 'What this means' : 'Keep in mind'}</h2><p>{result.uncertainty}</p></section>}
    {view.notice && <p className={s.info}>{view.notice}</p>}
    {failure}
    {!question && !failure && <div className={s.resultRecovery}>
      <button className={result.status === 'partial' ? s.cta : s.secondaryButton} aria-busy={busy} disabled={busy} onClick={recover}>{busy ? 'Checking…' : view.recoveryLabel}</button>
      {view.recovery === 'retry' && <button className={s.textButton} disabled={busy} onClick={onEdit}>Edit input</button>}
      {showTextRecovery && <button className={s.textButton} disabled={busy} onClick={onCorrectText}>Review screenshot text</button>}
      {busy && <button className={s.textButton} onClick={onCancel}>Cancel check</button>}
    </div>}
    {view.hasEvidence && <details className={s.disclosure}><summary>Evidence<Icon name="down" /></summary><div className={s.evidenceList}>{result.evidence.map(evidence => <article key={evidence.id}>
      <div className={s.evidenceHeading}><h3>{evidence.title}</h3><span>{evidenceStateLabel(evidence)}</span></div>
      <p>{evidence.detail}</p>
      {safeSource(evidence.sourceUrl) && <a href={safeSource(evidence.sourceUrl)} target="_blank" rel="noopener noreferrer">View source<span className={s.sr}> for {evidence.title} (opens in a new tab)</span></a>}
      <time dateTime={evidence.checkedAt}>{['not_checked', 'unavailable', 'unsupported'].includes(evidence.state) ? 'Status as of' : 'Checked'} {new Date(evidence.checkedAt).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' })}</time>
    </article>)}</div></details>}
    {view.hasReadDetails && extraction && <details className={s.disclosure}><summary>Details read from your input<Icon name="down" /></summary><div className={s.extracted}>
      <p className={s.smallNote}>Check these details for reading errors.</p>
      {extraction.transcript.trim() && <blockquote>{extraction.transcript}</blockquote>}
      {extraction.claimedOrganisation && <p><strong>Claimed organisation</strong>{extraction.claimedOrganisation}</p>}
      {extraction.urls.length > 0 && <div><strong>Links</strong>{extraction.urls.map((url, i) => <p key={i}>{url}</p>)}</div>}
      {extraction.phoneNumbers.length > 0 && <div><strong>Phone numbers</strong>{extraction.phoneNumbers.map((phone, i) => <p key={i}>{phone}</p>)}</div>}
      {extraction.requestedActions.map((action, i) => <p key={i}><strong>{action.action}</strong><q>{action.quote}</q></p>)}
      {extraction.screenshotIssues?.map((issue, index) => <div key={index}>
        <strong>{issueTargets[issue.target]}{issue.location === 'unspecified' ? '' : ` (${issue.location})`}</strong>
        <p>{issueKinds[issue.kind]}</p>
        {issue.imageQuote && <p><strong>Image reading</strong><q>{issue.imageQuote}</q></p>}
        {issue.userQuote && <p><strong>{issue.userSource === 'context' ? 'Your added context' : 'Your typed correction'}</strong><q>{issue.userQuote}</q></p>}
      </div>)}
      {extraction.screenshotIssues === undefined && extraction.unreadableDetails.length > 0 && <p>Unclear or conflicting details: {extraction.unreadableDetails.join('; ')}</p>}
      {!showTextRecovery && !view.reviewConflict && <button className={s.textButton} disabled={busy} onClick={mode === 'screenshot' ? onCorrectText : onEdit}>{mode === 'screenshot' ? view.reviewTextLabel : 'Edit input'}</button>}
    </div></details>}
    {question && !failure && <button className={s.secondaryButton} disabled={busy} onClick={onEdit}>Edit input</button>}
    <p className={s.smallNote}>Kept in this tab until you reload.</p>
  </>;
}
