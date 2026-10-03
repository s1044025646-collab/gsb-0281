import { createHash } from "node:crypto";
import { ENDMARKER, Grammar, GrammarInput, Production, ValidationIssue } from "./types.js";
import { LIMITS } from "./limits.js";

// 符号是“完整词法单元”：允许多字符标识符，也允许 + ( 等标点终结符；
// 但不允许空白（防止把 "a b" 当成一个符号）。$ 与 ε 为系统保留。
const TOKEN_RE = /^\S+$/;

/**
 * 基本校验规则：
 * - 未声明符号 -> UNDECLARED_SYMBOL
 * - 终结符与非终结符重名 -> OVERLAP_SYMBOL
 * - 同类别内重复声明 -> DUP_SYMBOL（拒绝，不静默去重）
 * - 缺失/非法开始符号 -> MISSING_START / START_NOT_NONTERMINAL
 * - 重复产生式 -> DUP_PRODUCTION（拒绝，不静默丢弃）
 * - 保留符号 $ 不可声明
 */
export function validateGrammar(input: unknown): { issues: ValidationIssue[]; grammar?: Grammar } {
  const issues: ValidationIssue[] = [];

  if (typeof input !== "object" || input === null) {
    return { issues: [{ code: "SYNTAX_INVALID_JSON", message: "输入必须是 JSON 对象" }] };
  }
  const obj = input as Partial<GrammarInput>;

  for (const field of ["terminals", "nonterminals", "productions"] as const) {
    if (!Array.isArray(obj[field])) {
      issues.push({ code: "MISSING_FIELD", message: `字段 ${field} 必须是数组`, location: { field } });
    }
  }
  if (obj.startSymbol === undefined || obj.startSymbol === null) {
    issues.push({ code: "MISSING_START", message: "缺少开始符号 startSymbol" });
  }
  if (issues.length > 0) return { issues };

  const terminals = obj.terminals as unknown[];
  const nonterminals = obj.nonterminals as unknown[];
  const productions = obj.productions as unknown[];

  if (terminals.length > LIMITS.maxTerminals)
    issues.push(limitIssue(`终结符数量 ${terminals.length} 超过上限 ${LIMITS.maxTerminals}`));
  if (nonterminals.length > LIMITS.maxNonterminals)
    issues.push(limitIssue(`非终结符数量 ${nonterminals.length} 超过上限 ${LIMITS.maxNonterminals}`));
  if (productions.length > LIMITS.maxProductions)
    issues.push(limitIssue(`产生式数量 ${productions.length} 超过上限 ${LIMITS.maxProductions}`));

  const checkSym = (s: unknown, where: Record<string, unknown>): string | undefined => {
    if (typeof s !== "string" || s.length === 0) {
      issues.push({ code: "INVALID_SYMBOL", message: "符号必须是非空字符串", location: where });
      return;
    }
    if (s.length > LIMITS.maxSymbolLength) {
      issues.push({ code: "INVALID_SYMBOL", message: `符号 ${s} 超过长度上限`, location: where });
      return;
    }
    if (s === ENDMARKER || s === "ε") {
      issues.push({
        code: "RESERVED_SYMBOL",
        message: `符号 ${s} 为系统保留符号（$ 结束标记 / ε 空串标记）`,
        location: where,
      });
      return;
    }
    if (!TOKEN_RE.test(s)) {
      issues.push({ code: "INVALID_SYMBOL", message: `符号 ${s} 不合法：符号为完整词法单元，不能含空白`, location: where });
      return;
    }
    return s;
  };

  const termList: string[] = [];
  const nontermList: string[] = [];
  const termSeen = new Set<string>();
  const nonSeen = new Set<string>();

  for (const raw of terminals) {
    const s = checkSym(raw, { list: "terminals" });
    if (!s) continue;
    if (termSeen.has(s)) {
      issues.push({ code: "DUP_SYMBOL", message: `终结符重复声明：${s}`, location: { symbol: s } });
    }
    termSeen.add(s);
    termList.push(s);
  }
  for (const raw of nonterminals) {
    const s = checkSym(raw, { list: "nonterminals" });
    if (!s) continue;
    if (nonSeen.has(s)) {
      issues.push({ code: "DUP_SYMBOL", message: `非终结符重复声明：${s}`, location: { symbol: s } });
    }
    nonSeen.add(s);
    nontermList.push(s);
  }
  for (const t of termList) {
    if (nonSeen.has(t)) {
      issues.push({
        code: "OVERLAP_SYMBOL",
        message: `终结符与非终结符重名：${t}`,
        location: { symbol: t },
      });
    }
  }

  const start = obj.startSymbol;
  if (typeof start !== "string" || start.length === 0) {
    issues.push({ code: "MISSING_START", message: "开始符号必须是非空字符串" });
  } else if (!nonSeen.has(start)) {
    issues.push({ code: "START_NOT_NONTERMINAL", message: `开始符号 ${start} 不在非终结符列表中`, location: { symbol: start } });
  }

  if (nontermList.length === 0) {
    issues.push({ code: "EMPTY_GRAMMAR", message: "文法至少需要一个非终结符" });
  }

  const prodList: Production[] = [];
  const prodSeen = new Set<string>();
  productions.forEach((raw, i) => {
    const loc = { list: "productions", index: i };
    if (typeof raw !== "object" || raw === null) {
      issues.push({ code: "INVALID_SYMBOL", message: `第 ${i} 条产生式必须是对象 {lhs,rhs}`, location: loc });
      return;
    }
    const p = raw as Partial<Production>;
    if (typeof p.lhs !== "string") {
      issues.push({ code: "INVALID_SYMBOL", message: `第 ${i} 条产生式缺少左部 lhs`, location: loc });
      return;
    }
    if (!Array.isArray(p.rhs)) {
      issues.push({ code: "INVALID_SYMBOL", message: `第 ${i} 条产生式右部 rhs 必须是数组（空数组表示空产生式）`, location: loc });
      return;
    }
    if (p.rhs.length > LIMITS.maxRhsLength) {
      issues.push({ code: "LIMIT_EXCEEDED", message: `第 ${i} 条产生式右部超过长度上限`, location: loc });
      return;
    }
    if (!nonSeen.has(p.lhs)) {
      issues.push({ code: "UNDECLARED_SYMBOL", message: `第 ${i} 条产生式左部 ${p.lhs} 未声明为非终结符`, location: { ...loc, symbol: p.lhs } });
    }
    for (const sym of p.rhs) {
      if (typeof sym !== "string" || (!termSeen.has(sym) && !nonSeen.has(sym))) {
        issues.push({ code: "UNDECLARED_SYMBOL", message: `第 ${i} 条产生式引用未声明符号：${String(sym)}`, location: { ...loc, symbol: sym } });
      }
    }
    const key = `${p.lhs}=>${p.rhs.join(" ")}`;
    if (prodSeen.has(key)) {
      issues.push({ code: "DUP_PRODUCTION", message: `重复产生式：${p.lhs} -> ${p.rhs.join(" ") || "ε"}`, location: loc });
    }
    prodSeen.add(key);
    prodList.push({ lhs: p.lhs, rhs: [...p.rhs] });
  });

  if (issues.length > 0) return { issues };

  // 规范化：终结符/非终结符按标识符排序；产生式按 (lhs, rhs) 排序，
  // 使输入条目重排不会改变集合、下标与冲突候选。
  const canonProds = prodList
    .map((p) => ({ lhs: p.lhs, rhs: [...p.rhs] }))
    .sort((a, b) => {
      if (a.lhs !== b.lhs) return a.lhs < b.lhs ? -1 : 1;
      const ra = a.rhs.join(" ");
      const rb = b.rhs.join(" ");
      return ra < rb ? -1 : ra > rb ? 1 : 0;
    });

  const grammar: Grammar = {
    id: "",
    terminals: termList.sort(),
    nonterminals: nontermList.sort(),
    startSymbol: start as string,
    productions: canonProds,
    algorithmVersion: 1,
    createdAt: new Date(0).toISOString(),
  };
  grammar.id = computeGrammarId(grammar);
  grammar.createdAt = new Date().toISOString();
  return { issues: [], grammar };
}

/**
 * 文法内容指纹：符号与产生式重排不改变 id（集合与冲突候选也因此保持不变）。
 * 规范化：终结符/非终结符按标识符排序，产生式按 (lhs, rhs) 排序后再哈希。
 */
export function computeGrammarId(g: GrammarInput): string {
  const terminals = [...g.terminals].sort();
  const nonterminals = [...g.nonterminals].sort();
  const prods = g.productions
    .map((p) => ({ lhs: p.lhs, rhs: [...p.rhs] }))
    .sort((a, b) => {
      if (a.lhs !== b.lhs) return a.lhs < b.lhs ? -1 : 1;
      const ra = a.rhs.join(" ");
      const rb = b.rhs.join(" ");
      return ra < rb ? -1 : ra > rb ? 1 : 0;
    });
  const payload = JSON.stringify({ terminals, nonterminals, startSymbol: g.startSymbol, productions: prods });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function limitIssue(message: string): ValidationIssue {
  return { code: "LIMIT_EXCEEDED", message };
}
