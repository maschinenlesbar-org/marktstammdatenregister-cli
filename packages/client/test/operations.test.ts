// The skills' use cases (operations.ts) against a mock of the register (register.ts: the live
// columns of 2026-11-19 and live-shaped rows, filtered the way the register filters), with the
// skills' traps as cases: units in operation unless asked, labels to codes (never the label sent),
// inclusive bounds made strict, no ~or~, a sum only over a set small enough to read, the record
// read (ISO dates, no HTML, "&"), and every empty answer saying what was searched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MastrClient } from "../src/client.js";
import { MastrValidationError } from "../src/errors.js";
import { countUnits, findFilterCodes, getUnit, readRecord, searchUnits } from "../src/operations.js";
import { makeMockTransport } from "./helpers.js";
import { ENERGY, msDate, registerLog, registerOf, sampleRegister, STATE, STATUS, unit } from "./register.js";
import type { MastrUnit } from "../src/types.js";

/** A client on the mock register of `rows` (the sample by default), and its request log. */
function clientOn(rows: MastrUnit[] = sampleRegister()) {
  const log = registerLog();
  const client = new MastrClient({ transport: makeMockTransport(registerOf(rows, log)).transport });
  return { client, log, filters: () => log.unitRequests().map((q) => q.get("filter") ?? "") };
}

test("countUnits counts the units in operation unless asked, and says which status it counted", async () => {
  const { client, filters } = clientOn();
  const inOperation = await countUnits(client, { energySource: "Wind", state: "Bayern" });
  assert.equal(inOperation.status, "ok");
  assert.equal(inOperation.total, 3, "the planned unit is not counted");
  assert.match(filters().at(-1)!, /Betriebs-Status~eq~'35'/);
  assert.match(inOperation.notes[0]!, /Only units with status In Betrieb \(35\) are counted/);
  const all = await countUnits(client, { energySource: "Wind", state: "Bayern", status: "any" });
  assert.equal(all.status === "ok" && all.total, 4);
  assert.doesNotMatch(filters().at(-1)!, /Betriebs-Status/);
  assert.match(all.status === "ok" ? all.notes[0]! : "", /Every status is counted/);
});

test("labels become codes: aliases, abbreviations, several as one comma list; the label is never sent", async () => {
  const { client, filters } = clientOn();
  const count = await countUnits(client, { energySource: "pv, Windkraft", state: "BY, nrw" });
  assert.equal(count.status, "ok");
  const sent = filters().at(-1)!;
  assert.match(sent, new RegExp(`Energieträger~eq~'${ENERGY.Solar},${ENERGY.Wind}'`));
  assert.match(sent, new RegExp(`Bundesland~eq~'${STATE.Bayern},${STATE["Nordrhein-Westfalen"]}'`));
  assert.doesNotMatch(sent, /~or~/);
  assert.deepEqual(count.status === "ok" ? count.searched.conditions.slice(0, 2) : [], [
    "Energieträger: Solare Strahlungsenergie (2495) or Wind (2497)",
    "Bundesland: Bayern (1403) or Nordrhein-Westfalen (1409)",
  ]);
  // "Solar" is the PV code, not Solarthermie; "Sachsen" is the Land, not Niedersachsen or Sachsen-Anhalt.
  await countUnits(client, { energySource: "Solar", state: "Sachsen" });
  assert.match(filters().at(-1)!, new RegExp(`Energieträger~eq~'${ENERGY.Solar}'~and~Bundesland~eq~'${STATE.Sachsen}'`));
});

test("a label that fits several codes is ambiguous with the candidates, and nothing is counted", async () => {
  const { client, log } = clientOn();
  const answer = await countUnits(client, { state: "Sachs" });
  assert.equal(answer.status, "ambiguous");
  assert.deepEqual(answer.status === "ambiguous" ? (answer.candidates as { label: string }[]).map((c) => c.label) : [], ["Sachsen", "Sachsen-Anhalt"]);
  assert.match(answer.status === "ambiguous" ? answer.reason : "", /ask which one is meant/);
  assert.equal(log.unitRequests().length, 0);
});

