import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateGrammar } from "../core/validate.js";
import { analyze } from "../core/analyzer.js";
import { GrammarService } from "../core/service.js";
import { Store } from "../core/storage.js";
import { GrammarInput } from "../core/types.js";

const load = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, "..", "..", "examples", name), "utf8"));

function analyzeInput(input: unknown) {
  const { issues, grammar } = validateGrammar(input);
  assert.equal(issues.length, 0, JSON.stringify(issues));
  return { grammar: grammar!, report: analyze(grammar!) };
}

test("表达式文法：手工核对可空链 / FIRST / FOLLOW", () => {
  const { grammar, report } = analyzeInput(load("expression.json"));
  const { nullable, first, follow } = report.sets;

  assert.deepEqual(nullable, ["E'", "T'"]);
  assert.deepEqual(first["E'"], ["+", "ε"]);
  assert.deepEqual(first["T'"], ["*", "ε"]);
  assert.deepEqual(first["E"], ["(", "id"]);
  assert.deepEqual(first["T"], ["(", "id"]);
  assert.deepEqual(first["F"], ["(", "id"]);
  // FOLLOW 中绝不出现 ε
  for (const a of grammar.nonterminals) assert.ok(!follow[a]!.includes("ε"));
  assert.deepEqual(follow["E"], ["$", ")"]);
  assert.deepEqual(follow["E'"], ["$", ")"]);
  assert.deepEqual(follow["T"], ["$", ")", "+"]);
  assert.deepEqual(follow["T'"], ["$", ")", "+"]);
  assert.deepEqual(follow["F"], ["$", ")", "*", "+"]);
  assert.equal(report.ll1, true);
  assert.deepEqual(report.conflicts, []);
});

test("表达式文法：手工核对预测表关键格子", () => {
  const { report } = analyzeInput(load("expression.json"));
  const t = report.table;
  // 规范化按 (lhs,rhs) 排序：E 0；E' 1(ε),2(+)；F 3((),4(id)；T 5；T' 6(ε),7(*)。
  assert.deepEqual(t["F"]!["id"]!.map((e) => e.productionIndex), [4]);
  assert.deepEqual(t["F"]!["("]!.map((e) => e.productionIndex), [3]);
  assert.deepEqual(t["T'"]!["+"]!, [{ productionIndex: 6, source: "follow" }]);
  assert.deepEqual(t["E'"]![")"]!, [{ productionIndex: 1, source: "follow" }]);
});

test("共同前缀：FIRST_OVERLAP 冲突", () => {
  const { report } = analyzeInput(load("common-prefix.json"));
  assert.equal(report.ll1, false);
  const c = report.conflicts;
  assert.equal(c.length, 1);
  assert.deepEqual(
    { nt: c[0]!.nonterminal, t: c[0]!.terminal, kind: c[0]!.kind },
    { nt: "A", t: "a", kind: "FIRST_OVERLAP" },
  );
  // 规范化后两条 A 产生式排为 0、1
  assert.deepEqual(c[0]!.candidates.map((x) => x.productionIndex), [0, 1]);
});

test("FOLLOW 引起：FIRST_FOLLOW_EPSILON 冲突（悬空 else 型）", () => {
  const { report } = analyzeInput(load("follow-epsilon.json"));
  assert.deepEqual(report.sets.nullable, ["A"]);
  assert.deepEqual(report.sets.follow["A"], ["b"]);
  const kinds = new Map(report.conflicts.map((c) => [`${c.nonterminal},${c.terminal}`, c.kind]));
  assert.equal(kinds.get("A,b"), "FIRST_FOLLOW_EPSILON");
});

