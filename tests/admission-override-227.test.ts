import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { BudgetLedger, RESERVATION_MICRO_USD } from '../server/ledger';
import { testDatabase } from './d1';

const DAY = 86_400_000, START = Date.parse('2026-09-27T12:00:00.000Z');
const OWNER = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const opened: ReturnType<typeof testDatabase>[] = [];
const migration = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
const currentMigration = migration('0007_admission_override_227.sql');
function setup() {
  const database = testDatabase(); opened.push(database);
  let now = START;
  return { ...database, ledger: new BudgetLedger(database.db, '7000000', () => now),
    time: () => now, at: (value: number) => { now = value; } };
}
type Setup = ReturnType<typeof setup>;
function lease(t: Setup, limit = 227, user = OWNER, start = START, end = START + DAY) {
  t.sqlite.prepare('INSERT INTO admission_overrides VALUES(?,?,?,?)').run(user, limit, start, end);
}
async function complete(t: Setup, count: number, prefix: string, owner = OWNER) {
  for (let i = 0; i < count; i++) { await t.ledger.reserve(`${prefix}-${i}`, owner); await t.ledger.finish(`${prefix}-${i}`, owner); }
}
function oldSchema(t: Setup) {
  t.sqlite.exec('DROP TABLE admission_overrides');
  t.sqlite.exec(migration('0005_admission_overrides.sql'));
  t.sqlite.exec(migration('0006_admission_override_158.sql'));
}
function migrate(t: Setup) {
  // The real migration runner applies the SQL transactionally.
  t.sqlite.exec('BEGIN');
  try { t.sqlite.exec(currentMigration); t.sqlite.exec('COMMIT'); }
  catch (error) { t.sqlite.exec('ROLLBACK'); throw error; }
}
afterEach(() => opened.splice(0).forEach(t => t.sqlite.close()));

