import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFilter, filterProblem, FILTER_OPERATORS } from "../src/client/filter.js";
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
