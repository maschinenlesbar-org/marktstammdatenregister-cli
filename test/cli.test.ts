import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { MastrClient } from "../src/client/client.js";
import { renderJson } from "../src/cli/shared.js";
import { MastrParseError } from "../src/client/errors.js";
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

test("--total prints only the count and fetches just 1 row (pageSize=1)", async () => {
  const cli = makeCli(() => jsonResponse(fx.unitPage));
  await run(["stromerzeugung", "--total", "--page-size", "500"], cli.deps);
  assert.equal(JSON.parse(cli.out.join("\n")), 9063887);
  // --total overrides page size to 1 so the count query never pulls a full page.
  assert.equal(queryOf(cli.mt.last()).get("pageSize"), "1");
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

test("0 results with --sort set prints a note about the likely bad sort field", async () => {
  const cli = makeCli(() => jsonResponse({ Data: [], Total: 0, Errors: null }));
  const code = await run(["stromerzeugung", "--sort", "BogusField-desc", "--total"], cli.deps);
  assert.equal(code, 0);
  const err = cli.err.join("\n");
  assert.match(err, /0 results with --sort/);
  // `mastr filters` lists FilterNames, which are not sort keys (live: "Bruttoleistung der
  // Einheit-desc" gives 0 rows, "Bruttoleistung-desc" works), so point at the record keys.
  assert.match(err, /not the FilterNames from `mastr filters`/);
  assert.match(err, /mastr stromerzeugung --page-size 1 --compact \| jq '\.data\[0\] \| keys'/);
  assert.doesNotMatch(err, /--filter/);
});

test("0 results with --filter set prints a note about the values", async () => {
  const cli = makeCli(() => jsonResponse({ Data: [], Total: 0, Errors: null }));
  const code = await run(["stromerzeugung", "--filter", "Bruttoleistung der Einheit~gt~'4999,999'", "--total"], cli.deps);
  assert.equal(code, 0);
  const err = cli.err.join("\n");
  assert.match(err, /0 results with --filter/);
  assert.match(err, /not its label, decimals take a point/);
  assert.doesNotMatch(err, /--sort/);
});

test("0 results WITHOUT --sort or --filter prints no such note", async () => {
  const cli = makeCli(() => jsonResponse({ Data: [], Total: 0, Errors: null }));
  await run(["stromerzeugung", "--total"], cli.deps);
  assert.equal(cli.err.join("\n"), "");
});

test("matches with --sort and --filter set print no note", async () => {
  const cli = makeCli(() => jsonResponse(fx.unitPage));
  await run(["stromerzeugung", "--sort", "Bruttoleistung-desc", "--filter", "X~gt~'1'", "--total"], cli.deps);
  assert.equal(cli.err.join("\n"), "");
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

test("a non-http(s) --base-url is rejected at parse time (exit 2, no request) (MASTR-03)", async () => {
  for (const bad of ["file:///etc/passwd", "data:text/plain,x", "ftp://example.test"]) {
    const cli = makeCli(() => jsonResponse(fx.unitPage));
    const code = await run(["--base-url", bad, "stromerzeugung"], cli.deps);
    assert.equal(code, 2, `expected usage exit for ${bad}`);
    assert.equal(cli.mt.calls.length, 0, `no request should be made for ${bad}`);
  }
});

test("a control character in --user-agent is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.unitPage));
  const code = await run(["stromerzeugung", "--user-agent", "bad\r\nX-Injected: 1"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse(fx.unitPage));
  assert.equal(await run(["--timeout", "2147483647", "stromerzeugung"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse(fx.unitPage));
  assert.equal(await run(["--timeout", "2147483648", "stromerzeugung"], over.deps), 2);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /Must be <= 2147483647/);
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

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const unit = { ...fx.unitPage.Data[0], EinheitName: `PV${controls}`, Ort: String.fromCharCode(0x1b) + "[31m" };
  const served = { ...fx.unitPage, Data: [unit] };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run(["stromerzeugung", ...format], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) => c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f);
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /PV\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), { total: served.Total, data: served.Data });
  }
});

test("--compact prints single-line JSON", async () => {
  const cli = makeCli(() => jsonResponse(fx.unitPage));
  await run(["stromerzeugung", "--compact"], cli.deps);
  assert.equal(cli.out.length, 1);
});

test("renderJson maps a deep-nesting RangeError to a typed MastrParseError (MASTR-04)", () => {
  // Build a chain deep enough to overflow the call stack in JSON.stringify. This
  // must surface as a typed parse error, not a generic "Unexpected error".
  const deep: Record<string, unknown> = {};
  let cur = deep;
  for (let i = 0; i < 200_000; i++) {
    const next: Record<string, unknown> = {};
    cur["a"] = next;
    cur = next;
  }
  const out: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: () => {} },
    createClient: (opts) => new MastrClient(opts),
  };
  assert.throws(() => renderJson(deps, {}, deep), MastrParseError);
  // Fail-secure: nothing partial was written to stdout.
  assert.equal(out.length, 0);
});

