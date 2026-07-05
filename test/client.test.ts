import { test } from "node:test";
import assert from "node:assert/strict";
import { MastrClient, parseMsDate, isoifyDates } from "../src/client/client.js";
import { MastrApiError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, queryOf } from "./helpers.js";
import * as fx from "./fixtures.js";

function clientFor(body: unknown) {
  const mt = makeMockTransport(() => jsonResponse(body));
  return { client: new MastrClient({ transport: mt.transport }), mt };
}

test("stromerzeugung() ALWAYS sends the full Kendo param set (sort/page/pageSize/group/filter)", async () => {
  const { client, mt } = clientFor(fx.unitPage);
  await client.stromerzeugung();
  const q = queryOf(mt.last());
  // group and filter must be present (even empty) or the server returns "Die Anfrage ist Null."
  for (const key of ["sort", "page", "pageSize", "group", "filter"]) {
    assert.equal(q.has(key), true, `missing param ${key}`);
  }
  assert.equal(q.get("group"), "");
  assert.equal(q.get("filter"), "");
  assert.equal(q.get("page"), "1");
  assert.equal(
    new URL(mt.last().url).pathname.endsWith("/GetErweiterteOeffentlicheEinheitStromerzeugung"),
    true,
  );
});

test("returns { total, data } from the envelope", async () => {
  const { client } = clientFor(fx.unitPage);
  const page = await client.stromerzeugung({ pageSize: 2 });
  assert.equal(page.total, 9063887);
  assert.equal(page.data.length, 2);
  assert.equal(page.data[0]?.MaStRNummer, "SEE984033548619");
});

test("query options are forwarded", async () => {
  const { client, mt } = clientFor(fx.unitPage);
  await client.stromerzeugung({ page: 3, pageSize: 50, sort: "Bruttoleistung-desc", filter: "X~eq~'1'" });
  const q = queryOf(mt.last());
  assert.equal(q.get("page"), "3");
  assert.equal(q.get("pageSize"), "50");
  assert.equal(q.get("sort"), "Bruttoleistung-desc");
  assert.equal(q.get("filter"), "X~eq~'1'");
});

test("each category hits its own endpoint", async () => {
  for (const [method, suffix] of [
    ["stromverbrauch", "Stromverbrauch"],
    ["gaserzeugung", "Gaserzeugung"],
    ["gasverbrauch", "Gasverbrauch"],
  ] as const) {
    const { client, mt } = clientFor(fx.unitPage);
    await client[method]();
    assert.equal(
      new URL(mt.last().url).pathname.endsWith(`/GetErweiterteOeffentlicheEinheit${suffix}`),
      true,
    );
  }
});

test("a logical Errors envelope throws MastrApiError", async () => {
  const { client } = clientFor(fx.nullRequestError);
  await assert.rejects(
    () => client.stromerzeugung(),
    (err) => err instanceof MastrApiError && /Die Anfrage ist Null/.test(err.message),
  );
});

test("filterColumns() hits the GetFilterColumns endpoint and returns the array", async () => {
  const { client, mt } = clientFor(fx.filterColumns);
  const cols = await client.filterColumns("stromerzeugung");
  assert.equal(
    new URL(mt.last().url).pathname.endsWith("/GetFilterColumnsErweiterteOeffentlicheEinheitStromerzeugung"),
    true,
  );
  assert.equal(cols[0]?.FilterName, "Art der Solaranlage");
  assert.equal(cols[0]?.ListObject?.[0]?.Value, "852");
});

test("parseMsDate parses /Date(ms)/ and rejects other strings", () => {
  assert.equal(parseMsDate("/Date(0)/")?.toISOString(), "1970-01-01T00:00:00.000Z");
  assert.equal(parseMsDate("/Date(1548979200000)/")?.getTime(), 1548979200000);
  assert.equal(parseMsDate("2019-01-31"), null);
  assert.equal(parseMsDate("not a date"), null);
});

test("isoifyDates recursively rewrites /Date(ms)/ strings", () => {
  const out = isoifyDates({ a: "/Date(0)/", b: [{ c: "/Date(1000)/" }], d: "plain", e: 5 });
  assert.deepEqual(out, {
    a: "1970-01-01T00:00:00.000Z",
    b: [{ c: "1970-01-01T00:00:01.000Z" }],
    d: "plain",
    e: 5,
  });
});
