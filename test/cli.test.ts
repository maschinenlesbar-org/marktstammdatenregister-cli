import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { MastrClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, queryOf } from "./helpers.js";
import * as fx from "./fixtures.js";

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) => new MastrClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

test("stromerzeugung renders { total, data } and hits the endpoint", async () => {
  const cli = makeCli(() => jsonResponse(fx.unitPage));
  const code = await run(["stromerzeugung"], cli.deps);
  assert.equal(code, 0);
  assert.equal(
    new URL(cli.mt.last().url).pathname.endsWith("/GetErweiterteOeffentlicheEinheitStromerzeugung"),
    true,
  );
  const parsed = JSON.parse(cli.out.join("\n")) as { total: number; data: unknown[] };
  assert.equal(parsed.total, 9063887);
  assert.equal(parsed.data.length, 2);
});

test("--total prints only the count", async () => {
  const cli = makeCli(() => jsonResponse(fx.unitPage));
  await run(["stromerzeugung", "--total"], cli.deps);
  assert.equal(JSON.parse(cli.out.join("\n")), 9063887);
});

test("--page/--page-size/--sort/--filter are forwarded", async () => {
  const cli = makeCli(() => jsonResponse(fx.unitPage));
  await run(
    ["stromerzeugung", "--page", "2", "--page-size", "5", "--sort", "Bruttoleistung-desc", "--filter", "X~eq~'1'"],
    cli.deps,
  );
  const q = queryOf(cli.mt.last());
  assert.equal(q.get("page"), "2");
  assert.equal(q.get("pageSize"), "5");
  assert.equal(q.get("sort"), "Bruttoleistung-desc");
  assert.equal(q.get("filter"), "X~eq~'1'");
});

test("--page-size above 5000 is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.unitPage));
  const code = await run(["stromerzeugung", "--page-size", "6000"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("--page below 1 is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.unitPage));
  assert.equal(await run(["stromerzeugung", "--page", "0"], cli.deps), 2);
});

test("a logical Errors envelope surfaces as an error (exit 1)", async () => {
  const cli = makeCli(() => jsonResponse(fx.nullRequestError));
  const code = await run(["stromerzeugung"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /Die Anfrage ist Null/);
});

test("filters <category> hits GetFilterColumns and renders the columns", async () => {
  const cli = makeCli(() => jsonResponse(fx.filterColumns));
  const code = await run(["filters", "gaserzeugung"], cli.deps);
  assert.equal(code, 0);
  assert.equal(
    new URL(cli.mt.last().url).pathname.endsWith("/GetFilterColumnsErweiterteOeffentlicheEinheitGaserzeugung"),
    true,
  );
});

test("filters with a bad category is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.filterColumns));
  const code = await run(["filters", "bogus"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("filters with no category is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.filterColumns));
  assert.equal(await run(["filters"], cli.deps), 2);
});

test("--iso-dates rewrites /Date(ms)/ timestamps", async () => {
  const cli = makeCli(() => jsonResponse(fx.unitPage));
  await run(["stromerzeugung", "--iso-dates", "--compact"], cli.deps);
  const text = cli.out.join("\n");
  assert.doesNotMatch(text, /\/Date\(/);
  assert.match(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/); // an ISO timestamp appears
});

test("without --iso-dates the raw /Date(ms)/ is preserved", async () => {
  const cli = makeCli(() => jsonResponse(fx.unitPage));
  await run(["stromerzeugung", "--compact"], cli.deps);
  assert.match(cli.out.join("\n"), /\/Date\(1548979200000\)\//);
});

test("--max-retries above the sane maximum is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.unitPage));
  const code = await run(["--max-retries", "1000000", "stromerzeugung"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("an empty --base-url is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.unitPage));
  const code = await run(["--base-url", "", "stromerzeugung"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("a control character in --user-agent is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.unitPage));
  const code = await run(["stromerzeugung", "--user-agent", "bad\r\nX-Injected: 1"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("a bare invocation prints help and exits 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run([], cli.deps);
  assert.equal(code, 0);
  assert.match(cli.out.join("\n"), /Usage: mastr/);
});

test("an unknown command exits 2", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["boguscmd"], cli.deps), 2);
});

test("--compact prints single-line JSON", async () => {
  const cli = makeCli(() => jsonResponse(fx.unitPage));
  await run(["stromerzeugung", "--compact"], cli.deps);
  assert.equal(cli.out.length, 1);
});
