import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { ALGO_VERSION, AnalysisResult, Diagnostics, Grammar } from "./types.js";
import { analyze } from "./analysis.js";
import { buildTable, diagnose, PredictTable } from "./table.js";

export interface StoredReport {
  analysis: AnalysisResult;
  table: PredictTable["table"];
  conflicts: PredictTable["conflicts"];
  diagnostics: Diagnostics;
}

export class GrammarStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS grammars (
        id TEXT PRIMARY KEY,
        algo_version TEXT NOT NULL,
        grammar_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        grammar_id TEXT PRIMARY KEY REFERENCES grammars(id),
        algo_version TEXT NOT NULL,
        report_json TEXT NOT NULL
      );
    `);
  }

  /** 内容寻址：相同文法得到相同 id；修改产生式即产生新版本。 */
  static grammarId(grammar: Grammar): string {
    const canonical = JSON.stringify(grammar); // validateGrammar 已规范化排序
    return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  }

  /** 导入文法（幂等）。返回 id 与是否新建。 */
  import(grammar: Grammar): { id: string; created: boolean } {
    const id = GrammarStore.grammarId(grammar);
    const existing = this.db.prepare("SELECT id FROM grammars WHERE id = ?").get(id);
    if (existing) return { id, created: false };
    this.db.prepare("INSERT INTO grammars (id, algo_version, grammar_json, created_at) VALUES (?, ?, ?, ?)")
      .run(id, ALGO_VERSION, JSON.stringify(grammar), new Date().toISOString());
    const report = this.computeReport(grammar);
    this.db.prepare("INSERT INTO reports (grammar_id, algo_version, report_json) VALUES (?, ?, ?)")
      .run(id, ALGO_VERSION, JSON.stringify(report));
    return { id, created: true };
  }

  private computeReport(grammar: Grammar): StoredReport {
    const analysis = analyze(grammar);
    const { table, conflicts } = buildTable(grammar, analysis);
    return { analysis, table, conflicts, diagnostics: diagnose(grammar) };
  }

  getGrammar(id: string): Grammar | null {
    const row = this.db.prepare("SELECT grammar_json FROM grammars WHERE id = ?").get(id) as { grammar_json: string } | undefined;
    return row ? JSON.parse(row.grammar_json) : null;
  }

  getReport(id: string): StoredReport | null {
    const row = this.db.prepare("SELECT report_json FROM reports WHERE grammar_id = ?").get(id) as { report_json: string } | undefined;
    return row ? JSON.parse(row.report_json) : null;
  }

  list(): { id: string; algo_version: string; created_at: string }[] {
    return this.db.prepare("SELECT id, algo_version, created_at FROM grammars ORDER BY created_at").all() as never;
  }

  /** 版本比较：符号与产生式集合差异 + 冲突数量变化。 */
  diff(idA: string, idB: string) {
    const ga = this.getGrammar(idA);
    const gb = this.getGrammar(idB);
    if (!ga || !gb) return null;
    const ra = this.getReport(idA)!;
    const rb = this.getReport(idB)!;
    const prodKey = (p: { lhs: string; rhs: string[] }) => `${p.lhs} -> ${p.rhs.join(" ")}`;
    const setA = new Set(ga.productions.map(prodKey));
    const setB = new Set(gb.productions.map(prodKey));
    return {
      addedProductions: [...setB].filter((p) => !setA.has(p)).sort(),
      removedProductions: [...setA].filter((p) => !setB.has(p)).sort(),
      addedTerminals: gb.terminals.filter((t) => !ga.terminals.includes(t)),
      removedTerminals: ga.terminals.filter((t) => !gb.terminals.includes(t)),
      addedNonTerminals: gb.nonTerminals.filter((t) => !ga.nonTerminals.includes(t)),
      removedNonTerminals: ga.nonTerminals.filter((t) => !gb.nonTerminals.includes(t)),
      startChanged: ga.start !== gb.start ? { from: ga.start, to: gb.start } : null,
      conflictsBefore: ra.conflicts.length,
      conflictsAfter: rb.conflicts.length,
      conflictsResolved: ra.conflicts.filter((c) => !rb.conflicts.some((c2) => c2.nonTerminal === c.nonTerminal && c2.terminal === c.terminal)),
      conflictsIntroduced: rb.conflicts.filter((c) => !ra.conflicts.some((c2) => c2.nonTerminal === c.nonTerminal && c2.terminal === c.terminal)),
    };
  }

  close() { this.db.close(); }
}
