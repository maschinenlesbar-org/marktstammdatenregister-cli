import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { TextDecoder } from "node:util";
import assert from "node:assert/strict";
import { MAX_DETAIL_LENGTH, RequestEngine, bigIntegerKeysOption, cleartextProblem, describeMastrErrors, firstInexactNumber, parseRetryAfter, sanitizeServerText, scanNumbers } from "../src/engine.js";
import { MastrApiError, MastrParseError, MastrValidationError, TextBuilder, cutText, echoedCredentialForms, redactUrl, toWellFormed } from "../src/errors.js";
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
      (err) => err instanceof MastrParseError && err.message === "GET https://www.marktstammdatenregister.de/MaStR/x: empty response body.",
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
      // A whole escape sequence goes: `ESC ]` (unterminated, only the introducer) and `ESC e`.
      assert.match(err.message, /: 0;pwnedvil$/);
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
  await assert.rejects(e3.getJson("/x"), (e: unknown) => e instanceof MastrParseError && /^GET \S+\/x: unsupported response charset "x-bogus"\.$/.test((e as Error).message));
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

test("a charset label and a text snippet are quoted at most 200 characters long (L3)", async () => {
  const label = "x".repeat(5000);
  const charset = new RequestEngine({ transport: async () => rawResponse("{}", `application/json; charset=${label}`) });
  await assert.rejects(charset.getJson("/x"), (err: Error) => /charset "x+…"/.test(err.message) && err.message.length < 400);
  const text = new RequestEngine({ transport: async () => rawResponse("y".repeat(5000), "text/plain", 500) });
  await assert.rejects(text.getJson("/x"), (err: Error) => /: y{200}…$/.test(err.message));
});

test("credentials a server echoes are scrubbed from the error: Basic, user:password, password (L13)", async () => {
  const basic = Buffer.from("alice:pa ss-pw", "utf8").toString("base64");
  const body = JSON.stringify({ message: `no: Basic ${basic} / alice:pa ss-pw / pa ss-pw` });
  const engine = new RequestEngine({
    baseUrl: "https://alice:pa%20ss-pw@mirror.example",
    transport: async () => rawResponse(body, "application/json", 401),
  });
  await assert.rejects(engine.getJson("/x"), (err: MastrApiError) => {
    for (const form of [basic, "alice:pa ss-pw", "pa ss-pw"]) assert.ok(!err.message.includes(form), err.message);
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\* \/ \*\*\*/);
    return true;
  });
});

test("a number JSON.parse can't carry exactly is a MastrParseError, never a changed value (K1)", async () => {
  const inexact = [
    "1e400", "-1E400", "12345678901234567890", "-9007199254740993", "12345678901234567890.0",
    "9007199254740993e0", "9007199254740992.5", "1e-400", "123456789012345678901234567890",
    // Subnormal: below 2.2250738585072014e-308 a double has fewer digits, so a value that does
    // not print as written was changed (D4; bug 5: 4e-324 printed as 5e-324).
    "3e-324", "4e-324", "-4.9e-324", "1.2345678901234567e-310", "2.225073858507201e-309",
  ];
  for (const literal of inexact) {
    const mt = makeMockTransport(() => rawResponse(`{"Data":[{"Bruttoleistung":${literal}}],"Total":1,"Errors":null}`, "application/json"));
    const e = new RequestEngine({ transport: mt.transport });
    await assert.rejects(
      e.getJson("/x"),
      (err) =>
        err instanceof MastrParseError &&
        err.message === `GET https://www.marktstammdatenregister.de/MaStR/x: the number ${literal} cannot be represented exactly.`,
      literal,
    );
  }
  // Exact values, decimal fractions below 2^53 and numbers inside strings pass as they are.
  const exact: Array<[string, number]> = [
    ["9007199254740991", 9007199254740991], ["9007199254740992.0", 2 ** 53], ["1e21", 1e21],
    ["4999.999", 4999.999], ["0.1", 0.1], ["0.0e-500", 0], ["5e-324", 5e-324],
    // Past 2^53 a number passes when it prints as written: a double a server printed in its
    // own shortest form (an ArcGIS sentinel) is the same number, not a changed one.
    ["1e23", 1e23], ["100000000000000000000000", 1e23], ["1.7976931348623157E308", Number.MAX_VALUE],
    // A subnormal printed as written, and the smallest normal double, are the same number (D4).
    ["-5e-324", -5e-324], ["1e-310", 1e-310], ["2.2250738585072014e-308", 2.2250738585072014e-308],
  ];
  for (const [literal, value] of exact) {
    const mt = makeMockTransport(() =>
      rawResponse(`{"n":${literal},"s":"/Date(12345678901234567890)/","k":"1e400"}`, "application/json"),
    );
    const got = await new RequestEngine({ transport: mt.transport }).getJson<{ n: number; s: string }>("/x");
    assert.equal(got.n, value, literal);
    assert.equal(got.s, "/Date(12345678901234567890)/");
  }
});

