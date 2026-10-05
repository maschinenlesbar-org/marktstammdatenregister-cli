import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFilter, filterProblem, normalizeFilter, normalizeFilterName, FILTER_OPERATORS } from "../src/client/filter.js";
import { MastrValidationError } from "../src/client/errors.js";

test("filterProblem names a ~ inside a quoted value (the register has no escape)", () => {
  const problem = filterProblem("Anzeige-Name der Einheit~ct~'a~b'");
  assert.match(problem ?? "", /The value 'a~b' in condition 1 contains "~"/);
  assert.match(problem ?? "", /would read 'a'/);
  // The injection shape a naive `Ort~eq~'${input}'` produces is well-formed and so
  // passes the spec check; only buildFilter can refuse it (below).
  assert.equal(filterProblem("Ort~eq~'Münster'~and~Energieträger~eq~'2497'"), undefined);
});

test("buildFilter quotes values, joins with ~and~ and turns an array into a comma list", () => {
  assert.equal(
    buildFilter([
      { name: "Ort", op: "eq", value: "Münster" },
      { name: "Energieträger", op: "eq", value: ["2497", 2498] },
      { name: "Bruttoleistung der Einheit", op: "gt", value: 4999.999 },
      { name: "Plz", op: "null" },
      { name: "Anzeige-Name der Einheit", op: "ct", value: "d'Arc" },
    ]),
    "Ort~eq~'Münster'~and~Energieträger~eq~'2497,2498'~and~Bruttoleistung der Einheit~gt~'4999.999'" +
      "~and~Plz~null~''~and~Anzeige-Name der Einheit~ct~'d'Arc'",
  );
});

test("buildFilter refuses a value with ~, so user input cannot add conditions", () => {
  assert.throws(
    () => buildFilter([{ name: "Ort", op: "eq", value: "Münster'~and~Energieträger~eq~'2497" }]),
    (err) => err instanceof MastrValidationError && /contains "~"/.test(err.message),
  );
});

test("buildFilter refuses bad names, operators, values and list items", () => {
  const bad: unknown[] = [
    [],
    [{ name: "", op: "eq", value: "x" }],
    [{ name: "A~B", op: "eq", value: "x" }],
    [{ name: "Ort", op: "gte", value: "x" }],
    [{ name: "Ort", op: "EQ", value: "x" }],
    [{ name: "Ort", op: "eq" }],
    [{ name: "Ort", op: "eq", value: " " }],
    [{ name: "Ort", op: "eq", value: { x: 1 } }],
    [{ name: "Energieträger", op: "eq", value: ["2497", "24,98"] }],
    [{ name: "Energieträger", op: "eq", value: [] }],
  ];
  for (const conditions of bad) {
    assert.throws(
      () => buildFilter(conditions as Parameters<typeof buildFilter>[0]),
      MastrValidationError,
      JSON.stringify(conditions),
    );
  }
});

test("FILTER_OPERATORS lists the ten operators", () => {
  assert.deepEqual([...FILTER_OPERATORS], ["eq", "neq", "sw", "ct", "nct", "ew", "null", "nn", "gt", "lt"]);
});

test("normalizeFilter writes every FilterName as NFC without padding, and leaves values alone (findings 01#1, 04#5)", () => {
  const nfd = "Energietra\u0308ger";
  assert.equal(
    normalizeFilter(`${nfd}~eq~'2495'~and~ Bundesland ~eq~' 1403 '`),
    "Energieträger~eq~'2495'~and~Bundesland~eq~' 1403 '",
  );
  assert.equal(normalizeFilter(" Bruttoleistung  der Einheit~gt~'5000'"), "Bruttoleistung der Einheit~gt~'5000'");
  // A value with a decomposed umlaut stays as typed (the register normalises values itself).
  assert.equal(normalizeFilter("Ort~eq~'Mu\u0308nster'"), "Ort~eq~'Mu\u0308nster'");
  assert.equal(normalizeFilterName(`\t${nfd} `), "Energieträger");
});

test("buildFilter normalises names and writes numbers without exponent; NaN and Infinity are refused (finding 04#5)", () => {
  assert.equal(buildFilter([{ name: " Bundesland", op: "eq", value: "1403" }]), "Bundesland~eq~'1403'");
  assert.equal(buildFilter([{ name: "Energietra\u0308ger", op: "eq", value: 2495 }]), "Energieträger~eq~'2495'");
  assert.equal(buildFilter([{ name: "Bruttoleistung der Einheit", op: "gt", value: 0.0000001 }]), "Bruttoleistung der Einheit~gt~'0.0000001'");
  assert.equal(buildFilter([{ name: "Bruttoleistung der Einheit", op: "gt", value: 1e21 }]), "Bruttoleistung der Einheit~gt~'1000000000000000000000'");
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => buildFilter([{ name: "Bruttoleistung der Einheit", op: "gt", value }]),
      (err) => err instanceof MastrValidationError && /needs a finite number/.test(err.message),
      String(value),
    );
  }
});

test("filterProblem refuses a quoted empty value except for null/nn (finding 01#2)", () => {
  assert.match(filterProblem("Energieträger~eq~''") ?? "", /Condition 1 \("Energieträger~eq~''"\) has no value: '' is only for null\/nn/);
  assert.match(filterProblem("Ort~ct~'  '") ?? "", /has no value/);
  assert.equal(filterProblem("Ort~nn~''"), undefined);
  assert.equal(filterProblem("Ort~eq~' x '"), undefined);
});