test("两条空产生式：FOLLOW_EPSILON 冲突", () => {
  const input: GrammarInput = {
    terminals: ["a", "b"],
    nonterminals: ["S", "A"],
    startSymbol: "S",
    productions: [
      { lhs: "S", rhs: ["A", "a"] },
      { lhs: "A", rhs: [] },
      { lhs: "A", rhs: ["B"] },
    ],
  };
  // B 未声明会被拒，改用两个都可空的非终结符写法
  const g2: GrammarInput = {
    terminals: ["a"],
    nonterminals: ["S", "A", "B"],
    startSymbol: "S",
    productions: [
      { lhs: "S", rhs: ["A"] },
      { lhs: "A", rhs: ["B"] },
      { lhs: "B", rhs: [] },
      { lhs: "A", rhs: [] },
    ],
  };
  const { report } = analyzeInput(g2);
  const cell = report.conflicts.find((c) => c.nonterminal === "A" && c.terminal === "$");
  assert.ok(cell, "A 在 $ 处应有两条可空候选");
  assert.equal(cell!.kind, "FOLLOW_EPSILON");
  void input;
});

test("全可空右部与相互递归：固定点收敛且判定可空", () => {
  const input: GrammarInput = {
    terminals: ["x"],
    nonterminals: ["A", "B", "C"],
    startSymbol: "A",
    productions: [
      { lhs: "A", rhs: ["B"] },
      { lhs: "B", rhs: ["C"] },
      { lhs: "C", rhs: [] },
    ],
  };
  const { report } = analyzeInput(input);
  assert.deepEqual(report.sets.nullable, ["A", "B", "C"]);
  assert.deepEqual(report.sets.first["A"], ["ε"]);
  assert.deepEqual(report.sets.follow["A"], ["$"]);
  assert.deepEqual(report.sets.follow["B"], ["$"]);
  assert.deepEqual(report.sets.follow["C"], ["$"]);
});

test("不可达与不可生成终结符串：独立诊断", () => {
  const input: GrammarInput = {
    terminals: ["a", "b"],
    nonterminals: ["S", "U", "N"],
    startSymbol: "S",
    productions: [
      { lhs: "S", rhs: ["a"] },
      { lhs: "U", rhs: ["b"] }, // 不可达，但可生成
      { lhs: "N", rhs: ["N", "a"] }, // 可达性之外，不能生成终结符串
    ],
  };
  const { report } = analyzeInput(input);
  assert.deepEqual(report.diagnostics.unreachable, ["N", "U"]);
  assert.deepEqual(report.diagnostics.nonProductive, ["N"]);
});

test("开始符号不在首条产生式也能正确加入结束标记", () => {
  const input: GrammarInput = {
    terminals: ["a", "b"],
    nonterminals: ["X", "Start"],
    startSymbol: "Start",
    productions: [
      { lhs: "X", rhs: ["b"] },
      { lhs: "Start", rhs: ["a"] },
    ],
  };
  const { report } = analyzeInput(input);
  assert.deepEqual(report.sets.follow["Start"], ["$"]);
  assert.deepEqual(report.diagnostics.unreachable, ["X"]);
});

test("多字符标识符不被拆成单字符", () => {
  const input: GrammarInput = {
    terminals: ["num", "plus"],
    nonterminals: ["Expr", "Tail"],
    startSymbol: "Expr",
    productions: [
      { lhs: "Expr", rhs: ["num", "Tail"] },
      { lhs: "Tail", rhs: ["plus", "num", "Tail"] },
      { lhs: "Tail", rhs: [] },
    ],
  };
  const { report } = analyzeInput(input);
  assert.deepEqual(report.sets.first["Expr"], ["num"]);
  assert.deepEqual(report.sets.first["Tail"], ["plus", "ε"]);
  assert.deepEqual(report.sets.follow["Expr"], ["$"]);
  assert.deepEqual(report.sets.follow["Tail"], ["$"]);
});

test("再迭代一轮不改变固定点结果", () => {
  const { grammar, report } = analyzeInput(load("expression.json"));
  const again = analyze(grammar);
  assert.deepEqual(again.sets, report.sets);
  assert.deepEqual(again.table, report.table);
  assert.deepEqual(again.conflicts, report.conflicts);
});

