import { test } from "node:test";
import assert from "node:assert/strict";
import { MastrClient, parseMsDate, isoifyDates } from "../src/client/client.js";
import { MastrApiError, MastrParseError, MastrValidationError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, queryOf, registerResponder } from "./helpers.js";
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
  const mt = makeMockTransport(registerResponder(fx.unitPage));
  const client = new MastrClient({ transport: mt.transport });
  await client.stromerzeugung({ page: 3, pageSize: 50, sort: "Bruttoleistung-desc", filter: "Ort~eq~'1'" });
  const q = queryOf(mt.last());
  assert.equal(q.get("page"), "3");
  assert.equal(q.get("pageSize"), "50");
  assert.equal(q.get("sort"), "Bruttoleistung-desc");
  assert.equal(q.get("filter"), "Ort~eq~'1'");
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

test("MastrClient rejects a non-http(s) base URL even with a custom transport", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(registerResponder(fx.unitPage));
    assert.throws(
      () => new MastrClient({ baseUrl, transport: mt.transport }),
      (err) => err instanceof MastrValidationError && /Only http and https URLs are supported/.test(err.message),
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("units() rejects a filter with ~or~ before any request (MastrValidationError)", async () => {
  const { client, mt } = clientFor(fx.unitPage);
  await assert.rejects(
    () => client.stromerzeugung({ filter: "Energieträger~eq~'2497'~or~Energieträger~eq~'2498'" }),
    (err) => err instanceof MastrValidationError && /Invalid filter: "~or~" is not supported/.test(err.message),
  );
  assert.equal(mt.calls.length, 0);
});

test("a malformed 200 envelope throws MastrParseError instead of reading as 0 matches", async () => {
  const path = "/Einheit/EinheitJson/GetErweiterteOeffentlicheEinheitStromerzeugung";
  const cases: [unknown, string][] = [
    [null, "a JSON object with Data and Total"],
    ["hello", "a JSON object with Data and Total"],
    [[1, 2, 3], "a JSON object with Data and Total"],
    [{}, "a numeric Total"],
    [{ Data: [{ a: 1 }], Errors: null }, "a numeric Total"],
    [{ Data: "not-an-array", Total: "lots" }, "a numeric Total"],
    [{ Data: [], Total: -1 }, "a numeric Total"],
    [{ Data: [], Total: 1.5 }, "a numeric Total"],
    [{ Data: "not-an-array", Total: 3 }, "a Data array"],
    [{ Data: null, Total: 3 }, "a Data array"],
  ];
  for (const [body, expected] of cases) {
    const { client } = clientFor(body);
    await assert.rejects(
      () => client.stromerzeugung(),
      (err) =>
        err instanceof MastrParseError &&
        err.message === `Unexpected response shape from ${path}: expected ${expected}.`,
      JSON.stringify(body),
    );
  }
});

test("any non-null Errors in a 200 envelope throws MastrApiError with its messages", async () => {
  for (const [errors, detail] of [
    [{ "": { errors: ["Invalid filter"] } }, "Invalid filter"],
    [["bad filter", "bad filter", "other"], "bad filter; other"],
    [{ x: { errors: [{ ErrorMessage: "Feld unbekannt" }] } }, "Feld unbekannt"],
  ] as const) {
    const { client } = clientFor({ Data: [], Total: 0, Errors: errors });
    await assert.rejects(
      () => client.stromerzeugung(),
      (err) => err instanceof MastrApiError && err.detail === detail && err.message.endsWith(`: ${detail}`),
    );
  }
  const { client } = clientFor({ Data: [], Total: 0, Errors: 42 });
  await assert.rejects(
    () => client.stromerzeugung(),
    (err) => err instanceof MastrApiError && err.detail === undefined && /^MaStR error for GET /.test(err.message),
  );
});

test("Data null with Total 0 is an empty page", async () => {
  const { client } = clientFor({ Data: null, Total: 0, Errors: null });
  assert.deepEqual(await client.stromerzeugung(), { total: 0, data: [] });
});

test("filterColumns() throws on an Errors envelope or a non-array reply instead of returning []", async () => {
  const { client: c1 } = clientFor(fx.nullRequestError);
  await assert.rejects(
    () => c1.filterColumns("stromerzeugung"),
    (err) => err instanceof MastrApiError && err.detail === "Die Anfrage ist Null.",
  );
  for (const body of [{ Data: null, Total: 0 }, "x", [1, 2], null]) {
    const { client } = clientFor(body);
    await assert.rejects(
      () => client.filterColumns("stromerzeugung"),
      (err) => err instanceof MastrParseError && /expected a JSON array of filter columns\.$/.test(err.message),
      JSON.stringify(body),
    );
  }
});

test("units() rejects a malformed filter before any request (MastrValidationError)", async () => {
  const { client, mt } = clientFor(fx.unitPage);
  for (const filter of ["foo", "Ort~EQ~'x'", "Ort~eq~'x'~and~"]) {
    await assert.rejects(
      () => client.stromerzeugung({ filter }),
      (err) => err instanceof MastrValidationError && /^Invalid filter: /.test(err.message),
      filter,
    );
  }
  assert.equal(mt.calls.length, 0);
});

test("units() rejects an unknown category and out-of-range paging before any request", async () => {
  const { client, mt } = clientFor(fx.unitPage);
  const bad: [unknown, Record<string, unknown>, RegExp][] = [
    ["foo", {}, /^Invalid category: expected one of stromerzeugung, stromverbrauch, gaserzeugung, gasverbrauch, got "foo"\.$/],
    ["__proto__", {}, /^Invalid category: .*got "__proto__"\.$/],
    ["toString", {}, /^Invalid category: /],
    ["stromerzeugung", { page: -5 }, /^Invalid page: expected an integer from 1 to 1000000, got -5\.$/],
    ["stromerzeugung", { page: 1.5 }, /^Invalid page: /],
    ["stromerzeugung", { pageSize: 0 }, /^Invalid pageSize: expected an integer from 1 to 5000, got 0\.$/],
    ["stromerzeugung", { pageSize: 5001 }, /^Invalid pageSize: /],
    ["stromerzeugung", { pageSize: "10" }, /^Invalid pageSize: .*got "10"\.$/],
    ["stromerzeugung", { page: Number.NaN }, /^Invalid page: .*got NaN\.$/],
  ];
  for (const [category, query, message] of bad) {
    await assert.rejects(
      () => client.units(category as "stromerzeugung", query),
      (err) => err instanceof MastrValidationError && message.test(err.message),
      `${String(category)} ${JSON.stringify(query)}`,
    );
  }
  await assert.rejects(() => client.filterColumns("foo" as "stromerzeugung"), MastrValidationError);
  assert.equal(mt.calls.length, 0);
});

test("parseMsDate accepts the offset form and returns null for an out-of-range value", () => {
  assert.equal(parseMsDate("/Date(1548979200000+0100)/")?.toISOString(), "2019-02-01T00:00:00.000Z");
  assert.equal(parseMsDate("/Date(1548979200000-0500)/")?.getTime(), 1548979200000);
  assert.equal(parseMsDate("/Date(99999999999999999)/"), null);
  assert.equal(parseMsDate("/Date(1548979200000+01)/"), null);
  assert.deepEqual(JSON.parse(JSON.stringify(isoifyDates({ d: "/Date(0+0200)/" }))), { d: "1970-01-01T00:00:00.000Z" });
});

test('units() and filterColumns() turn the register\'s {"Error":true} reply into a MastrApiError that says what to fix (findings 01#3, 06#1)', async () => {
  for (const body of [
    { Error: true, Message: null, Type: "danger", Icon: "fas fa-times-circle" },
    { Error: true, Message: "Ungültiger Filterwert", Type: "danger" },
  ]) {
    const client = new MastrClient({ transport: makeMockTransport(() => jsonResponse(body)).transport });
    for (const call of [() => client.stromerzeugung(), () => client.filterColumns("stromerzeugung")]) {
      await assert.rejects(call(), (err: unknown) => {
        assert.ok(err instanceof MastrApiError, String(err));
        assert.equal(err.status, undefined);
        assert.match(err.message, /the register rejected the request/);
        assert.match(err.message, /dropdown label instead of its code/);
        if (body.Message !== null) assert.match(err.message, /Ungültiger Filterwert/);
        return true;
      });
    }
  }
});

test("units() rejects a page whose rows contradict its Total or the pageSize (finding 03#3)", async () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ Id: i }));
  for (const [body, pageSize, pattern] of [
    [{ Data: rows(2), Total: 0, Errors: null }, 25, /a Total of at least the 2 rows on the page, got 0/],
    [{ Data: rows(7), Total: 7, Errors: null }, 1, /at most 1 rows \(the pageSize\), got 7/],
  ] as const) {
    const client = new MastrClient({ transport: makeMockTransport(() => jsonResponse(body)).transport });
    await assert.rejects(client.stromerzeugung({ pageSize }), (err: unknown) => err instanceof MastrParseError && pattern.test(err.message));
  }
});

