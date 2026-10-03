import path from "node:path";
import { readFileSync } from "node:fs";
import { GrammarStore } from "./store.js";
import { validateGrammar } from "./validate.js";
import { serve } from "./api.js";
import { GrammarError } from "./types.js";

const DATA_DIR = process.env.GSA_DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "grammars.db");

function usage(): never {
  console.log(`用法: node dist/src/cli.js <命令> [参数]

命令:
  serve [--port N]                 启动 HTTP API（默认自动选择空闲端口）
  import <file.json>               导入文法，输出版本 id
  list                             列出所有文法版本
  show <id>                        查看文法原文
  analyze <id>                     输出可空集合 / FIRST / FOLLOW
  table <id>                       输出预测分析表
  conflicts <id>                   输出冲突列表
  diagnostics <id>                 输出不可达 / 不可生成诊断
  explain <id> <set> <symbol> [e]  解释集合元素来源（set: nullable|first|follow）
  diff <idA> <idB>                 比较两个版本
  export <id>                      导出完整 JSON 报告
  demo                             运行内置演示（修改产生式前后冲突变化）

数据目录: ${DATA_DIR}（可用 GSA_DATA_DIR 覆盖）`);
  process.exit(1);
}

function out(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) usage();
  const store = new GrammarStore(DB_PATH);

  const needReport = (id: string) => {
    const r = store.getReport(id);
    if (!r) { console.error(`错误: 文法版本不存在: ${id}`); process.exit(1); }
    return r;
  };

  try {
    switch (cmd) {
      case "serve": {
        const pi = args.indexOf("--port");
        const port = pi >= 0 ? Number(args[pi + 1]) : 0;
        serve(store, port).then(({ port: p }) => {
          console.log(`API 服务已启动: http://127.0.0.1:${p}`);
        });
        return; // 不关闭 store，保持进程
      }
      case "import": {
        const file = args[0];
        if (!file) usage();
        const grammar = validateGrammar(JSON.parse(readFileSync(file, "utf8")));
        out(store.import(grammar));
        break;
      }
      case "list": out(store.list()); break;
      case "show": out(store.getGrammar(args[0]) ?? `未找到: ${args[0]}`); break;
      case "analyze": {
        const r = needReport(args[0]);
        out({ nullable: r.analysis.nullable, first: r.analysis.first, follow: r.analysis.follow });
        break;
      }
      case "table": out(needReport(args[0]).table); break;
      case "conflicts": out(needReport(args[0]).conflicts); break;
      case "diagnostics": out(needReport(args[0]).diagnostics); break;
      case "explain": {
        const [id, setKind, symbol, element] = args;
        const prov = needReport(id).analysis.provenance;
        const entry = setKind === "nullable" ? prov.nullable[symbol]
          : setKind === "first" ? prov.first[symbol]?.[element]
          : setKind === "follow" ? prov.follow[symbol]?.[element]
          : undefined;
        if (!entry) { console.error("未找到来源记录"); process.exit(1); }
        out({ set: setKind, symbol, element, provenance: entry });
        break;
      }
      case "diff": {
        const result = store.diff(args[0], args[1]);
        if (!result) { console.error("版本不存在"); process.exit(1); }
        out(result);
        break;
      }
      case "export": {
        const r = needReport(args[0]);
        out({ id: args[0], grammar: store.getGrammar(args[0]), report: r });
        break;
      }
      case "demo": {
        // 演示：修改一条产生式前后的冲突变化
        const before = validateGrammar(JSON.parse(readFileSync(path.join(process.cwd(), "examples", "follow-conflict.json"), "utf8")));
        const after = JSON.parse(JSON.stringify(before)) as typeof before;
        // 把 A -> a 改为 A -> c，消除 FIRST/FOLLOW 冲突
        after.productions = after.productions.map((p) =>
          p.lhs === "A" && p.rhs.join(" ") === "a" ? { lhs: "A", rhs: ["c"] } : p);
        if (!after.terminals.includes("c")) after.terminals.push("c");
        const afterV = validateGrammar(after);
        const idA = store.import(before).id;
        const idB = store.import(afterV).id;
        console.log(`修改前版本: ${idA}`);
        console.log(`修改后版本: ${idB}（A -> a 改为 A -> c）`);
        console.log("\n修改前冲突:");
        out(store.getReport(idA)!.conflicts);
        console.log("修改后冲突:");
        out(store.getReport(idB)!.conflicts);
        console.log("版本比较:");
        out(store.diff(idA, idB));
        break;
      }
      default:
        usage();
    }
  } catch (err) {
    if (err instanceof GrammarError) {
      console.error(`错误 [${err.code}]: ${err.message}`);
      process.exit(2);
    }
    throw err;
  } finally {
    if (cmd !== "serve") store.close();
  }
}

main();
