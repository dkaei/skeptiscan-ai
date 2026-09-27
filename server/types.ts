import type { CheckInput, Extraction, Review } from '../shared/contracts';

// Bindings come from `wrangler types`; optional settings are validated at runtime.
export type Env = Pick<CloudflareBindings, 'DB'> & Partial<Omit<CloudflareBindings, 'DB'>>;
export interface ModelUsage { model: 'gpt-5.4-mini-2026-03-17' | 'gpt-5.4-2026-03-05'; inputTokens: number; outputTokens: number; costMicroUsd: number }
export interface ModelOutput<T> { value: T; usage: ModelUsage }
export interface ModelGateway {
  extract(input: CheckInput, signal: AbortSignal): Promise<ModelOutput<Extraction>>;
  review(input: CheckInput, extraction: Extraction, evidence: import('../shared/contracts').Evidence[], signal: AbortSignal, clarification?: { questionId: string; answer: string }): Promise<ModelOutput<Review>>;
}
export class ServiceError extends Error {
  constructor(public code: string, message: string, public status = 400, public field?: string) { super(message); this.name = 'ServiceError'; }
}
