import { afterEach, describe, expect, it } from 'vitest';
import { BudgetLedger, RESERVATION_MICRO_USD } from '../server/ledger';
import { testDatabase } from './d1';
import { readFileSync } from 'node:fs';
const opened: ReturnType<typeof testDatabase>[] = [];
function setup(limit?: string) { const t = testDatabase(); opened.push(t); let time = 1_000_000; return { ...t, ledger: new BudgetLedger(t.db, limit, () => time), advance: (ms: number) => { time += ms; } }; }
afterEach(() => { opened.splice(0).forEach(t => t.sqlite.close()); });
const usage = (cost = 1000) => ({ model: 'gpt-5.4-2026-03-05' as const, inputTokens: 100, outputTokens: 50, costMicroUsd: cost });

describe('durable pilot budget', () => {
  it('reserves atomically and blocks duplicate IDs without increasing the reservation', async () => {
    const t = setup(); await t.ledger.reserve('id', 'user');
    await expect(t.ledger.reserve('id', 'user')).rejects.toMatchObject({ code: 'duplicate_request' });
    expect(t.budget().reserved_micro).toBe(RESERVATION_MICRO_USD);
  });
  it('admits only two concurrent users and only one check per user', async () => {
    const t = setup(); const attempts = await Promise.allSettled(['a', 'b', 'c'].map(id => t.ledger.reserve(id, id)));
    expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    expect(t.budget().reserved_micro).toBe(2 * RESERVATION_MICRO_USD);
    await expect(t.ledger.reserve('another', 'a')).rejects.toMatchObject({ code: 'busy' });
  });
  it('never admits work beyond the lifetime cap even with simultaneous requests', async () => {
    const t = setup('250000'); const attempts = await Promise.allSettled(['a', 'b'].map(id => t.ledger.reserve(id, id)));
    expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(t.budget().reserved_micro).toBe(250000);
  });
  it('settles actual usage, releases unused funds and makes finish idempotent', async () => {
    const t = setup(); await t.ledger.reserve('id', 'u'); await t.ledger.beforeCall('id', 'u');
    await t.ledger.recordUsage('id', 'u', usage()); await t.ledger.finish('id', 'u'); await t.ledger.finish('id', 'u');
    expect(t.budget()).toMatchObject({ spent_micro: 1000, reserved_micro: 0, halted: 0 });
  });
  it('charges full reservation on unknown usage and tolerates a late known response', async () => {
    const t = setup(); await t.ledger.reserve('id', 'u'); await t.ledger.beforeCall('id', 'u'); await t.ledger.finish('id', 'u', true);
    await t.ledger.recordUsage('id', 'u', usage());
    expect(t.budget()).toMatchObject({ spent_micro: 250000, reserved_micro: 0, halted: 0 });
  });
  it('handles usage racing finalization without halting the pilot', async () => {
    const t = setup(); await t.ledger.reserve('id', 'u'); await t.ledger.beforeCall('id', 'u');
    await Promise.all([t.ledger.recordUsage('id', 'u', usage()), t.ledger.finish('id', 'u')]);
    expect(t.budget()).toMatchObject({ spent_micro: 250000, reserved_micro: 0, halted: 0 });
  });
  it('reclaims expired leases conservatively across a fresh ledger instance', async () => {
    const t = setup(); await t.ledger.reserve('id', 'u'); await t.ledger.beforeCall('id', 'u'); t.advance(100000);
    await t.ledger.reapExpired(); await new BudgetLedger(t.db).recordUsage('id', 'u', usage());
    expect(t.budget()).toMatchObject({ spent_micro: 250000, reserved_micro: 0, halted: 0 });
  });
  it('forbids concurrent model calls and a fourth generation call', async () => {
    const t = setup(); await t.ledger.reserve('id', 'u');
    for (let i = 0; i < 3; i++) { await t.ledger.beforeCall('id', 'u'); await expect(t.ledger.beforeCall('id', 'u')).rejects.toMatchObject({ code: 'call_limit' }); await t.ledger.recordUsage('id', 'u', usage()); }
    await expect(t.ledger.beforeCall('id', 'u')).rejects.toMatchObject({ code: 'call_limit' });
  });
  it('permits one atomic continuation, bound to the same user', async () => {
    const t = setup(); await t.ledger.reserve('id', 'u');
    for (let i = 0; i < 2; i++) { await t.ledger.beforeCall('id', 'u'); await t.ledger.recordUsage('id', 'u', usage()); }
    await t.ledger.waitForAnswer('id', 'u'); await expect(t.ledger.resume('id', 'other')).rejects.toMatchObject({ code: 'continuation_unavailable' });
    const attempts = await Promise.allSettled([t.ledger.resume('id', 'u'), t.ledger.resume('id', 'u')]);
    expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    await t.ledger.beforeCall('id', 'u'); await t.ledger.recordUsage('id', 'u', usage());
    await expect(t.ledger.waitForAnswer('id', 'u')).rejects.toMatchObject({ code: 'continuation_unavailable' });
  });
  it('cancel releases only the owner’s waiting reservation, never active work', async () => {
    const t = setup(); await t.ledger.reserve('id', 'u'); await t.ledger.cancelWaiting('id', 'u'); expect(t.row('id').state).toBe('active');
    await t.ledger.waitForAnswer('id', 'u'); await t.ledger.cancelWaiting('id', 'other'); expect(t.row('id').state).toBe('waiting');
    await t.ledger.cancelWaiting('id', 'u'); await t.ledger.cancelWaiting('id', 'u'); expect(t.budget().reserved_micro).toBe(0);
  });
  it('expires unanswered questions and prevents late replay', async () => {
    const t = setup(); await t.ledger.reserve('id', 'u'); await t.ledger.waitForAnswer('id', 'u'); t.advance(600001);
    await expect(t.ledger.resume('id', 'u')).rejects.toMatchObject({ code: 'continuation_unavailable' }); expect(t.budget().reserved_micro).toBe(0);
  });
  it('halts when actual usage exceeds the reservation', async () => {
    const t = setup(); await t.ledger.reserve('id', 'u'); await t.ledger.beforeCall('id', 'u');
    await expect(t.ledger.recordUsage('id', 'u', usage(250001))).rejects.toMatchObject({ code: 'budget_reconciliation' });
    expect(t.budget().halted).toBe(1); await expect(t.ledger.reserve('new', 'another')).rejects.toMatchObject({ code: 'budget_unavailable' });
  });
  it('enforces 20 submissions per user in a rolling day', async () => {
    const t = setup(); for (let i = 0; i < 20; i++) { await t.ledger.reserve(String(i), 'u'); await t.ledger.finish(String(i), 'u'); }
    await expect(t.ledger.reserve('21', 'u')).rejects.toMatchObject({ code: 'busy' }); t.advance(86400001); await t.ledger.reserve('22', 'u');
  });
  it('caps external lookups and image transformations independently', async () => {
    const t = setup(); t.sqlite.exec('UPDATE budget SET lookup_count=999,image_count=999');
    await t.ledger.reserveLookup(); await t.ledger.reserveImage();
    await expect(t.ledger.reserveLookup()).rejects.toMatchObject({ code: 'lookup_limit' });
    await expect(t.ledger.reserveImage()).rejects.toMatchObject({ code: 'image_limit' });
  });
  it('rejects a higher, fractional or invalid configured budget', () => {
    const t = setup(); for (const limit of ['8000001', '-1', '3.5', 'bad']) expect(() => new BudgetLedger(t.db, limit)).toThrow();
  });
  it('fails closed for new work, dispatch and continuation under an unmigrated pricing version', async () => {
    const t = setup();
    await t.ledger.reserve('active', 'a');
    await t.ledger.reserve('waiting', 'b');
    await t.ledger.waitForAnswer('waiting', 'b');
    t.sqlite.exec("UPDATE budget SET pricing_version='2026-09-26-gpt6-standard'");
    await expect(t.ledger.reserve('new', 'c')).rejects.toMatchObject({ code: 'budget_unavailable' });
    await expect(t.ledger.beforeCall('active', 'a')).rejects.toMatchObject({ code: 'call_limit' });
    await expect(t.ledger.resume('waiting', 'b')).rejects.toMatchObject({ code: 'continuation_unavailable' });
    expect(t.row('active').calls).toBe(0);
    expect(t.row('waiting').state).toBe('waiting');
  });
  it('migrates pricing while preserving spend, counters, halt state and check history', () => {
    const t = setup();
    t.sqlite.exec("UPDATE budget SET pricing_version='2026-09-26-gpt6-standard',spent_micro=123456,lookup_count=17,image_count=23,halted=1");
    t.sqlite.exec("INSERT INTO checks(id,nonce,user_hash,state,created_at,lease_until,reserved_micro,spent_micro,calls,settled_calls) VALUES('old','n','u','complete',1,2,0,123456,2,2)");
    const priorBudget = t.budget();
    const priorRow = t.row('old');
    t.sqlite.exec(readFileSync(new URL('../migrations/0003_gpt5_pricing.sql', import.meta.url), 'utf8'));
    expect(t.budget()).toEqual({ ...priorBudget, pricing_version: '2026-09-26-gpt54mini-gpt55-standard' });
    expect(t.row('old')).toEqual(priorRow);
  });
  it.each(['active', 'waiting'])('refuses a pricing migration with %s work without releasing its reservation', async state => {
    const t = setup(); await t.ledger.reserve('id', 'u');
    if (state === 'waiting') await t.ledger.waitForAnswer('id', 'u');
    t.sqlite.exec("UPDATE budget SET pricing_version='2026-09-26-gpt6-standard'");
    const priorBudget = t.budget(); const priorRow = t.row('id');
    expect(() => t.sqlite.exec(readFileSync(new URL('../migrations/0003_gpt5_pricing.sql', import.meta.url), 'utf8'))).toThrow(/NOT NULL/);
    expect(t.budget()).toEqual(priorBudget); expect(t.row('id')).toEqual(priorRow);
  });
  it('moves to the GPT-5.4 reviewer without erasing a previously charged unknown attempt', () => {
    const t = setup();
    t.sqlite.exec("UPDATE budget SET pricing_version='2026-09-26-gpt54mini-gpt55-standard',spent_micro=250000,lookup_count=7,image_count=3");
    t.sqlite.exec("INSERT INTO checks(id,nonce,user_hash,state,created_at,lease_until,reserved_micro,spent_micro,calls,settled_calls) VALUES('unknown','n','u','failed',1,2,0,250000,1,0)");
    const previousBudget = t.budget(); const previousRow = t.row('unknown');
    t.sqlite.exec(readFileSync(new URL('../migrations/0004_gpt54_reviewer.sql', import.meta.url), 'utf8'));
    expect(t.budget()).toEqual({ ...previousBudget, pricing_version: '2026-09-26-gpt54mini-gpt54-standard' });
    expect(t.row('unknown')).toEqual(previousRow);
  });
  it.each(['active', 'waiting'])('blocks reviewer migration while %s work remains', async state => {
    const t = setup(); await t.ledger.reserve('id', 'u');
    if (state === 'waiting') await t.ledger.waitForAnswer('id', 'u');
    t.sqlite.exec("UPDATE budget SET pricing_version='2026-09-26-gpt54mini-gpt55-standard'");
    const previousBudget = t.budget(); const previousRow = t.row('id');
    expect(() => t.sqlite.exec(readFileSync(new URL('../migrations/0004_gpt54_reviewer.sql', import.meta.url), 'utf8'))).toThrow(/NOT NULL/);
    expect(t.budget()).toEqual(previousBudget); expect(t.row('id')).toEqual(previousRow);
  });
});