test("a timeout, the size cap, a refused connection and a DNS failure name the request (K3)", async () => {
  const { MastrNetworkError } = await import("../src/errors.js");
  const http = await import("node:http");
  const url = (base: string) => `${base}/x?page=1`;
  const expectNamed = (base: string, reason: RegExp, hasCause = true) => (err: unknown) => {
    assert.ok(err instanceof MastrNetworkError, String(err));
    assert.ok(err.message.startsWith(`GET ${redactUrl(url(base))} failed: `), err.message);
    assert.doesNotMatch(err.message, /:pw@/);
    assert.match(err.message, reason);
    if (hasCause) assert.ok(err.cause instanceof Error, "the original is the cause");
    return true;
  };
  // The engine's deadline, with a transport that never answers.
  const hang = new RequestEngine({ baseUrl: "https://h.test", timeoutMs: 20, transport: () => new Promise(() => {}) });
  await assert.rejects(hang.getJson("/x", { page: 1 }), expectNamed("https://h.test", /timed out after 20ms/));
  // The size cap, checked by the engine on a custom transport's body.
  const big = new RequestEngine({ baseUrl: "https://h.test", maxResponseBytes: 4, transport: async () => jsonResponse({ Total: 0 }) });
  await assert.rejects(big.getJson("/x", { page: 1 }), expectNamed("https://h.test", /size limit of 4 bytes/, false));
  // A DNS failure as a transport reports it (a MastrNetworkError, like the default transport's).
  const dns = new RequestEngine({
    baseUrl: "https://user:pw@nowhere.test",
    transport: async () => {
      throw new MastrNetworkError("getaddrinfo ENOTFOUND nowhere.test", { cause: Object.assign(new Error("x"), { code: "ENOTFOUND" }) });
    },
  });
  await assert.rejects(dns.getJson("/x", { page: 1 }), expectNamed("https://user:pw@nowhere.test", /ENOTFOUND nowhere\.test/));
  // The default transport, against a local server: the size cap and a refused connection.
  const server = http.createServer((_req, res) => res.end("x".repeat(100)));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const local = `http://127.0.0.1:${port}`;
  try {
    await assert.rejects(
      new RequestEngine({ baseUrl: local, maxResponseBytes: 10 }).getJson("/x", { page: 1 }),
      expectNamed(local, /size limit of 10 bytes/),
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  await assert.rejects(
    new RequestEngine({ baseUrl: local, maxRetries: 0 }).getJson("/x", { page: 1 }),
    expectNamed(local, /ECONNREFUSED/),
  );
});

test("a header named __proto__ is an ordinary header, never the prototype of the headers read (T12)", async () => {
  // A JavaScript transport may return any object; JSON.parse makes "__proto__" an own key.
  // With it as the record's prototype, its "content-type" was read as the answer's (here an
  // unknown charset, so a valid answer failed to decode).
  const headers = JSON.parse('{"__proto__":{"content-type":"application/json; charset=bogus"}}') as Record<string, string>;
  const e = new RequestEngine({ transport: async () => ({ status: 200, headers, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await e.getJson("/x"), { a: 1 });
  const fetchLike = new Headers([["__proto__", "x"], ["content-type", "application/json"]]);
  const f = new RequestEngine({ transport: async () => ({ status: 200, headers: fetchLike as unknown as Record<string, string>, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await f.getJson("/x"), { a: 1 });
});

test("an answer error names the request: method and URL, userinfo redacted (D9)", async () => {
  const answers: Array<[string, () => ReturnType<typeof rawResponse>]> = [
    ["the answer is not valid JSON (expected JSON, got Content-Type \"text/html\")", () => rawResponse("<html>", "text/html")],
    ["the answer is not valid JSON.", () => rawResponse("{", "application/json")],
    ["empty response body", () => rawResponse(" ", "application/json")],
    ["cannot be represented exactly", () => rawResponse('{"n":1e400}', "application/json")],
    ["unsupported response charset", () => rawResponse("{}", "application/json; charset=x-bogus")],
  ];
  for (const [what, respond] of answers) {
    const e = new RequestEngine({ baseUrl: "https://alice:s3cret@h.test/MaStR", transport: makeMockTransport(respond).transport });
    await assert.rejects(e.getJson("/Einheit", { page: 1, filter: "Ort~eq~'x'" }), (err: unknown) => {
      assert.ok(err instanceof MastrParseError, what);
      assert.ok(err.message.startsWith("GET https://***@h.test/MaStR/Einheit?page=1&filter=Ort%7Eeq%7E%27x%27: "), err.message);
      assert.ok(err.message.includes(what), `${what}: ${err.message}`);
      assert.ok(!err.message.includes("s3cret"), err.message);
      return true;
    });
  }
});

test("bigIntegerKeys: a declared member's number is its exact literal as a string; others keep the rule (D3)", async () => {
  const body = '{"_version_":1858054135406919680,"small":{"_version_":5},"neg":{"\\u005fversion_":-12345678901234567890},' +
    '"s":{"_version_":"text"},"n":{"_version_":null},"arr":{"_version_":[1]},"t":"\\"_version_\\":1","n2":42}';
  const e = new RequestEngine({
    bigIntegerKeys: new Set(["_version_"]),
    transport: makeMockTransport(() => rawResponse(body, "application/json")).transport,
  });
  assert.deepEqual(await e.getJson("/x"), {
    _version_: "1858054135406919680", small: { _version_: "5" }, neg: { _version_: "-12345678901234567890" },
    s: { _version_: "text" }, n: { _version_: null }, arr: { _version_: [1] }, t: '"_version_":1', n2: 42,
  });
  assert.deepEqual([...e.bigIntegerKeys], ["_version_"]);
  // An undeclared big number is still refused; a declared member doesn't make others exact.
  const other = new RequestEngine({
    bigIntegerKeys: ["_version_"] as unknown as ReadonlySet<string>,
    transport: makeMockTransport(() => rawResponse('{"_version_":1858054135406919680,"id":12345678901234567890}', "application/json")).transport,
  });
  await assert.rejects(other.getJson("/x"), /the number 12345678901234567890 cannot be represented exactly/);
  // Malformed stays malformed: a declared member with a leading zero still fails JSON.parse.
  const malformed = new RequestEngine({ bigIntegerKeys: new Set(["_version_"]), transport: makeMockTransport(() => rawResponse('{"_version_":01}', "application/json")).transport });
  await assert.rejects(malformed.getJson("/x"), /not valid JSON/);
  for (const bad of [new Set([""]), new Set([1]), "x", 5, null]) {
    assert.throws(() => new RequestEngine({ bigIntegerKeys: bad as unknown as ReadonlySet<string> }),
      (err: unknown) => err instanceof MastrValidationError && err.message === "Invalid bigIntegerKeys: expected a set of non-empty member names.");
  }
  // The option reader copies a set or a list; undefined is none.
  const names = new Set(["a"]);
  const copy = bigIntegerKeysOption(names);
  names.add("b");
  assert.deepEqual([...copy], ["a"]);
  assert.deepEqual([...bigIntegerKeysOption(["x", "y"] as unknown as ReadonlySet<string>)], ["x", "y"]);
  assert.equal(bigIntegerKeysOption(undefined).size, 0);
  // Without declarations the scan is the plain number check.
  assert.equal(firstInexactNumber('{"a":"1e400","b":3e-324}'), "3e-324");
  assert.deepEqual(scanNumbers('{"a":1}'), { json: '{"a":1}', inexact: undefined });
});

test("text that is not valid is replaced with U+FFFD and reported through onWarning, never silently (D2)", async () => {
  const cases: Array<[string, Buffer, string, unknown, number]> = [
    // A lone surrogate written as an escape (high alone, low alone); a real pair and an escaped backslash stay.
    ["lone escapes", Buffer.from('{"a":"x\\ud800y","b":"\\udc00","c":"\\ud83d\\ude00","d":"\\\\ud800"}'), "application/json", { a: "x\ufffdy", b: "\ufffd", c: "\u{1f600}", d: "\\ud800" }, 2],
    // A lone surrogate in a member name.
    ["lone in a key", Buffer.from('{"\\udbff":1}'), "application/json", { "\ufffd": 1 }, 1],
    // Invalid UTF-8 bytes; a U+FFFD the server sent is not counted.
    ["invalid bytes", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xc3]), Buffer.from('","b":"\ufffd"}')]), "application/json", { a: "\ufffd\ufffd", b: "\ufffd" }, 2],
    // A byte undefined in a single-byte charset.
    ["iso-8859-3", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xa5]), Buffer.from('"}')]), "application/json; charset=iso-8859-3", { a: "\ufffd" }, 1],
  ];
  for (const [label, body, type, expected, count] of cases) {
    const warnings: string[] = [];
    const e = new RequestEngine({ onWarning: (m) => warnings.push(m), transport: makeMockTransport(() => rawResponse(body, type)).transport });
    const value = await e.getJson("/Einheit", { page: 1 });
    assert.deepEqual(value, expected, label);
    assert.ok(!/[\ud800-\udfff]/u.test(JSON.stringify(value)), `${label}: well-formed`);
    assert.deepEqual(warnings, [
      `GET https://www.marktstammdatenregister.de/MaStR/Einheit?page=1: ${count} ${count === 1 ? "character" : "characters"} of the answer ${count === 1 ? "was" : "were"} not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.`,
    ], label);
  }
  // Valid text: no warning; a throwing hook never fails the request.
  const quiet: string[] = [];
  const ok = new RequestEngine({ onWarning: (m) => quiet.push(m), transport: makeMockTransport(() => rawResponse('{"a":"\\u00fc\ufffd"}', "application/json")).transport });
  assert.deepEqual(await ok.getJson("/x"), { a: "ü\ufffd" });
  assert.deepEqual(quiet, []);
  const throwing = new RequestEngine({ onWarning: () => { throw new Error("hook"); }, transport: makeMockTransport(() => rawResponse('"\\ud800"', "application/json")).transport });
  assert.equal(await throwing.getJson("/x"), "\ufffd");
  assert.throws(() => new RequestEngine({ onWarning: "log" as unknown as () => void }), MastrValidationError);
});