test("the filter check names a dropdown label's code and refuses codes the column doesn't list", async () => {
  const client = new MastrClient({ transport: makeMockTransport(registerResponder(fx.unitPage)).transport });
  for (const [filter, pattern] of [
    ["Energieträger~eq~'Wind'", /"Wind" is not a code of the dropdown column "Energieträger".*It is the label of code 2497.*Energieträger~eq~'2497'/],
    ["Energieträger~eq~'2495,abc'", /"abc" is not a code of the dropdown column "Energieträger".*Codes: 2495 \(Solare Strahlungsenergie\)/],
    ["Energieträger~neq~'9999'", /"9999" is not a code/],
    ["energieträger~eq~'2495'~and~Bundesland~eq~'Bayern'", /It is the label of code 1403/],
  ] as const) {
    await assert.rejects(client.stromerzeugung({ filter }), (err: unknown) => err instanceof MastrValidationError && pattern.test(err.message), filter);
  }
  // A comma list of listed codes (with a space after the comma) passes, as do gt/lt on a dropdown.
  await client.stromerzeugung({ filter: "Energieträger~eq~'2495, 2497'~and~Energieträger~gt~'2000'" });
});

test("the filter check suggests close names and writes a name in another case the register's way", async () => {
  const mt = makeMockTransport(registerResponder(fx.unitPage));
  const client = new MastrClient({ transport: mt.transport });
  await assert.rejects(
    client.stromerzeugung({ filter: "Energietäger~eq~'2495'" }),
    (err: unknown) =>
      err instanceof MastrValidationError &&
      /unknown FilterName "Energietäger" in condition 1: stromerzeugung has no such column/.test(err.message) &&
      /Did you mean "Energieträger"\?/.test(err.message) &&
      /`mastr filters stromerzeugung`/.test(err.message),
  );
  await client.stromerzeugung({ filter: "ORT~eq~'Münster'" });
  assert.equal(queryOf(mt.last()).get("filter"), "Ort~eq~'Münster'");
});

