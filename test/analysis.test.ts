import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { validateGrammar } from "../src/validate.js";
import { analyze } from "../src/analysis.js";
import { buildTable, diagnose } from "../src/table.js";
import { GrammarStore } from "../src/store.js";
import { EOF, EPSILON, GrammarError } from "../src/types.js";

const load = (name: string) =>
  validateGrammar(JSON.parse(readFileSync(path.join(process.cwd(), "examples", name), "utf8")));

// ---------- 示例 1：含可空链的表达式文法（手工预期） ----------
test("表达式文法：可空 / FIRST / FOLLOW 与手工结果一致", () => {
  const g = load("expr-nullable.json");
  const a = analyze(g);
  assert.deepEqual(a.nullable, ["ExprRest", "TermRest"]);
  assert.deepEqual(a.first.Expr, ["ID", "LPAREN"]);
  assert.deepEqual(a.first.Term, ["ID", "LPAREN"]);
  assert.deepEqual(a.first.Factor, ["ID", "LPAREN"]);
  assert.deepEqual(a.first.ExprRest, [EPSILON, "PLUS"].sort());
  assert.deepEqual(a.first.TermRest, [EPSILON, "MUL"].sort());
  assert.deepEqual(a.follow.Expr, [EOF, "RPAREN"].sort());
  assert.deepEqual(a.follow.ExprRest, [EOF, "RPAREN"].sort());
  assert.deepEqual(a.follow.Term, [EOF, "PLUS", "RPAREN"].sort());
  assert.deepEqual(a.follow.TermRest, [EOF, "PLUS", "RPAREN"].sort());
  assert.deepEqual(a.follow.Factor, [EOF, "MUL", "PLUS", "RPAREN"].sort());
  // 无冲突
  const { conflicts } = buildTable(g, a);
  assert.equal(conflicts.length, 0);
});

test("表达式文法：多字符标识符不被拆成单字符", () => {
  const g = load("expr-nullable.json");
  const a = analyze(g);
  assert.ok(a.first.Expr.includes("LPAREN"));
  assert.ok(!a.first.Expr.includes("L"));
});

// ---------- 示例 2：共同前缀 FIRST/FIRST 冲突 ----------
test("共同前缀文法：报告 FIRST_FIRST 冲突并保留全部候选", () => {
  const g = load("common-prefix.json");
  const a = analyze(g);
  const { table, conflicts } = buildTable(g, a);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, "FIRST_FIRST");
  assert.equal(conflicts[0].nonTerminal, "S");
  assert.equal(conflicts[0].terminal, "a");
  assert.deepEqual(conflicts[0].candidates.map((c) => c.production), [0, 1]);
  assert.equal(table.S["a"].length, 2); // 不静默选第一条
});

// ---------- 示例 3：FOLLOW 引起的 FIRST/FOLLOW 冲突 ----------
test("FOLLOW 冲突文法：报告 FIRST_FOLLOW 冲突", () => {
  const g = load("follow-conflict.json");
  const a = analyze(g);
  assert.deepEqual(a.follow.A, ["a"]);
  const { conflicts } = buildTable(g, a);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, "FIRST_FOLLOW");
  assert.deepEqual(conflicts[0].candidates.map((c) => c.source).sort(), ["first", "follow"]);
});

// ---------- 固定点与结构性质 ----------
test("循环依赖不会死循环且结果稳定", () => {
  const g = validateGrammar({
    terminals: ["b"],
    nonTerminals: ["S", "A", "B"],
    start: "S",
    productions: [
      { lhs: "S", rhs: ["A"] },
      { lhs: "A", rhs: ["B"] },
      { lhs: "B", rhs: ["A"] },
      { lhs: "B", rhs: ["b"] },
    ],
  });
  const a1 = analyze(g);
  const a2 = analyze(g); // 再次运行：固定点不变
  assert.deepEqual(a1, a2);
  assert.deepEqual(a1.first.S, ["b"]);
  assert.deepEqual(a1.follow.A, a1.follow.B);
});

test("全可空右部：FIRST 含空串，FOLLOW 沿可空后缀传播", () => {
  const g = validateGrammar({
    terminals: [],
    nonTerminals: ["S", "A", "B"],
    start: "S",
    productions: [
      { lhs: "S", rhs: ["A", "B"] },
      { lhs: "A", rhs: [] },
      { lhs: "B", rhs: [] },
    ],
  });
  const a = analyze(g);
  assert.deepEqual(a.nullable, ["A", "B", "S"]);
  assert.deepEqual(a.first.S, [EPSILON]);
  assert.deepEqual(a.follow.A, [EOF]);
  assert.deepEqual(a.follow.B, [EOF]);
});

test("开始符号不在首条产生式时 FOLLOW 仍含结束标记", () => {
  const g = validateGrammar({
    terminals: ["x", "y"],
    nonTerminals: ["S", "X"],
    start: "S",
    productions: [
      { lhs: "X", rhs: ["x"] },
      { lhs: "S", rhs: ["y"] },
    ],
  });
  const a = analyze(g);
  assert.deepEqual(a.follow.S, [EOF]);
});

