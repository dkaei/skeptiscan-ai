import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';

/** Run D1 SQL against real SQLite; batch rollback semantics match D1. */
export function testDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0001_pilot.sql', '0002_image_budget.sql', '0003_gpt5_pricing.sql', '0004_gpt54_reviewer.sql', '0005_admission_overrides.sql', '0006_admission_override_158.sql', '0007_admission_override_227.sql']) sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  class Statement {
    constructor(private sql: string, private values: SQLInputValue[] = []) {}
    bind(...values: SQLInputValue[]) { return new Statement(this.sql, values); }
    execute() { const result = sqlite.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) }, results: [] }; }
    async run() { return this.execute(); }
    async first<T>() { return (sqlite.prepare(this.sql).get(...this.values) ?? null) as T | null; }
  }
  const db = {
    prepare: (sql: string) => new Statement(sql),
    batch: async (statements: Statement[]) => {
      sqlite.exec('BEGIN');
      try { const results = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  return { db, sqlite, budget: () => sqlite.prepare('SELECT * FROM budget').get()!, row: (id: string) => sqlite.prepare('SELECT * FROM checks WHERE id=?').get(id)! };
}
