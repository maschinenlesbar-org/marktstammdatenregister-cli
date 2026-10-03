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
