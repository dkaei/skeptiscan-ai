import { afterEach, describe, expect, it } from 'vitest';
import { BudgetLedger, RESERVATION_MICRO_USD } from '../server/ledger';
import type { ModelUsage } from '../server/types';
import { testDatabase } from './d1';

const opened: ReturnType<typeof testDatabase>[] = [];
const usage = (costMicroUsd = 1_000): ModelUsage => ({ model: 'gpt-5.4-2026-03-05', inputTokens: 100, outputTokens: 50, costMicroUsd });
function setup(limit = '7000000') {
  const t = testDatabase(); opened.push(t);
  let time = 1_000_000;
  const now = () => time;
  return { ...t, now, ledger: new BudgetLedger(t.db, limit, now), advance: (ms: number) => { time += ms; } };
}
afterEach(() => opened.splice(0).forEach(t => t.sqlite.close()));

/** A lost acknowledgement happens after a real SQLite transaction commits.
 * No real D1, provider, network transport or database reset is involved. */
function loseNextBatchAcknowledgement(db: D1Database, afterCommit?: () => Promise<void>): D1Database {
  let pending = true;
  return new Proxy(db, {
    get(target, property) {
      if (property === 'batch') return async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
        const result = await target.batch<T>(statements);
        if (pending) { pending = false; await afterCommit?.(); throw new Error('injected lost D1 acknowledgement after commit'); }
        return result;
      };
      return Reflect.get(target, property);
    },
  });
}

function balanced(t: ReturnType<typeof setup>, priorSpend = 0) {
  const sums = t.sqlite.prepare('SELECT COALESCE(SUM(spent_micro),0) AS spent,COALESCE(SUM(reserved_micro),0) AS reserved FROM checks').get()!;
  expect(t.budget().spent_micro).toBe(priorSpend + Number(sums.spent));
  expect(t.budget().reserved_micro).toBe(sums.reserved);
  expect(Number(t.budget().spent_micro)).toBeGreaterThanOrEqual(0);
  expect(Number(t.budget().reserved_micro)).toBeGreaterThanOrEqual(0);
  const bad = t.sqlite.prepare('SELECT COUNT(*) AS count FROM checks WHERE reserved_micro<0 OR spent_micro<0 OR settled_calls>calls').get()!;
  expect(bad.count).toBe(0);
}

