import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as netCreateServer } from "node:net";
import { join } from "node:path";
import { GrammarService } from "./core/service.js";
import { Store, defaultDataDir } from "./core/storage.js";
import { ALGORITHM_VERSION, ApiError } from "./core/types.js";

const send = (res: ServerResponse, status: number, body: unknown) => {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
};

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 4 * 1024 * 1024) reject(new Error("BODY_TOO_LARGE"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("SYNTAX_INVALID_JSON"));
      }
    });
    req.on("error", reject);
  });

/** 请求体 size=0 时让操作系统选择空闲端口。 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = netCreateServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === "object" ? resolve(addr.port) : reject(new Error("NO_PORT"))));
    });
    srv.on("error", reject);
  });
}

export interface HttpApp {
  server: Server;
  port: number;
  close: () => void;
}

export async function startHttpServer(opts: { port?: number; dataDir?: string } = {}): Promise<HttpApp> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const store = new Store(dataDir);
  const service = new GrammarService(store);
  const port = opts.port ?? (await pickFreePort());

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const seg = path.split("/").filter(Boolean);

      if (req.method === "GET" && path === "/health") {
        return send(res, 200, { ok: true, algorithmVersion: ALGORITHM_VERSION });
      }
      if (req.method === "GET" && path === "/api/versions") {
        return send(res, 200, { versions: service.list() });
      }
      if (req.method === "POST" && path === "/api/grammars") {
        const body = await readBody(req);
        const note = url.searchParams.get("note") ?? undefined;
        const r = service.importGrammar(body, note);
        return send(res, r.created ? 201 : 200, r.version);
      }

      // /api/grammars/:id/...
      if (seg[0] === "api" && seg[1] === "grammars" && seg[2]) {
        const id = decodeURIComponent(seg[2]);
        const sub = seg[3];
        if (req.method === "GET" && (sub === undefined || sub === "report")) {
          return send(res, 200, service.requireVersion(id));
        }
        if (req.method === "GET" && sub === "sets") {
          return send(res, 200, { sets: service.getReport(id).sets });
        }
        if (req.method === "GET" && sub === "table") {
          return send(res, 200, {
            table: service.queryTable(
              id,
              url.searchParams.get("nonterminal") ?? undefined,
              url.searchParams.get("terminal") ?? undefined,
            ),
          });
        }
        if (req.method === "GET" && sub === "conflicts") {
          return send(res, 200, { conflicts: service.conflicts(id) });
        }
        if (req.method === "GET" && sub === "diagnostics") {
          return send(res, 200, { diagnostics: service.getReport(id).diagnostics });
        }
        if (req.method === "GET" && sub === "export") {
          return send(res, 200, service.exportJson(id));
        }
        if (req.method === "GET" && sub === "explain") {
          const set = url.searchParams.get("set") as "first" | "follow" | "nullable" | null;
          const nt = url.searchParams.get("nonterminal");
          if (!set || !nt) throw Object.assign(new Error("MISSING_QUERY"), { code: "MISSING_QUERY" });
          return send(res, 200, {
            origins: service.explain(id, set, nt, url.searchParams.get("element") ?? undefined),
          });
        }
      }

      // /api/compare?from=..&to=..
      if (req.method === "GET" && seg[0] === "api" && seg[1] === "compare") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to) throw Object.assign(new Error("MISSING_QUERY"), { code: "MISSING_QUERY" });
        return send(res, 200, service.compare(from, to));
      }

      send(res, 404, { error: { code: "NOT_FOUND", message: `无此路由：${path}` } } satisfies ApiError);
    } catch (err) {
      const e = err as { code?: string; message?: string; details?: unknown };
      const code = e.code ?? "INTERNAL";
      const status =
        code === "VALIDATION_FAILED" ? 400
        : code === "VERSION_NOT_FOUND" || code === "UNKNOWN_NONTERMINAL" ? 404
        : code === "UNKNOWN_ELEMENT" || code === "MISSING_QUERY" || code === "SYNTAX_INVALID_JSON" ? 400
        : 500;
      send(res, status, { error: { code, message: e.message ?? "内部错误", details: e.details } } satisfies ApiError);
    }
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    server,
    port: (server.address() as { port: number }).port,
    close: () => {
      server.close();
      store.close();
    },
  };
}

export { join };
