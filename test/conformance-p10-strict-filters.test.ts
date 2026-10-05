// Conformance test P10 (fix plan 2026-10-06): a filter the API would ignore never goes out.
// An unknown, misspelled or `__proto__` key, an unknown filter name, an array or NaN where
// the API takes one value are the library's validation error before any data request; a
// filter name that is only spelled differently (NFD, padding, case) is normalised or
// rejected, never sent as typed; a repeated filter flag is combined or rejected, never
// "last one wins". The API answers all of these with the whole unfiltered set or a wrong
// count and HTTP 200. Shared across the *-cli repos with filters; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { MastrClient as Client } from "../src/client/client.js";
import { MastrValidationError as ValidationError } from "../src/client/errors.js";
/** The library's filtered call, with its query/parameter object passed through as is. */
const call = (client: Client, query: Record<string, unknown>): Promise<unknown> =>
  client.stromerzeugung(query as never);
/** A valid query, and the filter it sends (read back from the request by `sentFilter`). */
const GOOD = { query: { filter: "Energieträger~eq~'2495'~and~Bundesland~eq~'1403'" } };
const GOOD_SENT = "Energieträger~eq~'2495'~and~Bundesland~eq~'1403'";
/** What a data request carries as its filter (to compare with GOOD_SENT). */
const sentFilter = (req: HttpRequest): string | null => new URL(req.url).searchParams.get("filter");
/** Queries with a key the call doesn't take: unknown, misspelled, `__proto__` (from JSON). */
const BAD_KEYS: Array<[string, Record<string, unknown>]> = [
  ["unknown key", { bundesland: "1403" }],
  ["misspelled key", { filtr: "Energieträger~eq~'2495'" }],
  ["wrong-case key", { Filter: "Energieträger~eq~'2495'" }],
  ["__proto__ key", JSON.parse('{"__proto__": {"filter": "Energieträger~eq~\'2495\'"}}') as Record<string, unknown>],
];
/** Queries whose filter names the API doesn't have. */
const BAD_FILTER_NAMES: Array<[string, Record<string, unknown>]> = [
  ["unknown name", { filter: "Leistung~gt~'5000'" }],
  ["misspelled name", { filter: "Energietäger~eq~'2495'" }],
  ["__proto__ name", { filter: "__proto__~eq~'1'" }],
  ["constructor name", { filter: "constructor~eq~'1'" }],
  ["a name of another category", { filter: "Maximale Gasbezugsleistung~gt~'5'" }],
];
/** Values of the wrong type: arrays where the API takes one value, NaN, objects. */
const BAD_VALUES: Array<[string, Record<string, unknown>]> = [
  ["array filter", { filter: ["Energieträger~eq~'2495'", "Bundesland~eq~'1403'"] }],
  ["object filter", { filter: { Energieträger: "2495" } }],
  ["NaN page", { page: Number.NaN }],
  ["NaN pageSize", { pageSize: Number.NaN }],
  ["array page", { page: [1, 2] }],
];
/**
 * Queries that differ from GOOD only in how a filter name is spelled (decomposed umlaut,
 * padding, case): the API ignores such a name. "normalise" = sent as GOOD_SENT; "reject" =
 * the validation error.
 */
const UNNORMALISED: Array<[string, Record<string, unknown>]> = [
  ["NFD umlaut", { filter: "Energietra\u0308ger~eq~'2495'~and~Bundesland~eq~'1403'" }],
  ["space after ~and~", { filter: "Energieträger~eq~'2495'~and~ Bundesland~eq~'1403'" }],
  ["padded name", { filter: " Energieträger ~eq~'2495'~and~Bundesland~eq~'1403'" }],
  ["lower case", { filter: "energieträger~eq~'2495'~and~bundesland~eq~'1403'" }],
];
const UNNORMALISED_POLICY = "normalise" as "normalise" | "reject";
/** The CLI's filter flag given twice (the two halves of GOOD), and what the repo does with it. */
const REPEATED_FLAG_ARGV = ["stromerzeugung", "--total", "--filter", "Energieträger~eq~'2495'", "--filter", "Bundesland~eq~'1403'"];
const REPEATED_POLICY = "combine" as "combine" | "reject";
/** A single-value option given twice, which must be a usage error. */
const REPEATED_SINGLE_ARGV = ["stromerzeugung", "--sort", "Bruttoleistung-desc", "--sort", "Bruttoleistung-asc"];
const USAGE_EXIT = 2;
/** The register's filter columns for the category (the names the client checks against). */
const COLUMNS = [
  { FilterName: "Energieträger", Type: "multidropdown", ListObject: [{ Name: "Solare Strahlungsenergie", Value: "2495" }] },
  { FilterName: "Bundesland", Type: "multidropdown", ListObject: [{ Name: "Bayern", Value: "1403" }] },
  { FilterName: "Bruttoleistung der Einheit", Type: "number", ListObject: [] },
];
/** True for a request that fetches data (not the column list the client checks names with). */
const isDataRequest = (req: HttpRequest): boolean => !new URL(req.url).pathname.includes("/GetFilterColumns");
/** The answer to any request. */
const respond = (req: HttpRequest): HttpResponse => ({
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: Buffer.from(JSON.stringify(isDataRequest(req) ? { Data: [], Total: 1456625, Errors: null } : COLUMNS)),
});
/** CliDeps for this repo. */
const makeDeps = (io: CliDeps["io"], transport: (req: HttpRequest) => Promise<HttpResponse>): CliDeps => ({
  io,
  createClient: (opts) => new Client({ ...opts, transport }),
});
// --------------------------------------------------------------------------------------

function recorder() {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    return respond(req);
  };
  return { transport, data: () => requests.filter(isDataRequest) };
}

async function rejectsBeforeData(label: string, query: Record<string, unknown>): Promise<void> {
  const r = recorder();
  await assert.rejects(call(new Client({ transport: r.transport }), query), ValidationError, label);
  assert.equal(r.data().length, 0, `${label}: a data request went out`);
}

test("P10: the valid query goes out as given", async () => {
  const r = recorder();
  await call(new Client({ transport: r.transport }), GOOD.query);
  assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
});

test("P10: an unknown, misspelled or __proto__ key is a validation error before any data request", async () => {
  for (const [label, query] of BAD_KEYS) await rejectsBeforeData(label, query);
});

test("P10: a filter name the API doesn't have is a validation error before any data request", async () => {
  for (const [label, query] of BAD_FILTER_NAMES) await rejectsBeforeData(label, query);
});

test("P10: an array, object or NaN where the API takes one value is a validation error", async () => {
  for (const [label, query] of BAD_VALUES) await rejectsBeforeData(label, query);
});

test("P10: a filter name spelled differently is normalised or rejected, never sent as typed", async () => {
  for (const [label, query] of UNNORMALISED) {
    if (UNNORMALISED_POLICY === "reject") {
      await rejectsBeforeData(label, query);
      continue;
    }
    const r = recorder();
    await call(new Client({ transport: r.transport }), query);
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT], label);
  }
});

test("P10: a repeated filter flag is combined or rejected, never last-one-wins", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_FLAG_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  if (REPEATED_POLICY === "combine") {
    assert.equal(code, 0, err.join("\n"));
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
  } else {
    assert.equal(code, USAGE_EXIT);
    assert.equal(r.data().length, 0);
  }
});

test("P10: a repeated single-value option is a usage error", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_SINGLE_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  assert.equal(code, USAGE_EXIT, err.join("\n"));
  assert.equal(r.data().length, 0);
});
