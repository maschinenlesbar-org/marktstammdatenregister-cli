import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine, parseRetryAfter } from "../src/client/engine.js";
import { MastrApiError, MastrNetworkError, MastrParseError, redactUrl } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse, queryOf } from "./helpers.js";
import * as fx from "./fixtures.js";

// Built via char code so no raw control byte ever appears in this source file.
const ESC = String.fromCharCode(0x1b);

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

test("getJson throws MastrParseError on an empty/204 body (never a silent null)", async () => {
  for (const [body, status] of [["", 204], ["", 200], ["  ", 200]] as const) {
    const mt = makeMockTransport(() => rawResponse(body, "application/json", status));
    const e = new RequestEngine({ transport: mt.transport });
    await assert.rejects(
      () => e.getJson("/x"),
      (err) => err instanceof MastrParseError && err.message === "Empty response body from /x",
    );
  }
});

test("a non-2xx with a Kendo ModelState Errors object uses its messages as the detail", async () => {
  const mt = makeMockTransport(() => jsonResponse({ Errors: { "": { errors: ["Invalid filter"] } } }, 400));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof MastrApiError && /HTTP 400 for GET .*: Invalid filter$/.test(err.message),
  );
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

test("control characters in a JSON error detail are stripped before reaching the message (MASTR-02)", async () => {
  const mt = makeMockTransport(() => jsonResponse({ Errors: `${ESC}]0;pwned${ESC}evil` }, 400));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => {
      assert.ok(err instanceof MastrApiError);
      assert.equal(err.message.includes(ESC), false, "ESC must not reach the message");
      assert.match(err.message, /pwnedevil/);
      return true;
    },
  );
});

test("control characters in a plain-text error snippet are stripped (MASTR-02)", async () => {
  const mt = makeMockTransport(() => rawResponse(`boom${ESC}]0;x`, "text/plain", 500));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof MastrApiError && !err.message.includes(ESC) && /boom/.test(err.message),
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

test("a non-http(s) base URL is rejected at construction, before any request", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse(fx.unitPage));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err) => err instanceof MastrNetworkError && /Unsupported protocol/.test(err.message),
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("an unparseable base URL is rejected at construction", () => {
  const mt = makeMockTransport(() => jsonResponse(fx.unitPage));
  assert.throws(
    () => new RequestEngine({ baseUrl: "not a url", transport: mt.transport }),
    (err) => err instanceof MastrNetworkError && /Invalid base URL/.test(err.message),
  );
  assert.equal(mt.calls.length, 0);
});

function retryRun(retryAfter: string | undefined) {
  const delays: number[] = [];
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return {
      status: 429,
      headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
      body: Buffer.from("{}"),
    };
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { e, delays, calls: () => calls };
}

test("Retry-After (seconds) is honoured on 429", async () => {
  const r = retryRun("1");
  await assert.rejects(() => r.e.getJson("/x"), (err) => err instanceof MastrApiError && err.status === 429);
  assert.deepEqual(r.delays, [1000, 1000]);
  assert.equal(r.calls(), 3);
});

test("a malformed Retry-After falls back to the linear backoff", async () => {
  for (const bad of ["-1", "1.5", "+5", "1e3", "0x10", "soon", "2026-09-26T10:00:00Z", ""]) {
    const r = retryRun(bad);
    await assert.rejects(() => r.e.getJson("/x"));
    assert.deepEqual(r.delays, [200, 400], bad);
  }
});

test("a Retry-After above 30 s is not retried: the error surfaces at once", async () => {
  for (const long of ["31", "99999999999", new Date(Date.now() + 3_600_000).toUTCString()]) {
    const r = retryRun(long);
    await assert.rejects(() => r.e.getJson("/x"), (err) => err instanceof MastrApiError && err.status === 429);
    assert.deepEqual(r.delays, [], long);
    assert.equal(r.calls(), 1, long);
  }
});

test("parseRetryAfter reads seconds and IMF-fixdates only", () => {
  const now = Date.parse("Sat, 26 Sep 2026 10:00:00 GMT");
  assert.equal(parseRetryAfter("3", now), 3000);
  assert.equal(parseRetryAfter(["2", "9"], now), 2000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 10:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 09:00:00 GMT", now), 0);
  assert.equal(parseRetryAfter("Saturday, 26-Sep-26 10:00:05 GMT", now), undefined);
  assert.equal(parseRetryAfter("1.5", now), undefined);
  assert.equal(parseRetryAfter(undefined, now), undefined);
});

test("a base URL with a query or fragment is rejected at construction", () => {
  for (const baseUrl of ["https://example.test/MaStR?x=1", "https://example.test/MaStR#f"]) {
    const mt = makeMockTransport(() => jsonResponse(fx.unitPage));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err) => err instanceof MastrNetworkError && /must not contain a query or fragment/.test(err.message),
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("redactUrl hides userinfo and leaves other URLs alone", () => {
  assert.equal(redactUrl("http://user:secret@h.test/a?b=1"), "http://***@h.test/a?b=1");
  assert.equal(redactUrl("http://user@h.test/"), "http://***@h.test/");
  assert.equal(redactUrl("https://h.test/x"), "https://h.test/x");
  assert.equal(redactUrl("not a url"), "not a url");
});

test("base-URL errors redact userinfo", () => {
  assert.throws(
    () => new RequestEngine({ baseUrl: "ftp://user:secret@h.test/" }),
    (err) => err instanceof MastrNetworkError && !/secret/.test(err.message) && /\*\*\*@h\.test/.test(err.message),
  );
});
