import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ALGORITHM_VERSION, AnalysisReport, Grammar, GrammarVersion } from "./types.js";

/**
 * SQLite 持久化。文法版本不可变：任何修改产生新行，旧报告永远对应旧文法。
 */
export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "cfg.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        algorithm_version INTEGER NOT NULL,
        grammar_json TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        note TEXT,
        lineage INTEGER NOT NULL
      );
    `);
  }

  /** 若相同文法已存在则直接返回已有版本（幂等导入，不产生重复版本）。 */
  saveVersion(g: Grammar, report: AnalysisReport, note?: string): { version: GrammarVersion; created: boolean } {
    const existing = this.getVersion(g.id);
    if (existing) return { version: existing, created: false };
    const lineageRow = this.db.prepare("SELECT COALESCE(MAX(lineage), 0) + 1 AS n FROM versions").get() as { n: number };
    this.db
      .prepare(
        `INSERT INTO versions (id, algorithm_version, grammar_json, report_json, created_at, note, lineage)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(g.id, ALGORITHM_VERSION, JSON.stringify(g), JSON.stringify(report), g.createdAt, note ?? null, lineageRow.n);
    return { version: this.getVersion(g.id)!, created: true };
  }

  getVersion(id: string): GrammarVersion | null {
    const row = this.db
      .prepare("SELECT id, algorithm_version, grammar_json, report_json, created_at, note FROM versions WHERE id = ?")
      .get(id) as
      | { id: string; algorithm_version: number; grammar_json: string; report_json: string; created_at: string; note: string | null }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      algorithmVersion: row.algorithm_version,
      grammar: JSON.parse(row.grammar_json) as Grammar,
      report: JSON.parse(row.report_json) as AnalysisReport,
      createdAt: row.created_at,
      note: row.note ?? undefined,
    };
  }

  listVersions(): Array<Pick<GrammarVersion, "id" | "createdAt" | "note" | "algorithmVersion">> {
    const rows = this.db
      .prepare("SELECT id, algorithm_version, created_at, note FROM versions ORDER BY lineage")
      .all() as Array<{ id: string; algorithm_version: number; created_at: string; note: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      algorithmVersion: r.algorithm_version,
      createdAt: r.created_at,
      note: r.note ?? undefined,
    }));
  }

  close(): void {
    this.db.close();
  }
}

export function defaultDataDir(): string {
  return join(process.cwd(), "data");
}

export { dirname };