test("the filter columns are fetched once per client and category; a failed fetch is retried next time", async () => {
  let failColumns = true;
  const mt = makeMockTransport((req) => {
    if (new URL(req.url).pathname.includes("/GetFilterColumns") && failColumns) {
      failColumns = false;
      return jsonResponse({ Errors: "kaputt" });
    }
    return registerResponder(fx.unitPage)(req);
  });
  const client = new MastrClient({ transport: mt.transport });
  await assert.rejects(client.count("stromerzeugung", { filter: "Ort~eq~'a'" }), MastrApiError);
  await client.count("stromerzeugung", { filter: "Ort~eq~'a'" });
  await client.count("stromerzeugung", { filter: "Ort~eq~'b'" });
  const columnRequests = mt.calls.filter((r) => new URL(r.url).pathname.includes("/GetFilterColumns"));
  assert.equal(columnRequests.length, 2);
});

test("allowUnknownFilters sends the normalised filter without the column check (no extra request)", async () => {
  const mt = makeMockTransport(registerResponder(fx.unitPage));
  const client = new MastrClient({ transport: mt.transport, allowUnknownFilters: true });
  await client.count("stromerzeugung", { filter: " Neue Spalte~eq~'1'" });
  assert.equal(mt.calls.length, 1);
  assert.equal(queryOf(mt.last()).get("filter"), "Neue Spalte~eq~'1'");
  assert.throws(() => new MastrClient({ allowUnknownFilters: "yes" as unknown as boolean }), MastrValidationError);
});

test("null/nn on a number, dropdown or boolean column is a validation error; on text, date and MaStR-number columns it goes out (finding 06#1)", async () => {
  const mt = makeMockTransport(registerResponder(fx.unitPage));
  const client = new MastrClient({ transport: mt.transport });
  for (const filter of ["Bruttoleistung der Einheit~null~''", "Energieträger~null~''", "Bürgerenergie~nn~''", "Bürgerenergie~null~''"]) {
    await assert.rejects(
      client.count("stromerzeugung", { filter }),
      (err: unknown) => err instanceof MastrValidationError && /the register answers null\/nn on number, dropdown and boolean columns with an error/.test(err.message),
      filter,
    );
  }
  for (const filter of ["Ort~null~''", "Inbetriebnahmedatum der Einheit~nn~''", "MaStR-Nr. der Einheit~nn~''"]) {
    await client.count("stromerzeugung", { filter });
    assert.equal(queryOf(mt.last()).get("filter"), filter);
  }
});
