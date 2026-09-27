import { readFileSync } from 'node:fs';
import type { SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetLedger, RESERVATION_MICRO_USD } from '../server/ledger';
import { testDatabase } from './d1';

const DAY = 86_400_000;
const ACTIVATION = Date.parse('2026-09-27T00:00:00.000Z');
const OPERATOR = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const opened: ReturnType<typeof testDatabase>[] = [];
function setup(limit?: string) {
  const database = testDatabase(); opened.push(database);
  let time = ACTIVATION;
  return { ...database, ledger: new BudgetLedger(database.db, limit, () => time),
    clock: () => time, at: (value: number) => { time = value; } };
}
type Setup = ReturnType<typeof setup>;
function lease(t: Setup, user = OPERATOR, limit: SQLInputValue = 91, start: SQLInputValue = ACTIVATION, end: SQLInputValue = ACTIVATION + DAY) {
  t.sqlite.prepare('INSERT INTO admission_overrides(user_hash,daily_limit,starts_at,expires_at) VALUES(?,?,?,?)').run(user, limit, start, end);
}
async function complete(t: Setup, count: number, user = OPERATOR, prefix = 'check') {
  for (let index = 0; index < count; index++) {
    const id = `${prefix}-${index}`;
    await t.ledger.reserve(id, user);
    await t.ledger.finish(id, user);
  }
}
const usage = { model: 'gpt-5.4-2026-03-05' as const, inputTokens: 100, outputTokens: 50, costMicroUsd: 1000 };
const originalLeaseMigration = readFileSync(new URL('../migrations/0005_admission_overrides.sql', import.meta.url), 'utf8');
const expandedLeaseMigration = readFileSync(new URL('../migrations/0006_admission_override_158.sql', import.meta.url), 'utf8');
function restoreOriginalLeaseTable(t: Setup) {
  t.sqlite.exec('DROP TABLE admission_overrides');
  t.sqlite.exec(originalLeaseMigration);
}
function migrateExpandedLeaseTable(t: Setup) {
  // Wrangler applies each migration transactionally; reproduce its rollback
  // boundary while executing the actual SQL against SQLite.
  t.sqlite.exec('BEGIN');
  try { t.sqlite.exec(expandedLeaseMigration); t.sqlite.exec('COMMIT'); }
  catch (error) { t.sqlite.exec('ROLLBACK'); throw error; }
}
afterEach(() => { opened.splice(0).forEach(t => t.sqlite.close()); vi.restoreAllMocks(); });

