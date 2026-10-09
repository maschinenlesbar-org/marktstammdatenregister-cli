import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFilter, filterProblem, normalizeFilter, normalizeFilterName, resolveFilter, FILTER_OPERATORS } from "../src/client/filter.js";
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

test("own messages quote a typed filter part at most 200 characters long (L3)", () => {
  const long = "x".repeat(5000);
  for (const spec of [`Ort~${long}~'a'`, `Ort~eq~'${long}`, `Ort~eq~'a'~${long}~Ort~eq~'b'`, `Ort~eq~'a'~and~${long}`]) {
    const problem = filterProblem(spec) ?? "";
    assert.match(problem, /x…/, spec.slice(0, 20));
    assert.ok(problem.length < 600, `${problem.length}`);
  }
  assert.throws(
    () => resolveFilter(`${long}~eq~'a'`, [{ FilterName: "Ort", Type: "text" }], "stromerzeugung"),
    (err: Error) => /unknown FilterName "x+…"/.test(err.message) && err.message.length < 600,
  );
  assert.throws(
    () => buildFilter([{ name: "Ort", op: "eq", value: `${long}~` }]),
    (err: Error) => /the value "x+…" in condition 1/.test(err.message) && err.message.length < 600,
  );
});

// The register's filter-columns reply, as a hostile or broken server could send it: a
// dropdown Name with a line break and a record-shaped line, ESC/OSC/CSI sequences, C1, DEL,
// CR, bidi controls, and 200 000 characters (2026-10-09, result 01, bugs 01-1 and 01-2).
const FORGED = "Solar\n2026-10-09T00:00:00.000Z ERROR [mastr.api] HTTP 500 forged record";
const ESCAPES = "Wind \u001b]0;pwned\u0007\u001b[31mRED\u001b[0m\u009b2J\u007f\r\u202eevil\u2028ls";
const HOSTILE_COLUMNS = [
  {
    FilterName: "Energieträger",
    Type: "multidropdown",
    ListObject: [
      { Name: FORGED, Value: "2495" },
      { Name: ESCAPES, Value: "2497" },
      { Name: "Wasser", Value: `2498\n${FORGED}\u001b[31m` },
      { Name: "Z".repeat(200_000), Value: "Y".repeat(100_000) },
    ],
  },
  { FilterName: "Ortsteil\n2026 forged", Type: "text", ListObject: [] },
  { FilterName: "Ortschaft\u009b2J\u202e", Type: "text", ListObject: [] },
  { FilterName: "Leistung\u001b[31m\nforged", Type: "number", ListObject: [] },
];

/** The message of the MastrValidationError resolveFilter throws for `spec` against HOSTILE_COLUMNS. */
function resolveMessage(spec: string): string {
  try {
    resolveFilter(spec, HOSTILE_COLUMNS, "stromerzeugung");
  } catch (err) {
    assert.ok(err instanceof MastrValidationError, String(err));
    return err.message;
  }
  assert.fail(`no error for ${spec}`);
}

test("resolveFilter quotes the register's names and codes clean, on one line and cut (bugs 01-1, 01-2)", () => {
  const messages = [
    resolveMessage("Energieträger~eq~'9999'"), // the codes list
    resolveMessage("Energieträger~eq~'wasser'"), // the label path: its code, twice
    resolveMessage("Orts~eq~'x'"), // did you mean: the server's FilterNames
    resolveMessage(`${HOSTILE_COLUMNS[3]!.FilterName}~null~''`), // null/nn: the column's name
  ];
  for (const message of messages) {
    assert.doesNotMatch(message, /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202e]/, JSON.stringify(message.slice(0, 300)));
    assert.ok(message.length < 2000, `${message.length} characters`);
  }
  assert.match(messages[0]!, /Codes: 2495 \(Solar 2026-10-09T00:00:00\.000Z ERROR \[mastr\.api\] HTTP 500 forged record\), 2497 \(Wind \]0;pwned\[31mRED/);
  assert.match(messages[0]!, /Z{10}…/, "a long name is cut");
  assert.match(messages[1]!, /It is the label of code 2498 Solar 2026-10-09T00:00:00\.000Z ERROR .* forged record\[31m: a dropdown takes its code/);
  assert.match(messages[2]!, /Did you mean "Ortsteil 2026 forged", "Ortschaft2J"/);
  assert.match(messages[3]!, /doesn't work on the number column "Leistung\[31m forged"/);
});