test("an unknown label, or a column the category lacks, is a validation error naming what there is", async () => {
  const { client, log } = clientOn();
  await assert.rejects(countUnits(client, { energySource: "Kohlestrom" }), (err: unknown) => err instanceof MastrValidationError && /Solare Strahlungsenergie \(2495\)/.test(err.message));
  await assert.rejects(countUnits(client, { category: "gasverbrauch", energySource: "Wind" }), /only stromerzeugung \(electricity generation\) has an energy source/);
  await assert.rejects(countUnits(client, { category: "stromverbrauch", minCapacity: 10 }), /no capacity in the register/);
  await assert.rejects(countUnits(client, { filter: "Ort~eq~'A'~or~Ort~eq~'B'" }), MastrValidationError);
  assert.equal(log.unitRequests().length, 0);
});

test("capacity and date bounds are inclusive: the register's strict gt/lt are moved by 0.001 kW and a day", async () => {
  const { client, filters } = clientOn();
  const big = await countUnits(client, { energySource: "Wind", minCapacity: 5000, status: "any" });
  assert.equal(big.status === "ok" && big.total, 3, "5000, 6000, 7000 kW; not 4999.999");
  assert.match(filters().at(-1)!, /Bruttoleistung der Einheit~gt~'4999\.999'/);
  const newYear = await countUnits(client, { energySource: "Wind", commissionedFrom: "2025-01-01", commissionedTo: "2025-01-01" });
  assert.equal(newYear.status === "ok" && newYear.total, 1);
  assert.match(filters().at(-1)!, /Inbetriebnahmedatum der Einheit~gt~'2024-12-31'~and~Inbetriebnahmedatum der Einheit~lt~'2025-01-02'/);
  await assert.rejects(countUnits(client, { commissionedFrom: "2025-02-30" }), /expected a day from 0001-01-01 to 9999-12-31 as YYYY-MM-DD/);
  await assert.rejects(countUnits(client, { minCapacity: 10, maxCapacity: 5 }), /more than maxCapacity/);
});

test("a day bound at the calendar's ends is no restriction, years before 100 are read as written, year 0 is refused", async () => {
  const { client, filters } = clientOn();
  const all = await countUnits(client, { energySource: "Wind", status: "any" });
  const toEnd = await countUnits(client, { energySource: "Wind", status: "any", commissionedTo: "9999-12-31", registeredTo: "9999-12-31" });
  assert.equal(toEnd.status === "ok" && toEnd.total, all.status === "ok" && all.total);
  assert.doesNotMatch(filters().at(-1)!, /~lt~|\+0100/, "no condition past the year 9999");
  assert.deepEqual(toEnd.status === "ok" ? toEnd.searched.conditions.slice(1) : [], ["Inbetriebnahmedatum der Einheit on or before 9999-12-31", "Registrierungsdatum der Einheit on or before 9999-12-31"]);
  const fromStart = await countUnits(client, { energySource: "Wind", status: "any", commissionedFrom: "0001-01-01" });
  assert.equal(fromStart.status === "ok" && fromStart.total, all.status === "ok" && all.total);
  assert.doesNotMatch(filters().at(-1)!, /~gt~/, "no condition before the year 1");
  await countUnits(client, { energySource: "Wind", commissionedFrom: "0099-03-01", commissionedTo: "0099-12-31" });
  assert.match(filters().at(-1)!, /Inbetriebnahmedatum der Einheit~gt~'0099-02-28'~and~Inbetriebnahmedatum der Einheit~lt~'0100-01-01'/, "the year 99, not 1999");
  await assert.rejects(countUnits(client, { commissionedFrom: "0000-01-01" }), /expected a day from 0001-01-01 to 9999-12-31 as YYYY-MM-DD, got "0000-01-01"/);
});

test("by counts per code of one dropdown, largest first; a filter on that column narrows the codes", async () => {
  const { client, log } = clientOn();
  const byState = await countUnits(client, { energySource: "Wind", by: "Bundesland" });
  assert.equal(byState.status, "ok");
  if (byState.status !== "ok") return;
  assert.equal(byState.by, "Bundesland");
  assert.deepEqual(byState.groups?.slice(0, 2), [{ label: "Bayern", code: "1403", total: 3 }, { label: "Saarland", code: "1412", total: 1 }]);
  assert.equal(byState.groups?.length, 17);
  const before = log.unitRequests().length;
  const two = await countUnits(client, { energySource: "Wind", state: "BY, SL", by: "bundesland" });
  assert.equal(two.status === "ok" && two.groups?.length, 2);
  assert.equal(log.unitRequests().length - before, 3, "the total and one count per code");
  const perStatus = await countUnits(client, { energySource: "Wind", by: "Betriebs-Status" });
  assert.equal(perStatus.status === "ok" && perStatus.total, 6, "per status counts every status");
  assert.match(perStatus.status === "ok" ? perStatus.notes[0]! : "", /per operating status/);
  await assert.rejects(countUnits(client, { by: "Hauptbrennstoff" }), /more than the 20 counts one call makes/);
  const fuzzy = await countUnits(client, { by: "Gebiet" });
  assert.equal(fuzzy.status, "ambiguous", "two dropdowns are named Gebiet nach dem Flächenentwicklungsplan");
});

