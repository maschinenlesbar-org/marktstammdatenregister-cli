// CLI <-> library parity: the same input through run() and through the library, on
// one recording mock transport, must give the same outcome — both reject before any
// request, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MastrClient } from "../src/client/client.js";
import { MastrValidationError } from "../src/client/errors.js";
import { parity, requestShapes } from "./helpers.js";

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
