import { z } from 'zod';

// A bounded interpretation tied to supplied text, never a new evidence source.
export const ContextRationaleSchema = z.object({
  relation: z.enum(['routine_context', 'context_not_authority', 'untrusted_instruction', 'conflicting_accounts', 'claim_unverified', 'action_risk', 'unclear_context'])
    .describe('routine: benign/expected, no risks; claim: unverified_claim, no risks; conflict: opposing accounts; action: explicit risk; unclear: unresolved.'),
  anchors: z.array(z.object({
    source: z.enum(['content', 'context', 'transcript']),
    quote: z.string().min(1).max(180).describe('Exact contiguous source text; preserve whitespace, negation and context.'),
  }).strict()).min(1).max(4).describe('Distinct anchors. Context/override first, separate request second; conflicts need two opposing quotes. Include consequential supporting details.'),
  risks: z.array(z.object({
    kind: z.enum(['account_access', 'payment', 'device_control']),
    anchorIndex: z.number().int().min(0).max(3),
  }).strict()).max(3).describe('Unique kinds linked to actual request anchors; never warnings/negations. Include the finding risk. Context/override: no index 0, include index 1. Action: include index 0.'),
}).strict();
export type ContextRationale = z.infer<typeof ContextRationaleSchema>;
