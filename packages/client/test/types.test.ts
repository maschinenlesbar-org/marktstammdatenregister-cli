// Compile-time checks of the exported library types: a consumer with the strictest compiler
// settings can pass `undefined` for any optional option, as the runtime treats it as omitted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MastrClient, buildFilter } from "../src/index.js";
import { makeMockTransport, queryOf, registerResponder } from "./helpers.js";
import * as fx from "./fixtures.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ baseUrl: process.env.X }` fails to compile against an
  // option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "marktstammdatenregister-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { MastrClient, buildFilter, type CountQuery, type EngineOptions, type FilterCondition, type MastrClientOptions, type UnitQuery } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const engine: EngineOptions = allUndefined<EngineOptions>();",
        "export const options: MastrClientOptions = allUndefined<MastrClientOptions>();",
        "export const query: UnitQuery = allUndefined<UnitQuery>();",
        "export const countQuery: CountQuery = allUndefined<CountQuery>();",
        "export const condition: FilterCondition = { name: \"Ort\", op: \"null\", value: undefined };",
        "export const client = new MastrClient({ baseUrl: process.env.MASTR_BASE_URL, timeoutMs: 15_000, allowUnknownFilters: undefined });",
        "export const total = async (): Promise<number> => (await client.stromerzeugung({ filter: process.env.MASTR_FILTER, page: undefined })).total;",
        "export const spec: string = buildFilter([condition]);",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const mt = makeMockTransport(registerResponder(fx.unitPage));
  const client = new MastrClient({
    baseUrl: undefined,
    userAgent: undefined,
    defaultHeaders: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    bigIntegerKeys: undefined,
    allowUnknownFilters: undefined,
    transport: mt.transport,
  });
  await client.stromerzeugung({ page: undefined, pageSize: undefined, sort: undefined, filter: undefined });
  const req = mt.last();
  assert.ok(req.url.startsWith("https://www.marktstammdatenregister.de/MaStR/Einheit/"), req.url);
  const q = queryOf(req);
  assert.deepEqual([q.get("page"), q.get("pageSize"), q.get("sort"), q.get("filter")], ["1", "25", "", ""]);
  assert.equal(await client.count("stromerzeugung", { sort: undefined, filter: undefined }), fx.unitPage.Total);
  assert.equal(buildFilter([{ name: "Ort", op: "null", value: undefined }]), "Ort~null~''");
});
