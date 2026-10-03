// CLI <-> library parity: the same input through run() and through the library, on
// one recording mock transport, must give the same outcome — both reject before any
// request, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MastrClient } from "../src/client/client.js";
import { MastrNetworkError, MastrValidationError } from "../src/client/errors.js";
import { validateBaseUrl } from "../src/index.js";
import { run } from "../src/cli/run.js";
import { jsonResponse, makeMockTransport, parity, requestShapes } from "./helpers.js";

test("parity: a blank or whitespace-only sort is rejected on both sides, before any request", async () => {
  for (const sort of ["", "   ", "\t"]) {
    for (const category of ["stromerzeugung", "gasverbrauch"] as const) {
      const { cli, lib } = await parity(["--compact", category, "--sort", sort], (transport) =>
        new MastrClient({ transport }).units(category, { sort }),
      );
      assert.equal(cli.code, 2, JSON.stringify(sort));
      assert.equal(cli.requests.length, 0);
      assert.match(cli.err, /Expected a non-empty value\./);
      assert.equal(lib.ok, false, JSON.stringify(sort));
      assert.ok(!lib.ok && lib.error instanceof MastrValidationError);
      assert.equal((lib.error as Error).message, "Invalid sort: Expected a non-empty value.");
      assert.equal(lib.requests.length, 0);
    }
  }
});

test("parity: a sort spec is sent identically by the CLI and the library", async () => {
  const { cli, lib } = await parity(["--compact", "stromerzeugung", "--sort", "Bruttoleistung-desc"], (transport) =>
    new MastrClient({ transport }).stromerzeugung({ sort: "Bruttoleistung-desc" }),
  );
  assert.equal(cli.code, 0);
  assert.equal(lib.ok, true);
  assert.deepEqual(requestShapes(cli.requests), requestShapes(lib.requests));
});

test("parity: out-of-range timeout, retry and size-cap options are rejected on both sides", async () => {
  const cases: [string, string, keyof import("../src/client/engine.js").EngineOptions, number][] = [
    ["--max-retries", "11", "maxRetries", 11],
    ["--max-retries", "50", "maxRetries", 50],
    ["--max-retries", "-1", "maxRetries", -1],
    ["--max-retries", "1.5", "maxRetries", 1.5],
    ["--max-retries", "Infinity", "maxRetries", Infinity],
    ["--timeout", "-1", "timeoutMs", -1],
    ["--timeout", "1.5", "timeoutMs", 1.5],
    ["--timeout", "NaN", "timeoutMs", NaN],
    ["--timeout", "2147483648", "timeoutMs", 2_147_483_648],
    ["--max-response-bytes", "-1", "maxResponseBytes", -1],
    ["--max-response-bytes", "1.5", "maxResponseBytes", 1.5],
    ["--max-response-bytes", "NaN", "maxResponseBytes", NaN],
  ];
  for (const [flag, arg, option, value] of cases) {
    const label = `${flag} ${arg}`;
    const { cli, lib } = await parity(["--compact", flag, arg, "stromerzeugung"], (transport) =>
      new MastrClient({ transport, [option]: value }).stromerzeugung(),
    );
    assert.equal(cli.code, 2, label);
    assert.equal(cli.requests.length, 0, label);
    assert.equal(lib.ok, false, label);
    assert.ok(!lib.ok && lib.error instanceof MastrValidationError, label);
    assert.match((lib.error as Error).message, new RegExp(`^Invalid ${option}: expected an integer from 0 to `), label);
    assert.equal(lib.requests.length, 0, label);
  }
});

test("parity: in-range timeout, retry and size-cap options are sent identically", async () => {
  for (const [argv, options] of [
    [["--max-retries", "10", "--timeout", "0", "--max-response-bytes", "0"], { maxRetries: 10, timeoutMs: 0, maxResponseBytes: 0 }],
    [["--timeout", "2147483647", "--max-response-bytes", "1"], { timeoutMs: 2_147_483_647, maxResponseBytes: 1 }],
  ] as const) {
    const { cli, lib } = await parity(["--compact", ...argv, "stromerzeugung"], (transport) =>
      new MastrClient({ transport, ...options }).stromerzeugung(),
    );
    assert.equal(cli.code, 0, argv.join(" "));
    assert.equal(lib.ok, true);
    assert.deepEqual(cli.requests, lib.requests);
  }
});

test("retryDelayMs must be a non-negative integer", () => {
  for (const retryDelayMs of [-1, 1.5, NaN, Infinity]) {
    assert.throws(
      () => new MastrClient({ retryDelayMs }),
      (err) => err instanceof MastrValidationError && /^Invalid retryDelayMs: /.test(err.message),
      String(retryDelayMs),
    );
  }
  assert.doesNotThrow(() => new MastrClient({ retryDelayMs: 0 }));
});