test("sumCapacity sums gross and net kW here, and only for a set small enough to read", async () => {
  const { client, log } = clientOn();
  const bavaria = await countUnits(client, { energySource: "Wind", state: "Bayern", sumCapacity: true });
  assert.deepEqual(bavaria.status === "ok" && bavaria.capacity, { summed: true, unit: "kW", units: 3, gross: 13000, net: 12700, withoutFigure: 0 });
  assert.equal(log.unitRequests().at(-1)?.get("pageSize"), "2000");
  const before = log.unitRequests().length;
  const tooMany = await countUnits(client, { energySource: "Wind", sumCapacity: true, maxSumUnits: 2 });
  assert.equal(tooMany.status === "ok" && tooMany.capacity?.summed, false);
  assert.match(tooMany.status === "ok" && !tooMany.capacity!.summed ? tooMany.capacity!.reason : "", /4 units match, more than the 2 read here.*no sum of its own/);
  assert.equal(log.unitRequests().length - before, 1, "only the count, no page read");
  const consumption = await countUnits(client, { category: "stromverbrauch", status: "any", sumCapacity: true });
  assert.match(consumption.status === "ok" && !consumption.capacity!.summed ? consumption.capacity!.reason : "", /no capacity/);
});

test("an empty count says what was searched and what to change", async () => {
  const { client } = clientOn();
  const none = await countUnits(client, { place: "Frankfurt" });
  assert.equal(none.status, "empty");
  assert.match(none.status === "empty" ? none.reason! : "", /No stromerzeugung unit matches Ort is "Frankfurt"\. .*matched whole.*the postal town \('Frankfurt', not 'Frankfurt am Main'\).*Only status In Betrieb \(35\) was counted/);
});

test("searchUnits: sorted by the category's capacity key, read rows, ISO days, '&' for the full-width ampersand", async () => {
  const rows = [...sampleRegister(), unit("gaserzeugung", { Erzeugungsleistung: 9999 }), unit("stromerzeugung", { AnlagenbetreiberName: "Wind ＆ Co. KG", BundeslandId: STATE.Saarland })];
  const { client, log } = clientOn(rows);
  const answer = await searchUnits(client, { energySource: "Wind", sortBy: "capacity", limit: 2 });
  assert.equal(answer.status, "ok");
  if (answer.status !== "ok") return;
  assert.equal(log.unitRequests().at(-1)?.get("sort"), "Bruttoleistung-desc");
  assert.deepEqual(answer.units.map((u) => u.grossKw), [6000, 5000]);
  assert.equal(answer.units[0]?.commissioned, "2025-01-01");
  assert.equal(answer.units[0]?.status, "In Betrieb");
  assert.equal(answer.total, 5);
  assert.equal(answer.nextOffset, 2);
  const amp = await searchUnits(client, { operator: "Wind" });
  assert.equal(amp.status === "ok" && amp.units[0]?.operator, "Wind & Co. KG");
  const gas = await searchUnits(client, { category: "gaserzeugung", sortBy: "capacity", status: "any" });
  assert.equal(gas.status === "ok" && gas.units[0]?.gasCapacity, 9999);
  assert.equal(log.unitRequests().at(-1)?.get("sort"), "Erzeugungsleistung-desc");
  await assert.rejects(searchUnits(client, { category: "stromverbrauch", sortBy: "capacity" }), /can't be sorted by capacity/);
});

test("searchUnits: an offset off the page grid reads two pages and gives exactly the slice", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => unit("stromerzeugung", { EinheitName: `PV ${String(i).padStart(2, "0")}`, Bruttoleistung: 100 - i }, "pv"));
  const { client, log } = clientOn(rows);
  const page = await searchUnits(client, { sortBy: "capacity", offset: 5, limit: 10 });
  assert.deepEqual(page.status === "ok" && page.units.map((u) => u.name), Array.from({ length: 10 }, (_, i) => `PV ${String(i + 5).padStart(2, "0")}`));
  assert.deepEqual(log.unitRequests().map((q) => q.get("page")), ["1", "2"]);
  assert.equal(page.status === "ok" && page.nextOffset, 15);
  const last = await searchUnits(client, { offset: 25, limit: 10 });
  assert.equal(last.status === "ok" && last.units.length, 5);
  assert.equal(last.status === "ok" && last.nextOffset, undefined);
  const anonymised = await searchUnits(client, { limit: 1 });
  assert.match(anonymised.status === "ok" ? anonymised.notes.join(" ") : "", /natural persons are anonymised/);
});

