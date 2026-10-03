import { AnalysisResult, EOF, EPSILON, Grammar, Provenance } from "./types.js";

interface SetState {
  values: Set<string>;
  prov: Map<string, Provenance>;
}

function newState(): SetState {
  return { values: new Set(), prov: new Map() };
}

/** 向集合添加元素；返回是否发生了变化。首次加入时记录来源。 */
function add(state: SetState, element: string, prov: Provenance): boolean {
  if (state.values.has(element)) return false;
  state.values.add(element);
  state.prov.set(element, prov);
  return true;
}

const fmt = (lhs: string, rhs: string[]) => `${lhs} -> ${rhs.length ? rhs.join(" ") : EPSILON}`;

/**
 * 以固定点迭代计算可空集合、FIRST、FOLLOW，并记录每个元素的来源产生式。
 * 迭代直到任何集合都不再增长为止，相互递归不会导致死循环（集合单调有界）。
 */
export function analyze(grammar: Grammar): AnalysisResult {
  const { productions, nonTerminals, terminals, start } = grammar;
  const isTerminal = new Set(terminals);

  // ---- 可空集合 ----
  const nullable = new Set<string>();
  const nullableProv = new Map<string, Provenance>();
  let changed = true;
  while (changed) {
    changed = false;
    productions.forEach((p, i) => {
      if (nullable.has(p.lhs)) return;
      if (p.rhs.every((s) => !isTerminal.has(s) && nullable.has(s))) {
        nullable.add(p.lhs);
        nullableProv.set(p.lhs, {
          production: i,
          reason: p.rhs.length === 0
            ? `${fmt(p.lhs, p.rhs)} 是空产生式`
            : `${fmt(p.lhs, p.rhs)} 右部全部符号可空`,
        });
        changed = true;
      }
    });
  }

  // ---- FIRST ----
  const first = new Map<string, SetState>();
  for (const n of nonTerminals) first.set(n, newState());
  const firstOfTerminal = (t: string) => t; // 终结符的 FIRST 是其自身

  changed = true;
  while (changed) {
    changed = false;
    productions.forEach((p, i) => {
      const target = first.get(p.lhs)!;
      if (p.rhs.length === 0) {
        if (add(target, EPSILON, { production: i, reason: `${fmt(p.lhs, p.rhs)} 是空产生式` })) changed = true;
        return;
      }
      // 沿可空前缀继续累加
      for (let k = 0; k < p.rhs.length; k++) {
        const sym = p.rhs[k];
        if (isTerminal.has(sym)) {
          if (add(target, firstOfTerminal(sym), { production: i, reason: `${fmt(p.lhs, p.rhs)} 右部第 ${k + 1} 个符号是终结符 ${sym}，且前缀可空` })) changed = true;
          break; // 终结符不可空，停止
        }
        const sub = first.get(sym)!;
        for (const v of sub.values) {
          if (v === EPSILON) continue;
          if (add(target, v, { production: i, reason: `${fmt(p.lhs, p.rhs)} 右部第 ${k + 1} 个符号 ${sym} 的 FIRST（前缀可空）` })) changed = true;
        }
        if (!nullable.has(sym)) break;
      }
      // 整段右部可空才包含空串
      if (p.rhs.every((s) => !isTerminal.has(s) && nullable.has(s))) {
        if (add(target, EPSILON, { production: i, reason: `${fmt(p.lhs, p.rhs)} 右部整段可空` })) changed = true;
      }
    });
  }

  // ---- FOLLOW ----
  const follow = new Map<string, SetState>();
  for (const n of nonTerminals) follow.set(n, newState());
  add(follow.get(start)!, EOF, { production: -1, reason: `${start} 是开始符号，FOLLOW 包含结束标记 ${EOF}` });

  changed = true;
  while (changed) {
    changed = false;
    productions.forEach((p, i) => {
      // 对每个右部位置的非终结符 B，考察其后缀 β
      for (let k = 0; k < p.rhs.length; k++) {
        const B = p.rhs[k];
        if (isTerminal.has(B)) continue;
        const target = follow.get(B)!;
        const suffix = p.rhs.slice(k + 1);
        // 加入 FIRST(β) 的非空符号
        let suffixNullable = true;
        for (const sym of suffix) {
          if (isTerminal.has(sym)) {
            if (add(target, sym, { production: i, reason: `${fmt(p.lhs, p.rhs)} 中 ${B} 的后缀以终结符 ${sym} 开头（前缀可空）` })) changed = true;
            suffixNullable = false;
            break;
          }
          const sub = first.get(sym)!;
          for (const v of sub.values) {
            if (v === EPSILON) continue;
            if (add(target, v, { production: i, reason: `${fmt(p.lhs, p.rhs)} 中 ${B} 的后缀符号 ${sym} 的 FIRST（前缀可空）` })) changed = true;
          }
          if (!nullable.has(sym)) { suffixNullable = false; break; }
        }
        // 后缀可空（含空后缀）时传播 FOLLOW(左部)
        if (suffixNullable) {
          for (const v of follow.get(p.lhs)!.values) {
            // FOLLOW 永不包含空串；values 里本就不会有 ε，这里只是防御
            if (v === EPSILON) continue;
            if (add(target, v, { production: i, reason: `${fmt(p.lhs, p.rhs)} 中 ${B} 的后缀可空，传播 FOLLOW(${p.lhs})` })) changed = true;
          }
        }
      }
    });
  }

  const toSortedRecord = (m: Map<string, SetState>) => {
    const out: Record<string, string[]> = {};
    for (const [k, s] of [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out[k] = [...s.values].sort();
    }
    return out;
  };
  const toProvRecord = (m: Map<string, SetState>) => {
    const out: Record<string, Record<string, Provenance>> = {};
    for (const [k, s] of m) {
      out[k] = Object.fromEntries([...s.prov.entries()].sort((a, b) => a[0].localeCompare(b[0])));
    }
    return out;
  };

  return {
    nullable: [...nullable].sort(),
    first: toSortedRecord(first),
    follow: toSortedRecord(follow),
    provenance: {
      nullable: Object.fromEntries([...nullableProv.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
      first: toProvRecord(first),
      follow: toProvRecord(follow),
    },
  };
}