describe('temporary admission lease schema and exact account scope', () => {
  it('starts empty and preserves the ordinary rolling limit of 20', async () => {
    const t = setup();
    expect(t.sqlite.prepare('SELECT COUNT(*) AS count FROM admission_overrides').get()?.count).toBe(0);
    await complete(t, 20);
    await expect(t.ledger.reserve('twenty-first', OPERATOR)).rejects.toMatchObject({ code: 'busy' });
    expect(t.budget().reserved_micro).toBe(0);
  });

  it('counts the existing 20 checks, permits only 71 more, and refuses check 92', async () => {
    const t = setup();
    await complete(t, 20, OPERATOR, 'before-approval');
    const existing = t.sqlite.prepare('SELECT * FROM checks ORDER BY id').all();
    lease(t);
    await complete(t, 71, OPERATOR, 'under-lease');
    await expect(t.ledger.reserve('ninety-second', OPERATOR)).rejects.toMatchObject({ code: 'busy' });
    expect(t.sqlite.prepare('SELECT COUNT(*) AS count FROM checks WHERE user_hash=?').get(OPERATOR)?.count).toBe(91);
    for (const row of existing) expect(t.row(String(row.id))).toEqual(row);
    expect(t.budget().reserved_micro).toBe(0);
  });

  it('does not extend another account or a different case spelling of the hash', async () => {
    const t = setup(); lease(t);
    await complete(t, 20, OTHER, 'other');
    await expect(t.ledger.reserve('other-21', OTHER)).rejects.toMatchObject({ code: 'busy' });
    await complete(t, 20, OPERATOR.toUpperCase(), 'uppercase');
    await expect(t.ledger.reserve('uppercase-21', OPERATOR.toUpperCase())).rejects.toMatchObject({ code: 'busy' });
    await complete(t, 21, OPERATOR, 'approved');
  });

  it.each([
    ['below default', 19, ACTIVATION, ACTIVATION + DAY],
    ['above maximum', 228, ACTIVATION, ACTIVATION + DAY],
    ['fractional limit', 90.5, ACTIVATION, ACTIVATION + DAY],
    ['non-numeric limit', 'unlimited', ACTIVATION, ACTIVATION + DAY],
    ['too-long duration', 91, ACTIVATION, ACTIVATION + DAY + 1],
    ['empty duration', 91, ACTIVATION, ACTIVATION],
    ['reversed duration', 91, ACTIVATION, ACTIVATION - 1],
    ['negative start', 91, -1, 100],
    ['fractional start', 91, ACTIVATION + 0.5, ACTIVATION + DAY],
    ['fractional end', 91, ACTIVATION, ACTIVATION + DAY - 0.5],
    ['non-numeric start', 91, 'tomorrow', ACTIVATION + DAY],
    ['unsafe integer end', 91, 9007199254740991, 9007199254740992],
  ] satisfies [string, SQLInputValue, SQLInputValue, SQLInputValue][])('rejects an invalid lease at the database boundary: %s', (_label, limit, start, end) => {
    const t = setup();
    expect(() => lease(t, OPERATOR, limit, start, end)).toThrow();
    expect(t.sqlite.prepare('SELECT COUNT(*) AS count FROM admission_overrides').get()?.count).toBe(0);
  });

  it('allows the bounded endpoints 20 and 91 but not duplicate account rows', () => {
    const t = setup(); lease(t, OPERATOR, 20); lease(t, OTHER, 91);
    expect(() => lease(t, OPERATOR, 91)).toThrow();
    expect(t.sqlite.prepare('SELECT daily_limit FROM admission_overrides WHERE user_hash=?').get(OPERATOR)?.daily_limit).toBe(20);
  });
});

describe('lease activation, expiry and defensive query bounds', () => {
  it('uses an inclusive start and exclusive expiry, with no default-limit gap', async () => {
    const t = setup(); t.at(ACTIVATION - 1); lease(t);
    await complete(t, 20, OPERATOR, 'before');
    await expect(t.ledger.reserve('too-early', OPERATOR)).rejects.toMatchObject({ code: 'busy' });
    t.at(ACTIVATION);
    await t.ledger.reserve('at-start', OPERATOR); await t.ledger.finish('at-start', OPERATOR);
    t.at(ACTIVATION + DAY - 1);
    await t.ledger.reserve('just-before-expiry', OPERATOR); await t.ledger.finish('just-before-expiry', OPERATOR);
    // All these remain inside the rolling window when the lease expires.
    await complete(t, 19, OPERATOR, 'late');
    t.at(ACTIVATION + DAY);
    await expect(t.ledger.reserve('at-expiry', OPERATOR)).rejects.toMatchObject({ code: 'busy' });
    t.at(ACTIVATION + DAY * 2);
    await complete(t, 20, OPERATOR, 'ordinary-after-expiry');
    await expect(t.ledger.reserve('ordinary-21', OPERATOR)).rejects.toMatchObject({ code: 'busy' });
  });

  it.each([
    ['limit above maximum', 228, ACTIVATION, ACTIVATION + DAY],
    ['fractional limit', 90.5, ACTIVATION, ACTIVATION + DAY],
    ['text limit', 'unlimited', ACTIVATION, ACTIVATION + DAY],
    ['overlong active window', 91, ACTIVATION - 1, ACTIVATION + DAY],
    ['negative active start', 91, -1, ACTIVATION + DAY],
    ['fractional active start', 91, ACTIVATION - 0.5, ACTIVATION + DAY - 1],
    ['fractional active end', 91, ACTIVATION, ACTIVATION + DAY - 0.5],
  ] satisfies [string, SQLInputValue, SQLInputValue, SQLInputValue][])('falls back to 20 even if database checks were bypassed: %s', async (_label, limit, start, end) => {
    const t = setup();
    // Simulate corruption/legacy schema without relaxing production constraints.
    t.sqlite.exec('PRAGMA ignore_check_constraints=ON');
    lease(t, OPERATOR, limit, start, end);
    t.sqlite.exec('PRAGMA ignore_check_constraints=OFF');
    await complete(t, 20);
    await expect(t.ledger.reserve('not-granted', OPERATOR)).rejects.toMatchObject({ code: 'busy' });
    expect(t.budget().reserved_micro).toBe(0);
  });

  it('fails closed with no reservation when migration 0005 is absent', async () => {
    const t = setup(); t.sqlite.exec('DROP TABLE admission_overrides');
    await expect(t.ledger.reserve('unmigrated', OPERATOR)).rejects.toThrow();
    expect(t.sqlite.prepare('SELECT COUNT(*) AS count FROM checks').get()?.count).toBe(0);
    expect(t.budget()).toMatchObject({ spent_micro: 0, reserved_micro: 0 });
  });
});