describe('explicit 227-check operator lease', () => {
  it('does not activate a lease and retains default 20 after migration', async () => {
    const t = setup();
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM admission_overrides').get()?.n).toBe(0);
    await complete(t, 20, 'default');
    await expect(t.ledger.reserve('default-21', OWNER)).rejects.toMatchObject({ code: 'busy' });
    expect(t.budget().reserved_micro).toBe(0);
  });

  it('preserves an existing exhausted 158 lease until an explicit update and permits exactly 69 more', async () => {
    const t = setup(); oldSchema(t); lease(t, 158);
    await complete(t, 158, 'prior');
    const before = t.sqlite.prepare('SELECT * FROM checks ORDER BY id').all();
    const beforeBudget = t.budget();
    const beforeLease = t.sqlite.prepare('SELECT * FROM admission_overrides').get();
    migrate(t);
    expect(t.sqlite.prepare('SELECT * FROM admission_overrides').get()).toEqual(beforeLease);
    await expect(t.ledger.reserve('not-automatically-raised', OWNER)).rejects.toMatchObject({ code: 'busy' });
    t.sqlite.prepare('UPDATE admission_overrides SET daily_limit=227 WHERE user_hash=?').run(OWNER);
    await complete(t, 69, 'approved');
    await expect(t.ledger.reserve('228th', OWNER)).rejects.toMatchObject({ code: 'busy' });
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM checks WHERE user_hash=?').get(OWNER)?.n).toBe(227);
    for (const row of before) expect(t.row(String(row.id))).toEqual(row);
    expect(t.budget()).toEqual(beforeBudget);
    expect(t.sqlite.prepare('SELECT * FROM admission_overrides').get()).toEqual({ ...beforeLease, daily_limit: 227 });
  });

  it('starts inclusively and expires exclusively at 24 hours without clearing rolling history', async () => {
    const t = setup(); lease(t); t.at(START - 1);
    await complete(t, 20, 'before');
    await expect(t.ledger.reserve('before-start', OWNER)).rejects.toMatchObject({ code: 'busy' });
    t.at(START); await complete(t, 206, 'active');
    t.at(START + DAY - 1); await complete(t, 1, 'last-millisecond');
    await expect(t.ledger.reserve('above-ceiling', OWNER)).rejects.toMatchObject({ code: 'busy' });
    const history = t.sqlite.prepare('SELECT * FROM checks ORDER BY id').all();
    t.at(START + DAY);
    await expect(t.ledger.reserve('at-expiry', OWNER)).rejects.toMatchObject({ code: 'busy' });
    expect(t.sqlite.prepare('SELECT * FROM checks ORDER BY id').all()).toEqual(history);
    t.at(START + DAY * 2); await complete(t, 20, 'after');
    await expect(t.ledger.reserve('after-21', OWNER)).rejects.toMatchObject({ code: 'busy' });
  });

  it('does not raise another account or a differently cased hash', async () => {
    const t = setup(); lease(t);
    for (const user of [OTHER, OWNER.toUpperCase()]) {
      await complete(t, 20, user, user);
      await expect(t.ledger.reserve(`${user}-21`, user)).rejects.toMatchObject({ code: 'busy' });
    }
    await complete(t, 21, 'owner');
  });

  it('admits only one competing final slot across independent ledger instances', async () => {
    const t = setup(); lease(t); await complete(t, 226, 'existing');
    const second = new BudgetLedger(t.db, '7000000', t.time);
    const result = await Promise.allSettled([t.ledger.reserve('last-a', OWNER), second.reserve('last-b', OWNER)]);
    expect(result.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(t.budget().reserved_micro).toBe(RESERVATION_MICRO_USD);
    const admitted = t.row('last-a') ? 'last-a' : 'last-b';
    await t.ledger.finish(admitted, OWNER);
    await expect(second.reserve('next', OWNER)).rejects.toMatchObject({ code: 'busy' });
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM checks WHERE user_hash=?').get(OWNER)?.n).toBe(227);
  });

  it('retains the US$7 budget, halt, global concurrency and per-account waiting limits', async () => {
    const t = setup(); lease(t);
    t.sqlite.exec('UPDATE budget SET spent_micro=6750001');
    await expect(t.ledger.reserve('budget', OWNER)).rejects.toMatchObject({ code: 'budget_unavailable' });
    t.sqlite.exec('UPDATE budget SET spent_micro=0,halted=1');
    await expect(t.ledger.reserve('halt', OWNER)).rejects.toMatchObject({ code: 'budget_unavailable' });
    t.sqlite.exec('UPDATE budget SET halted=0');
    await t.ledger.reserve('waiting', OWNER); await t.ledger.waitForAnswer('waiting', OWNER);
    await expect(t.ledger.reserve('same-user', OWNER)).rejects.toMatchObject({ code: 'busy' });
    await t.ledger.reserve('other-active', OTHER); await t.ledger.reserve('third-active', 'c');
    await expect(t.ledger.reserve('fourth-active', 'd')).rejects.toMatchObject({ code: 'busy' });
    expect(t.budget().reserved_micro).toBe(3 * RESERVATION_MICRO_USD);
  });

  it.each([
    ['228 limit', 228, START, START + DAY],
    ['fractional limit', 227.5, START, START + DAY],
    ['overlong window', 227, START, START + DAY + 1],
  ])('rejects %s in the database and defensively falls back to 20 if constraints were bypassed', async (_label, limit, start, end) => {
    const t = setup();
    expect(() => lease(t, Number(limit), OWNER, Number(start), Number(end))).toThrow();
    t.sqlite.exec('PRAGMA ignore_check_constraints=ON');
    lease(t, Number(limit), OWNER, Number(start), Number(end));
    t.sqlite.exec('PRAGMA ignore_check_constraints=OFF');
    await complete(t, 20, 'ordinary');
    await expect(t.ledger.reserve('not-approved', OWNER)).rejects.toMatchObject({ code: 'busy' });
  });
});

describe('0007 admission ceiling migration preservation', () => {
  it('copies active, expired and future 158 leases exactly and leaves all accounting untouched', async () => {
    const t = setup(); oldSchema(t);
    lease(t, 158); lease(t, 158, OTHER, START - DAY, START); lease(t, 158, 'future', START + DAY, START + DAY * 2);
    await t.ledger.reserve('charged', OWNER); await t.ledger.beforeCall('charged', OWNER); await t.ledger.finish('charged', OWNER, true);
    await t.ledger.reserve('waiting', OWNER); await t.ledger.waitForAnswer('waiting', OWNER);
    await t.ledger.reserve('active', OTHER);
    t.sqlite.exec('UPDATE budget SET lookup_count=4,image_count=39,halted=1');
    const budget = t.budget(), checks = t.sqlite.prepare('SELECT * FROM checks ORDER BY id').all();
    const leases = t.sqlite.prepare('SELECT * FROM admission_overrides ORDER BY user_hash').all();
    migrate(t);
    expect(t.budget()).toEqual(budget);
    expect(t.sqlite.prepare('SELECT * FROM checks ORDER BY id').all()).toEqual(checks);
    expect(t.sqlite.prepare('SELECT * FROM admission_overrides ORDER BY user_hash').all()).toEqual(leases);
    expect(t.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='admission_overrides_227'").get()).toBeUndefined();
  });

  it('rolls back rather than drop a malformed historical lease', () => {
    const t = setup(); oldSchema(t);
    t.sqlite.exec('PRAGMA ignore_check_constraints=ON'); lease(t, 228); t.sqlite.exec('PRAGMA ignore_check_constraints=OFF');
    const before = t.sqlite.prepare('SELECT * FROM admission_overrides').all(), budget = t.budget();
    const schema = t.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='admission_overrides'").get();
    expect(() => migrate(t)).toThrow();
    expect(t.sqlite.prepare('SELECT * FROM admission_overrides').all()).toEqual(before);
    expect(t.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='admission_overrides'").get()).toEqual(schema);
    expect(t.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='admission_overrides_227'").get()).toBeUndefined();
    expect(t.budget()).toEqual(budget);
  });
});
