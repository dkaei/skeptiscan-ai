import { z } from 'zod';
import { ContextRationaleSchema } from './rationale';

export const InputModeSchema = z.enum(['message', 'call', 'link', 'screenshot']);
export type InputMode = z.infer<typeof InputModeSchema>;
export const ImageInputSchema = z.object({
  base64: z.string().min(1).max(2_800_000),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
}).strict();
export const CheckInputSchema = z.object({
  mode: InputModeSchema,
  content: z.string().max(6000),
  context: z.string().max(500).default(''),
  senderEmail: z.union([z.email(), z.literal('')]).default(''),
  senderPhone: z.string().max(50).default(''),
  externalLookup: z.boolean().default(false),
  image: ImageInputSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (input.mode === 'screenshot' && !input.image) ctx.addIssue({ code: 'custom', path: ['image'], message: 'Choose a screenshot.' });
  if (input.mode !== 'screenshot' && !input.content.trim()) ctx.addIssue({ code: 'custom', path: ['content'], message: 'Add the details you want to check.' });
  if (input.mode !== 'screenshot' && input.image) ctx.addIssue({ code: 'custom', path: ['image'], message: 'Images belong in the screenshot input.' });
});
export type CheckInput = z.infer<typeof CheckInputSchema>;
export const CheckRequestSchema = z.object({ requestId: z.uuid(), input: CheckInputSchema }).strict();
export type CheckRequest = z.infer<typeof CheckRequestSchema>;

export const EvidenceStateSchema = z.enum(['matched', 'no_match', 'not_checked', 'unavailable', 'unsupported', 'observation']);
export const EvidenceSchema = z.object({
  id: z.string(),
  kind: z.enum(['domain', 'reputation', 'phone', 'guidance', 'input']),
  state: EvidenceStateSchema,
  title: z.string(),
  detail: z.string(),
  sourceUrl: z.string().optional(),
  checkedAt: z.string(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const QuoteSourceSchema = z.enum(['content', 'context', 'senderEmail', 'senderPhone', 'transcript']);
export const QuoteSpanSchema = z.object({
  source: QuoteSourceSchema, start: z.number().int().nonnegative(), end: z.number().int().positive(),
}).strict();
export const ScreenshotIssueSchema = z.object({
  kind: z.enum(['unreadable_region', 'missing_detail', 'conflicting_accounts']),
  target: z.enum(['requested_action', 'code_recipient', 'link_destination', 'payment_recipient', 'payment_amount', 'sender_identity', 'reference_number', 'other']),
  location: z.enum(['header', 'body', 'link', 'button', 'footer', 'unspecified']),
  consequential: z.boolean(),
  imageQuote: z.string().min(1).max(240).nullable(),
  userQuote: z.string().min(1).max(240).nullable(),
  userSource: z.enum(['correction', 'context']).nullable(),
}).strict();
export type ScreenshotIssue = z.infer<typeof ScreenshotIssueSchema>;

export const ExtractionSchema = z.object({
  transcript: z.string(),
  claimedOrganisation: z.string().nullable(),
  urls: z.array(z.string()),
  phoneNumbers: z.array(z.string()),
  requestedActions: z.array(z.object({ action: z.string(), quote: z.string(), source: QuoteSourceSchema.optional(), span: QuoteSpanSchema.optional() }).strict()),
  unreadableDetails: z.array(z.string()),
  missingContext: z.array(z.string()),
  // Optional only for older signed continuations and historical captures.
  screenshotIssues: z.array(ScreenshotIssueSchema).max(4).optional(),
}).strict();
export type Extraction = z.infer<typeof ExtractionSchema>;

export const ActionIdSchema = z.enum(['pause_and_verify', 'protect_credentials', 'avoid_installation', 'verify_payment', 'check_independently', 'need_context']);
export type ActionId = z.infer<typeof ActionIdSchema>;
export const QuestionIdSchema = z.enum(['initiated_request', 'sharing_code', 'asked_to_install', 'payment_expected']);
export type QuestionId = z.infer<typeof QuestionIdSchema>;
export const FindingSchema = z.enum(['credential_disclosure', 'own_login', 'collection_code', 'payment_request', 'remote_access', 'information_only', 'quoted_example', 'link_only', 'identity_unknown', 'unclear_request', 'unreadable_image', 'unverified_claim']);
export type Finding = z.infer<typeof FindingSchema>;
export const ReviewSchema = z.object({
  // Model interpretation, never a verified fact or a new evidence source.
  finding: FindingSchema,
  actionId: ActionIdSchema,
  reason: z.string(),
  uncertainty: z.string(),
  evidenceIds: z.array(z.string()),
  quotes: z.array(z.string()),
  questionId: QuestionIdSchema.nullable(),
  // The live model schema requires this; absence supports older injected fixtures.
  rationale: ContextRationaleSchema.nullable().optional(),
}).strict();
export type Review = z.infer<typeof ReviewSchema>;

export const CheckResultSchema = z.object({
  requestId: z.string(),
  status: z.enum(['complete', 'partial', 'needs_context']),
  title: z.string(),
  nextStep: z.string(),
  reason: z.string(),
  uncertainty: z.string(),
  evidence: z.array(EvidenceSchema),
  extraction: ExtractionSchema.nullable(),
  question: z.object({ id: QuestionIdSchema, text: z.string(), options: z.array(z.string()) }).nullable(),
  continuation: z.string().optional(),
  checkedAt: z.string(),
  aiUsed: z.boolean(),
  notice: z.string().optional(),
  recovery: z.enum(['retry', 'edit_input', 'clearer_image', 'none']).optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;
export const ClarifyRequestSchema = z.object({
  requestId: z.uuid(),
  input: CheckInputSchema,
  continuation: z.string().max(24000),
  answer: z.enum(['yes', 'no', 'unsure']),
}).strict();
export const CapabilitiesSchema = z.object({
  mode: z.enum(['local', 'pilot']),
  ai: z.boolean(),
  screenshots: z.boolean(),
  linkReputation: z.boolean(),
  phoneReputation: z.literal(false),
  message: z.string(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export interface ApiError { error: { code: string; message: string; field?: string } }

export const QUESTIONS: Record<QuestionId, { text: string; options: string[] }> = {
  initiated_request: { text: 'Did you start this request yourself?', options: ['Yes', 'No', 'Not sure'] },
  sharing_code: { text: 'Are they asking you to tell someone a login or account code?', options: ['Yes', 'No', 'Not sure'] },
  asked_to_install: { text: 'Did someone ask you to install an app or allow remote access?', options: ['Yes', 'No', 'Not sure'] },
  payment_expected: { text: 'Were you already expecting this payment request?', options: ['Yes', 'No', 'Not sure'] },
};
export const ACTIONS: Record<ActionId, { title: string; nextStep: string }> = {
  pause_and_verify: { title: 'Pause before acting', nextStep: 'Confirm the request through a contact route you already trust.' },
  protect_credentials: { title: 'Keep account codes private', nextStep: 'Do not send your password or account verification code to another person.' },
  avoid_installation: { title: 'Pause the installation', nextStep: 'Do not install an app or grant remote access just because this contact asked you to.' },
  verify_payment: { title: 'Confirm the payment request', nextStep: 'Verify who should receive the payment through a trusted, independent contact route.' },
  check_independently: { title: 'Check through a trusted route', nextStep: 'Use the official app or a contact route you already know to confirm the request.' },
  need_context: { title: 'One detail would help', nextStep: 'Answer the question below if you know. You can choose “Not sure”.' },
};