describe('temporary admission does not override other durable controls', () => {
  it('keeps the last rolling-day slot atomic across distinct ledger instances', async () => {
    const t = setup(); lease(t); await complete(t, 90);
    const otherLedger = new BudgetLedger(t.db, undefined, t.clock);
    const attempts = await Promise.allSettled([t.ledger.reserve('last-a', OPERATOR), otherLedger.reserve('last-b', OPERATOR)]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(t.budget().reserved_micro).toBe(RESERVATION_MICRO_USD);
    expect(t.sqlite.prepare('SELECT COUNT(*) AS count FROM checks WHERE user_hash=?').get(OPERATOR)?.count).toBe(91);
  });

  it('retains duplicate protection, per-user one-check and global two-check concurrency', async () => {
    const t = setup(); lease(t); lease(t, OTHER);
    await t.ledger.reserve('operator-active', OPERATOR);
    await expect(t.ledger.reserve('operator-active', OPERATOR)).rejects.toMatchObject({ code: 'duplicate_request' });
    await expect(t.ledger.reserve('operator-extra', OPERATOR)).rejects.toMatchObject({ code: 'busy' });
    await t.ledger.reserve('other-active', OTHER);
    await expect(t.ledger.reserve('third', 'c'.repeat(64))).rejects.toMatchObject({ code: 'busy' });
    expect(t.budget().reserved_micro).toBe(2 * RESERVATION_MICRO_USD);
  });

  it('retains configured spend and halt gates', async () => {
    const t = setup('7000000'); lease(t);
    t.sqlite.exec('UPDATE budget SET spent_micro=6900000');
    await expect(t.ledger.reserve('too-expensive', OPERATOR)).rejects.toMatchObject({ code: 'budget_unavailable' });
    expect(t.budget()).toMatchObject({ spent_micro: 6900000, reserved_micro: 0 });
    t.sqlite.exec('UPDATE budget SET spent_micro=0,halted=1');
    await expect(t.ledger.reserve('halted', OPERATOR)).rejects.toMatchObject({ code: 'budget_unavailable' });
  });

  it('retains the three-generation ceiling and the conservative unknown-usage charge', async () => {
    const t = setup(); lease(t); await t.ledger.reserve('generation-bound', OPERATOR);
    for (let index = 0; index < 3; index++) {
      await t.ledger.beforeCall('generation-bound', OPERATOR);
      await t.ledger.recordUsage('generation-bound', OPERATOR, usage);
    }
    await expect(t.ledger.beforeCall('generation-bound', OPERATOR)).rejects.toMatchObject({ code: 'call_limit' });
    await t.ledger.finish('generation-bound', OPERATOR);
    await t.ledger.reserve('unknown-charge', OPERATOR); await t.ledger.beforeCall('unknown-charge', OPERATOR);
    await t.ledger.finish('unknown-charge', OPERATOR, true);
    expect(t.budget()).toMatchObject({ spent_micro: 3000 + RESERVATION_MICRO_USD, reserved_micro: 0 });
  });

  it('migration and activation never reset history, charged spend or ancillary counters', async () => {
    const t = setup(); await t.ledger.reserve('old-unknown', OPERATOR); await t.ledger.beforeCall('old-unknown', OPERATOR);
    await t.ledger.finish('old-unknown', OPERATOR, true);
    t.sqlite.exec('UPDATE budget SET lookup_count=17,image_count=23');
    const priorBudget = t.budget(), priorCheck = t.row('old-unknown');
    t.sqlite.exec(readFileSync(new URL('../migrations/0005_admission_overrides.sql', import.meta.url), 'utf8'));
    lease(t);
    expect(t.budget()).toEqual(priorBudget); expect(t.row('old-unknown')).toEqual(priorCheck);
  });
});

describe('explicit 158-check operator lease', () => {
  it('counts the prior 91 admissions when the same account is explicitly raised to 158', async () => {
    const t = setup(); lease(t);
    await complete(t, 91, OPERATOR, 'existing');
    const existing = t.sqlite.prepare('SELECT * FROM checks ORDER BY id').all(), priorBudget = t.budget();
    await expect(t.ledger.reserve('unapproved-92', OPERATOR)).rejects.toMatchObject({ code: 'busy' });
    // Raising the schema ceiling alone never changes the account's saved lease.
    t.sqlite.prepare('UPDATE admission_overrides SET daily_limit=158 WHERE user_hash=?').run(OPERATOR);
    await complete(t, 67, OPERATOR, 'approved-extension');
    await expect(t.ledger.reserve('one-hundred-fifty-ninth', OPERATOR)).rejects.toMatchObject({ code: 'busy' });
    expect(t.sqlite.prepare('SELECT COUNT(*) AS count FROM checks WHERE user_hash=?').get(OPERATOR)?.count).toBe(158);
    for (const row of existing) expect(t.row(String(row.id))).toEqual(row);
    expect(t.budget()).toEqual(priorBudget);
    expect(t.sqlite.prepare('SELECT COUNT(*) AS count FROM admission_overrides').get()?.count).toBe(1);
  });

  it('accepts 158 but rejects updates to 159 or an extended 24-hour window without altering the lease', () => {
    // Preserve the historical boundary test against the actual 0006 schema.
    const t = setup(); restoreOriginalLeaseTable(t); migrateExpandedLeaseTable(t); lease(t, OPERATOR, 158);
    const original = t.sqlite.prepare('SELECT * FROM admission_overrides').get();
    expect(() => t.sqlite.prepare('UPDATE admission_overrides SET daily_limit=159 WHERE user_hash=?').run(OPERATOR)).toThrow();
    expect(() => t.sqlite.prepare('UPDATE admission_overrides SET expires_at=? WHERE user_hash=?').run(ACTIVATION + DAY + 1, OPERATOR)).toThrow();
    expect(t.sqlite.prepare('SELECT * FROM admission_overrides').get()).toEqual(original);
  });

  it('applies 158 only to the exact account hash while other accounts retain 20', async () => {
    const t = setup(); lease(t, OPERATOR, 158);
    for (const [user, prefix] of [[OTHER, 'other'], [OPERATOR.toUpperCase(), 'uppercase']]) {
      await complete(t, 20, user, prefix);
      await expect(t.ledger.reserve(`${prefix}-21`, user)).rejects.toMatchObject({ code: 'busy' });
    }
    await complete(t, 92, OPERATOR, 'approved');
    expect(t.budget()).toMatchObject({ spent_micro: 0, reserved_micro: 0 });
  });

  it('activates 158 at the exact start and restores 20 at expiry without erasing rolling history', async () => {
    const t = setup(); lease(t, OPERATOR, 158); t.at(ACTIVATION - 1);
    await complete(t, 20, OPERATOR, 'before');
    await expect(t.ledger.reserve('early', OPERATOR)).rejects.toMatchObject({ code: 'busy' });
    t.at(ACTIVATION);
    await complete(t, 137, OPERATOR, 'at-start');
    t.at(ACTIVATION + DAY - 1);
    await complete(t, 1, OPERATOR, 'last-slot');
    await expect(t.ledger.reserve('above-158', OPERATOR)).rejects.toMatchObject({ code: 'busy' });
    const history = t.sqlite.prepare('SELECT * FROM checks ORDER BY id').all();
    t.at(ACTIVATION + DAY);
    await expect(t.ledger.reserve('expired', OPERATOR)).rejects.toMatchObject({ code: 'busy' });
    expect(t.sqlite.prepare('SELECT * FROM checks ORDER BY id').all()).toEqual(history);
    t.at(ACTIVATION + DAY * 2);
    await complete(t, 20, OPERATOR, 'ordinary');
    await expect(t.ledger.reserve('ordinary-21', OPERATOR)).rejects.toMatchObject({ code: 'busy' });
  });

  it('counts failed, cancelled and expired checks while a clarification stays within one admission', async () => {
    const t = setup(); lease(t, OPERATOR, 158);
    await complete(t, 154);
    await t.ledger.reserve('failed', OPERATOR); await t.ledger.finish('failed', OPERATOR, true);
    await t.ledger.reserve('cancelled', OPERATOR); await t.ledger.waitForAnswer('cancelled', OPERATOR);
    await t.ledger.cancelWaiting('cancelled', OPERATOR);
    await t.ledger.reserve('expired', OPERATOR); await t.ledger.beforeCall('expired', OPERATOR);
    t.at(ACTIVATION + 90_001); await t.ledger.reapExpired();
    await t.ledger.reserve('clarification', OPERATOR);
    for (let index = 0; index < 2; index++) {
      await t.ledger.beforeCall('clarification', OPERATOR); await t.ledger.recordUsage('clarification', OPERATOR, usage);
    }
    await t.ledger.waitForAnswer('clarification', OPERATOR); await t.ledger.resume('clarification', OPERATOR);
    await t.ledger.beforeCall('clarification', OPERATOR); await t.ledger.recordUsage('clarification', OPERATOR, usage);
    await t.ledger.finish('clarification', OPERATOR);
    await expect(t.ledger.reserve('clarification', OPERATOR)).rejects.toMatchObject({ code: 'duplicate_request' });
    await expect(t.ledger.reserve('fresh-manual-attempt', OPERATOR)).rejects.toMatchObject({ code: 'busy' });
    expect(t.sqlite.prepare('SELECT COUNT(*) AS count FROM checks WHERE user_hash=?').get(OPERATOR)?.count).toBe(158);
    expect(t.row('clarification')).toMatchObject({ calls: 3, settled_calls: 3, spent_micro: 3000 });
    expect(t.row('expired')).toMatchObject({ state: 'failed', spent_micro: RESERVATION_MICRO_USD });
    expect(t.budget()).toMatchObject({ spent_micro: RESERVATION_MICRO_USD + 3000, reserved_micro: 0, halted: 0 });
  });

  it('admits only one competing 158th check across fresh ledger instances', async () => {
    const t = setup(); lease(t, OPERATOR, 158); await complete(t, 157);
    const otherLedger = new BudgetLedger(t.db, undefined, t.clock);
    const attempts = await Promise.allSettled([t.ledger.reserve('158-a', OPERATOR), otherLedger.reserve('158-b', OPERATOR)]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const admitted = t.row('158-a') ? '158-a' : '158-b';
    await t.ledger.finish(admitted, OPERATOR);
    await expect(otherLedger.reserve('159', OPERATOR)).rejects.toMatchObject({ code: 'busy' });
    expect(t.sqlite.prepare('SELECT COUNT(*) AS count FROM checks WHERE user_hash=?').get(OPERATOR)?.count).toBe(158);
    expect(t.budget().reserved_micro).toBe(0);
  });

  it('preserves the budget cap and halt even with a valid 158 lease', async () => {
    const t = setup('7000000'); lease(t, OPERATOR, 158);
    t.sqlite.exec('UPDATE budget SET spent_micro=6750001');
    await expect(t.ledger.reserve('over-cloud-allocation', OPERATOR)).rejects.toMatchObject({ code: 'budget_unavailable' });
    expect(t.budget()).toMatchObject({ spent_micro: 6750001, reserved_micro: 0 });
    t.sqlite.exec('UPDATE budget SET spent_micro=0, halted=1');
    await expect(t.ledger.reserve('halted-158', OPERATOR)).rejects.toMatchObject({ code: 'budget_unavailable' });
    expect(t.sqlite.prepare('SELECT COUNT(*) AS count FROM checks').get()?.count).toBe(0);
  });
});

describe('0006 admission ceiling migration preservation', () => {
  it('copies every prior lease exactly without renewing, activating or resetting any bookkeeping', async () => {
    const t = setup(); restoreOriginalLeaseTable(t);
    lease(t); lease(t, OTHER, 20, ACTIVATION - DAY, ACTIVATION);
    lease(t, 'future', 91, ACTIVATION + DAY, ACTIVATION + 2 * DAY);
    await t.ledger.reserve('charged', OPERATOR); await t.ledger.beforeCall('charged', OPERATOR);
    await t.ledger.finish('charged', OPERATOR, true);
    await t.ledger.reserve('waiting', OPERATOR); await t.ledger.beforeCall('waiting', OPERATOR);
    await t.ledger.recordUsage('waiting', OPERATOR, usage); await t.ledger.waitForAnswer('waiting', OPERATOR);
    await t.ledger.reserve('active', OTHER);
    t.sqlite.exec('UPDATE budget SET lookup_count=17,image_count=23,halted=1');
    const priorBudget = t.budget(), priorChecks = t.sqlite.prepare('SELECT * FROM checks ORDER BY id').all();
    const priorLeases = t.sqlite.prepare('SELECT * FROM admission_overrides ORDER BY user_hash').all();
    expect(() => t.sqlite.prepare('UPDATE admission_overrides SET daily_limit=158 WHERE user_hash=?').run(OPERATOR)).toThrow();
    migrateExpandedLeaseTable(t);
    expect(t.budget()).toEqual(priorBudget);
    expect(t.sqlite.prepare('SELECT * FROM checks ORDER BY id').all()).toEqual(priorChecks);
    expect(t.sqlite.prepare('SELECT * FROM admission_overrides ORDER BY user_hash').all()).toEqual(priorLeases);
    expect(t.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='admission_overrides_158'").get()).toBeUndefined();
    // The subsequent explicit account update is separate from the migration.
    t.sqlite.prepare('UPDATE admission_overrides SET daily_limit=158 WHERE user_hash=?').run(OPERATOR);
    expect(t.sqlite.prepare('SELECT * FROM admission_overrides WHERE user_hash=?').get(OPERATOR)).toEqual({
      ...priorLeases.find(row => row.user_hash === OPERATOR), daily_limit: 158,
    });
    expect(t.budget()).toEqual(priorBudget);
    expect(t.sqlite.prepare('SELECT * FROM checks ORDER BY id').all()).toEqual(priorChecks);
  });

  it('rolls back the table rebuild instead of dropping an invalid historical lease', () => {
    const t = setup(); restoreOriginalLeaseTable(t);
    t.sqlite.exec('PRAGMA ignore_check_constraints=ON'); lease(t, OPERATOR, 159);
    t.sqlite.exec('PRAGMA ignore_check_constraints=OFF');
    const priorBudget = t.budget(), priorLeases = t.sqlite.prepare('SELECT * FROM admission_overrides').all();
    const priorSchema = t.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='admission_overrides'").get();
    expect(() => migrateExpandedLeaseTable(t)).toThrow();
    expect(t.sqlite.prepare('SELECT * FROM admission_overrides').all()).toEqual(priorLeases);
    expect(t.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='admission_overrides'").get()).toEqual(priorSchema);
    expect(t.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='admission_overrides_158'").get()).toBeUndefined();
    expect(t.budget()).toEqual(priorBudget);
  });
});
