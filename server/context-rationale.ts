import { ContextRationaleSchema, type ContextRationale } from '../shared/rationale';
import type { CheckInput, Extraction, Finding, QuestionId } from '../shared/contracts';
import { findExactQuoteSpan, quoteSourcesFor } from './grounding';

type Risk = ContextRationale['risks'][number]['kind'];
const PRIMARY_RISK: Partial<Record<Finding, Risk>> = {
  credential_disclosure: 'account_access', payment_request: 'payment', remote_access: 'device_control',
};
const BENIGN_FINDINGS: Finding[] = ['own_login', 'collection_code', 'information_only', 'quoted_example'];
const RISK_COPY: Record<Risk, string> = {
  account_access: 'Sharing a password or account code, or approving another person’s sign-in, can give them account access.',
  device_control: 'Remote access can let someone operate your device.',
  payment: 'The payment recipient still needs independent verification.',
};

// Finite, content-free diagnostics. Schema/grounding errors never include input
// text or raw provider output in the gateway or persistent diagnostic ledger.
export const RATIONALE_FAILURE_CODES = [
  'ungrounded_rationale', 'missing_rationale', 'invalid_rationale_shape',
  'invalid_rationale_duplicate_anchor', 'invalid_rationale_missing_pair',
  'invalid_rationale_duplicate_risk', 'invalid_rationale_risk_index',
  'invalid_rationale_anchor_role', 'invalid_rationale_relation_finding',
  'invalid_rationale_risk_forbidden', 'invalid_rationale_primary_risk',
] as const;

/** Literal grounding and structural consistency, not proof of semantic correctness. */
export function validateContextRationale(
  value: ContextRationale,
  input: CheckInput,
  extraction: Pick<Extraction, 'transcript'> | undefined,
  finding: Finding,
): ContextRationale {
  const parsed = ContextRationaleSchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid_rationale_shape');
  const rationale = parsed.data;
  const sources = quoteSourcesFor(input, extraction);
  if (rationale.anchors.some(anchor => !findExactQuoteSpan(anchor.quote, sources, anchor.source).matched)) {
    throw new Error('ungrounded_rationale');
  }
  const uniqueAnchors = new Set(rationale.anchors.map(anchor => `${anchor.source}\u0000${anchor.quote}`));
  if (uniqueAnchors.size !== rationale.anchors.length) throw new Error('invalid_rationale_duplicate_anchor');
  const { relation, anchors, risks } = rationale;
  if (['context_not_authority', 'conflicting_accounts'].includes(relation)
    && (anchors.length < 2 || new Set(anchors.map(anchor => anchor.quote)).size < 2)) throw new Error('invalid_rationale_missing_pair');
  if (new Set(risks.map(risk => risk.kind)).size !== risks.length) throw new Error('invalid_rationale_duplicate_risk');
  if (risks.some(risk => risk.anchorIndex >= anchors.length)) throw new Error('invalid_rationale_risk_index');
  if (risks.length && ['context_not_authority', 'untrusted_instruction'].includes(relation)
    && (anchors.length < 2 || anchors[0].quote === anchors[1].quote
      || risks.some(risk => risk.anchorIndex === 0) || !risks.some(risk => risk.anchorIndex === 1))) throw new Error('invalid_rationale_anchor_role');
  if (relation === 'action_risk' && !risks.some(risk => risk.anchorIndex === 0)) throw new Error('invalid_rationale_anchor_role');
  if ((relation === 'claim_unverified') !== (finding === 'unverified_claim')) throw new Error('invalid_rationale_relation_finding');
  if (relation === 'routine_context' && ![...BENIGN_FINDINGS, 'payment_request'].includes(finding)) throw new Error('invalid_rationale_relation_finding');
  if (BENIGN_FINDINGS.includes(finding) && risks.length) throw new Error('invalid_rationale_risk_forbidden');
  if (relation === 'routine_context' && risks.length) throw new Error('invalid_rationale_risk_forbidden');
  if (relation === 'context_not_authority' && ![...Object.keys(PRIMARY_RISK), 'identity_unknown', 'link_only'].includes(finding)) throw new Error('invalid_rationale_relation_finding');
  if (relation === 'conflicting_accounts' && !['unclear_request', 'credential_disclosure', 'payment_request', 'remote_access'].includes(finding)) throw new Error('invalid_rationale_relation_finding');
  if (relation === 'unclear_context' && !['unclear_request', 'identity_unknown', 'link_only', 'payment_request'].includes(finding)) throw new Error('invalid_rationale_relation_finding');
  if (relation === 'action_risk' && (!PRIMARY_RISK[finding] || !risks.length)) throw new Error('invalid_rationale_relation_finding');
  if (relation === 'claim_unverified' && risks.length) throw new Error('invalid_rationale_risk_forbidden');
  const primary = PRIMARY_RISK[finding];
  if (primary && relation !== 'routine_context' && !risks.some(risk => risk.kind === primary)) throw new Error('invalid_rationale_primary_risk');
  return rationale;
}