test("an answer longer than V8's longest string is a MastrParseError naming the request, not a plain Error (T14)", async (t) => {
  // A real one needs a body of 512 MB and more (possible with maxResponseBytes 0): V8's own
  // error is stood in for, for the body marked by its length.
  const huge = Buffer.from('{"Data":[],"Total":0}     ');
  const tooLong = Object.assign(new Error("Cannot create a string longer than 0x1fffffe8 characters"), { code: "ERR_STRING_TOO_LONG" });
  const decode = TextDecoder.prototype.decode;
  t.mock.method(TextDecoder.prototype, "decode", function (this: InstanceType<typeof TextDecoder>, input?: Uint8Array, options?: { stream?: boolean }) {
    if (input !== undefined && input.byteLength === huge.length) throw tooLong;
    return decode.call(this, input, options);
  });
  const toString = Buffer.prototype.toString;
  t.mock.method(Buffer.prototype, "toString", function (this: Buffer, ...args: Parameters<Buffer["toString"]>) {
    if (this.length === huge.length && args[0] === "utf8") throw tooLong;
    return toString.apply(this, args);
  });
  const e = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "application/json")).transport });
  await assert.rejects(e.getJson("/Einheit", { page: 1 }), (err: unknown) => {
    assert.ok(err instanceof MastrParseError, String(err));
    assert.equal(
      err.message,
      `GET https://www.marktstammdatenregister.de/MaStR/Einheit?page=1: the answer is too large to read as text (${huge.length} bytes; the longest string is 536870888 characters).`,
    );
    return true;
  });
  // An error status with such a body is still the API error, without the unreadable body.
  const failing = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "text/plain", 500)).transport });
  await assert.rejects(failing.getJson("/x"), (err: unknown) => err instanceof MastrApiError && err.status === 500 && err.body === "");
});