test("parity: a User-Agent with control characters, outside Latin-1 or blank is rejected on both sides", async () => {
  const cases: [string, RegExp][] = [
    ["a\r\nX-Injected: 1", /Value contains control characters\./],
    ["a\u007f", /Value contains control characters\./],
    ["a\u0000b", /Value contains control characters\./],
    ["a€b", /Value contains characters outside Latin-1 \(above U\+00FF\)\./],
    ["", /Expected a non-empty value\./],
    ["   ", /Expected a non-empty value\./],
  ];
  for (const [ua, reason] of cases) {
    const label = JSON.stringify(ua);
    const { cli, lib } = await parity(["--compact", "--user-agent", ua, "stromerzeugung", "--page-size", "1"], (transport) =>
      new MastrClient({ transport, userAgent: ua }).stromerzeugung({ pageSize: 1 }),
    );
    assert.equal(cli.code, 2, label);
    assert.equal(cli.requests.length, 0, label);
    assert.match(cli.err, reason, label);
    assert.equal(lib.ok, false, label);
    assert.ok(!lib.ok && lib.error instanceof MastrValidationError, label);
    assert.match((lib.error as Error).message, /^Invalid userAgent: /, label);
    assert.match((lib.error as Error).message, reason, label);
    assert.equal(lib.requests.length, 0, label);
  }
});

test("parity: a tab or a Latin-1 letter in the User-Agent is sent identically", async () => {
  for (const ua of ["a\tb", "mastr-é"]) {
    const { cli, lib } = await parity(["--compact", "--user-agent", ua, "stromerzeugung"], (transport) =>
      new MastrClient({ transport, userAgent: ua }).stromerzeugung(),
    );
    assert.equal(cli.code, 0, JSON.stringify(ua));
    assert.equal(lib.ok, true);
    assert.equal(cli.requests[0]?.headers?.["User-Agent"], ua);
    assert.deepEqual(requestShapes(cli.requests), requestShapes(lib.requests));
  }
});

test("defaultHeaders names and values are checked when the client is built", () => {
  assert.throws(
    () => new MastrClient({ defaultHeaders: { "X-Foo": "a\r\nX-Bar: 2" } }),
    (err) => err instanceof MastrValidationError && err.message === 'Invalid defaultHeaders["X-Foo"]: Value contains control characters.',
  );
  assert.throws(
    () => new MastrClient({ defaultHeaders: { "X Foo": "ok" } }),
    (err) => err instanceof MastrValidationError && /^Invalid defaultHeaders name: /.test(err.message),
  );
  assert.doesNotThrow(() => new MastrClient({ defaultHeaders: { "X-Trace-Id": "abc" } }));
});

test("parity: a base URL with surrounding or inner whitespace is rejected on both sides", async () => {
  const cases: [string, RegExp][] = [
    [" https://h.example/MaStR ", /A base URL cannot have surrounding whitespace\./],
    ["https://h.example/MaStR ", /A base URL cannot have surrounding whitespace\./],
    ["https://h.example/MaStR/ ", /A base URL cannot have surrounding whitespace\./],
    ["https://h.example/MaStR\n", /A base URL cannot have surrounding whitespace\./],
    ["\thttps://h.example/MaStR", /A base URL cannot have surrounding whitespace\./],
    ["https://h.example/Ma StR", /A base URL cannot contain whitespace or control characters\./],
    ["https://h.example/Ma\tStR", /A base URL cannot contain whitespace or control characters\./],
  ];
  for (const [baseUrl, reason] of cases) {
    const label = JSON.stringify(baseUrl);
    const { cli, lib } = await parity(["--compact", "--base-url", baseUrl, "stromerzeugung"], (transport) =>
      new MastrClient({ transport, baseUrl }).stromerzeugung(),
    );
    assert.equal(cli.code, 2, label);
    assert.equal(cli.requests.length, 0, label);
    assert.match(cli.err, reason, label);
    assert.equal(lib.ok, false, label);
    assert.ok(!lib.ok && lib.error instanceof MastrValidationError, label);
    assert.match((lib.error as Error).message, /^Invalid baseUrl: /, label);
    assert.match((lib.error as Error).message, reason, label);
    assert.equal(lib.requests.length, 0, label);
  }
});