test("--filter with ~or~ is rejected (exit 2, no request) and points at the comma list", async () => {
  for (const spec of [
    "Energieträger~eq~'2497'~or~Energieträger~eq~'2498'",
    "Ort~eq~'x'~OR~Ort~eq~'Münster'",
  ]) {
    const cli = makeCli(() => jsonResponse(fx.unitPage));
    assert.equal(await run(["stromerzeugung", "--filter", spec, "--total"], cli.deps), 2, spec);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /"~or~" is not supported/);
    assert.match(cli.err.join("\n"), /Energieträger~eq~'2497,2498'/);
  }
});

test("--filter with a comma list inside one value is sent as is", async () => {
  const cli = makeCli(() => jsonResponse(fx.unitPage));
  assert.equal(await run(["stromerzeugung", "--filter", "Energieträger~eq~'2497,2498'", "--total"], cli.deps), 0);
  assert.equal(queryOf(cli.mt.last()).get("filter"), "Energieträger~eq~'2497,2498'");
});

test("the 0-results --sort note suggests a sort key that exists in that category", async () => {
  const expected = {
    stromerzeugung: "Bruttoleistung",
    stromverbrauch: "InbetriebnahmeDatum",
    gaserzeugung: "Erzeugungsleistung",
    gasverbrauch: "MaximaleGasbezugsLeistung",
  };
  for (const [category, key] of Object.entries(expected)) {
    const cli = makeCli(() => jsonResponse({ Data: [], Total: 0, Errors: null }));
    assert.equal(await run([category, "--sort", "Bruttoleistung-desc", "--total"], cli.deps), 0);
    const err = cli.err.join("\n");
    assert.match(err, new RegExp(`record field names \\(e\\.g\\. ${key}\\)`), category);
    if (category !== "stromerzeugung") assert.doesNotMatch(err, /e\.g\. Bruttoleistung/, category);
  }
});

test("an empty 200 body or a malformed envelope exits 1 with nothing on stdout", async () => {
  for (const body of ["", "null", '{"Data":[{"a":1}]}', '{"Data":[],"Total":0,"Errors":{"":{"errors":["Invalid filter"]}}}']) {
    const cli = makeCli(() => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(body) }));
    assert.equal(await run(["stromerzeugung", "--compact"], cli.deps), 1, body);
    assert.deepEqual(cli.out, [], body);
    assert.match(cli.err.join("\n"), /Empty response body|Unexpected response shape|Invalid filter/, body);
  }
});

test("filters exits 1 on an Errors envelope or an empty body (not [] with exit 0)", async () => {
  const errs = makeCli(() => jsonResponse(fx.nullRequestError));
  assert.equal(await run(["filters", "stromerzeugung"], errs.deps), 1);
  assert.deepEqual(errs.out, []);
  assert.match(errs.err.join("\n"), /Die Anfrage ist Null/);
  const empty = makeCli(() => ({ status: 200, headers: {}, body: Buffer.alloc(0) }));
  assert.equal(await run(["filters", "stromerzeugung"], empty.deps), 1);
  assert.deepEqual(empty.out, []);
});

