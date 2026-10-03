#!/usr/bin/env node
// node:sqlite 在当前 Node 版本仍标记为实验性，屏蔽其启动警告以免污染 JSON 输出。
process.removeAllListeners("warning");
import { readFileSync, writeFileSync } from "node:fs";
import { GrammarService } from "../core/service.js";
import { Store, defaultDataDir } from "../core/storage.js";
import { startHttpServer } from "../server.js";

const args = process.argv.slice(2);
const command = args.shift();

function parseFlags(argv: string[]) {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
  }
  return flags;
}

const out = (x: unknown) => console.log(JSON.stringify(x, null, 2));

async function main() {
  const flags = parseFlags(args);
  const dataDir = flags["data-dir"] ?? defaultDataDir();
  const store = new Store(dataDir);
  const service = new GrammarService(store);

  const loadInput = (): unknown => {
    const file = flags["file"];
    if (!file) throw new Error("需要 --file <文法 JSON 文件>");
    return JSON.parse(readFileSync(file, "utf8"));
  };

  switch (command) {
    case "import": {
      const r = service.importGrammar(loadInput(), flags.note);
      out({ created: r.created, id: r.version.id, ll1: r.version.report.ll1, conflicts: r.version.report.conflicts.length });
      break;
    }
    case "report": {
      out(service.requireVersion(requireId(flags)).report);
      break;
    }
    case "sets": {
      out({ sets: service.getReport(requireId(flags)).sets });
      break;
    }
    case "table": {
      out({
        table: service.queryTable(
          requireId(flags),
          flags.nonterminal,
          flags.terminal,
        ),
      });
      break;
    }
    case "conflicts": {
      out({ conflicts: service.conflicts(requireId(flags)) });
      break;
    }
    case "explain": {
      if (!flags.set || !flags.nonterminal) throw new Error("需要 --set first|follow|nullable --nonterminal <名> [--element <符号>]");
      out({ origins: service.explain(requireId(flags), flags.set as "first" | "follow" | "nullable", flags.nonterminal, flags.element) });
      break;
    }
    case "diagnostics": {
      out({ diagnostics: service.getReport(requireId(flags)).diagnostics });
      break;
    }
    case "compare": {
      if (!flags.from || !flags.to) throw new Error("需要 --from <id> --to <id>");
      out(service.compare(flags.from, flags.to));
      break;
    }
    case "export": {
      const json = JSON.stringify(service.exportJson(requireId(flags)), null, 2);
      if (flags.out) writeFileSync(flags.out, json, "utf8");
      else console.log(json);
      break;
    }
    case "list": {
      out({ versions: service.list() });
      break;
    }
    case "serve": {
      const app = await startHttpServer({
        port: flags.port ? Number(flags.port) : undefined,
        dataDir,
      });
      console.log(`CFG 分析服务已启动: http://127.0.0.1:${app.port}  (数据目录 ${dataDir})`);
      break;
    }
    case "validate": {
      const { validateGrammar } = await import("../core/validate.js");
      const r = validateGrammar(loadInput());
      if (r.issues.length) out({ ok: false, issues: r.issues });
      else out({ ok: true, id: r.grammar!.id });
      break;
    }
    default:
      console.log(`用法: cfg <import|validate|report|sets|table|conflicts|explain|diagnostics|compare|export|list|serve> [选项]

  import    --file g.json [--note 备注]      导入并分析文法（重复内容幂等）
  validate  --file g.json                    仅校验
  report    --id <id>                        完整报告
  sets      --id <id>                        可空/FIRST/FOLLOW
  table     --id <id> [--nonterminal A] [--terminal t]   预测表查询
  conflicts --id <id>                        冲突列表
  explain   --id <id> --set first|follow|nullable --nonterminal A [--element a]  来源解释
  diagnostics --id <id>                      不可达/不可生成符号
  compare   --from <id> --to <id>           版本比较
  export    --id <id> [--out report.json]    JSON 导出
  list                                        列出全部版本
  serve     [--port 端口] [--data-dir 目录]  启动 HTTP 服务（默认空闲端口）

通用选项: --data-dir <目录>（默认 ./data）`);
  }
  store.close();
}

function requireId(flags: Record<string, string>): string {
  if (!flags.id) throw new Error("需要 --id <文法版本 id>");
  return flags.id;
}

main().catch((err) => {
  console.error(JSON.stringify({ error: { code: err.code ?? "CLI_ERROR", message: err.message, details: err.details } }, null, 2));
  process.exit(1);
});