test("FOLLOW 永不包含空串", () => {
  for (const name of ["expr-nullable.json", "common-prefix.json", "follow-conflict.json"]) {
    const a = analyze(load(name));
    for (const n of Object.keys(a.follow)) {
      assert.ok(!a.follow[n].includes(EPSILON), `${name}: FOLLOW(${n}) 含空串`);
    }
  }
});

test("输入条目重排不改变集合与冲突候选", () => {
  const g1 = load("expr-nullable.json");
  const g2 = validateGrammar({
    terminals: [...g1.terminals].reverse(),
    nonTerminals: [...g1.nonTerminals].reverse(),
    start: g1.start,
    productions: [...g1.productions].reverse(),
  });
  const a1 = analyze(g1);
  const a2 = analyze(g2);
  assert.deepEqual(a1.nullable, a2.nullable);
  assert.deepEqual(a1.first, a2.first);
  assert.deepEqual(a1.follow, a2.follow);
  const c1 = buildTable(g1, a1).conflicts.map((c) => [c.nonTerminal, c.terminal, c.kind, c.candidates.length]);
  const c2 = buildTable(g2, a2).conflicts.map((c) => [c.nonTerminal, c.terminal, c.kind, c.candidates.length]);
  assert.deepEqual(c1, c2);
});

test("不可达与不可生成非终结符独立诊断", () => {
  const g = validateGrammar({
    terminals: ["a", "z"],
    nonTerminals: ["S", "Z", "NG"],
    start: "S",
    productions: [
      { lhs: "S", rhs: ["a"] },
      { lhs: "Z", rhs: ["z"] },   // 不可达
      { lhs: "NG", rhs: ["NG", "a"] }, // 不可生成（左递归无出口）
    ],
  });
  const d = diagnose(g);
  assert.deepEqual(d.unreachable, ["NG", "Z"]);
  assert.deepEqual(d.nonGenerating, ["NG"]);
});

// ---------- 来源解释 ----------
test("来源解释：元素可追溯到产生式", () => {
  const g = load("follow-conflict.json");
  const a = analyze(g);
  assert.equal(a.provenance.follow.A["a"].production, 0);
  assert.ok(a.provenance.follow.A["a"].reason.includes("S -> A a"));
  assert.equal(a.provenance.nullable.A.production, 3);
  assert.equal(a.provenance.first.S["b"].production, 1);
});

// ---------- 校验规则 ----------
test("校验：未声明符号 / 重名 / 缺开始符号 / 重复产生式 / 保留符号", () => {
  const base = { terminals: ["a"], nonTerminals: ["S"], start: "S", productions: [{ lhs: "S", rhs: ["a"] }] };
  assert.throws(() => validateGrammar({ ...base, productions: [{ lhs: "S", rhs: ["nope"] }] }),
    (e: GrammarError) => e.code === "UNDECLARED_SYMBOL");
  assert.throws(() => validateGrammar({ ...base, terminals: ["a", "S"] }),
    (e: GrammarError) => e.code === "SYMBOL_KIND_CONFLICT");
  assert.throws(() => validateGrammar({ ...base, start: "Missing" }),
    (e: GrammarError) => e.code === "MISSING_START_SYMBOL");
  assert.throws(() => validateGrammar({ ...base, productions: [...base.productions, ...base.productions] }),
    (e: GrammarError) => e.code === "DUPLICATE_PRODUCTION");
  assert.throws(() => validateGrammar({ ...base, terminals: ["a", EOF] }),
    (e: GrammarError) => e.code === "RESERVED_SYMBOL");
  assert.throws(() => validateGrammar({ ...base, terminals: ["a", "a"] }),
    (e: GrammarError) => e.code === "DUPLICATE_SYMBOL");
});

// ---------- 存储：不可变版本与修改产生式产生新版本 ----------
test("存储：相同文法幂等，修改产生式产生新版本，旧报告仍对应原文法", async () => {
  const fs = await import("node:fs");
  const tmp = path.join(process.cwd(), "data", `test-${Date.now()}.db`);
  const store = new GrammarStore(tmp);
  const g1 = load("follow-conflict.json");
  const idA1 = store.import(g1);
  const idA2 = store.import(g1);
  assert.equal(idA1.id, idA2.id);
  assert.equal(idA2.created, false);

  const g2 = JSON.parse(JSON.stringify(g1)) as typeof g1;
  g2.terminals.push("c");
  g2.terminals.sort();
  g2.productions = g2.productions.map((p) => (p.lhs === "A" && p.rhs.join(" ") === "a" ? { lhs: "A", rhs: ["c"] } : p));
  const idB = store.import(validateGrammar(g2));
  assert.notEqual(idA1.id, idB.id);

  // 旧表仍对应原文法
  assert.equal(store.getReport(idA1.id)!.conflicts.length, 1);
  assert.equal(store.getReport(idB.id)!.conflicts.length, 0);

  const diff = store.diff(idA1.id, idB.id)!;
  assert.deepEqual(diff.addedProductions, ["A -> c"]);
  assert.deepEqual(diff.removedProductions, ["A -> a"]);
  assert.equal(diff.conflictsBefore, 1);
  assert.equal(diff.conflictsAfter, 0);
  assert.equal(diff.conflictsResolved.length, 1);

  store.close();
  fs.unlinkSync(tmp);
});