test("a number literal with a long inner run of zeros is checked in linear time, with the same verdict", () => {
  // decimalOf stripped the zeros with /0+$/, which tries a match at every zero of a run that
  // doesn't end the text: 40 000 zeros took about 2.3 s, 100 000 well over 10 s.
  const zeros = "0".repeat(100_000);
  for (const literal of [`1${"0".repeat(20)}.${zeros}1`, `0.${"0".repeat(400)}1${zeros}3`, `1.${zeros}1e300`]) {
    const started = performance.now();
    const scan = scanNumbers(`{"Total":1,"Data":[{"x":${literal}}]}`);
    const ms = performance.now() - started;
    assert.ok(ms < 1000, `${literal.length} digits: ${Math.round(ms)} ms`);
    assert.equal(scan.inexact, literal);
  }
  // The verdicts at the edges are unchanged: zeros only at the end, a value printed in its
  // shortest form, an exact zero, and the leading zeros of an underflow.
  assert.equal(firstInexactNumber(`{"a":1${"0".repeat(30)}}`), undefined);
  assert.equal(firstInexactNumber('{"a":1E23,"b":1.7976931348623157E308,"c":5e-324,"d":0.000,"e":-0e5}'), undefined);
  assert.equal(firstInexactNumber('{"a":12345678901234567890}'), "12345678901234567890");
  assert.equal(firstInexactNumber('{"a":4e-324}'), "4e-324");
  assert.equal(firstInexactNumber('{"a":0.0001e-400}'), "0.0001e-400");
});

