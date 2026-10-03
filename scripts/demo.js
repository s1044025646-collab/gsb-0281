/* 端到端演示：CLI 导入三个文法、展示冲突、修改产生式后比较版本。 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const cli = path.join(__dirname, "..", "dist", "cli", "index.js");
const run = (args) =>
  execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: path.join(__dirname, "..") });

function show(title, args) {
  console.log("\n=== " + title + " ===");
  console.log(run(args).trim());
}

for (const name of ["expression", "common-prefix", "follow-epsilon"]) {
  show(`导入 examples/${name}.json`, ["import", "--file", `examples/${name}.json`, "--note", name]);
}

show("版本列表", ["list"]);

const list = JSON.parse(run(["list"]));
const prefix = list.versions.find((v) => v.note === "common-prefix");

show("共同前缀文法的冲突", ["conflicts", "--id", prefix.id]);
show("FIRST(S) 中 a 的来源解释", [
  "explain", "--id", prefix.id, "--set", "first", "--nonterminal", "S", "--element", "a",
]);
show("不可达/不可生成诊断", ["diagnostics", "--id", prefix.id]);

// 修改一条产生式后重新导入并比较
const fs = require("node:fs");
const os = require("node:os");
const fixed = JSON.parse(fs.readFileSync("examples/common-prefix.json", "utf8"));
fixed.productions[2].rhs = ["c", "c"];
const tmp = path.join(os.tmpdir(), "common-prefix-fixed.json");
fs.writeFileSync(tmp, JSON.stringify(fixed, null, 2));
const fixedImport = JSON.parse(run(["import", "--file", tmp, "--note", "fixed"]));

show("修改产生式后的版本比较（冲突应被移除）", ["compare", "--from", prefix.id, "--to", fixedImport.id]);
show("导出修订版报告（片段：ll1）", ["report", "--id", fixedImport.id]);

console.log("\n演示完成。数据保存在项目内 ./data/cfg.db");