test("parity: a base URL with a path prefix and a trailing slash is sent identically", async () => {
  const baseUrl = "https://h.example/mirror/MaStR/";
  const { cli, lib } = await parity(["--compact", "--base-url", baseUrl, "stromerzeugung"], (transport) =>
    new MastrClient({ transport, baseUrl }).stromerzeugung(),
  );
  assert.equal(cli.code, 0);
  assert.equal(lib.ok, true);
  assert.match(cli.requests[0]?.url ?? "", /^https:\/\/h\.example\/mirror\/MaStR\/Einheit\//);
  assert.deepEqual(requestShapes(cli.requests), requestShapes(lib.requests));
});

test("parity: --total and client.count() send the same one-row request and give the same number", async () => {
  const page = { Data: [{ Id: 1 }], Total: 9063887, Errors: null };
  for (const [argv, call] of [
    [["stromerzeugung", "--total", "--page-size", "100", "--page", "3"], (c: MastrClient) => c.count("stromerzeugung")],
    [["stromerzeugung", "--total"], (c: MastrClient) => c.count("stromerzeugung")],
    [
      ["gasverbrauch", "--total", "--filter", "Ort~eq~'Berlin'", "--sort", "MaximaleGasbezugsLeistung-desc"],
      (c: MastrClient) => c.count("gasverbrauch", { filter: "Ort~eq~'Berlin'", sort: "MaximaleGasbezugsLeistung-desc" }),
    ],
  ] as const) {
    const { cli, lib } = await parity(
      ["--compact", ...argv],
      (transport) => call(new MastrClient({ transport })),
      () => jsonResponse(page),
    );
    assert.equal(cli.code, 0, argv.join(" "));
    assert.equal(lib.ok, true);
    assert.equal(JSON.parse(cli.out), 9063887);
    assert.ok(lib.ok && lib.value === 9063887);
    assert.deepEqual(requestShapes(cli.requests), requestShapes(lib.requests));
    assert.equal(new URL(lib.requests[0]?.url ?? "").searchParams.get("pageSize"), "1");
    assert.equal(new URL(lib.requests[0]?.url ?? "").searchParams.get("page"), "1");
  }
});

test("count() refuses paging options and checks sort and filter before any request", async () => {
  const mt = makeMockTransport(() => jsonResponse({ Data: [], Total: 0, Errors: null }));
  const client = new MastrClient({ transport: mt.transport });
  await assert.rejects(
    () => client.count("stromerzeugung", { pageSize: 100 } as never),
    (err) =>
      err instanceof MastrValidationError &&
      err.message === "Invalid count query: pageSize cannot be combined with count(): it counts every match, so paging does not apply.",
  );
  await assert.rejects(() => client.count("stromerzeugung", { sort: " " }), MastrValidationError);
  await assert.rejects(() => client.count("stromerzeugung", { filter: "Ort~or~'x'" }), MastrValidationError);
  await assert.rejects(() => client.count("bogus" as never), MastrValidationError);
  assert.equal(mt.calls.length, 0);
});

test("parity: an invalid base URL is a validation error on both sides, never a network error", async () => {
  const cases: [string, string][] = [
    ["", "Expected a non-empty value."],
    ["   ", "Expected a non-empty value."],
    ["h.example", "Expected an absolute http(s) URL."],
    ["ftp://h.example/", "Only http and https URLs are supported."],
    ["file:///etc/", "Only http and https URLs are supported."],
    ["https://h.example/MaStR?x=1", "A base URL cannot have a query (?) or fragment (#)."],
    ["https://h.example/MaStR#f", "A base URL cannot have a query (?) or fragment (#)."],
  ];
  for (const [baseUrl, reason] of cases) {
    const label = JSON.stringify(baseUrl);
    const { cli, lib } = await parity(["--compact", "--base-url", baseUrl, "stromerzeugung", "--page-size", "1"], (transport) =>
      new MastrClient({ transport, baseUrl }).stromerzeugung({ pageSize: 1 }),
    );
    assert.equal(cli.code, 2, label);
    assert.equal(cli.requests.length, 0, label);
    assert.ok(cli.err.includes(reason), label);
    assert.equal(lib.ok, false, label);
    assert.ok(!lib.ok && lib.error instanceof MastrValidationError, label);
    assert.ok(!(lib.error instanceof MastrNetworkError), label);
    assert.equal((lib.error as Error).message, `Invalid baseUrl: ${reason}`, label);
    assert.equal(lib.requests.length, 0, label);
  }
});

test("a bad base URL rejected by the library, not the CLI parser, still exits 2", async () => {
  const err: string[] = [];
  const code = await run(["stromerzeugung"], {
    io: { out: () => {}, err: (s) => err.push(s) },
    createClient: (opts) => new MastrClient({ ...opts, baseUrl: "ftp://h.example/" }),
  });
  assert.equal(code, 2);
  assert.deepEqual(err, ["Error: Invalid baseUrl: Only http and https URLs are supported."]);
});

test("validateBaseUrl returns the value without trailing slashes, or throws MastrValidationError", () => {
  assert.equal(validateBaseUrl("https://h.example/MaStR//"), "https://h.example/MaStR");
  assert.throws(() => validateBaseUrl("ftp://h.example"), MastrValidationError);
});