test("a malformed --filter is a usage error (exit 2, no request)", async () => {
  const cases: [string, RegExp][] = [
    ["foo", /Condition 1 \("foo"\) is incomplete/],
    ["Ort~eq", /Condition 1 \("Ort~eq"\) is incomplete/],
    ["Ort~null", /Condition 1 \("Ort~null"\) is incomplete/],
    ["~eq~'1'", /Condition 1 has no FilterName/],
    ["Energieträger~eq~'2495'~and~", /ends with "~and~"/],
    ["Energieträger~eq~'2495'~and~ ", /ends with "~and~"/],
    ["Energieträger~eq~'2495'~und~Ort~eq~'x'", /Expected ~and~ after condition 1, got "~und~"/],
    ["Energieträger~EQ~'2495'", /Unknown operator "EQ" in condition 1\..*use "eq"/],
    ["Bruttoleistung der Einheit~gte~'5000'", /Unknown operator "gte".*there is no gte\/lte/],
    ["Ort~eq~'Münster'~and~Ort~ct~ ", /Condition 2 \("Ort~ct"\) has no value/],
    ["Ort~eq~'Münster", /value of condition 1 \('Münster\) has no closing single quote/],
  ];
  for (const [spec, message] of cases) {
    const cli = makeCli(() => jsonResponse(fx.unitPage));
    assert.equal(await run(["stromerzeugung", "--filter", spec, "--total"], cli.deps), 2, spec);
    assert.equal(cli.mt.calls.length, 0, spec);
    assert.match(cli.err.join("\n"), message, spec);
  }
});

test("well-formed --filter specs pass (unary ops with '', unquoted codes, an apostrophe in a value)", async () => {
  for (const spec of [
    "Ort~null~''",
    "Ort~nn~''~and~Energieträger~eq~2497",
    "Anzeige-Name der Einheit~ct~'d'Arc'",
    "Bruttoleistung der Einheit~gt~'5000'~and~Bruttoleistung der Einheit~lt~'6000'",
    "MaStR-Nr. der Einheit~eq~'SEE984033548619'",
  ]) {
    const cli = makeCli(() => jsonResponse(fx.unitPage));
    assert.equal(await run(["stromerzeugung", "--filter", spec, "--total"], cli.deps), 0, spec);
    assert.equal(queryOf(cli.mt.last()).get("filter"), spec);
  }
});

test("a ~ inside a quoted --filter value is a usage error naming the cause", async () => {
  const cli = makeCli(() => jsonResponse(fx.unitPage));
  assert.equal(await run(["stromerzeugung", "--filter", "Anzeige-Name der Einheit~ct~'a~b'", "--total"], cli.deps), 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /A filter value cannot contain "~"/);
});

test("a --base-url with a query, fragment or surrounding whitespace is rejected (exit 2, no request)", async () => {
  for (const [bad, message] of [
    ["http://127.0.0.1:1/ok#frag", /cannot have a query \(\?\) or fragment \(#\)/],
    ["http://127.0.0.1:1/ok?x=1", /cannot have a query \(\?\) or fragment \(#\)/],
    [" http://127.0.0.1:1/ok", /surrounding whitespace/],
  ] as const) {
    const cli = makeCli(() => jsonResponse(fx.unitPage));
    assert.equal(await run(["--base-url", bad, "stromerzeugung"], cli.deps), 2, bad);
    assert.equal(cli.mt.calls.length, 0, bad);
    assert.match(cli.err.join("\n"), message, bad);
  }
  const prefix = makeCli(() => jsonResponse(fx.unitPage));
  assert.equal(await run(["--base-url", "http://127.0.0.1:1/mirror/MaStR/", "stromerzeugung"], prefix.deps), 0);
  assert.match(prefix.mt.last().url, /^http:\/\/127\.0\.0\.1:1\/mirror\/MaStR\/Einheit\//);
});

test("userinfo in --base-url is redacted in error messages but still sent", async () => {
  const cli = makeCli(() => jsonResponse({ message: "nope" }, 404));
  assert.equal(await run(["--base-url", "http://user:pw@127.0.0.1:1/r404", "stromerzeugung"], cli.deps), 4);
  const err = cli.err.join("\n");
  assert.doesNotMatch(err, /user:pw|:pw@/);
  assert.match(err, /HTTP 404 for GET http:\/\/\*\*\*@127\.0\.0\.1:1\/r404\/Einheit\/.*: nope/);
  assert.match(cli.mt.last().url, /^http:\/\/user:pw@127\.0\.0\.1:1\//);
});

test("bidi controls from the server are stripped on stderr and escaped on stdout", async () => {
  const RLO = String.fromCharCode(0x202e);
  const errCli = makeCli(() => jsonResponse({ Data: null, Total: 0, Errors: `bad text${RLO}evil\nError: forged` }));
  assert.equal(await run(["stromerzeugung"], errCli.deps), 1);
  const err = errCli.err.join("\n");
  assert.equal(err.includes(RLO), false);
  assert.equal(err.split("\n").length, 1);
  assert.match(err, /: bad textevil Error: forged$/);

  const unit = { ...fx.unitPage.Data[0], EinheitName: `PV${RLO}1` };
  const outCli = makeCli(() => jsonResponse({ ...fx.unitPage, Data: [unit] }));
  assert.equal(await run(["stromerzeugung", "--compact"], outCli.deps), 0);
  const text = outCli.out.join("\n");
  assert.equal(text.includes(RLO), false);
  assert.match(text, /PV\\u202e1/);
  assert.equal((JSON.parse(text) as { data: { EinheitName: string }[] }).data[0]?.EinheitName, `PV${RLO}1`);
});