test("输入条目重排不改变集合、id 与冲突候选", () => {
  const a = load("common-prefix.json") as GrammarInput;
  const b: GrammarInput = {
    terminals: [...a.terminals].reverse(),
    nonterminals: [...a.nonterminals].reverse(),
    startSymbol: a.startSymbol,
    productions: [...a.productions].reverse().map((p) => ({ lhs: p.lhs, rhs: [...p.rhs].reverse() })) as GrammarInput["productions"],
  };
  // rhs 反转会改变语义，这里仅重排产生式顺序与符号声明顺序，不改右部内容
  b.productions = [...a.productions].reverse();
  const ga = validateGrammar(a).grammar!;
  const gb = validateGrammar(b).grammar!;
  assert.equal(ga.id, gb.id);
  const ra = analyze(ga);
  const rb = analyze(gb);
  assert.deepEqual(ra.sets, rb.sets);
  assert.deepEqual(ra.conflicts, rb.conflicts);
});

test("校验：未声明/重名/缺失开始/重复产生式", () => {
  const base = load("common-prefix.json") as GrammarInput;
  assert.equal(validateGrammar({ ...base, terminals: [...base.terminals, "A"] }).issues[0]!.code, "OVERLAP_SYMBOL");
  assert.equal(validateGrammar({ ...base, startSymbol: "Z" }).issues[0]!.code, "START_NOT_NONTERMINAL");
  assert.equal(validateGrammar({ ...base, startSymbol: "a" }).issues[0]!.code, "START_NOT_NONTERMINAL");
  assert.equal(
    validateGrammar({ ...base, productions: [...base.productions, base.productions[0]!] }).issues[0]!.code,
    "DUP_PRODUCTION",
  );
  assert.equal(
    validateGrammar({ ...base, productions: [{ lhs: "S", rhs: ["nope"] }] }).issues[0]!.code,
    "UNDECLARED_SYMBOL",
  );
  assert.equal(validateGrammar({ ...base, terminals: [...base.terminals, "$"] }).issues.some((i) => i.code === "RESERVED_SYMBOL"), true);
});

test("来源解释：可空链与 FIRST 传播", () => {
  const { grammar, report } = analyzeInput(load("expression.json"));
  assert.ok(report.sets.nullableWhy["T'"]![0]!.reason.includes("空产生式"));
  // id 由 FIRST(T) 经可空前缀传入 FIRST(E)
  const why = report.sets.firstWhy["E"]!["id"]!;
  assert.ok(why.some((o) => o.via === "T"));
  assert.ok(why.every((o) => o.productionIndex !== null));
  // 开始符号结束标记来源为 null
  assert.equal(report.sets.followWhy["E"]!["$"]![0]!.productionIndex, null);
  void grammar;
});

test("SQLite 持久化与版本比较：修改一条产生式后冲突消失", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  const store = new Store(dir);
  const svc = new GrammarService(store);

  const v1 = svc.importGrammar(load("common-prefix.json"), "共同前缀").version;
  assert.equal(v1.report.ll1, false);

  // 修改：把两条 a 开头右部区分开
  const fixed = load("common-prefix.json") as GrammarInput;
  fixed.productions = [
    { lhs: "S", rhs: ["A", "b"] },
    { lhs: "A", rhs: ["a", "b"] },
    { lhs: "A", rhs: ["c", "c"] },
  ];
  const v2 = svc.importGrammar(fixed, "左因子已手动处理").version;
  assert.notEqual(v1.id, v2.id);
  assert.equal(v2.report.ll1, true);

  const cmp = svc.compare(v1.id, v2.id);
  assert.deepEqual(cmp.conflicts.added, []);
  assert.equal(cmp.conflicts.removed.length, 1);
  assert.equal(cmp.conflicts.removed[0]!.nonterminal, "A");

  // 重启等价：重新打开同一数据目录，旧报告仍对应旧文法
  store.close();
  const store2 = new Store(dir);
  const svc2 = new GrammarService(store2);
  const old = svc2.requireVersion(v1.id);
  assert.equal(old.report.conflicts.length, 1);
  assert.equal(old.grammar.productions.length, 3);
  store2.close();
});

test("同一文法重复导入幂等，不产生新版本", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  const store = new Store(dir);
  const svc = new GrammarService(store);
  const a = svc.importGrammar(load("expression.json"));
  const b = svc.importGrammar(load("expression.json"));
  assert.equal(a.version.id, b.version.id);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(svc.list().length, 1);
  store.close();
});
