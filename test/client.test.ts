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

test("control characters in a 200 Errors envelope are stripped from the message (MASTR-02)", async () => {
  // Built via char code so no raw control byte appears in this source file.
  const ESC = String.fromCharCode(0x1b);
  const { client } = clientFor({ Errors: `${ESC}]0;spoof${ESC}\\Die Anfrage ist Null.` });
  await assert.rejects(
    () => client.stromerzeugung(),
    (err) => {
      assert.ok(err instanceof MastrApiError);
      assert.equal(err.message.includes(ESC), false, "ESC must not reach the message");
      assert.match(err.message, /Die Anfrage ist Null/);
      return true;
    },
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
  // Rebuilt objects have a null prototype (prototype-pollution hardening), so
  // compare the JSON projection — the own enumerable data is what downstream sees.
  assert.deepEqual(JSON.parse(JSON.stringify(out)), {
    a: "1970-01-01T00:00:00.000Z",
    b: [{ c: "1970-01-01T00:00:01.000Z" }],
    d: "plain",
    e: 5,
  });
});

test("isoifyDates leaves an out-of-range /Date(ms)/ as-is instead of throwing", () => {
  // 1e20 ms is far outside the valid Date range -> Invalid Date; must not throw.
  const bad = "/Date(99999999999999999999)/";
  assert.doesNotThrow(() => isoifyDates({ x: bad }));
  assert.deepEqual(JSON.parse(JSON.stringify(isoifyDates({ x: bad }))), { x: bad });
});

test("isoifyDates does not reparent or pollute on an attacker '__proto__' key", () => {
  // A response body can carry an own property literally named "__proto__"
  // (JSON.parse makes it an own key). isoifyDates must keep it an own property
  // rather than routing it through the Object.prototype.__proto__ setter and
  // reparenting the rebuilt object, and must never touch the global prototype.
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"ok":"/Date(0)/"}');
  const out = isoifyDates(hostile) as Record<string, unknown>;

  // The date field is still transformed as usual.
  assert.equal(out["ok"], "1970-01-01T00:00:00.000Z");
  // "__proto__" survived as a real own property, not as a reparented prototype.
  assert.equal(Object.prototype.hasOwnProperty.call(out, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(out), null);
  // No global prototype pollution occurred.
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  assert.equal((Object.prototype as Record<string, unknown>)["polluted"], undefined);
  // The rebuilt object still round-trips through JSON.stringify unchanged.
  const round = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
  assert.equal(round["ok"], "1970-01-01T00:00:00.000Z");
});
