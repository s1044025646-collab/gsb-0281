import { GrammarVersion, Origin } from "./types.js";
import { Store } from "./storage.js";
import { analyze } from "./analyzer.js";
import { validateGrammar } from "./validate.js";

export class GrammarError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface ImportResult {
  version: GrammarVersion;
  created: boolean;
}

export class GrammarService {
  constructor(private store: Store) {}

 importGrammar(input: unknown, note?: string): ImportResult {
    const { issues, grammar } = validateGrammar(input);
    if (issues.length > 0) {
      throw new GrammarError("VALIDATION_FAILED", "文法校验未通过", issues);
    }
    const report = analyze(grammar!);
    const saved = this.store.saveVersion(grammar!, report, note);
    return saved;
  }

  requireVersion(id: string): GrammarVersion {
    const v = this.store.getVersion(id);
    if (!v) throw new GrammarError("VERSION_NOT_FOUND", `文法版本不存在：${id}`);
    return v;
  }

  getReport(id: string) {
    return this.requireVersion(id).report;
  }

  list() {
    return this.store.listVersions();
  }

  /** 查询单符号集合元素的传播来源 */
  explain(id: string, set: "first" | "follow" | "nullable", nonterminal: string, element?: string): Origin[] {
    const v = this.requireVersion(id);
    const g = v.grammar;
    if (!g.nonterminals.includes(nonterminal)) {
      throw new GrammarError("UNKNOWN_NONTERMINAL", `非终结符不存在：${nonterminal}`);
    }
    if (set === "nullable") {
      return v.report.sets.nullableWhy[nonterminal] ?? [];
    }
    const why = set === "first" ? v.report.sets.firstWhy : v.report.sets.followWhy;
    const row = why[nonterminal];
    if (!row) throw new GrammarError("UNKNOWN_ELEMENT", `该文法未计算 ${nonterminal} 的集合`);
    if (element === undefined) {
      return Object.values(row).flat();
    }
    const origins = row[element];
    if (!origins) {
      throw new GrammarError("UNKNOWN_ELEMENT", `${set.toUpperCase()}(${nonterminal}) 不包含 ${element}`);
    }
    return origins;
  }

  queryTable(id: string, nonterminal?: string, terminal?: string) {
    const v = this.requireVersion(id);
    let table = v.report.table;
    if (nonterminal !== undefined) {
      if (!(nonterminal in table)) throw new GrammarError("UNKNOWN_NONTERMINAL", `非终结符不存在：${nonterminal}`);
      const row = table[nonterminal]!;
      if (terminal !== undefined) return { [nonterminal]: { [terminal]: row[terminal] ?? [] } };
      return { [nonterminal]: row };
    }
    return table;
  }

  conflicts(id: string) {
    return this.requireVersion(id).report.conflicts;
  }

  exportJson(id: string) {
    const v = this.requireVersion(id);
    return {
      version: v.id,
      algorithmVersion: v.algorithmVersion,
      exportedAt: new Date().toISOString(),
      grammar: v.grammar,
      report: v.report,
    };
  }

  compare(idA: string, idB: string) {
    const a = this.requireVersion(idA);
    const b = this.requireVersion(idB);
    const setDiff = (sa: string[] | undefined, sb: string[] | undefined) => {
      const A = new Set(sa ?? []);
      const B = new Set(sb ?? []);
      return {
        added: [...B].filter((x) => !A.has(x)).sort(),
        removed: [...A].filter((x) => !B.has(x)).sort(),
      };
    };

    const symbols: Record<string, { nullable: ReturnType<typeof setDiff>; first: ReturnType<typeof setDiff>; follow: ReturnType<typeof setDiff> }> = {};
    const allSyms = new Set([...a.grammar.nonterminals, ...b.grammar.nonterminals]);
    for (const x of allSyms) {
      symbols[x] = {
        nullable: setDiff(a.report.sets.nullable.includes(x) ? [x] : [], b.report.sets.nullable.includes(x) ? [x] : []),
        first: setDiff(a.report.sets.first[x], b.report.sets.first[x]),
        follow: setDiff(a.report.sets.follow[x], b.report.sets.follow[x]),
      };
    }

    const key = (c: { nonterminal: string; terminal: string }) => `${c.nonterminal}\u0000${c.terminal}`;
    const ma = new Map(a.report.conflicts.map((c) => [key(c), c]));
    const mb = new Map(b.report.conflicts.map((c) => [key(c), c]));
    return {
      from: { id: idA, ll1: a.report.ll1 },
      to: { id: idB, ll1: b.report.ll1 },
      symbols,
      conflicts: {
        added: [...mb.keys()].filter((k) => !ma.has(k)).map((k) => mb.get(k)!),
        removed: [...ma.keys()].filter((k) => !mb.has(k)).map((k) => ma.get(k)!),
        changed: [...ma.keys()].filter((k) => mb.has(k) && JSON.stringify(ma.get(k)!.candidates) !== JSON.stringify(mb.get(k)!.candidates))
          .map((k) => ({ from: ma.get(k)!, to: mb.get(k)! })),
      },
    };
  }
}
