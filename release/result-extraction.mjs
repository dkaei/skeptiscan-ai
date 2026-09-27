import { z } from 'zod';

// Capture schemas intentionally retain bounded historical result shapes, rather
// than import the live API schema (which accepts continuation bearer tokens).
// New optional extraction metadata mirrors shared/contracts.ts. Parsing must
// preserve observations, including failures; it is not a semantic quality grade.
const TEXT = z.string().max(24000);
const source = z.enum(['content', 'context', 'senderEmail', 'senderPhone', 'transcript']);
const span = z.object({
  source, start: z.number().int().nonnegative(), end: z.number().int().positive(),
}).strict();
const screenshotIssue = z.object({
  kind: z.enum(['unreadable_region', 'missing_detail', 'conflicting_accounts']),
  target: z.enum(['requested_action', 'code_recipient', 'link_destination', 'payment_recipient', 'payment_amount', 'sender_identity', 'reference_number', 'other']),
  location: z.enum(['header', 'body', 'link', 'button', 'footer', 'unspecified']),
  consequential: z.boolean(),
  imageQuote: z.string().min(1).max(240).nullable(),
  userQuote: z.string().min(1).max(240).nullable(),
  userSource: z.enum(['correction', 'context']).nullable(),
}).strict();

export const capturedExtractionSchema = z.object({
  transcript: TEXT, claimedOrganisation: TEXT.nullable(), urls: z.array(TEXT).max(100),
  phoneNumbers: z.array(TEXT).max(100),
  requestedActions: z.array(z.object({ action: TEXT, quote: TEXT, source: source.optional(), span: span.optional() }).strict()).max(100),
  unreadableDetails: z.array(TEXT).max(100), missingContext: z.array(TEXT).max(100),
  screenshotIssues: z.array(screenshotIssue).max(4).optional(),
}).strict();
