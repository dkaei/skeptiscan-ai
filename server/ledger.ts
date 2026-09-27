import { ServiceError } from './types';
import type { ModelUsage } from './types';

export const RESERVATION_MICRO_USD = 250_000;
export const LIFETIME_LIMIT_MICRO_USD = 8_000_000;
const ACTIVE_LEASE_MS = 90_000;
const WAITING_LEASE_MS = 10 * 60_000;
const ROLLING_DAY_MS = 86_400_000;
const PRICING_VERSION = '2026-09-26-gpt54mini-gpt54-standard';
interface CheckRow { id: string; state: string; user_hash: string; calls: number; settled_calls: number; reserved_micro: number; spent_micro: number; lease_until: number }

/** Only bookkeeping lives here; inputs and model responses never enter D1. */
export class BudgetLedger {
  private limit: number;
  constructor(private db: D1Database, configuredLimit?: string, private now = () => Date.now()) {
    this.limit = configuredLimit ? Number(configuredLimit) : LIFETIME_LIMIT_MICRO_USD;
    if (!Number.isSafeInteger(this.limit) || this.limit < 0 || this.limit > LIFETIME_LIMIT_MICRO_USD) throw new ServiceError('budget_configuration', 'Checking is unavailable until the spending limit is configured.', 503);
  }

  async reapExpired(): Promise<void> {
    const now = this.now();
    // An interrupted dispatch might have been billed. Never refund its unknown cost.
    await this.db.batch([
      this.db.prepare(`UPDATE budget SET spent_micro = spent_micro + COALESCE((SELECT SUM(reserved_micro) FROM checks WHERE state IN ('active','waiting') AND lease_until < ? AND calls > settled_calls),0), reserved_micro = reserved_micro - COALESCE((SELECT SUM(reserved_micro) FROM checks WHERE state IN ('active','waiting') AND lease_until < ?),0) WHERE id=1`).bind(now, now),
      this.db.prepare(`UPDATE checks SET spent_micro=spent_micro + CASE WHEN calls > settled_calls THEN reserved_micro ELSE 0 END, reserved_micro=0, state='failed', error_code=COALESCE(error_code,'expired') WHERE state IN ('active','waiting') AND lease_until < ?`).bind(now),
    ]);
  }

  async reserve(id: string, userHash: string): Promise<void> {
    await this.reapExpired();
    const nonce = crypto.randomUUID();
    const now = this.now();
    // D1 batch is transactional. The INSERT predicate and budget update are one unit.
    const result = await this.db.batch([
      this.db.prepare(`INSERT INTO checks (id,nonce,user_hash,state,created_at,lease_until,reserved_micro)
        SELECT ?,?,?,'active',?,?,? WHERE EXISTS (SELECT 1 FROM budget WHERE id=1 AND halted=0 AND pricing_version=? AND spent_micro + reserved_micro + ? <= ?)
        AND (SELECT COUNT(*) FROM checks WHERE state='active') < 2
        AND NOT EXISTS (SELECT 1 FROM checks WHERE user_hash=? AND state IN ('active','waiting'))
        AND (SELECT COUNT(*) FROM checks WHERE user_hash=? AND created_at>=?) < COALESCE((
          SELECT daily_limit FROM admission_overrides WHERE user_hash=? COLLATE BINARY
          AND typeof(daily_limit)='integer' AND daily_limit BETWEEN 20 AND 227
          AND typeof(starts_at)='integer' AND starts_at BETWEEN 0 AND 9007199254740991
          AND typeof(expires_at)='integer' AND expires_at BETWEEN 0 AND 9007199254740991
          AND expires_at>starts_at AND expires_at-starts_at<=86400000
          AND starts_at<=? AND expires_at>?
        ),20)
        ON CONFLICT(id) DO NOTHING`).bind(id, nonce, userHash, now, now + ACTIVE_LEASE_MS, RESERVATION_MICRO_USD, PRICING_VERSION, RESERVATION_MICRO_USD, this.limit, userHash, userHash, now - ROLLING_DAY_MS, userHash, now, now),
      this.db.prepare(`UPDATE budget SET reserved_micro=reserved_micro+? WHERE id=1 AND EXISTS (SELECT 1 FROM checks WHERE id=? AND nonce=?)`).bind(RESERVATION_MICRO_USD, id, nonce),
    ]);
    if (result[0].meta.changes !== 1) {
      const existing = await this.db.prepare('SELECT id FROM checks WHERE id=?').bind(id).first();
      if (existing) throw new ServiceError('duplicate_request', 'This check has already been submitted. Start a new check if you need to try again.', 409);
      const budget = await this.db.prepare('SELECT * FROM budget WHERE id=1').first<{ halted: number; spent_micro: number; reserved_micro: number; pricing_version: string }>();
      if (!budget || budget.halted || budget.pricing_version !== PRICING_VERSION || budget.spent_micro + budget.reserved_micro + RESERVATION_MICRO_USD > this.limit) throw new ServiceError('budget_unavailable', 'The pilot checking allowance is unavailable. Your input has not been sent for analysis.', 503);
      throw new ServiceError('busy', 'Another check is running, awaiting your answer, or your daily limit has been reached. Please try again later.', 429);
    }
  }

