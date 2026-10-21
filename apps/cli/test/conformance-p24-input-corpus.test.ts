// Conformance test P24 (trend analysis 2026-10-21; fix plan 2026-10-21, D8 and D10): an input
// is canonicalised or refused, never sent raw. One corpus of tricky values goes through every
// text filter, every token (id, code, enum, sort key) and every list the repo declares, on the
// CLI and in the library. Either both refuse it before any request (exit 2, the validation
// error), or both send the same request with the value in canonical form: a text without
// surrounding whitespace, in composed Unicode, never blank; a token as the adapter canonicalises
// it, never empty, a dot segment or with a "/"; a list item by item. A value that holds only
// invisible characters or combining marks is blank. A refusal shows an invisible or control
// character escaped (`\u200b`), never raw. Each value here was once sent raw by some *-cli and
// matched nothing, or the wrong thing, with exit 0. Shared across the *-cli repos; only the
// adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";

// ---- adapter (per repo) -------------------------------------------------------------
/**
 * `parity(argv, call, responder)`: argv through run() and `call` through the library, each on a
 * recording mock transport; resolves to `{ cli: { code, out, err, requests }, lib: { ok, value?,
 * error?: { name, message }, requests } }`. Map the repo's own helper to this shape if it differs.
 * mastr's `kitParity` maps its `parity` to this shape; here the client's filter-columns requests
 * (one per category, for the filter check) are left out of `requests` on both sides, so
 * "refused before any request" means before the unit request, and a FilterName the category
 * doesn't have counts as refused.
 */
import { isColumnsRequest, jsonResponse, kitParity, withColumns } from "./helpers.js";
const parity: typeof kitParity = async (argv, call, responder) => {
  const o = await kitParity(argv, call, responder);
  return {
    cli: { ...o.cli, requests: o.cli.requests.filter((r) => !isColumnsRequest(r)) },
    lib: { ...o.lib, requests: o.lib.requests.filter((r) => !isColumnsRequest(r)) },
  };
};
/** The exit code of a usage error in this repo (commander's default is 1; most repos use 2). */
const USAGE_EXIT = 2;
import { MastrClient as Client } from "@maschinenlesbar.org/marktstammdatenregister-client/internal/client";
interface Input<T = string | null> {
  name: string;
  /** CLI argv that sends `value`. */
  argv: (value: string) => string[];
  /** The same in the library. */
  lib: (client: Client, value: string) => Promise<unknown>;
  /** The value as it went out, read from the request URL (null when it wasn't sent). */
  sent: (url: URL) => T;
}
/** The `filter` parameter split the register's way, on every `~`. */
const filterParts = (url: URL): string[] => (url.searchParams.get("filter") ?? "").split("~");
/** Every free-text value (sent as a query parameter). */
const textInputs: Input[] = [];
/**
 * Every token: a FilterName in a `--filter` spec (compared exactly by the register; checked
 * against a column list that holds the corpus's valid names, so those are sent and the rest is
 * refused as unknown), and a `--sort` key, sent as `<value>-desc` (the documented syntax,
 * FieldKey-asc|desc; a key that isn't a record field name is refused).
 */
const idInputs: Input[] = [
  {
    name: "--filter FilterName",
    argv: (v) => ["stromerzeugung", "--filter", `${v}~eq~'x'`],
    lib: (c, v) => c.stromerzeugung({ filter: `${v}~eq~'x'` }),
    sent: (u) => filterParts(u)[0] ?? null,
  },
  {
    name: "--sort",
    argv: (v) => ["stromerzeugung", "--sort", `${v}-desc`],
    lib: (c, v) => c.stromerzeugung({ sort: `${v}-desc` }),
    sent: (u) => u.searchParams.get("sort")?.replace(/-desc$/, "") ?? null,
  },
];
/**
 * Every comma-separated list option. None in mastr: a comma list exists only inside a filter
 * value (`Energieträger~eq~'2497,2498'`), the DSL's own; its codes are checked against the
 * dropdown's (`resolveFilter`).
 */
const listInputs: Array<Input<string[] | null>> = [];
/** The id as the repo sends it (trimmed, NFC; a repo with numeric ids may drop leading zeros). */
const canonicalId = (value: string): string => value.trim().normalize("NFC");
/** A valid answer to any of these requests; the column list names the corpus's valid FilterNames. */
const respond = withColumns(() => jsonResponse({ Data: [], Total: 0, Errors: null }), [
  { FilterName: "a1", Type: "text" },
  { FilterName: "a b", Type: "text" },
  { FilterName: "\u00e9", Type: "text" },
  { FilterName: "Ort", Type: "text" },
]);
// --------------------------------------------------------------------------------------

