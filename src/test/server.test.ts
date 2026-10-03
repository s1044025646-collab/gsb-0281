import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttpServer, HttpApp } from "../server.js";

const base = (app: HttpApp) => `http://127.0.0.1:${app.port}`;

test("HTTP API 端到端：导入->查询->解释->比较->错误码", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-http-"));
  const app = await startHttpServer({ dataDir: dir, port: 0 });
  const grammar = JSON.parse(readFileSync(join(__dirname, "..", "..", "examples", "common-prefix.json"), "utf8"));

  const health = await fetch(`${base(app)}/health`).then((r) => r.json());
  assert.equal(health.ok, true);

  const created = await fetch(`${base(app)}/api/grammars`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(grammar),
  });
  assert.equal(created.status, 201);
  const v1 = await created.json();
  assert.equal(v1.report.ll1, false);

  const conflicts = await fetch(`${base(app)}/api/grammars/${v1.id}/conflicts`).then((r) => r.json());
  assert.equal(conflicts.conflicts[0].kind, "FIRST_OVERLAP");

  const table = await fetch(
    `${base(app)}/api/grammars/${v1.id}/table?nonterminal=A&terminal=a`,
  ).then((r) => r.json());
  assert.equal(table.table.A.a.length, 2);

  const explain = await fetch(
    `${base(app)}/api/grammars/${v1.id}/explain?set=follow&nonterminal=A&element=b`,
  ).then((r) => r.json());
  assert.ok(explain.origins[0].reason.includes("后缀"));

  const fixed = structuredClone(grammar);
  fixed.productions[2].rhs = ["c", "c"];
  const v2 = await fetch(`${base(app)}/api/grammars`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fixed),
  }).then((r) => r.json());
  assert.equal(v2.report.ll1, true);

  const cmp = await fetch(`${base(app)}/api/compare?from=${v1.id}&to=${v2.id}`).then((r) => r.json());
  assert.equal(cmp.conflicts.removed.length, 1);

  // 错误码
  const bad = await fetch(`${base(app)}/api/grammars`, {
    method: "POST",
    body: JSON.stringify({ terminals: [], nonterminals: [], productions: [] }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "VALIDATION_FAILED");

  const nf = await fetch(`${base(app)}/api/grammars/nope/report`);
  assert.equal(nf.status, 404);
  assert.equal((await nf.json()).error.code, "VERSION_NOT_FOUND");

  app.close();
});
