import { z } from 'zod';
import { FindingSchema, QuestionIdSchema, type CheckInput, type Evidence, type Extraction, type Review } from '../shared/contracts';
import { ContextRationaleSchema } from '../shared/rationale';
import { canOmitContextRationale, renderContextRationale, validateContextRationale } from './context-rationale';

// Compact model output avoids asking a model to repeat or coordinate UI strings.
export const ReviewDecisionSchema = z.object({
  finding: FindingSchema,
  evidenceIds: z.array(z.string().min(1).max(100)).max(8),
  questionId: QuestionIdSchema.nullable(),
  rationale: ContextRationaleSchema.nullable(),
}).strict();
export type LiveReviewDecision = z.infer<typeof ReviewDecisionSchema>;
// Only the rendering boundary accepts the older independently supplied quotes.
// Live output has one quotation representation: source-validated rationale anchors.
export type ReviewDecision = LiveReviewDecision | (Omit<LiveReviewDecision, 'rationale'> & {
  quotes: string[];
  rationale?: LiveReviewDecision['rationale'];
});
const RenderingDecisionSchema = ReviewDecisionSchema.extend({
  quotes: z.array(z.string().min(1).max(240)).max(4).optional(),
});

// The one clarification has already been consumed; constrain the generated
// response as well as retaining the pipeline's independent final-turn guard.
export const FinalReviewDecisionSchema = ReviewDecisionSchema.extend({ questionId: z.null() });

export const FINDING_REASONS = {
  credential_disclosure: 'Sharing an account code or password can let someone access your account.',
  own_login: 'Entering a code in the app you opened differs from sending it to another person.',
  collection_code: 'A collection code is for collecting an item, rather than giving access to an account.',
  payment_request: 'Confirming a payment through a separate trusted route can help prevent a mistaken transfer.',
  remote_access: 'Installing software or allowing remote access can give someone control of your device.',
  information_only: 'Your description asks for information, without a stated payment, account-code or device-access request.',
  quoted_example: 'The concerning words are presented as an example, rather than a request you are being asked to follow.',
  link_only: 'The actual website address matters. A familiar name within a link does not establish who controls its destination.',
  identity_unknown: 'The supplied name or number does not establish who is contacting you.',
  unclear_request: 'The appropriate next step depends on what you are being asked to do.',
  unreadable_image: 'A consequential detail in the screenshot could not be read reliably.',
  unverified_claim: 'This claim has not been verified against a current official source.',
} as const;

const ACTION_FOR_FINDING = {
  credential_disclosure: 'protect_credentials', own_login: 'check_independently', collection_code: 'check_independently',
  payment_request: 'verify_payment', remote_access: 'avoid_installation', information_only: 'check_independently',
  quoted_example: 'check_independently', link_only: 'check_independently', identity_unknown: 'pause_and_verify',
  unclear_request: 'pause_and_verify', unreadable_image: 'pause_and_verify',
  unverified_claim: 'check_independently',
} as const;

const UNCERTAINTY_FOR_FINDING = {
  credential_disclosure: 'The sender’s identity and intentions have not been verified.',
  own_login: 'The app and sign-in request have not been verified.',
  collection_code: 'The collection arrangement and recipient have not been verified.',
  payment_request: 'The recipient and purpose of the payment have not been verified.',
  remote_access: 'The software and the person requesting access have not been verified.',
  information_only: 'This covers the details supplied. A later request may need a new check.',
  quoted_example: 'This assessment covers the example as described, not a separate live request.',
  link_only: 'The website’s content and owner have not been verified.',
  identity_unknown: 'A name or phone number cannot confirm this contact’s identity.',
  unclear_request: 'The requested action is still unclear.',
  unreadable_image: 'Unclear screenshot text could change the next step.',
  unverified_claim: 'No conclusion about this claim’s truth follows from the absence of a payment or account-access request.',
} as const;

export function renderDecision(decision: ReviewDecision, input: CheckInput, evidence: Evidence[], extraction?: Pick<Extraction, 'transcript'>): Review {
  const legacy = !Object.prototype.hasOwnProperty.call(decision, 'rationale');
  const parsed = RenderingDecisionSchema.parse(legacy ? { ...decision, rationale: null } : decision);
  const { finding, questionId, evidenceIds, rationale } = parsed;
  if (legacy && parsed.quotes === undefined) throw new Error('missing_rationale');
  if (!legacy && rationale === null && !canOmitContextRationale(finding, input)) throw new Error('missing_rationale');
  const groundedRationale = rationale ? validateContextRationale(rationale, input, extraction, finding) : null;
  // Public/pipeline callers can include quotes when rerendering a Review. They do
  // not override canonical anchors. The pipeline independently checks that the
  // received public quotes are literal and equal to this canonical projection.
  const quotes = legacy ? parsed.quotes! : groundedRationale?.anchors.map(anchor => anchor.quote) ?? [];
  // A question is never a substitute for acting on an explicit consequential request.
  if (questionId && finding !== 'unclear_request') throw new Error('unnecessary_question');
  const matchedDomain = evidence.some(item => item.kind === 'domain' && item.state === 'matched');
  const noThreatMatch = evidence.some(item => item.kind === 'reputation' && item.state === 'no_match');
  let reason: string = FINDING_REASONS[finding];
  if (finding === 'payment_request' && matchedDomain) reason = 'A matching website address does not authorise a separate payment request.';
  if (finding === 'identity_unknown' && evidence.some(item => item.kind === 'phone' && ['unavailable', 'unsupported'].includes(item.state))) {
    reason = 'The caller has not been identified. No authorised reported-number database is connected.';
  }
  if (groundedRationale) reason = renderContextRationale(groundedRationale, finding, questionId);
  const limit = questionId ? 'Your answer may change the next step.'
    : groundedRationale?.relation === 'conflicting_accounts' ? 'The supplied accounts disagree; the current request has not been established.'
    : finding === 'unclear_request' ? UNCERTAINTY_FOR_FINDING.unclear_request
    : matchedDomain ? 'A matching domain does not authenticate the sender or the requested action.'
    : noThreatMatch ? 'No threat-list match does not establish that a link or request is safe.'
    : UNCERTAINTY_FOR_FINDING[finding];
  // Image interpretation does not replace the limits of the underlying finding.
  const uncertainty = input.mode === 'screenshot'
    ? `${limit} Screenshot text is machine-transcribed and may contain mistakes.`
    : limit;
  return { finding, actionId: questionId ? 'need_context' : ACTION_FOR_FINDING[finding], reason, uncertainty, evidenceIds, quotes, questionId,
    ...(!legacy ? { rationale: groundedRationale } : {}),
  };
}
