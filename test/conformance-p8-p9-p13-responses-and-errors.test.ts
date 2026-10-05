// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { MastrClient as Client } from "../src/client/client.js";
import { buildFilter } from "../src/client/filter.js";
import type { UnitCategory, UnitPage } from "../src/client/types.js";
import {
  MastrError as BaseError,
  MastrParseError as ParseError,
  MastrValidationError as ValidationError,
} from "../src/client/errors.js";
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.stromerzeugung();
const textBody = (text: string): unknown => ({ Data: [{ Ort: text }], Total: 1, Errors: null });
const readText = (result: unknown): string => (result as UnitPage).data[0]!["Ort"] as string;
/**
 * 2xx bodies the call must reject (error envelopes, empty or wrong shapes). The register's
 * `{"Error":true}` envelope is a MastrApiError, not a parse error: client.test.ts covers it.
 */
const malformedBodies: unknown[] = [
  null,
  {},
  [],
  "text",
  42,
  { Data: "x", Total: 1, Errors: null },
  { Data: [], Total: "5", Errors: null },
  { Data: null, Total: 5, Errors: null },
  { Data: [{ Ort: "a" }, { Ort: "b" }], Total: 0, Errors: null },
];
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ["units(5)", () => new Client().units(5 as unknown as UnitCategory)],
  ["stromerzeugung(5)", () => new Client().stromerzeugung(5 as unknown as object)],
  ["stromerzeugung({ filter: 5 })", () => new Client().stromerzeugung({ filter: 5 as unknown as string })],
  ["stromerzeugung({ filter: ['a'] })", () => new Client().stromerzeugung({ filter: ["a"] as unknown as string })],
  ["stromerzeugung({ page: '2' })", () => new Client().stromerzeugung({ page: "2" as unknown as number })],
  ["count('stromerzeugung', 'x')", () => new Client().count("stromerzeugung", "x" as unknown as object)],
  ["filterColumns(null)", () => new Client().filterColumns(null as unknown as UnitCategory)],
  ["buildFilter('x')", () => buildFilter("x" as unknown as [])],
  ["timeoutMs: 'x'", () => new Client({ timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => new Client({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => new Client({ maxRetries: 1.5 })],
  ["baseUrl: 5", () => new Client({ baseUrl: 5 as unknown as string })],
  ["userAgent: {}", () => new Client({ userAgent: {} as unknown as string })],
  ["transport: 'x'", () => new Client({ transport: "x" as unknown as never })],
  ["sleep: 5", () => new Client({ sleep: 5 as unknown as never })],
  ["defaultHeaders: 'x'", () => new Client({ defaultHeaders: "x" as unknown as Record<string, string> })],
  ["options 'x'", () => new Client("x" as unknown as object)],
  ["unknown option timeout", () => new Client({ timeout: 5 } as unknown as object)],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(JSON.stringify(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});