test("describeMastrErrors describes many distinct strings in linear time, with the same message near the cut", () => {
  // The repeats were found with Array.includes over every string so far, and the walk went on
  // past the 500 characters the message keeps: 40 000 distinct strings took about 1.7 s.
  const many = Array.from({ length: 200_000 }, (_, i) => `error ${i}`);
  const started = performance.now();
  const message = describeMastrErrors(many);
  const ms = performance.now() - started;
  assert.ok(ms < 1000, `${Math.round(ms)} ms`);
  assert.equal(message, `${many.join("; ").slice(0, MAX_DETAIL_LENGTH)}…`);
  const nested = describeMastrErrors({ "": { errors: many }, other: { errors: many } });
  assert.equal(nested, message);
  // The old description, as the reference: every string found, repeats and blanks dropped,
  // joined and then cut.
  const reference = (errors: unknown): string | undefined => {
    const found: string[] = [];
    const walk = (value: unknown, depth: number): void => {
      if (typeof value === "string") {
        const text = sanitizeServerText(value);
        if (text !== "" && !found.includes(text)) found.push(text);
      } else if (value !== null && typeof value === "object" && depth < 5) {
        for (const v of Object.values(value)) walk(v, depth + 1);
      }
    };
    walk(errors, 0);
    if (found.length === 0) return undefined;
    const joined = found.join("; ");
    return joined.length > MAX_DETAIL_LENGTH ? `${joined.slice(0, MAX_DETAIL_LENGTH)}…` : joined;
  };
  // Pieces whose joined length lands just under, at and just over the cut, with repeats, blanks
  // and nesting, and a piece that crosses the cut.
  for (const size of [1, 7, 48, 99, 166, 249, 250, 251, 498, 499, 500, 501, 502]) {
    for (let extra = 0; extra < 4; extra++) {
      const pieces = Array.from({ length: Math.ceil(1000 / size) + extra }, (_, i) => `${String(i).padStart(size, "x")}`);
      const cases: unknown[] = [
        pieces,
        [...pieces.slice(0, 3), pieces[0], "", " ", ...pieces.slice(3)],
        { "": { errors: pieces.slice(0, 2) }, b: [pieces.slice(2, 5), { c: pieces.slice(5) }] },
        pieces.slice(0, extra + 1),
        pieces.map((p) => p.slice(0, MAX_DETAIL_LENGTH - 2 - extra)).slice(0, 2),
      ];
      for (const errors of cases) assert.equal(describeMastrErrors(errors), reference(errors), `size ${size}, extra ${extra}`);
    }
  }
  assert.equal(describeMastrErrors(["", " "]), reference(["", " "]));
  assert.equal(describeMastrErrors("one"), "one");
});

