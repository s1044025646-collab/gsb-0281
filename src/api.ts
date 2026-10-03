import http from "node:http";
import { GrammarStore } from "./store.js";
import { validateGrammar } from "./validate.js";
import { ALGO_VERSION, GrammarError } from "./types.js";

function send(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string, details?: unknown) {
  send(res, status, { error: { code, message, details } });
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(text); } catch { throw new GrammarError("INVALID_JSON", "请求体不是合法 JSON"); }
}

export function createServer(store: GrammarStore): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      // POST /grammars  导入文法
      if (req.method === "POST" && parts.length === 1 && parts[0] === "grammars") {
        const grammar = validateGrammar(await readBody(req));
        const { id, created } = store.import(grammar);
        send(res, created ? 201 : 200, { id, created, algoVersion: ALGO_VERSION });
        return;
      }
      // GET /grammars  列出版本
      if (req.method === "GET" && parts.length === 1 && parts[0] === "grammars") {
        send(res, 200, { grammars: store.list() });
        return;
      }
      if (parts[0] === "grammars" && parts.length >= 2) {
        const id = parts[1];
        const grammar = store.getGrammar(id);
        if (!grammar) { sendError(res, 404, "NOT_FOUND", `文法版本不存在: ${id}`); return; }
        const report = () => store.getReport(id)!;
        const sub = parts[2];

        if (req.method === "GET" && parts.length === 2) { send(res, 200, { id, grammar }); return; }
        if (req.method === "GET" && sub === "analysis") { send(res, 200, { id, ...report().analysis }); return; }
        if (req.method === "GET" && sub === "table") { send(res, 200, { id, table: report().table }); return; }
        if (req.method === "GET" && sub === "conflicts") { send(res, 200, { id, conflicts: report().conflicts }); return; }
        if (req.method === "GET" && sub === "diagnostics") { send(res, 200, { id, ...report().diagnostics }); return; }
        if (req.method === "GET" && sub === "export") {
          send(res, 200, { id, algoVersion: ALGO_VERSION, grammar, report: report() });
          return;
        }
        // GET /grammars/:id/explain?set=first&symbol=E&element=a
        if (req.method === "GET" && sub === "explain") {
          const setKind = url.searchParams.get("set");
          const symbol = url.searchParams.get("symbol");
          const element = url.searchParams.get("element");
          if (!setKind || !symbol || element === null) {
            sendError(res, 400, "INVALID_QUERY", "需要查询参数 set(nullable|first|follow), symbol, element");
            return;
          }
          const prov = report().analysis.provenance;
          let entry: unknown;
          if (setKind === "nullable") entry = prov.nullable[symbol];
          else if (setKind === "first") entry = prov.first[symbol]?.[element];
          else if (setKind === "follow") entry = prov.follow[symbol]?.[element];
          else { sendError(res, 400, "INVALID_QUERY", `未知集合类型: ${setKind}`); return; }
          if (!entry) { sendError(res, 404, "NOT_FOUND", `未找到 ${setKind}(${symbol}${setKind === "nullable" ? "" : `, ${element}`}) 的来源记录`); return; }
          send(res, 200, { id, set: setKind, symbol, element, provenance: entry });
          return;
        }
        // GET /grammars/:id/diff/:otherId
        if (req.method === "GET" && sub === "diff" && parts[3]) {
          const result = store.diff(id, parts[3]);
          if (!result) { sendError(res, 404, "NOT_FOUND", `文法版本不存在: ${parts[3]}`); return; }
          send(res, 200, { from: id, to: parts[3], ...result });
          return;
        }
      }
      sendError(res, 404, "NOT_FOUND", `未知路由: ${req.method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof GrammarError) {
        sendError(res, 422, err.code, err.message, err.details);
      } else {
        sendError(res, 500, "INTERNAL", err instanceof Error ? err.message : String(err));
      }
    }
  });
}

/** 启动服务；port=0（默认）时由系统分配空闲端口。 */
export function serve(store: GrammarStore, port = 0): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(store);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : port });
    });
  });
}
