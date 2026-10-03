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