test("sanitizeServerText drops whole escape sequences, not just their control bytes", () => {
  const BEL = String.fromCharCode(0x07);
  const CSI8 = String.fromCharCode(0x9b);
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  for (const [input, expected] of [
    [`line1 ${ESC}]0;title${BEL}rest`, "line1 rest"],
    [`${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`, "click"],
    [`${ESC}[31mred${ESC}[0m plain`, "red plain"],
    [`${ESC}[1;31;4mbold`, "bold"],
    [`${CSI8}2Jcleared`, "cleared"],
    [`${OSC8}0;t${ST8}ok`, "ok"],
    [`a${ESC}7b${ESC}(Bc`, "abc"],
    // Unterminated: only ESC and its introducer go, the text stays.
    [`keep ${ESC}]0;no terminator here`, "keep 0;no terminator here"],
  ] as const) {
    assert.equal(sanitizeServerText(input), expected, JSON.stringify(input));
  }
});

test("sanitizeServerText reads a bounded prefix and drops what the per-character filter dropped", () => {
  // The filter it replaces, one character at a time: C0 but TAB to CR, DEL, C1 and Cf go.
  const perCharacter = (text: string): string =>
    [...text]
      .filter((ch) => {
        const n = ch.codePointAt(0) ?? 0;
        return (n >= 0x09 && n <= 0x0d) || !(n <= 0x1f || (n >= 0x7f && n <= 0x9f) || /\p{Cf}/u.test(ch));
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  const every = Array.from({ length: 0x3000 }, (_, i) => String.fromCharCode(i)).join("") + "\u{1f600}\u{e0001}\ud800x";
  for (let at = 0; at < every.length; at += 512) {
    const piece = every.slice(at, at + 512).replace(/[\u001b\u0090\u0098\u009b-\u009f]/g, "");
    assert.equal(sanitizeServerText(piece), perCharacter(piece), `from U+${at.toString(16)}`);
  }
  // At most 16 384 units of the text are read, never half a surrogate pair.
  assert.equal(sanitizeServerText("x".repeat(100_000)).length, 16_384);
  assert.equal(sanitizeServerText(`${"x".repeat(16_383)}\u{1f600}`), "x".repeat(16_383));
  // A control string ends at another introducer: the first is dropped by the filter, the second
  // string as a whole.
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  const BEL = String.fromCharCode(0x07);
  assert.equal(sanitizeServerText(`a${OSC8}0;x${OSC8}0;t${ST8}b`), "a0;xb");
  assert.equal(sanitizeServerText(`a${ESC}]0;x${ESC}]0;t${BEL}b`), "a0;xb");
});

test("a TextBuilder joins its pieces in order across batches", () => {
  const b = new TextBuilder();
  const expected: string[] = [];
  for (let i = 0; i < 40_000; i++) {
    b.push(String(i), ",");
    expected.push(String(i), ",");
  }
  assert.equal(b.toString(), expected.join(""));
  assert.equal(new TextBuilder().toString(), "");
});

// These tests start a process with a small heap: 30 s instead of the suite's 5 s.
const STARTS_A_PROCESS = { timeout: 30_000 };

test("scanNumbers quotes millions of declared members within a small heap", STARTS_A_PROCESS, () => {
  // One `+=` per quoted member made a rope node each: 3 million of them exhausted a 128 MB heap.
  const engine = new URL("../src/engine.js", import.meta.url).href;
  const n = 3_000_000;
  const script =
    `const { scanNumbers } = await import(${JSON.stringify(engine)});` +
    `const json = "[" + '{"k":1},'.repeat(${n - 1}) + '{"k":1}]';` +
    `process.stdout.write(String(scanNumbers(json, new Set(["k"])).json.length));`;
  const out = execFileSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(out, String(n * 10 + 1));
});

test("lone surrogate escapes are repaired within a small heap, millions of them", STARTS_A_PROCESS, () => {
  // One `+=` per repair made a rope node each: 6 million repairs exhausted a 128 MB heap.
  const engine = new URL("../src/engine.js", import.meta.url).href;
  const n = 6_000_000;
  const script =
    `const { RequestEngine } = await import(${JSON.stringify(engine)});` +
    `const body = Buffer.from('{"x":"' + "\\\\ud800".repeat(${n}) + '"}');` +
    `const e = new RequestEngine({ transport: async () => ({ status: 200, headers: { "content-type": "application/json" }, body }) });` +
    `const v = await e.getJson("/x");` +
    `process.stdout.write(String(v.x.length));`;
  const out = execFileSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(out, String(n));
});

test("an error body keeps its spelling unless a credential hides behind an escape", async () => {
  const base = "https://alice:s3cret-pw@mirror.example";
  const bodyOf = async (body: string): Promise<string> => {
    const e = new RequestEngine({ baseUrl: base, transport: async () => rawResponse(body, "application/json", 500) });
    const err = await e.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof MastrApiError, String(err));
    return err.body;
  };
  // No credential, or one spelled as sent: the body as sent (scrubbed), escapes kept.
  assert.equal(await bodyOf('{"m":"caf\\u00e9 \\"x\\""}'), '{"m":"caf\\u00e9 \\"x\\""}');
  assert.equal(await bodyOf('{"m":"pw s3cret-pw \\u00e9"}'), '{"m":"pw *** \\u00e9"}');
  // Escaped: written again decoded, scrubbed in that spelling.
  assert.equal(await bodyOf('{"m":"pw s3cret\\u002dpw \\u00e9"}'), '{"m":"pw *** é"}');
  // Not JSON: nobody decodes it, it stays as sent.
  assert.equal(await bodyOf("pw s3cret\\u002dpw"), "pw s3cret\\u002dpw");
  // Deeply nested: written again where this runtime can, else left out (probed, not assumed:
  // whether JSON.stringify recurses depends on the Node version).
  const deep = `${"[".repeat(200_000)}"s3cret\\u002dpw"${"]".repeat(200_000)}`;
  let parses = true;
  let writes = true;
  try {
    const value: unknown = JSON.parse(deep);
    try {
      JSON.stringify(value);
    } catch {
      writes = false;
    }
  } catch {
    parses = false;
  }
  if (parses) {
    const body = await bodyOf(deep);
    assert.ok(!body.includes("s3cret"), body.slice(199_990, 200_030));
    assert.equal(body === "", !writes);
  }
});

test("a credential echoed behind JSON escapes is scrubbed from the detail of every error envelope, an inner space too", async () => {
  // A password with a space (typed %20 in the base URL), a quote and an umlaut: a JSON writer
  // spells it with \" and may write ä; the scrub of the body as sent missed it, and the
  // decoded detail (`Errors`, `message`) carried it whole or from its second word on.
  const pw = 'pa ss-"ä';
  const base = `https://alice:${encodeURIComponent(pw)}@mirror.example`;
  const basic = Buffer.from(`alice:${pw}`, "utf8").toString("base64");
  const ascii = (text: string): string => JSON.stringify(text).replace(/[\u0080-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const every = (text: string): string => `"${[...text].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"`;
  for (const [status, member] of [[500, "Errors"], [401, "message"], [400, "detail"], [500, "Errors-object"]] as const) {
    for (const json of [ascii(`wrong ${pw}`), every(`alice:${pw}`), JSON.stringify(`Basic ${basic}`)]) {
      const body = member === "Errors-object" ? `{"Errors":{"":{"errors":[${json}]}}}` : `{"${member}":${json}}`;
      const e = new RequestEngine({ baseUrl: base, transport: async () => rawResponse(body, "application/json", status) });
      const err = await e.getJson("/x").catch((caught: unknown) => caught);
      assert.ok(err instanceof MastrApiError, String(err));
      const decoded = JSON.stringify(JSON.parse(err.body));
      for (const text of [err.message, err.detail ?? "", err.body, decoded]) {
        for (const secret of [pw, "ss-", basic, JSON.stringify(pw).slice(1, -1)]) assert.ok(!text.includes(secret), `${member} ${json}: ${text}`);
      }
    }
  }
});

test("an echo of the request URL as sent is scrubbed, a short password too", async () => {
  // Typed raw; WHATWG sends `p%22%C3%A4` in the URL, which a server echoes.
  const e = new RequestEngine({
    baseUrl: 'https://alice:p"ä@mirror.example',
    transport: async (req) => rawResponse(JSON.stringify({ message: `no access: ${new URL(req.url).href}` }), "application/json", 403),
  });
  const err = await e.getJson("/x").catch((caught: unknown) => caught);
  assert.ok(err instanceof MastrApiError, String(err));
  for (const text of [err.message, err.detail ?? "", err.body]) {
    assert.ok(!text.includes("p%22%C3%A4@") && !text.includes('p"ä@'), text);
  }
});

test("a credential in an answer's Content-Type or charset is scrubbed from the parse error", async () => {
  const base = "https://alice:s3cret-pw@mirror.example";
  for (const contentType of ["text/s3cret-pw", "application/json; charset=s3cret-pw"]) {
    const e = new RequestEngine({ baseUrl: base, transport: async () => rawResponse("<x>", contentType) });
    const err = await e.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof MastrParseError, String(err));
    assert.ok(!err.message.includes("s3cret"), err.message);
  }
});

test("echoedCredentialForms treats a userinfo without a password as a token (Basic `TOKEN:`)", () => {
  const basic = (pair: string): string => Buffer.from(pair, "utf8").toString("base64");
  assert.deepEqual(echoedCredentialForms("alice:s3cret"), [basic("alice:s3cret"), "alice:s3cret", "s3cret"]);
  assert.deepEqual(echoedCredentialForms("T0ken"), [basic("T0ken:"), "T0ken:", "T0ken"]);
  assert.deepEqual(echoedCredentialForms("T0ken:"), [basic("T0ken:"), "T0ken:", "T0ken"]);
  assert.deepEqual(echoedCredentialForms("T%C3%B6k"), [basic("Tök:"), "Tök:"]); // short: not alone
  assert.deepEqual(echoedCredentialForms(":pw12"), [basic(":pw12"), ":pw12", "pw12"]);
  assert.deepEqual(echoedCredentialForms(""), []);
  assert.deepEqual(echoedCredentialForms(":"), []);
});

test("a token userinfo (no password) is scrubbed from library errors in every echoed form", async () => {
  const token = "T0kenS3cret";
  const basic = Buffer.from(`${token}:`, "utf8").toString("base64");
  for (const baseUrl of [`https://${token}@mirror.example`, `https://${token}:@mirror.example`]) {
    for (const echo of [`bad token ${token}`, `Authorization: Basic ${basic}`, `user ${token}: unknown`]) {
      const e = new RequestEngine({ baseUrl, transport: async () => jsonResponse({ Errors: echo }, 401) });
      const err = await e.getJson("/x").catch((caught: unknown) => caught);
      assert.ok(err instanceof MastrApiError, String(err));
      for (const text of [err.message, err.detail ?? "", err.body]) {
        assert.ok(!text.includes(token) && !text.includes(basic), `${baseUrl} ${echo}: ${text}`);
      }
    }
  }
});