/** Values every input refuses: blank, only invisible characters or combining marks, a lone surrogate, a control or format character. */
const REFUSED = [
  "", " ", "\u00a0", "\n\t", "\u3000", "\u200b", "\u00ad", "\u200d", "\ufeff", "\u0301\u0308", " \u200b ",
  "a\u200bb", "M\u00fcl\u00adler", "\u202eabc", "a\u0000b", "a\u001bb", "a\u0085b", "\ud800", "a\udc00b", "x\ud83d",
];
const TEXT_CORPUS = [
  "Müller", "Mu\u0308ller", "  Müller  ", "\u00a0Müller\u00a0", "Müller\n", "\tMüller", "a  b", "A\u030a",
  "ﬁ", "x".repeat(5000), "\u3000x", "😀 smile", "a\u200db",
];
const ID_CORPUS = ["a1", " a1 ", "a1\n", " a1", ".", "..", " .. ", "a1/../a2", "a1/", "/a1", "%2e%2e", "a b", "e\u0301"];
const LIST_REFUSED = ["", ",", " , ", "a1,,a2", "a1,", ",a1", "a1,\u200b", "a1,a\u200bb", "\ud800,a1"];
const LIST_CORPUS = ["a1", "a1,a2", " a1 , a2 ", "e\u0301,a2", "a1,a1"];

type Outcome = Awaited<ReturnType<typeof parity>>;

/** Both sides refused before any request, or both sent the same requests. Returns the one sent URL, if any. */
function sameOutcome(o: Outcome, label: string): URL | undefined {
  if (o.cli.code === USAGE_EXIT) {
    assert.deepEqual(o.cli.requests, [], `${label}: the CLI refused but sent a request`);
    assert.equal(o.lib.ok, false, `${label}: the CLI refused, the library resolved`);
    assert.deepEqual(o.lib.requests, [], `${label}: the library sent a request`);
    assert.match(o.lib.error?.name ?? "", /ValidationError$/, `${label}: ${String(o.lib.error)}`);
    return undefined;
  }
  assert.equal(o.cli.code, 0, `${label}: CLI exit ${o.cli.code}: ${o.cli.err}`);
  assert.equal(o.lib.ok, true, `${label}: the library rejected: ${String(o.lib.error?.message)}`);
  assert.deepEqual(o.lib.requests.map((r) => r.url), o.cli.requests.map((r) => r.url), `${label}: different requests`);
  assert.equal(o.cli.requests.length, 1, label);
  return new URL(o.cli.requests[0]!.url);
}

/** A control, format or lone-surrogate character in `value`, or undefined. */
const INVISIBLE = /[\p{Cc}\p{Cf}]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

/** A refusal of `value` shows its invisible character as an escape on both sides, never raw (D10). */
function refusedVisibly(o: Outcome, value: string, label: string): void {
  const blank = value.replace(/[\s\p{Cc}\p{Cf}\p{M}]/gu, "") === "";
  const ch = INVISIBLE.exec(value.trim())?.[0];
  if (ch === undefined || blank) return;
  const escape = `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  assert.ok(o.cli.err.toLowerCase().includes(escape), `${label}: the CLI's refusal doesn't show ${escape}: ${o.cli.err}`);
  assert.ok(!o.cli.err.includes(ch), `${label}: the CLI's refusal shows the character raw`);
  assert.ok((o.lib.error?.message ?? "").toLowerCase().includes(escape), `${label}: the library's refusal doesn't show ${escape}: ${o.lib.error?.message}`);
}

const short = (value: string): string => JSON.stringify(value.length > 20 ? `${value.slice(0, 20)}…` : value);

test("P24: a text filter is sent trimmed and in composed Unicode, or refused; never blank", async () => {
  for (const input of textInputs) {
    for (const value of TEXT_CORPUS) {
      const label = `${input.name} ${short(value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      if (url === undefined) continue;
      const sent = input.sent(url);
      assert.ok(sent !== null && sent !== "", `${label}: not sent`);
      const canonical = [value.trim().normalize("NFC"), value.trim().normalize("NFKC")];
      assert.ok(canonical.includes(sent), `${label}: sent ${JSON.stringify(sent)}`);
    }
  }
});

test("P24: every input refuses a blank, invisible, control or half character, before any request, showing it escaped", async () => {
  const inputs = [...textInputs, ...idInputs];
  for (const input of inputs) {
    for (const value of REFUSED) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const o = await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond);
      assert.equal(o.cli.code, USAGE_EXIT, `${label}: CLI exit ${o.cli.code}, sent ${o.cli.requests.map((r) => r.url).join(" ")}`);
      assert.equal(sameOutcome(o, label), undefined, label);
      refusedVisibly(o, value, label);
    }
  }
});

test("P24: an id is sent in its canonical form, or refused; never empty, a dot segment or with a slash", async () => {
  for (const input of idInputs) {
    for (const value of ID_CORPUS) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      const id = canonicalId(value);
      if (id === "" || id === "." || id === ".." || id.includes("/")) {
        assert.equal(url, undefined, `${label}: sent although it would re-target the request`);
        continue;
      }
      if (url === undefined) continue;
      assert.equal(input.sent(url), id, label);
    }
  }
});

test("P24: a list is canonicalised item by item; an empty or invisible item refuses the whole list", async () => {
  for (const input of listInputs) {
    for (const value of LIST_REFUSED) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const o = await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond);
      assert.equal(o.cli.code, USAGE_EXIT, `${label}: CLI exit ${o.cli.code}`);
      assert.equal(sameOutcome(o, label), undefined, label);
      refusedVisibly(o, value.split(",").find((item) => INVISIBLE.test(item)) ?? "", label);
    }
    for (const value of LIST_CORPUS) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      assert.ok(url !== undefined, `${label}: refused`);
      assert.deepEqual(input.sent(url), value.split(",").map(canonicalId), label);
    }
  }
});
