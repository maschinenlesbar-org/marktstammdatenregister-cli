// This server's tools against a mock of the register (the client's register.ts: the live filter
// columns, live-shaped rows, filtered the way the register filters), with the skills' traps as
// cases: each tool answers through the protocol (its structuredContent checked by the SDK against
// its output schema), units in operation unless asked and said so, a name that fits several codes
// is ambiguous, a capacity sum only for a set small enough to read, an unknown number is empty and
// says so, and every result carries the source and the dl-de/by-2-0 attribution.
// The rules every server follows are the conformance tests (M1–M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { INSTRUCTIONS, listTools } from "../src/mcp/server.js";
import { DEADLINE_HINT, SIZE_HINT, TOOLS } from "../src/mcp/tools.js";
import { connect } from "./harness.js";
import { mastr, sampleRegister, unit } from "./helpers.js";

const BASE = "https://www.marktstammdatenregister.de/MaStR/Einheit/EinheitJson";

test("four tools: counting, searching, one unit, and the columns with their codes", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["countUnits", "searchUnits", "getUnit", "findFilterCodes"]);
});

test("the instructions name the column of a breakdown per German Land: Bundesland, not Land (the country)", () => {
  assert.match(INSTRUCTIONS, /by for a breakdown per Bundesland or Energieträger/);
  assert.doesNotMatch(INSTRUCTIONS, /per Land\b/);
});

test("the deadline's and the size cap's advice fit every tool: each option they name comes with the tools that take it", async () => {
  const schemas = new Map(TOOLS.map((tool) => [tool.name, Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)]));
  const options = new Set([...schemas.values()].flat());
  for (const hint of [DEADLINE_HINT, SIZE_HINT]) {
    const pairs = [...hint.matchAll(/(\w+(?: or \w+)*) \((\w+(?:, \w+)*)\)/g)];
    assert.ok(pairs.length >= 2, hint);
    const named = new Set<string>();
    for (const [, names, tools] of pairs) {
      for (const tool of (tools as string).split(", ")) {
        for (const option of (names as string).split(" or ")) {
          assert.ok(schemas.get(tool)?.includes(option), `${tool} takes no ${option}: ${hint}`);
          named.add(option);
        }
      }
    }
    for (const word of hint.match(/\w+/g) ?? []) assert.ok(!options.has(word) || named.has(word), `${word} named without its tools: ${hint}`);
  }
  // getUnit has neither a limit nor a filter: its deadline error says to try again, nothing it can't do.
  const hanging = { transport: (request: { signal?: AbortSignal }): Promise<never> => new Promise<never>((_, reject) => request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) };
  const connection = await connect({ transport: hanging, config: { callTimeoutMs: 30 } });
  const text = (await connection.call("getUnit", { mastrNumber: "SEE900000000001" })).content[0]?.text ?? "";
  await connection.close();
  assert.match(text, /took longer than .* and was stopped.*try again shortly/);
});

test("countUnits: units in operation by name, the status said, with the source and the attribution", async () => {
  const connection = await connect({ transport: mastr() });
  const content = (await connection.call("countUnits", { energySource: "Wind", state: "Bayern" })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.equal(content["total"], 3);
  assert.match(String((content["notes"] as string[])[0]), /Only units with status In Betrieb \(35\)/);
  assert.equal((content["searched"] as { filter: string }).filter, "Energieträger~eq~'2497'~and~Bundesland~eq~'1403'~and~Betriebs-Status~eq~'35'");
  assert.equal(content["source"], `${BASE}/GetErweiterteOeffentlicheEinheitStromerzeugung`);
  assert.match(String(content["licence"]), /Marktstammdatenregister der Bundesnetzagentur.*dl-de\/by-2-0.*https:\/\/www\.govdata\.de\/dl-de\/by-2-0/);
  await connection.close();
});

test("countUnits: a breakdown per Land, a capacity sum, and an ambiguous name with its candidates", async () => {
  const connection = await connect({ transport: mastr() });
  const byState = (await connection.call("countUnits", { energySource: "Wind", by: "Bundesland", sumCapacity: true })).structuredContent ?? {};
  assert.deepEqual((byState["groups"] as { label: string; total: number }[]).slice(0, 2).map((g) => [g.label, g.total]), [["Bayern", 3], ["Saarland", 1]]);
  assert.deepEqual(byState["capacity"], { summed: true, unit: "kW", units: 4, gross: 16000, net: 15600, withoutFigure: 0 });
  const several = (await connection.call("countUnits", { state: "Sachs" })).structuredContent ?? {};
  assert.equal(several["status"], "ambiguous");
  assert.deepEqual((several["candidates"] as { label: string }[]).map((c) => c.label), ["Sachsen", "Sachsen-Anhalt"]);
  const none = (await connection.call("countUnits", { place: "Frankfurt" })).structuredContent ?? {};
  assert.equal(none["status"], "empty");
  assert.match(String(none["reason"]), /matched whole/);
  const wrong = await connection.call("countUnits", { category: "gasverbrauch", energySource: "Wind" });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0]?.text ?? "", /only stromerzeugung/);
  await connection.close();
});