export function canOmitContextRationale(finding: Finding, input: CheckInput): boolean {
  return finding === 'identity_unknown' || finding === 'unreadable_image' || (finding === 'link_only' && !input.context.trim());
}

function quoted(anchor: ContextRationale['anchors'][number]): string {
  return `“${anchor.quote}”`;
}

function additionalDetails(anchors: ContextRationale['anchors'], start: number): string {
  return anchors.length > start ? `Additional supplied detail: ${anchors.slice(start).map(quoted).join('; ')}. ` : '';
}

/** The model selects grounded relations; only this code supplies explanatory prose. */
export function renderContextRationale(rationale: ContextRationale, finding: Finding, questionId: QuestionId | null): string {
  const { relation, anchors, risks } = rationale;
  const first = quoted(anchors[0]);
  const second = anchors[1] ? quoted(anchors[1]) : first;
  const allDetails = anchors.map(quoted).join('; ');
  const extraDetails = additionalDetails(anchors, 2);
  const riskCopy = risks.map(risk => RISK_COPY[risk.kind]).join(' ');
  const sequence = risks.length > 1 ? 'Stop the requested sequence. ' : '';
  switch (relation) {
    case 'context_not_authority':
      return `${first} does not authorise the separate request ${second}. ${extraDetails}${sequence}${riskCopy || 'The sender and destination remain unverified.'}`;
    case 'untrusted_instruction': {
      const explanation = risks.length
        ? `The separate request ${second} needs attention. ${extraDetails}${sequence}${riskCopy}`
        : `${additionalDetails(anchors, 1)}${finding === 'quoted_example' ? 'It is presented as an example, rather than a current instruction to follow.' : 'These words do not establish a verified sender or an instruction you should follow.'}`;
      return `The pasted override ${first} is untrusted message text, not an instruction for this app or evidence of a performed check. ${explanation}`;
    }
    case 'conflicting_accounts':
      return `The accounts disagree: ${first} versus ${second}. ${extraDetails}The current step is unresolved. ${risks.length ? `If the step involves these capabilities: ${riskCopy}` : 'Confirm which instruction applies before acting.'}`;
    case 'claim_unverified':
      return `The claim ${first} has not been verified against a current official source. ${additionalDetails(anchors, 1)}Check that source independently before relying on or forwarding it.`;
    case 'routine_context': {
      const detail = allDetails;
      if (finding === 'own_login') return `As described, ${detail}. Entering a code only in the app you opened differs from sending it to another person; the app is not authenticated by this check.`;
      if (finding === 'collection_code') return `As described, ${detail}. An item-collection code differs from an account-access code; the collection arrangement is not verified.`;
      if (finding === 'payment_request') return `As described, ${detail}. This is an expected payment arrangement, not evidence authenticating a different recipient or changed payment details.`;
      if (finding === 'quoted_example') return `As described, ${detail}. The concerning wording is an example, rather than a current instruction to follow.`;
      return `As described, ${detail}. This ordinary arrangement states no payment, account-access or remote-control demand; the contact’s identity is not verified.`;
    }
    case 'action_risk':
      return `The supplied request details ${allDetails} concern ${risks.length > 1 ? 'several sensitive actions' : 'a sensitive action'}. ${sequence}${riskCopy}`;
    case 'unclear_context': {
      const kinds = new Set(risks.map(risk => risk.kind));
      const conditionalRisks = riskCopy ? ` If the step involves these capabilities: ${riskCopy}` : '';
      if (questionId === 'sharing_code' || kinds.has('account_access')) return `${allDetails} does not establish what the code is for. Whether it grants account access changes the advice; its actual value is unnecessary.${conditionalRisks}`;
      if (questionId === 'asked_to_install' || kinds.has('device_control')) return `${allDetails} leaves the requested capability unclear. Ordinary restart advice differs from installing software or granting control; confirm the current step first.${conditionalRisks}`;
      if (questionId === 'payment_expected' || kinds.has('payment') || finding === 'payment_request') return `${allDetails} leaves payment context unresolved. Expecting a payment can add context but cannot verify its recipient.${conditionalRisks}`;
      return `${allDetails} does not authenticate this sparse request. Open an app or contact route you already know independently, rather than relying on the message.`;
    }
  }
}
