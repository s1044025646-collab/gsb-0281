import { EOF, Grammar, GrammarError, LIMITS, Production } from "./types.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fail(code: string, message: string, details?: unknown): never {
  throw new GrammarError(code, message, details);
}

/** 校验并规范化文法输入；不修改语义，发现重复产生式直接拒绝。 */
export function validateGrammar(input: unknown): Grammar {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("INVALID_SHAPE", "文法必须是 JSON 对象");
  }
  const g = input as Record<string, unknown>;

  for (const key of ["terminals", "nonTerminals", "start", "productions"]) {
    if (!(key in g)) fail("INVALID_SHAPE", `缺少必需字段: ${key}`);
  }
  if (!Array.isArray(g.terminals) || !Array.isArray(g.nonTerminals)) {
    fail("INVALID_SHAPE", "terminals 与 nonTerminals 必须是字符串数组");
  }
  const terminals = g.terminals as unknown[];
  const nonTerminals = g.nonTerminals as unknown[];

  const checkSymbol = (s: unknown, where: string): string => {
    if (typeof s !== "string" || s.length === 0) fail("INVALID_SYMBOL", `${where}: 符号必须是非空字符串`);
    if (s === EOF) fail("RESERVED_SYMBOL", `${where}: "${EOF}" 是系统保留的输入结束标记`);
    if (!IDENT.test(s)) fail("INVALID_SYMBOL", `${where}: 非法标识符 "${s}"（需匹配 ${IDENT}）`);
    return s;
  };

  const termSet = new Set<string>();
  for (const t of terminals) {
    const s = checkSymbol(t, "terminals");
    if (termSet.has(s)) fail("DUPLICATE_SYMBOL", `终结符重复声明: ${s}`);
    termSet.add(s);
  }
  const nonTermSet = new Set<string>();
  for (const n of nonTerminals) {
    const s = checkSymbol(n, "nonTerminals");
    if (nonTermSet.has(s)) fail("DUPLICATE_SYMBOL", `非终结符重复声明: ${s}`);
    if (termSet.has(s)) fail("SYMBOL_KIND_CONFLICT", `符号同时声明为终结符与非终结符: ${s}`);
    nonTermSet.add(s);
  }

  if (termSet.size + nonTermSet.size > LIMITS.maxSymbols) {
    fail("LIMIT_EXCEEDED", `符号总数超过上限 ${LIMITS.maxSymbols}`);
  }

  if (typeof g.start !== "string" || g.start.length === 0) {
    fail("MISSING_START_SYMBOL", "缺少开始符号 start");
  }
  const start = g.start;
  if (!nonTermSet.has(start)) {
    if (termSet.has(start)) fail("START_IS_TERMINAL", `开始符号 "${start}" 被声明为终结符`);
    fail("MISSING_START_SYMBOL", `开始符号 "${start}" 未在 nonTerminals 中声明`);
  }

  if (!Array.isArray(g.productions)) fail("INVALID_SHAPE", "productions 必须是数组");
  if (g.productions.length > LIMITS.maxProductions) {
    fail("LIMIT_EXCEEDED", `产生式数量超过上限 ${LIMITS.maxProductions}`);
  }

  const productions: Production[] = [];
  const seen = new Set<string>();
  g.productions.forEach((p, i) => {
    if (typeof p !== "object" || p === null) fail("INVALID_SHAPE", `产生式 #${i} 必须是对象`);
    const prod = p as Record<string, unknown>;
    if (typeof prod.lhs !== "string") fail("INVALID_SHAPE", `产生式 #${i} 缺少 lhs`);
    if (!nonTermSet.has(prod.lhs)) {
      fail("UNDECLARED_SYMBOL", `产生式 #${i} 左部 "${prod.lhs}" 不是已声明的非终结符`);
    }
    if (!Array.isArray(prod.rhs)) fail("INVALID_SHAPE", `产生式 #${i} 的 rhs 必须是符号数组（空数组表示空产生式）`);
    if (prod.rhs.length > LIMITS.maxRhsLength) {
      fail("LIMIT_EXCEEDED", `产生式 #${i} 右部长度超过上限 ${LIMITS.maxRhsLength}`);
    }
    const rhs = (prod.rhs as unknown[]).map((s) => {
      const sym = checkSymbol(s, `产生式 #${i} rhs`);
      if (!termSet.has(sym) && !nonTermSet.has(sym)) {
        fail("UNDECLARED_SYMBOL", `产生式 #${i} 右部符号 "${sym}" 未声明`, { production: i, symbol: sym });
      }
      return sym;
    });
    const key = `${prod.lhs} -> ${rhs.join(" ")}`;
    if (seen.has(key)) fail("DUPLICATE_PRODUCTION", `重复产生式: ${key}`, { production: i });
    seen.add(key);
    productions.push({ lhs: prod.lhs, rhs });
  });

  return {
    terminals: [...termSet].sort(),
    nonTerminals: [...nonTermSet].sort(),
    start,
    productions,
  };
}