test("searchUnits: the largest first, read rows, paged with nextOffset", async () => {
  const connection = await connect({ transport: mastr() });
  const content = (await connection.call("searchUnits", { energySource: "Wind", sortBy: "capacity", limit: 2 })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.deepEqual((content["units"] as { name: string; grossKw: number; commissioned: string }[]).map((u) => [u.name, u.grossKw, u.commissioned]), [["WEA Bayern 2", 6000, "2025-01-01"], ["WEA Bayern 1", 5000, "2024-12-31"]]);
  assert.equal(content["total"], 4);
  assert.equal(content["nextOffset"], 2);
  assert.equal((content["searched"] as { sort: string }).sort, "Bruttoleistung-desc");
  const gas = (await connection.call("searchUnits", { category: "gaserzeugung", status: "any" })).structuredContent ?? {};
  assert.equal(gas["source"], `${BASE}/GetErweiterteOeffentlicheEinheitGaserzeugung`);
  const noCapacity = await connection.call("searchUnits", { category: "stromverbrauch", sortBy: "capacity" });
  assert.equal(noCapacity.isError, true);
  await connection.close();
});

test("getUnit: a unit read by its number; an unknown one is empty and named; an operator's number says what to call", async () => {
  const connection = await connect({ transport: mastr([...sampleRegister(), unit("stromerzeugung", { MaStRNummer: "SEE930070129359" })]) });
  const content = (await connection.call("getUnit", { mastrNumber: "SEE930070129359" })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.equal((content["record"] as Record<string, unknown>)["NetzbetreiberMaStRNummer"], "SNB940133714842");
  assert.equal((content["unit"] as { commissioned: string }).commissioned, "2018-06-14");
  const gas = (await connection.call("getUnit", { mastrNumber: "GVE111111111111" })).structuredContent ?? {};
  assert.equal(gas["status"], "empty");
  assert.match(String(gas["reason"]), /No gas consumption unit with the number GVE111111111111/);
  assert.equal(gas["source"], `${BASE}/GetErweiterteOeffentlicheEinheitGasverbrauch`);
  const operator = await connection.call("getUnit", { mastrNumber: "ABR949444220202" });
  assert.equal(operator.isError, true);
  assert.match(operator.content[0]?.text ?? "", /searchUnits|operatorNumber/);
  await connection.close();
});

test("findFilterCodes: a column's codes with the condition to send; the source is the columns of the category", async () => {
  const connection = await connect({ transport: mastr() });
  const content = (await connection.call("findFilterCodes", { column: "Wind an Land" })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  const column = (content["columns"] as { name: string; codes: { label: string; example: string }[] }[])[0]!;
  assert.deepEqual(column.codes.map((c) => [c.label, c.example]), [["Windenergie an Land", "Wind an Land oder auf See~eq~'888'"], ["Windenergie auf See", "Wind an Land oder auf See~eq~'889'"]]);
  assert.equal(content["source"], `${BASE}/GetFilterColumnsErweiterteOeffentlicheEinheitStromerzeugung`);
  const offshore = (await connection.call("countUnits", { energySource: "Wind", filter: column.codes[1]!.example, status: "any" })).structuredContent ?? {};
  assert.equal(offshore["status"], "empty", "no offshore unit in the sample; the raw filter is ANDed and sent");
  await connection.close();
});
