import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, type Problem } from "../src/client/validate.js";
import { MastrError, MastrValidationError } from "../src/client/errors.js";
import { MastrClient } from "../src/client/client.js";
import * as lib from "../src/index.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { jsonResponse, parity, requestShapes } from "./helpers.js";
import * as fx from "./fixtures.js";

const evenProblem: Problem<number> = (n) => (n % 2 === 0 ? undefined : "expected an even number.");

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("n", 4, evenProblem), 4);
});

test("assertValid throws MastrValidationError 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("n", 3, evenProblem),
    (err) =>
      err instanceof MastrValidationError &&
      err instanceof MastrError &&
      err.name === "MastrValidationError" &&
      err.message === "Invalid n: expected an even number.",
  );
});

test("assertValid inside an async method rejects instead of throwing synchronously", async () => {
  const method = async (n: number): Promise<number> => assertValid("n", n, evenProblem);
  let promise: Promise<number> | undefined;
  assert.doesNotThrow(() => {
    promise = method(3);
  });
  await assert.rejects(promise as Promise<number>, MastrValidationError);
});

test("the package root exports assertValid and MastrValidationError", () => {
  assert.equal(lib.assertValid, assertValid);
  assert.equal(lib.MastrValidationError, MastrValidationError);
});

test("run() maps a MastrValidationError raised in an action to exit 2 and 'Error: <message>'", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: () => {
      throw new MastrValidationError("Invalid thing: expected something else.");
    },
  };
  assert.equal(await run(["stromerzeugung"], deps), 2);
  assert.deepEqual(err, ["Error: Invalid thing: expected something else."]);
  assert.deepEqual(out, []);
});

test("run() maps a library rejection from a client method to exit 2 as well", async () => {
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: () => {}, err: (s) => err.push(s) },
    createClient: () =>
      ({
        stromerzeugung: async () => assertValid("page", 0, () => "expected an integer from 1 to 1000000, got 0."),
      }) as unknown as MastrClient,
  };
  assert.equal(await run(["stromerzeugung"], deps), 2);
  assert.deepEqual(err, ["Error: Invalid page: expected an integer from 1 to 1000000, got 0."]);
});

test("parity() drives the CLI and the library on one transport and records both sides", async () => {
  const { cli, lib: l } = await parity(
    ["--compact", "stromerzeugung", "--page-size", "3"],
    (transport) => new MastrClient({ transport }).stromerzeugung({ pageSize: 3 }),
    () => jsonResponse(fx.unitPage),
  );
  assert.equal(cli.code, 0);
  assert.equal(l.ok, true);
  assert.equal(cli.requests.length, 1);
  assert.deepEqual(requestShapes(cli.requests), requestShapes(l.requests));
});

test("parity() captures a synchronous throw from the library call", async () => {
  const { lib: l } = await parity(["--compact", "stromerzeugung"], () => {
    throw new MastrValidationError("Invalid x: no.");
  });
  assert.equal(l.ok, false);
  assert.equal(l.requests.length, 0);
});

test("nonBlankProblem and sortProblem reject blank strings and non-strings", async () => {
  const { nonBlankProblem, sortProblem } = await import("../src/client/validate.js");
  for (const problem of [nonBlankProblem, sortProblem]) {
    for (const blank of ["", "   ", "\t", "\n"]) assert.equal(problem(blank), "Expected a non-empty value.");
    assert.equal(problem(42 as unknown as string), "Expected a string, got 42.");
    assert.equal(problem("Bruttoleistung-desc"), undefined);
  }
});

test("intRangeProblem accepts safe integers in range and names everything else", async () => {
  const { intRangeProblem } = await import("../src/client/validate.js");
  const p = intRangeProblem(0, 10);
  for (const ok of [0, 5, 10]) assert.equal(p(ok), undefined);
  assert.equal(p(11), "expected an integer from 0 to 10, got 11.");
  assert.equal(p(-1), "expected an integer from 0 to 10, got -1.");
  assert.equal(p(1.5), "expected an integer from 0 to 10, got 1.5.");
  assert.equal(p(NaN), "expected an integer from 0 to 10, got NaN.");
  assert.equal(p(Infinity), "expected an integer from 0 to 10, got Infinity.");
  assert.equal(p("3" as unknown as number), 'expected an integer from 0 to 10, got "3".');
});

test("MAX_RETRIES is exported from the package root", () => {
  assert.equal((lib as Record<string, unknown>)["MAX_RETRIES"], 10);
});

test("headerValueProblem and headerNameProblem", async () => {
  const { headerValueProblem, headerNameProblem } = await import("../src/client/validate.js");
  for (const ok of ["mastr", "a\tb", "é ÿ"]) assert.equal(headerValueProblem(ok), undefined, JSON.stringify(ok));
  for (const ctl of ["a\r\nb", "a\nb", "a\u0000", "a\u007f", "\u001b[31m"]) {
    assert.equal(headerValueProblem(ctl), "Value contains control characters.", JSON.stringify(ctl));
  }
  assert.equal(headerValueProblem("aĀ"), "Value contains characters outside Latin-1 (above U+00FF).");
  assert.equal(headerValueProblem(" "), "Expected a non-empty value.");
  assert.equal(headerNameProblem("X-Trace-Id"), undefined);
  assert.match(headerNameProblem("X Foo") ?? "", /Expected an HTTP header name/);
  assert.match(headerNameProblem("") ?? "", /Expected an HTTP header name/);
});

test("baseUrlWhitespaceProblem", async () => {
  const { baseUrlWhitespaceProblem } = await import("../src/client/validate.js");
  assert.equal(baseUrlWhitespaceProblem("https://h.example/MaStR/"), undefined);
  for (const padded of [" https://h", "https://h ", "https://h/\n", "\thttps://h"]) {
    assert.equal(baseUrlWhitespaceProblem(padded), "A base URL cannot have surrounding whitespace.", JSON.stringify(padded));
  }
  for (const inner of ["https://h/a b", "https://h/a\tb", "https://h/a\u0000b", "https://h/a\u007fb"]) {
    assert.equal(baseUrlWhitespaceProblem(inner), "A base URL cannot contain whitespace or control characters.", JSON.stringify(inner));
  }
});

test("baseUrlProblem checks blank, whitespace, parse, scheme, query and fragment in that order", async () => {
  const { baseUrlProblem } = await import("../src/client/validate.js");
  assert.equal(baseUrlProblem("https://h.example/MaStR/"), undefined);
  assert.equal(baseUrlProblem("http://user:pw@h.example/"), undefined);
  assert.equal(baseUrlProblem(""), "Expected a non-empty value.");
  assert.equal(baseUrlProblem(" https://h"), "A base URL cannot have surrounding whitespace.");
  assert.equal(baseUrlProblem("nope"), "Expected an absolute http(s) URL.");
  assert.equal(baseUrlProblem("data:text/plain,x"), "Only http and https URLs are supported.");
  assert.equal(baseUrlProblem("https://h/?x"), "A base URL cannot have a query (?) or fragment (#).");
  assert.equal(baseUrlProblem(5 as unknown as string), "Expected a string, got 5.");
});
