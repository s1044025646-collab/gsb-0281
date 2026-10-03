import {
  ALGORITHM_VERSION,
  AnalysisReport,
  Conflict,
  ENDMARKER,
  EPSILON,
  Grammar,
  Origin,
  SetReport,
  TableEntry,
} from "./types.js";
import { LIMITS } from "./limits.js";

type Origins = Map<string, Origin[]>;

function addOrigins(map: Origins, sym: string, origin: Origin): boolean {
  const list = map.get(sym);
  if (!list) {
    map.set(sym, [origin]);
    return true;
  }
  const sig = `${origin.productionIndex}|${origin.via ?? ""}`;
  if (!list.some((o) => `${o.productionIndex}|${o.via ?? ""}` === sig)) {
    list.push(origin);
    return true;
  }
  return false;
}

const prodText = (g: Grammar, i: number) => {
  const p = g.productions[i]!;
  return `${p.lhs} -> ${p.rhs.join(" ") || EPSILON}`;
};

/**
 * 固定点分析。每一轮完整扫描全部产生式；任一轮无新增即收敛。
 * 相互递归不会造成无限循环：集合只单调增长，规模受符号数上界限制。
 */
export function analyze(g: Grammar): AnalysisReport {
  const isTerm = new Set(g.terminals);
  const isNon = new Set(g.nonterminals);

  // ---------- 可空性 ----------
  const nullable = new Set<string>();
  const nullableWhy = new Map<string, Origin[]>();
  let changed = true;
  let iterations = 0;
  while (changed) {
    changed = false;
    iterations++;
    if (iterations > LIMITS.maxFixpointIterations) throw new Error("FIXPOINT_LIMIT_EXCEEDED");
    g.productions.forEach((p, i) => {
      if (nullable.has(p.lhs)) return;
      // 空产生式，或右部每个符号都可空
      if (p.rhs.every((s) => isTerm.has(s) ? false : nullable.has(s))) {
        nullable.add(p.lhs);
        const reason =
          p.rhs.length === 0
            ? `空产生式 ${prodText(g, i)} 使 ${p.lhs} 可空`
            : `产生式 ${prodText(g, i)} 的整段右部均可空，使 ${p.lhs} 可空`;
        addOrigins(nullableWhy, p.lhs, { productionIndex: i, reason });
        changed = true;
      }
    });
  }

  // ---------- FIRST ----------
  // firstSets[A] 包含终结符及 EPSILON
  const firstSets = new Map<string, Origins>();
  g.nonterminals.forEach((a) => firstSets.set(a, new Map()));
  const firstOfSym = (s: string): Set<string> => {
    if (isTerm.has(s)) return new Set([s]);
    return new Set(firstSets.get(s)?.keys() ?? []);
  };

  changed = true;
  while (changed) {
    changed = false;
    iterations++;
    if (iterations > LIMITS.maxFixpointIterations) throw new Error("FIXPOINT_LIMIT_EXCEEDED");
    g.productions.forEach((p, i) => {
      const target = firstSets.get(p.lhs)!;
      // 沿可空前缀继续：X1..Xk 中依次并入 FIRST(Xj)，直到遇到不可空符号
      for (const sym of p.rhs) {
        const fs = firstOfSym(sym);
        for (const t of fs) {
          if (t === EPSILON) continue;
          const origin: Origin = {
            productionIndex: i,
            via: isNon.has(sym) ? sym : undefined,
            reason:
              sym === t
                ? `产生式 ${prodText(g, i)} 的右部前缀包含终结符 ${t}`
                : `产生式 ${prodText(g, i)} 的可空前缀处由 FIRST(${sym}) 传入 ${t}`,
          };
          if (addOrigins(target, t, origin)) changed = true;
        }
        // 当前符号不可空则停止沿前缀推进
        if (isTerm.has(sym) || !nullable.has(sym)) break;
      }
      // 整段右部可空 -> FIRST(A) 含 ε
      const allNullable = p.rhs.length > 0 && p.rhs.every((s) => isNon.has(s) && nullable.has(s));
      if (p.rhs.length === 0 || allNullable) {
        if (addOrigins(target, EPSILON, {
          productionIndex: i,
          reason:
            p.rhs.length === 0
              ? `空产生式 ${prodText(g, i)} 向 FIRST(${p.lhs}) 加入 ${EPSILON}`
              : `产生式 ${prodText(g, i)} 整段可空，向 FIRST(${p.lhs}) 加入 ${EPSILON}`,
        })) {
          changed = true;
        }
      }
    });
  }

  // ---------- FOLLOW ----------
  const followSets = new Map<string, Origins>();
  g.nonterminals.forEach((a) => followSets.set(a, new Map()));
  followSets.get(g.startSymbol)!.set(ENDMARKER, [
    { productionIndex: null, reason: `${g.startSymbol} 是开始符号，其 FOLLOW 包含结束标记 ${ENDMARKER}` },
  ]);

  const firstBeta = (rhs: string[]): Set<string> => {
    const out = new Set<string>();
    for (const sym of rhs) {
      const fs = firstOfSym(sym);
      for (const t of fs) if (t !== EPSILON) out.add(t);
      if (isTerm.has(sym) || !nullable.has(sym)) return out;
    }
    out.add(EPSILON);
    return out;
  };

  changed = true;
  while (changed) {
    changed = false;
    iterations++;
    if (iterations > LIMITS.maxFixpointIterations) throw new Error("FIXPOINT_LIMIT_EXCEEDED");
    g.productions.forEach((p, i) => {
      p.rhs.forEach((b, pos) => {
        if (!isNon.has(b)) return;
        const beta = p.rhs.slice(pos + 1);
        const fb = firstBeta(beta);
        const target = followSets.get(b)!;
        for (const t of fb) {
          if (t === EPSILON) continue; // ε 永不进入 FOLLOW
          if (addOrigins(target, t, {
            productionIndex: i,
            reason: `产生式 ${prodText(g, i)} 中 ${b} 的后缀 FIRST 含 ${t}`,
          })) {
            changed = true;
          }
        }
        // 后缀可空（含后缀为空）-> FOLLOW(A) 传播给 FOLLOW(B)
        if (fb.has(EPSILON)) {
          for (const t of followSets.get(p.lhs)!.keys()) {
            if (addOrigins(target, t, {
              productionIndex: i,
              via: p.lhs,
              reason:
                beta.length === 0
                  ? `产生式 ${prodText(g, i)} 中 ${b} 位于右部末尾，继承 FOLLOW(${p.lhs}) 的 ${t}`
                  : `产生式 ${prodText(g, i)} 中 ${b} 的后缀可空，继承 FOLLOW(${p.lhs}) 的 ${t}`,
            })) {
              changed = true;
            }
          }
        }
      });
    });
  }

  // ---------- 诊断：可达性 / 可生成终结符串 ----------
  const reachable = new Set<string>([g.startSymbol]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of [...reachable]) {
      for (const p of g.productions) {
        if (p.lhs !== a) continue;
        for (const s of p.rhs) {
          if (isNon.has(s) && !reachable.has(s)) {
            reachable.add(s);
            grew = true;
          }
        }
      }
    }
  }

  const productive = new Set<string>(); // 能推导出终结符串（含 ε）的非终结符
  changed = true;
  while (changed) {
    changed = false;
    g.productions.forEach((p) => {
      if (productive.has(p.lhs)) return;
      if (p.rhs.every((s) => isTerm.has(s) || productive.has(s))) {
        productive.add(p.lhs);
        changed = true;
      }
    });
  }

  // ---------- 输出整理（确定顺序） ----------
  const sorted = (m: Origins) => [...m.keys()].sort();
  const whyOut = (m: Origins) => {
    const out: Record<string, Origin[]> = {};
    for (const k of sorted(m)) out[k] = m.get(k)!;
    return out;
  };

  const first: Record<string, string[]> = {};
  const firstWhy: Record<string, Record<string, Origin[]>> = {};
  for (const a of g.nonterminals) {
    const m = firstSets.get(a)!;
    first[a] = sorted(m);
    firstWhy[a] = whyOut(m);
  }
  const follow: Record<string, string[]> = {};
  const followWhy: Record<string, Record<string, Origin[]>> = {};
  for (const a of g.nonterminals) {
    const m = followSets.get(a)!;
    follow[a] = sorted(m);
    followWhy[a] = whyOut(m);
  }
  const nullableOut = [...nullable].sort();
  const nullableWhyOut: Record<string, Origin[]> = {};
  for (const a of nullableOut) nullableWhyOut[a] = nullableWhy.get(a)!;

  const sets: SetReport = {
    nullable: nullableOut,
    first,
    follow,
    nullableWhy: nullableWhyOut,
    firstWhy,
    followWhy,
    iterations,
  };

  // ---------- 预测分析表 ----------
  const table: Record<string, Record<string, TableEntry[]>> = {};
  for (const a of g.nonterminals) table[a] = {};
  const put = (a: string, t: string, e: TableEntry) => {
    const row = table[a]!;
    (row[t] ??= []).push(e);
  };

  g.productions.forEach((p, i) => {
    const fb = firstBeta(p.rhs);
    for (const t of fb) {
      if (t === EPSILON) continue;
      put(p.lhs, t, { productionIndex: i, source: "first" });
    }
    if (fb.has(EPSILON)) {
      // 右部可空（含空产生式）：左部 FOLLOW 的每一格都放该候选
      for (const t of followSets.get(p.lhs)!.keys()) {
        put(p.lhs, t, { productionIndex: i, source: "follow" });
      }
    }
  });

  // 候选按下标排序，保证重排无关
  const conflicts: Conflict[] = [];
  for (const a of g.nonterminals) {
    for (const t of Object.keys(table[a]!).sort()) {
      const cands = table[a]![t]!.sort((x, y) => x.productionIndex - y.productionIndex);
      if (cands.length < 2) continue;
      const kinds = new Set(cands.map((c) => c.source));
      let kind: Conflict["kind"];
      let reason: string;
      if (kinds.has("first") && kinds.has("follow")) {
        kind = "FIRST_FOLLOW_EPSILON";
        reason = `M[${a}, ${t}] 同时被右部 FIRST(${t}) 的产生式与可空产生式（经 FOLLOW(${a})）占用`;
      } else if (kinds.has("first")) {
        kind = "FIRST_OVERLAP";
        reason = `M[${a}, ${t}] 被多条产生式的右部 FIRST 同时占用（典型为共同前缀）`;
      } else {
        kind = "FOLLOW_EPSILON";
        reason = `M[${a}, ${t}] 被多条可空产生式经 FOLLOW(${a}) 同时占用`;
      }
      conflicts.push({ nonterminal: a, terminal: t, kind, candidates: cands, reason });
    }
  }

  return {
    algorithmVersion: ALGORITHM_VERSION,
    sets,
    table,
    conflicts,
    ll1: conflicts.length === 0,
    diagnostics: {
      unreachable: g.nonterminals.filter((a) => !reachable.has(a)).sort(),
      nonProductive: g.nonterminals.filter((a) => !productive.has(a)).sort(),
    },
  };
}