describe('ledger reliability: settlement recovery', () => {
  it('R01 concurrent identical settlements charge once without halting healthy work', async () => {
    const t = setup(); await t.ledger.reserve('a', 'u'); await t.ledger.beforeCall('a', 'u');
    const results = await Promise.allSettled([t.ledger.recordUsage('a', 'u', usage()), t.ledger.recordUsage('a', 'u', usage())]);
    expect.soft(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect.soft(t.budget()).toMatchObject({ spent_micro: 1000, reserved_micro: 249000, halted: 0 });
    expect(t.row('a')).toMatchObject({ calls: 1, settled_calls: 1 }); balanced(t);
  });

  it('R02 a committed settlement with a lost acknowledgement is recognized from durable state', async () => {
    const t = setup(); await t.ledger.reserve('a', 'u'); await t.ledger.beforeCall('a', 'u');
    const unstable = new BudgetLedger(loseNextBatchAcknowledgement(t.db), '7000000', t.now);
    await expect.soft(unstable.recordUsage('a', 'u', usage())).resolves.toBeUndefined();
    expect.soft(t.budget()).toMatchObject({ spent_micro: 1000, reserved_micro: 249000, halted: 0 });
    expect(t.row('a')).toMatchObject({ calls: 1, settled_calls: 1 }); balanced(t);
  });

  it('R03 conflicting concurrent settlement amounts still fail closed without charging twice', async () => {
    const t = setup(); await t.ledger.reserve('a', 'u'); await t.ledger.beforeCall('a', 'u');
    const results = await Promise.allSettled([t.ledger.recordUsage('a', 'u', usage(1000)), t.ledger.recordUsage('a', 'u', usage(2000))]);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(t.budget()).toMatchObject({ spent_micro: 1000, reserved_micro: 249000, halted: 1 }); balanced(t);
  });

  it('R04 a sequential duplicate without a per-call receipt is rejected without another charge', async () => {
    const t = setup(); await t.ledger.reserve('a', 'u'); await t.ledger.beforeCall('a', 'u'); await t.ledger.recordUsage('a', 'u', usage());
    await expect(t.ledger.recordUsage('a', 'u', usage())).rejects.toMatchObject({ code: 'budget_reconciliation' });
    expect(t.budget()).toMatchObject({ spent_micro: 1000, reserved_micro: 249000, halted: 1 }); balanced(t);
  });

  it.each(['wrong-owner', 'missing-check'])('R05 internal %s settlement cannot debit another check and fails closed', async condition => {
    const t = setup(); await t.ledger.reserve('a', 'u'); await t.ledger.beforeCall('a', 'u');
    await expect(t.ledger.recordUsage(condition === 'missing-check' ? 'missing' : 'a', condition === 'wrong-owner' ? 'other' : 'u', usage())).rejects.toMatchObject({ code: 'budget_reconciliation' });
    expect(t.budget()).toMatchObject({ spent_micro: 0, reserved_micro: 250000, halted: 1 });
    expect(t.row('a')).toMatchObject({ spent_micro: 0, settled_calls: 0 }); balanced(t);
  });

  it('R06 failed second SQL statement rolls the aggregate debit back', async () => {
    const t = setup(); await t.ledger.reserve('a', 'u'); await t.ledger.beforeCall('a', 'u');
    t.sqlite.exec("CREATE TRIGGER block_settlement BEFORE UPDATE OF settled_calls ON checks BEGIN SELECT RAISE(FAIL,'injected second-statement failure'); END");
    await expect(t.ledger.recordUsage('a', 'u', usage())).rejects.toMatchObject({ code: 'budget_reconciliation' });
    expect(t.budget()).toMatchObject({ spent_micro: 0, reserved_micro: 250000, halted: 1 });
    expect(t.row('a')).toMatchObject({ spent_micro: 0, reserved_micro: 250000, settled_calls: 0 }); balanced(t);
  });

  it.each([0, 1])('R07 usage and finalization interleaving %s retains an unknown dispatch conservatively', async order => {
    const t = setup(); await t.ledger.reserve('a', 'u'); await t.ledger.beforeCall('a', 'u');
    if (order === 0) await Promise.all([t.ledger.recordUsage('a', 'u', usage()), t.ledger.finish('a', 'u')]);
    else await Promise.all([t.ledger.finish('a', 'u'), t.ledger.recordUsage('a', 'u', usage())]);
    expect(t.budget()).toMatchObject({ spent_micro: 250000, reserved_micro: 0, halted: 0 }); balanced(t);
  });

  it('R08 zero-cost settlement races cannot increment settled_calls twice', async () => {
    const t = setup(); await t.ledger.reserve('a', 'u'); await t.ledger.beforeCall('a', 'u');
    const results = await Promise.allSettled([t.ledger.recordUsage('a', 'u', usage(0)), t.ledger.recordUsage('a', 'u', usage(0))]);
    expect.soft(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect.soft(t.budget()).toMatchObject({ spent_micro: 0, reserved_micro: 250000, halted: 0 });
    expect(t.row('a').settled_calls).toBe(1); balanced(t);
  });

  it.each([2, 3])('R24 lost acknowledgement for call %s recognizes only its exact spend increment', async call => {
    const t = setup(); await t.ledger.reserve('a', 'u');
    for (let i = 1; i < call; i++) { await t.ledger.beforeCall('a', 'u'); await t.ledger.recordUsage('a', 'u', usage(1000)); }
    await t.ledger.beforeCall('a', 'u');
    const unstable = new BudgetLedger(loseNextBatchAcknowledgement(t.db), '7000000', t.now);
    await unstable.recordUsage('a', 'u', usage(2000));
    expect(t.row('a')).toMatchObject({ calls: call, settled_calls: call, spent_micro: (call - 1) * 1000 + 2000 });
    expect(t.budget().halted).toBe(0); balanced(t);
  });

  it.each(['finish', 'waiting'])('R25 acknowledged state may advance to %s before a settlement acknowledgement is lost', async state => {
    const t = setup(); await t.ledger.reserve('a', 'u'); await t.ledger.beforeCall('a', 'u');
    const transition = () => state === 'finish' ? t.ledger.finish('a', 'u') : t.ledger.waitForAnswer('a', 'u');
    const unstable = new BudgetLedger(loseNextBatchAcknowledgement(t.db, transition), '7000000', t.now);
    await unstable.recordUsage('a', 'u', usage());
    expect(t.budget()).toMatchObject({ spent_micro: 1000, halted: 0 });
    expect(t.row('a').state).toBe(state === 'finish' ? 'complete' : 'waiting'); balanced(t);
  });
});

describe('ledger reliability: finalization and lease races', () => {
  it('R09 repeated finalization of a dispatch with unknown cost charges one reservation', async () => {
    const t = setup(); await t.ledger.reserve('a', 'u'); await t.ledger.beforeCall('a', 'u');
    await Promise.all([t.ledger.finish('a', 'u'), t.ledger.finish('a', 'u', true), t.ledger.finish('a', 'u')]);
    expect(t.budget()).toMatchObject({ spent_micro: 250000, reserved_micro: 0, halted: 0 }); balanced(t);
  });

  it('R10 cancel, finish and two reapers release a settled waiting check only once', async () => {
    const t = setup(); await t.ledger.reserve('a', 'u'); await t.ledger.beforeCall('a', 'u'); await t.ledger.recordUsage('a', 'u', usage()); await t.ledger.waitForAnswer('a', 'u');
    t.advance(600001);
    await Promise.all([t.ledger.cancelWaiting('a', 'u'), t.ledger.finish('a', 'u'), t.ledger.reapExpired(), t.ledger.reapExpired()]);
    expect(t.budget()).toMatchObject({ spent_micro: 1000, reserved_micro: 0, halted: 0 }); balanced(t);
  });

  it('R11 simultaneous reapers distinguish unknown dispatches from settled waiting work', async () => {
    const t = setup(); await t.ledger.reserve('a', 'u1'); await t.ledger.beforeCall('a', 'u1');
    await t.ledger.reserve('b', 'u2'); await t.ledger.beforeCall('b', 'u2'); await t.ledger.recordUsage('b', 'u2', usage(2000)); await t.ledger.waitForAnswer('b', 'u2');
    t.advance(600001); await Promise.all([t.ledger.reapExpired(), t.ledger.reapExpired()]);
    expect(t.budget()).toMatchObject({ spent_micro: 252000, reserved_micro: 0, halted: 0 });
    await t.ledger.recordUsage('a', 'u1', usage());
    expect(t.budget().spent_micro).toBe(252000); balanced(t);
  });

  it('R12 expired waiting cleanup permits a fresh ID while retaining spend and history', async () => {
    const t = setup(); await t.ledger.reserve('old', 'u'); await t.ledger.beforeCall('old', 'u'); await t.ledger.recordUsage('old', 'u', usage()); await t.ledger.waitForAnswer('old', 'u');
    t.advance(600001); await t.ledger.reserve('new', 'u');
    expect(t.row('old')).toMatchObject({ state: 'failed', error_code: 'expired', spent_micro: 1000, reserved_micro: 0 });
    expect(t.budget()).toMatchObject({ spent_micro: 1000, reserved_micro: 250000, halted: 0 });
    await expect(t.ledger.resume('old', 'u')).rejects.toMatchObject({ code: 'continuation_unavailable' }); balanced(t);
  });

  it('R13 cancelling a waiting check wins over a subsequent resume without a model dispatch', async () => {
    const t = setup(); await t.ledger.reserve('a', 'u'); await t.ledger.waitForAnswer('a', 'u');
    const outcomes = await Promise.allSettled([t.ledger.cancelWaiting('a', 'u'), t.ledger.resume('a', 'u')]);
    expect(outcomes.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(t.row('a')).toMatchObject({ state: 'complete', calls: 0, error_code: 'cancelled' }); balanced(t);
  });

  it('R14 cancellation after a committed resume cannot release active work', async () => {
    const t = setup(); await t.ledger.reserve('a', 'u'); await t.ledger.waitForAnswer('a', 'u'); await t.ledger.resume('a', 'u');
    await Promise.all([t.ledger.cancelWaiting('a', 'u'), t.ledger.beforeCall('a', 'u')]);
    expect(t.row('a')).toMatchObject({ state: 'active', calls: 1, reserved_micro: 250000 }); balanced(t);
  });

  it('R15 finalization before dispatch prevents a later dispatch without charging work', async () => {
    const t = setup(); await t.ledger.reserve('a', 'u');
    const outcomes = await Promise.allSettled([t.ledger.finish('a', 'u'), t.ledger.beforeCall('a', 'u')]);
    expect(outcomes.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(t.budget()).toMatchObject({ spent_micro: 0, reserved_micro: 0, halted: 0 }); balanced(t);
  });

  it('R16 an expired undisbursed lease cannot start a paid call and is fully released', async () => {
    const t = setup(); await t.ledger.reserve('a', 'u'); t.advance(90001);
    await expect(t.ledger.beforeCall('a', 'u')).rejects.toMatchObject({ code: 'call_limit' });
    await t.ledger.reapExpired(); expect(t.budget()).toMatchObject({ spent_micro: 0, reserved_micro: 0, halted: 0 }); balanced(t);
  });
});

describe('ledger reliability: repeated submissions and fixed spending boundaries', () => {
  it('R17 simultaneous repeat IDs admit one owner and reserve once', async () => {
    const t = setup(); const results = await Promise.allSettled([t.ledger.reserve('same', 'one'), t.ledger.reserve('same', 'one'), t.ledger.reserve('same', 'two')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(t.budget().reserved_micro).toBe(250000); expect(t.row('same').user_hash).toBe('one'); balanced(t);
  });

  it('R18 simultaneous distinct IDs still admit one active check per user', async () => {
    const t = setup(); const results = await Promise.allSettled(['a', 'b', 'c', 'd'].map(id => t.ledger.reserve(id, 'u')));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); balanced(t);
  });

  it('R19 a cancelled or completed ID is not reusable even by a different user', async () => {
    const t = setup(); await t.ledger.reserve('a', 'u'); await t.ledger.waitForAnswer('a', 'u'); await t.ledger.cancelWaiting('a', 'u');
    const before = t.budget();
    await expect(t.ledger.reserve('a', 'u')).rejects.toMatchObject({ code: 'duplicate_request' });
    await expect(t.ledger.reserve('a', 'other')).rejects.toMatchObject({ code: 'duplicate_request' });
    expect(t.budget()).toEqual(before); balanced(t);
  });

  it('R20 cancelled checks still consume the existing 20-admission rolling limit', async () => {
    const t = setup();
    for (let i = 0; i < 20; i++) { await t.ledger.reserve(String(i), 'u'); await t.ledger.waitForAnswer(String(i), 'u'); await t.ledger.cancelWaiting(String(i), 'u'); }
    await expect(t.ledger.reserve('blocked', 'u')).rejects.toMatchObject({ code: 'busy' });
    expect(t.sqlite.prepare('SELECT COUNT(*) AS count FROM checks').get()!.count).toBe(20);
    expect(t.budget()).toMatchObject({ spent_micro: 0, reserved_micro: 0, halted: 0 }); balanced(t);
  });

  it('R21 reserves exactly at the US$7 boundary and refuses one micro-dollar beyond it', async () => {
    const t = setup(); t.sqlite.exec('UPDATE budget SET spent_micro=6750000');
    await t.ledger.reserve('exact', 'u');
    expect(t.budget()).toMatchObject({ spent_micro: 6750000, reserved_micro: 250000 });
    await expect(t.ledger.reserve('excess', 'other')).rejects.toMatchObject({ code: 'budget_unavailable' });
    await t.ledger.finish('exact', 'u'); t.sqlite.exec('UPDATE budget SET spent_micro=6750001');
    await expect(t.ledger.reserve('one-more', 'other')).rejects.toMatchObject({ code: 'budget_unavailable' });
    expect(t.budget().reserved_micro).toBe(0); balanced(t, 6750001);
  });

  it('R22 competing users cannot reserve more than the final lifetime slot', async () => {
    const t = setup(); t.sqlite.exec('UPDATE budget SET spent_micro=6749999');
    const outcomes = await Promise.allSettled(['one', 'two', 'three'].map(id => t.ledger.reserve(id, id)));
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(Number(t.budget().spent_micro) + Number(t.budget().reserved_micro)).toBe(6999999); balanced(t, 6749999);
  });

  it.each([-1, NaN, 250001])('R23 invalid or over-reservation cost %s cannot mutate spending', async cost => {
    const t = setup(); await t.ledger.reserve('a', 'u'); await t.ledger.beforeCall('a', 'u');
    await expect(t.ledger.recordUsage('a', 'u', usage(cost))).rejects.toBeDefined();
    expect(t.budget()).toMatchObject({ spent_micro: 0, reserved_micro: RESERVATION_MICRO_USD, halted: 1 }); balanced(t);
  });
});

describe('ledger reliability: bounded first-failure diagnostics', () => {
  it('D01 can record a sanitized failure after finalization without changing accounting', async () => {
    const t = setup(); await t.ledger.reserve('a', 'u'); await t.ledger.beforeCall('a', 'u'); await t.ledger.finish('a', 'u');
    const before = t.budget(); const prior = t.row('a');
    await t.ledger.recordDiagnostic('a', 'u', 'extract:MODEL_TIMEOUT');
    expect(t.row('a')).toEqual({ ...prior, error_code: 'extract:MODEL_TIMEOUT' });
    expect(t.budget()).toEqual(before); balanced(t);
  });

  it('D02 competing diagnostic writes keep the first failure', async () => {
    const t = setup(); await t.ledger.reserve('a', 'u');
    await Promise.all([t.ledger.recordDiagnostic('a', 'u', 'extract:MODEL_INVALID'), t.ledger.recordDiagnostic('a', 'u', 'review:MODEL_TIMEOUT')]);
    expect(t.row('a').error_code).toBe('extract:MODEL_INVALID');
    expect(t.budget().halted).toBe(0); balanced(t);
  });

  it('D03 wrong-owner and missing-check diagnostic writes do not touch another user or halt the budget', async () => {
    const t = setup(); await t.ledger.reserve('a', 'u'); const before = t.budget(); const prior = t.row('a');
    await t.ledger.recordDiagnostic('a', 'other', 'extract:MODEL_TIMEOUT');
    await t.ledger.recordDiagnostic('missing', 'u', 'extract:MODEL_TIMEOUT');
    expect(t.row('a')).toEqual(prior); expect(t.budget()).toEqual(before); balanced(t);
  });

  it.each(['cancel', 'expire'])('D04 %s preserves an earlier diagnostic instead of replacing it', async transition => {
    const t = setup(); await t.ledger.reserve('a', 'u'); await t.ledger.waitForAnswer('a', 'u');
    await t.ledger.recordDiagnostic('a', 'u', 'review:NEEDS_CONTEXT');
    if (transition === 'cancel') await t.ledger.cancelWaiting('a', 'u');
    else { t.advance(600001); await t.ledger.reapExpired(); }
    expect(t.row('a').error_code).toBe('review:NEEDS_CONTEXT');
    expect(t.budget()).toMatchObject({ spent_micro: 0, reserved_micro: 0, halted: 0 }); balanced(t);
  });

  it.each(['', 'provider secret response', 'https://example.org/private', 'x'.repeat(101), 'extract:failure\nPRIVATE'])('D05 unbounded or free-text diagnostic %j is rejected without changing accounting', async code => {
    const t = setup(); await t.ledger.reserve('a', 'u'); const before = t.budget();
    await expect(t.ledger.recordDiagnostic('a', 'u', code)).rejects.toMatchObject({ code: 'diagnostic_invalid' });
    expect(t.row('a').error_code).toBeNull(); expect(t.budget()).toEqual(before); balanced(t);
  });

  it('D06 a diagnostic storage failure propagates but never halts or changes spending', async () => {
    const t = setup(); await t.ledger.reserve('a', 'u'); const before = t.budget();
    t.sqlite.exec("CREATE TRIGGER block_diagnostic BEFORE UPDATE OF error_code ON checks BEGIN SELECT RAISE(FAIL,'injected diagnostic write failure'); END");
    await expect(t.ledger.recordDiagnostic('a', 'u', 'extract:MODEL_TIMEOUT')).rejects.toThrow('diagnostic write failure');
    expect(t.row('a').error_code).toBeNull(); expect(t.budget()).toEqual(before); balanced(t);
  });
});