  async beforeCall(id: string, userHash: string): Promise<void> {
    const result = await this.db.prepare(`UPDATE checks SET calls=calls+1 WHERE id=? AND user_hash=? AND state='active' AND calls=settled_calls AND calls<3 AND lease_until>=? AND reserved_micro>0 AND EXISTS (SELECT 1 FROM budget WHERE id=1 AND halted=0 AND pricing_version=?)`).bind(id, userHash, this.now(), PRICING_VERSION).run();
    if (result.meta.changes !== 1) throw new ServiceError('call_limit', 'This check cannot make another AI request.', 409);
  }

  async recordUsage(id: string, userHash: string, usage: ModelUsage): Promise<void> {
    const cost = usage.costMicroUsd;
    if (!Number.isSafeInteger(cost) || cost < 0) { await this.halt(); throw new ServiceError('usage_invalid', 'Checking paused because usage could not be reconciled.', 503); }
    const row = await this.db.prepare(`SELECT * FROM checks WHERE id=? AND user_hash=?`).bind(id, userHash).first<CheckRow>();
    if (this.alreadyCharged(row, cost)) return;
    if (!row || row.state !== 'active' || row.calls <= row.settled_calls || cost > row.reserved_micro) {
      await this.halt();
      throw new ServiceError('budget_reconciliation', 'Checking paused because usage could not be reconciled.', 503);
    }
    try {
      const result = await this.db.batch([
        this.db.prepare(`UPDATE budget SET reserved_micro=reserved_micro-?,spent_micro=spent_micro+? WHERE id=1 AND EXISTS (SELECT 1 FROM checks WHERE id=? AND user_hash=? AND settled_calls=? AND state='active')`).bind(cost, cost, id, userHash, row.settled_calls),
        this.db.prepare(`UPDATE checks SET reserved_micro=reserved_micro-?,spent_micro=spent_micro+?,settled_calls=settled_calls+1 WHERE id=? AND user_hash=? AND settled_calls=? AND state='active'`).bind(cost, cost, id, userHash, row.settled_calls),
      ]);
      if (result[1].meta.changes !== 1) throw new Error('usage conflict');
    } catch {
      // The deadline may finalize this check, or a committed transaction may
      // lose its acknowledgement. Confirm the exact settlement from the
      // original snapshot; aggregate spend alone cannot identify a replay.
      const latest = await this.db.prepare('SELECT * FROM checks WHERE id=? AND user_hash=?').bind(id, userHash).first<CheckRow>();
      if (this.alreadyCharged(latest, cost) || this.matchesSettledSnapshot(latest, row, cost)) return;
      await this.halt();
      throw new ServiceError('budget_reconciliation', 'Checking paused because usage could not be reconciled.', 503);
    }
  }

  private alreadyCharged(row: CheckRow | null, cost: number): boolean {
    return !!row && ['complete', 'failed'].includes(row.state) && row.reserved_micro === 0 && row.calls > row.settled_calls && cost <= row.spent_micro;
  }

  private matchesSettledSnapshot(latest: CheckRow | null, previous: CheckRow, cost: number): boolean {
    if (!latest || latest.user_hash !== previous.user_hash || previous.calls !== previous.settled_calls + 1
      || latest.calls < previous.calls || latest.settled_calls !== previous.calls
      || latest.spent_micro !== previous.spent_micro + cost) return false;
    return ['active', 'waiting'].includes(latest.state)
      ? latest.reserved_micro === previous.reserved_micro - cost
      : ['complete', 'failed'].includes(latest.state) && latest.reserved_micro === 0;
  }

