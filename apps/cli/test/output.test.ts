// The output sink (src/cli/output.ts): rendering JSON to stdout — pretty or compact,
// --iso-dates, terminal controls escaped, a deep or huge answer printed or refused cleanly.
// A large answer within a small heap is conformance test P27's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { OutputError, renderJson } from "../src/cli/output.js";
import type { CliDeps } from "../src/cli/io.js";
import { MastrClient } from "@maschinenlesbar.org/marktstammdatenregister-client/internal/client";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/marktstammdatenregister-client/internal/http";
import { jsonResponse, makeMockTransport, untimed } from "./helpers.js";

function makeCli(responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () => jsonResponse({ Data: [], Total: 0, Errors: null })) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(untimed(s)) },
    createClient: (opts) => new MastrClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

/** A unit page whose one row holds `x` nested `depth` levels deep. */
const deepAnswer = (depth: number) => () => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: Buffer.from(`{"Data":[{"x":${"[".repeat(depth)}${"]".repeat(depth)}}],"Total":1,"Errors":null}`),
});

test("an answer nested too deeply is a clean error; it suggests --compact only where --compact prints it (D7, bug 7)", async () => {
  // A hostile or broken answer: JSON.parse reads it, the pretty printer's recursion can't. Whether
  // the compact printer can depends on the Node version (iterative from Node 26) and the stack:
  // probed here, never assumed. On Node 22 and 24 the hint used to be given and was wrong.
  const depth = 200_000;
  let compactPrints = true;
  try {
    JSON.stringify(JSON.parse(`${"[".repeat(depth)}${"]".repeat(depth)}`));
  } catch {
    compactPrints = false;
  }
  const pretty = makeCli(deepAnswer(depth));
  assert.equal(await run(["stromerzeugung", "--page-size", "1"], pretty.deps), 1);
  assert.deepEqual(pretty.out, []);
  assert.deepEqual(pretty.err, [
    `ERROR [mastr.output] The answer is nested too deeply to pretty-print${compactPrints ? "; try --compact" : ""}.`,
  ]);
  const compact = makeCli(deepAnswer(depth));
  assert.equal(await run(["--compact", "stromerzeugung", "--page-size", "1"], compact.deps), compactPrints ? 0 : 1);
  if (!compactPrints) assert.deepEqual(compact.err, ["ERROR [mastr.output] The answer is nested too deeply to print."]);
});

test("--iso-dates on an answer nested too deeply names --iso-dates (D7)", async () => {
  const cli = makeCli(deepAnswer(200_000));
  assert.equal(await run(["--iso-dates", "stromerzeugung", "--page-size", "1"], cli.deps), 1);
  assert.deepEqual(cli.out, []);
  assert.deepEqual(cli.err, ["ERROR [mastr.output] The answer is nested too deeply for --iso-dates."]);
});

test("an answer too large to print is called too large, not too deep; the hint only where --compact prints (D7)", (t) => {
  const { deps } = makeCli();
  const real = JSON.stringify;
  // V8's own error for a text past its longest string, stood in for: a real one needs 512 MB.
  const tooLarge = (gap: unknown): boolean => gap === 2 || gap === "big";
  t.mock.method(JSON, "stringify", (value: unknown, replacer: never, gap: unknown) => {
    if (tooLarge(gap) || (gap === undefined && (value as { all?: boolean }).all === true)) throw new RangeError("Invalid string length");
    return real(value, replacer, gap as number);
  });
  assert.throws(() => renderJson(deps, {}, { id: "a1" }), (err: Error) =>
    err instanceof OutputError && /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print; try --compact\.$/.test(err.message));
  assert.throws(() => renderJson(deps, {}, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print\.$/.test(err.message));
  assert.throws(() => renderJson(deps, { compact: true }, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to print\.$/.test(err.message));
});

test("--compact takes the gap path only for an answer holding a huge string, the fast path otherwise (K4)", (t) => {
  // On Node 26 V8's fast stringifier (no gap) aborts the process on a ~250 MB string that
  // JSON.parse made ("Zone Allocation failed", exit 134); the gap path prints it. Only the fast
  // path is iterative there, though, and prints nesting the gap path refuses at ~7,000 levels.
  // So the path is chosen per answer. Too big a body for this suite: this pins the calls.
  const { deps, out } = makeCli();
  const stringify = t.mock.method(JSON, "stringify", () => '"stub"');
  const huge = "x".repeat(64 * 1024 * 1024);
  renderJson(deps, { compact: true }, { id: "a1", text: huge });
  renderJson(deps, { compact: true }, { id: "a1", x: [[["Rede"]]], text: huge.slice(1) });
  renderJson(deps, { compact: true }, { [huge]: 1 });
  renderJson(deps, { compact: true }, [[huge]]);
  renderJson(deps, {}, { id: "a1" });
  const calls = stringify.mock.calls.map((call) => call.arguments);
  stringify.mock.restore();
  assert.deepEqual(calls.map((args) => (args.length >= 3 ? args[2] : "none")), ["", "none", "", "", 2]);
  assert.deepEqual(out, ['"stub"', '"stub"', '"stub"', '"stub"', '"stub"']);
});

test("a rendering failure writes nothing to stdout (MASTR-04)", () => {
  // A chain deep enough to overflow the call stack: a typed OutputError, never "Unexpected
  // error", and nothing partial on stdout.
  const deep: Record<string, unknown> = {};
  let cur = deep;
  for (let i = 0; i < 200_000; i++) {
    const next: Record<string, unknown> = {};
    cur["a"] = next;
    cur = next;
  }
  const { deps, out } = makeCli();
  assert.throws(() => renderJson(deps, {}, deep), OutputError);
  assert.equal(out.length, 0);
});
