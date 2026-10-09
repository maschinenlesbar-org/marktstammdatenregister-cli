import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine, cleartextProblem, parseRetryAfter, sanitizeServerText } from "../src/client/engine.js";
import { MastrApiError, MastrParseError, MastrValidationError, cutText, redactUrl, toWellFormed } from "../src/client/errors.js";
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
      (err) => err instanceof MastrValidationError && /Only http and https URLs are supported/.test(err.message),
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("an unparseable base URL is rejected at construction", () => {
  const mt = makeMockTransport(() => jsonResponse(fx.unitPage));
  assert.throws(
    () => new RequestEngine({ baseUrl: "not-a-url", transport: mt.transport }),
    (err) => err instanceof MastrValidationError && err.message === "Invalid baseUrl: Expected an absolute http(s) URL.",
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

test("a Retry-After above 30 s waits the 30 s cap, then retries", async () => {
  for (const long of ["31", "99999999999", new Date(Date.now() + 3_600_000).toUTCString()]) {
    const r = retryRun(long);
    await assert.rejects(() => r.e.getJson("/x"), (err) => err instanceof MastrApiError && err.status === 429);
    assert.deepEqual(r.delays, [30_000, 30_000], long);
    assert.equal(r.calls(), 3, long);
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
      (err) => err instanceof MastrValidationError && /cannot have a query \(\?\) or fragment \(#\)/.test(err.message),
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

test("base-URL errors never echo the URL, so userinfo cannot leak", () => {
  assert.throws(
    () => new RequestEngine({ baseUrl: "ftp://user:secret@h.test/" }),
    (err) => err instanceof MastrValidationError && !/secret|user/.test(err.message),
  );
});

test("sanitizeServerText drops bidi controls and folds line breaks into one line", () => {
  const RLO = String.fromCharCode(0x202e);
  const bidi = [0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069].map((c) => String.fromCharCode(c)).join("");
  assert.equal(sanitizeServerText(`bad text${RLO}evil`), "bad textevil");
  assert.equal(sanitizeServerText(`a${bidi}b`), "ab");
  assert.equal(sanitizeServerText("line1\nError: forged\r\n\tx  "), "line1 Error: forged x");
  assert.equal(sanitizeServerText("a\u2028b"), "a b");
});

test("getJson decodes the body by its declared charset (finding 03#4) and drops a BOM", async () => {
  const body = (data: Buffer, contentType: string) => async () => ({ status: 200, headers: { "content-type": contentType }, body: data });
  const latin1 = Buffer.from(JSON.stringify({ Ort: "Münster" }), "latin1");
  const e1 = new RequestEngine({ transport: body(latin1, "application/json; charset=iso-8859-1") });
  assert.deepEqual(await e1.getJson("/x"), { Ort: "Münster" });
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]);
  const e2 = new RequestEngine({ transport: body(bom, "application/json; charset=utf-8") });
  assert.deepEqual(await e2.getJson("/x"), { a: 1 });
  const e3 = new RequestEngine({ transport: body(Buffer.from("{}"), "application/json; charset=x-bogus") });
  await assert.rejects(e3.getJson("/x"), (e: unknown) => e instanceof MastrParseError && /Unsupported response charset "x-bogus"/.test((e as Error).message));
});

test("cleartextProblem: wording, loopback and https exemptions", () => {
  for (const quiet of ["https://a.example", "not a url", "http://localhost:8080", "http://127.1.2.3", "http://[::1]:9", "http://LOCALHOST."]) {
    assert.equal(cleartextProblem(quiet), undefined, quiet);
  }
  assert.equal(cleartextProblem("http://a.example:8080/MaStR"), "requests to a.example:8080 are sent unencrypted (http:, not https:)");
  assert.equal(
    cleartextProblem("http://u:pw@a.example"),
    "the base URL's credentials are sent unencrypted to a.example (http:, not https:)",
  );
  assert.equal(cleartextProblem("http://a.example", ["the API key"]), "the API key is sent unencrypted to a.example (http:, not https:)");
  assert.equal(
    cleartextProblem("http://u:pw@a.example", ["the API key"]),
    "the API key and the base URL's credentials are sent unencrypted to a.example (http:, not https:)",
  );
  // A host that only starts like a loopback name still warns.
  assert.match(cleartextProblem("http://127.0.0.1.example") ?? "", /127\.0\.0\.1\.example/);
});

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a� b� \u{1f600}");
});

test("a server detail or text snippet cut to its limit keeps the message well-formed", async () => {
  // The JSON detail is cut at 500 characters, a text body's snippet at 200: "a" + emoji
  // puts a high surrogate right before either cut.
  for (const body of [JSON.stringify({ detail: "a" + "\u{1f600}".repeat(400) }), "a" + "\u{1f600}".repeat(400)]) {
    const engine = new RequestEngine({ transport: async () => rawResponse(body, "application/json", 500) });
    await assert.rejects(engine.getJson("/x"), (err: Error) => {
      assert.equal(toWellFormed(err.message), err.message, body.slice(0, 20));
      assert.match(err.message, /…$/);
      return true;
    });
  }
});