  /** Persist only the first bounded stage/code, never provider text or input. */
  async recordDiagnostic(id: string, userHash: string, code: string): Promise<void> {
    if (!/^[a-zA-Z0-9_:-]{1,100}$/.test(code)) throw new ServiceError('diagnostic_invalid', 'The diagnostic code is invalid.', 500);
    await this.db.prepare('UPDATE checks SET error_code=? WHERE id=? AND user_hash=? AND error_code IS NULL').bind(code, id, userHash).run();
  }

  async waitForAnswer(id: string, userHash: string): Promise<void> {
    const result = await this.db.prepare(`UPDATE checks SET state='waiting',lease_until=? WHERE id=? AND user_hash=? AND state='active' AND calls=settled_calls AND calls<3`).bind(this.now() + WAITING_LEASE_MS, id, userHash).run();
    if (result.meta.changes !== 1) throw new ServiceError('continuation_unavailable', 'This check cannot ask another question.', 409);
  }

  async resume(id: string, userHash: string): Promise<void> {
    await this.reapExpired();
    const result = await this.db.prepare(`UPDATE checks SET state='active',lease_until=? WHERE id=? AND user_hash=? AND state='waiting' AND calls<3 AND lease_until>=? AND (SELECT COUNT(*) FROM checks WHERE state='active')<2 AND EXISTS (SELECT 1 FROM budget WHERE id=1 AND halted=0 AND pricing_version=?)`).bind(this.now() + ACTIVE_LEASE_MS, id, userHash, this.now(), PRICING_VERSION).run();
    if (result.meta.changes !== 1) throw new ServiceError('continuation_unavailable', 'This question has expired, was already answered, or checking is busy. Start a new check.', 409);
  }

  async finish(id: string, userHash: string, failed = false): Promise<void> {
    // Charge the full remaining reservation if a dispatched call has unknown usage.
    await this.db.batch([
      this.db.prepare(`UPDATE budget SET reserved_micro=reserved_micro-COALESCE((SELECT reserved_micro FROM checks WHERE id=? AND user_hash=? AND state IN ('active','waiting')),0),spent_micro=spent_micro+COALESCE((SELECT CASE WHEN calls>settled_calls THEN reserved_micro ELSE 0 END FROM checks WHERE id=? AND user_hash=? AND state IN ('active','waiting')),0) WHERE id=1`).bind(id, userHash, id, userHash),
      this.db.prepare(`UPDATE checks SET spent_micro=spent_micro + CASE WHEN calls>settled_calls THEN reserved_micro ELSE 0 END,reserved_micro=0,state=? WHERE id=? AND user_hash=? AND state IN ('active','waiting')`).bind(failed ? 'failed' : 'complete', id, userHash),
    ]);
  }

  async reserveLookup(): Promise<void> {
    const result = await this.db.prepare('UPDATE budget SET lookup_count=lookup_count+1 WHERE id=1 AND lookup_count<1000 AND halted=0').run();
    if (result.meta.changes !== 1) throw new ServiceError('lookup_limit', 'External link checking is unavailable.', 503);
  }

  async reserveImage(): Promise<void> {
    const result = await this.db.prepare('UPDATE budget SET image_count=image_count+1 WHERE id=1 AND image_count<1000 AND halted=0').run();
    if (result.meta.changes !== 1) throw new ServiceError('image_limit', 'Screenshot checking is unavailable. You can paste the message instead.', 503);
  }

  async cancelWaiting(id: string, userHash: string): Promise<void> {
    await this.db.batch([
      this.db.prepare(`UPDATE budget SET reserved_micro=reserved_micro-COALESCE((SELECT reserved_micro FROM checks WHERE id=? AND user_hash=? AND state='waiting'),0) WHERE id=1`).bind(id, userHash),
      this.db.prepare(`UPDATE checks SET reserved_micro=0,state='complete',error_code=COALESCE(error_code,'cancelled') WHERE id=? AND user_hash=? AND state='waiting'`).bind(id, userHash),
    ]);
  }

  async halt(): Promise<void> { await this.db.prepare('UPDATE budget SET halted=1 WHERE id=1').run(); }
}
