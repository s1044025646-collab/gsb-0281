import { AnalysisResult, CellCandidate, Conflict, Diagnostics, EOF, EPSILON, Grammar } from "./types.js";

export interface PredictTable {
  // table[非终结符][终结符] = 候选列表（保留全部，不静默选第一条）
  table: Record<string, Record<string, CellCandidate[]>>;
  conflicts: Conflict[];
}

/** 计算右部符号序列的 FIRST（基于已完成的 FIRST/可空集合）。 */
export function firstOfSequence(rhs: string[], grammar: Grammar, analysis: AnalysisResult): { set: string[]; nullable: boolean } {
  const isTerminal = new Set(grammar.terminals);
  const nullableSet = new Set(analysis.nullable);
  const out = new Set<string>();
  let allNullable = true;
  for (const sym of rhs) {
    if (isTerminal.has(sym)) {
      out.add(sym);
      allNullable = false;
      break;
    }
    for (const v of analysis.first[sym] ?? []) {
      if (v !== EPSILON) out.add(v);
    }
    if (!nullableSet.has(sym)) { allNullable = false; break; }
  }
  return { set: [...out].sort(), nullable: allNullable };
}

/** 按每个右部的 FIRST 构建预测表；右部可空时加入左部 FOLLOW 对应的格子。 */
export function buildTable(grammar: Grammar, analysis: AnalysisResult): PredictTable {
  const table: Record<string, Record<string, CellCandidate[]>> = {};
  for (const n of grammar.nonTerminals) table[n] = {};

  grammar.productions.forEach((p, i) => {
    const { set, nullable } = firstOfSequence(p.rhs, grammar, analysis);
    for (const a of set) {
      (table[p.lhs][a] ??= []).push({ production: i, source: "first" });
    }
    if (nullable) {
      for (const b of analysis.follow[p.lhs] ?? []) {
        (table[p.lhs][b] ??= []).push({ production: i, source: "follow" });
      }
    }
  });

  // 排序保证输出确定
  for (const n of Object.keys(table)) {
    for (const t of Object.keys(table[n])) {
      table[n][t].sort((x, y) => x.production - y.production);
    }
  }

  const conflicts: Conflict[] = [];
  for (const n of Object.keys(table).sort()) {
    for (const t of Object.keys(table[n]).sort()) {
      const candidates = table[n][t];
      if (candidates.length < 2) continue;
      const hasFirst = candidates.some((c) => c.source === "first");
      const hasFollow = candidates.some((c) => c.source === "follow");
      const kind = hasFirst && hasFollow ? "FIRST_FOLLOW" : hasFollow ? "FOLLOW_FOLLOW" : "FIRST_FIRST";
      const label = kind === "FIRST_FIRST"
        ? "共同前缀导致多个右部的 FIRST 重叠"
        : kind === "FIRST_FOLLOW"
          ? "空产生式相关：某右部 FIRST 与可空右部经 FOLLOW 填入的格子重叠"
          : "多个可空右部经 FOLLOW 填入同一格子";
      conflicts.push({
        nonTerminal: n,
        terminal: t,
        kind,
        candidates,
        message: `M[${n}, ${t}] 有 ${candidates.length} 个候选产生式（${label}）`,
      });
    }
  }
  return { table, conflicts };
}

/** 不可达与不能生成终结符串的非终结符诊断（独立给出，不超时）。 */
export function diagnose(grammar: Grammar): Diagnostics {
  const isTerminal = new Set(grammar.terminals);

  // 可生成性：存在一条右部全部可生成的产生式
  const generating = new Set(grammar.terminals);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of grammar.productions) {
      if (!generating.has(p.lhs) && p.rhs.every((s) => generating.has(s))) {
        generating.add(p.lhs);
        changed = true;
      }
    }
  }

  // 可达性：从开始符号 BFS
  const reachable = new Set<string>([grammar.start]);
  const queue = [grammar.start];
  while (queue.length) {
    const cur = queue.pop()!;
    for (const p of grammar.productions) {
      if (p.lhs !== cur) continue;
      for (const s of p.rhs) {
        if (!isTerminal.has(s) && !reachable.has(s)) {
          reachable.add(s);
          queue.push(s);
        }
      }
    }
  }

  return {
    unreachable: grammar.nonTerminals.filter((n) => !reachable.has(n)).sort(),
    nonGenerating: grammar.nonTerminals.filter((n) => !generating.has(n)).sort(),
  };
}

export { EOF };
