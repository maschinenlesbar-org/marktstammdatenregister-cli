import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine } from "../src/client/engine.js";
import { MastrApiError, MastrParseError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse, queryOf } from "./helpers.js";
import * as fx from "./fixtures.js";

test("buildUrl appends the path and query string", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/MaStR/" });
  assert.equal(e.buildUrl("/x", { page: 1 }), "https://example.test/MaStR/x?page=1");
  assert.equal(e.buildUrl("y"), "https://example.test/MaStR/y");
});

test("getJson performs a GET with query params and browser-style headers", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.unitPage));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/Einheit/EinheitJson/GetErweiterteOeffentlicheEinheitStromerzeugung", {
    page: 1,
    pageSize: 2,
  });
  const req = mt.last();
  assert.equal(req.method, "GET");
  assert.equal(req.headers?.["Accept"], "application/json");
  assert.equal(req.headers?.["User-Agent"], "ua/1");
  assert.equal(req.headers?.["X-Requested-With"], "XMLHttpRequest");
  const q = queryOf(req);
  assert.equal(q.get("page"), "1");
  assert.equal(q.get("pageSize"), "2");
});

test("getJson parses and returns the JSON body", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.unitPage));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), fx.unitPage);
});

test("getJson returns null on an empty/204 body", async () => {
  const mt = makeMockTransport(() => rawResponse("", "application/json", 204));
  const e = new RequestEngine({ transport: mt.transport });
  assert.equal(await e.getJson("/x"), null);
});

test("getJson throws MastrParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), MastrParseError);
});

test("a non-2xx surfaces as a MastrApiError with the parsed detail", async () => {
  const mt = makeMockTransport(() => jsonResponse({ message: "kaputt" }, 400));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof MastrApiError && err.status === 400 && /kaputt/.test(err.message),
  );
});

test("a non-JSON (plain-text) error body is surfaced as the detail", async () => {
  const mt = makeMockTransport(() => rawResponse("Server overloaded, try later", "text/plain", 500));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof MastrApiError && err.status === 500 && /Server overloaded/.test(err.message),
  );
});

test("a 3xx is NOT followed and surfaces as an error", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return { status: 302, headers: { location: "https://example.test/login" }, body: Buffer.alloc(0) };
  });
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), (err) => err instanceof MastrApiError && err.status === 302);
  assert.equal(calls, 1);
});

test("a 503 is retried up to maxRetries then surfaces as a MastrApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ message: "busy" }, 503);
  });
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 2, sleep: async () => {} });
  await assert.rejects(() => e.getJson("/x"), (err) => err instanceof MastrApiError && err.status === 503);
  assert.equal(calls, 3);
});