test("getUnit reads a unit by its number: the category from the prefix, ISO dates, the grid operator's number without HTML", async () => {
  const { client, log } = clientOn([...sampleRegister(), unit("stromerzeugung", { MaStRNummer: "SEE930070129359" })]);
  const answer = await getUnit(client, { mastrNumber: " see930070129359 " });
  assert.equal(answer.status, "ok");
  if (answer.status !== "ok") return;
  assert.deepEqual(answer.searched, { mastrNumber: "SEE930070129359", category: "stromerzeugung", kind: "electricity generation unit" });
  assert.match(log.unitRequests().at(-1)?.get("filter") ?? "", /^MaStR-Nr\. der Einheit~eq~'SEE930070129359'$/);
  assert.equal(answer.record["NetzbetreiberMaStRNummer"], "SNB940133714842");
  assert.equal(answer.record["InbetriebnahmeDatum"], "2018-06-14");
  assert.match(String(answer.record["DatumLetzteAktualisierung"]), /^2026-03-04T\d{2}:\d{2}:\d{2}\.143\+01:00$/);
  assert.equal(answer.record["EndgueltigeStilllegungDatum"], undefined, "empty fields are left out");
  assert.equal(answer.unit.grossKw, 3000);
  assert.match(answer.notes.join(" "), /gross and net capacity in kW/);
});

test("a unit with several grid operators gets each number without the HTML; other markup passes as text; linear on hostile text", () => {
  const two = '<a href="/MaStR/Akteur/Marktakteur/Detail/1000010">SNB976890256486</a><a href="/MaStR/Akteur/Marktakteur/Detail/1001715"> SNB942182027607</a>';
  assert.equal(readRecord({ NetzbetreiberMaStRNummer: two })["NetzbetreiberMaStRNummer"], "SNB976890256486, SNB942182027607");
  assert.equal(readRecord({ N: ' <a href="/x">SNB1</a>, <A HREF="/y">SNB2</A> ' })["N"], "SNB1, SNB2");
  assert.equal(readRecord({ N: '<a href="/x">SNB940133714842</a>' })["N"], "SNB940133714842");
  assert.equal(readRecord({ N: "<b>fett</b>" })["N"], "<b>fett</b>", "only links are taken apart");
  assert.equal(readRecord({ N: '<a href="/x">SNB1</a> und mehr' })["N"], '<a href="/x">SNB1</a> und mehr', "text besides the links: left as it is");
  // Text that opens links but never closes them: one pass, not one scan per character.
  for (const hostile of ["<a ".repeat(100_000), `${'<a href="/x">S</a>'.repeat(20_000)}<a ${" ".repeat(100_000)}`, `<a href="/x">S</a>${" ".repeat(200_000)}x`]) {
    const started = performance.now();
    assert.equal(readRecord({ N: hostile })["N"], hostile);
    assert.ok(performance.now() - started < 500, `took ${performance.now() - started} ms for ${hostile.length} characters`);
  }
});

test("getUnit: a home battery by its SSE number, an anonymised PV unit, gas units by GEE/GVE", async () => {
  const { client, log } = clientOn([unit("stromerzeugung", { MaStRNummer: "SEE973635767818" }, "storage"), unit("stromerzeugung", { MaStRNummer: "SEE984033548619" }, "pv"), unit("gaserzeugung", { MaStRNummer: "GEE996968189478" })]);
  const battery = await getUnit(client, { mastrNumber: "SSE951549344691" });
  assert.equal(battery.status === "ok" && battery.unit.mastrNumber, "SEE973635767818");
  assert.match(log.unitRequests().at(-1)?.get("filter") ?? "", /^MaStR-Nr\. der Speichereinheit~eq~/);
  const pv = await getUnit(client, { mastrNumber: "SEE984033548619" });
  assert.match(pv.status === "ok" ? pv.notes.join(" ") : "", /natural person and anonymised by law.*location .* withheld/);
  const gas = await getUnit(client, { mastrNumber: "GEE996968189478" });
  assert.equal(gas.status === "ok" && gas.searched.category, "gaserzeugung");
  assert.match(gas.status === "ok" ? gas.notes.join(" ") : "", /no unit stated/);
  assert.equal(gas.status === "ok" && gas.record["AnlagenbetreiberName"], "Alterric Biogas GmbH & Co. KG");
});

test("getUnit: no match is empty naming the number; an installation of several units is ambiguous; other numbers say how to search", async () => {
  const { client, log } = clientOn([unit("stromerzeugung", { EegAnlageMastrNummer: "EEG900000000001" }), unit("stromerzeugung", { EegAnlageMastrNummer: "EEG900000000001" })]);
  const none = await getUnit(client, { mastrNumber: "SEE111111111111" });
  assert.equal(none.status, "empty");
  assert.match(none.status === "empty" ? none.reason : "", /No electricity generation unit with the number SEE111111111111 in the register's stromerzeugung units/);
  const two = await getUnit(client, { mastrNumber: "EEG900000000001" });
  assert.equal(two.status === "ambiguous" && two.candidates.length, 2);
  const requests = log.unitRequests().length;
  await assert.rejects(getUnit(client, { mastrNumber: "ABR949444220202" }), /an operator \(Anlagenbetreiber\): search its units with operatorNumber/);
  await assert.rejects(getUnit(client, { mastrNumber: "SEE123" }), /three letters .* and 12 digits/);
  await assert.rejects(getUnit(client, { mastrNumber: "" }), MastrValidationError);
  assert.equal(log.unitRequests().length, requests, "no request for a number that can't be a unit");
});

test("findFilterCodes: the columns with their operators and sort keys; one column with its codes; codes by label", async () => {
  const { client, log } = clientOn();
  const all = await findFilterCodes(client, {});
  assert.equal(all.status, "ok");
  if (all.status !== "ok") return;
  assert.equal(all.columns?.length, 85);
  assert.deepEqual(all.columns?.find((c) => c.name === "Bruttoleistung der Einheit")?.operators, ["eq", "neq", "gt", "lt"]);
  assert.equal(all.sortKeys["capacity"], "Bruttoleistung");
  assert.match(all.grammar, /no working ~or~/);
  const state = await findFilterCodes(client, { column: "bundesland", value: "bay" });
  assert.deepEqual(state.status === "ok" && state.columns?.[0]?.codes, [{ column: "Bundesland", label: "Bayern", code: "1403", example: "Bundesland~eq~'1403'" }]);
  const byLabel = await findFilterCodes(client, { value: "Sachsen" });
  assert.deepEqual(byLabel.status === "ok" && byLabel.codes?.map((c) => c.label), ["Sachsen", "Niedersachsen", "Sachsen-Anhalt"]);
  const several = await findFilterCodes(client, { column: "Leistung" });
  assert.equal(several.status, "ambiguous");
  const none = await findFilterCodes(client, { column: "Farbe" });
  assert.equal(none.status, "empty");
  assert.match(none.status === "empty" ? none.reason : "", /no column whose name contains "Farbe"/);
  const gas = await findFilterCodes(client, { category: "gasverbrauch", value: "Wind" });
  assert.equal(gas.status, "empty");
  assert.equal(log.requests.filter((r) => r.url.includes("GetFilterColumns")).length, 2, "the columns are fetched once per category and client");
});

test("the commissioning day of a unit is read as the day the register means (UTC midnight), not shifted by a time zone", async () => {
  const { client } = clientOn([unit("stromerzeugung", { InbetriebnahmeDatum: msDate("2025-01-01"), BetriebsStatusId: STATUS.inOperation })]);
  const answer = await searchUnits(client, {});
  assert.equal(answer.status === "ok" && answer.units[0]?.commissioned, "2025-01-01");
});
