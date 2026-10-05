// Checks for MaStR filter specs (`FilterName~op~'value'~and~…`), shared by the
// client (library callers) and the CLI's `--filter` parser. The register never
// reports a filter it misreads: it answers with a plausible but wrong count (an
// unfiltered total, a truncated condition list, or 0 rows), so specs it would
// misread are refused before any request.

import { MastrValidationError } from "./errors.js";
import type { FilterColumn } from "./types.js";

/**
 * The operators the register's search understands (from its web form, all checked
 * live). `gt`/`lt` are strict and only for `number`/`date` columns; there is no
 * `gte`/`lte`. Any other operator makes the register return 0 rows.
 */
export const FILTER_OPERATORS = ["eq", "neq", "sw", "ct", "nct", "ew", "null", "nn", "gt", "lt"] as const;

/** A filter operator. */
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/** Operators that test for an empty / non-empty column and ignore their value (send `''`). */
const UNARY_OPERATORS: ReadonlySet<string> = new Set(["null", "nn"]);

const OPERATORS: ReadonlySet<string> = new Set(FILTER_OPERATORS);

const SHAPE =
  "Expected FilterName~op~'value' (e.g. Energieträger~eq~'2495'), several joined by ~and~.";

/**
 * Describe why the register would misread a filter spec, or return `undefined` when
 * the spec is fine. The spec is read the way the register reads it — split on every
 * `~` into `FilterName`, operator and value, conditions joined by `and` — and must
 * have that shape:
 *
 * - every condition has a non-blank FilterName, a known lower-case operator and a
 *   value (`''` for `null`/`nn`: `Ort~null` without a value is ignored upstream and
 *   returns the unfiltered register); for the other operators the value is not blank,
 *   quoted (`''`, `' '`) or not;
 * - a value that starts with a single quote ends with one;
 * - conditions are joined by `and` only, and nothing dangles at the end.
 *
 * `~or~` is refused: the live search keeps only the part before the first `~or~` and
 * drops every later condition without an error (checked 2026-09-26: wind `2497` alone
 * 43633, `2497~or~…2498` also 43633). An OR between codes of one dropdown column works
 * as a comma list inside one value: `Energieträger~eq~'2497,2498'` (52448 = 43633 + 8815).
 *
 * An unknown FilterName cannot be checked here (the register ignores it and returns
 * the unfiltered set); compare with `filterColumns()`.
 */
export function filterProblem(spec: string): string | undefined {
  if (typeof spec !== "string") {
    return `Expected the filter as a string (FilterName~op~'value'), got ${spec === null ? "null" : Array.isArray(spec) ? "an array" : typeof spec}.`;
  }
  const parts = spec.split("~");
  let i = 0;
  for (let n = 1; ; n++) {
    const name = parts[i];
    const op = parts[i + 1];
    const value = parts[i + 2];
    if (name === undefined || name.trim() === "") {
      return `Condition ${n} has no FilterName. ${SHAPE}`;
    }
    if (op === undefined || value === undefined) {
      return `Condition ${n} ("${parts.slice(i).join("~")}") is incomplete. ${SHAPE}`;
    }
    if (!OPERATORS.has(op)) {
      const lower = op.trim().toLowerCase();
      const hint = OPERATORS.has(lower) ? ` Operators are lower case: use "${lower}".` : "";
      return (
        `Unknown operator "${op}" in condition ${n}. The operators are ` +
        `${FILTER_OPERATORS.join(", ")} (gt/lt are strict; there is no gte/lte); the register ` +
        `returns 0 rows for any other.${hint}`
      );
    }
    if (!UNARY_OPERATORS.has(op) && value.trim() === "") {
      return `Condition ${n} ("${name}~${op}") has no value. ${SHAPE}`;
    }
    // A quoted blank value ('' or ' ') is no value either: on a text column it matches
    // nothing, and on a dropdown the live register did not answer within 30 s
    // (2026-10-05). Only null/nn take ''.
    if (!UNARY_OPERATORS.has(op) && /^'\s*'$/.test(value.trim())) {
      return `Condition ${n} ("${name}~${op}~${value.trim()}") has no value: '' is only for null/nn. ${SHAPE}`;
    }
    if (value.startsWith("'") && (value.length < 2 || !value.endsWith("'"))) {
      // A later part that closes the quote means the value itself held a "~".
      const close = parts.findIndex((part, j) => j > i + 2 && part.endsWith("'"));
      if (close !== -1) {
        const meant = parts.slice(i + 2, close + 1).join("~");
        return (
          `The value ${meant} in condition ${n} contains "~". A filter value cannot contain "~": ` +
          `the register splits the filter on every "~" and has no escape, so it would read ${value}' ` +
          "and treat the rest as further conditions. Leave the ~ out (e.g. match a part with ct)."
        );
      }
      return `The value of condition ${n} (${value}) has no closing single quote. ${SHAPE}`;
    }
    i += 3;
    if (i >= parts.length) return undefined;
    const conjunction = parts[i] ?? "";
    if (conjunction.toLowerCase() === "or") {
      return (
        '"~or~" is not supported: the register ignores everything after the first ~or~ and ' +
        "returns a wrong count. For several codes of one dropdown column, list them in one " +
        "value: Energieträger~eq~'2497,2498'."
      );
    }
    if (conjunction !== "and") {
      return `Expected ~and~ after condition ${n}, got "~${conjunction}~". Conditions are joined by ~and~ only.`;
    }
    i += 1;
    if (parts.slice(i).join("~").trim() === "") {
      return 'The filter ends with "~and~": a condition must follow it.';
    }
  }
}

/**
 * A FilterName as the register spells it, as far as that can be told without its column
 * list: Unicode NFC, no surrounding whitespace, inner whitespace runs as one space. The
 * register matches FilterNames exactly and silently ignores one it doesn't know, so
 * `Energieträger` typed with a decomposed "ä" (macOS input: `a` + U+0308) or with a space
 * after `~and~` returned the unfiltered set (live 2026-10-05: 9 562 366 instead of 6 545 851).
 * The register's own names are NFC, never padded and never hold two spaces in a row, so this
 * can't turn a valid name into another one.
 */
export function normalizeFilterName(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ");
}

/**
 * The spec with every FilterName normalised ({@link normalizeFilterName}); the operators,
 * values and `and`s are left as they are. The spec is split the way the register splits it,
 * on every `~`: names are parts 0, 4, 8, … A malformed spec comes back with its names
 * normalised too; {@link filterProblem} then reports it. A non-string is returned as is.
 */
export function normalizeFilter(spec: string): string {
  if (typeof spec !== "string") return spec;
  return spec
    .split("~")
    .map((part, i) => (i % 4 === 0 ? normalizeFilterName(part) : part))
    .join("~");
}

/** One condition for {@link buildFilter}. */
export interface FilterCondition {
  /** The FilterName, e.g. `"Ort"` or `"Energieträger"` (see `filterColumns()`). */
  name: string;
  /** The operator. */
  op: FilterOperator;
  /**
   * The value, quoted by `buildFilter`. For a dropdown column pass its code; an array
   * becomes the comma list the register reads as "any of these codes". Ignored for
   * `null`/`nn` (sent as `''`). Must not contain `~` (nor `,` in an array item).
   */
  value?: string | number | readonly (string | number)[];
}

/**
 * Build a filter spec from conditions joined by `~and~`, quoting each value. Unlike
 * string interpolation (`Ort~eq~'${input}'`), a value can't add conditions: one with a
 * `~` (the register's separator, which has no escape) throws `MastrValidationError`, so
 * `Münster'~and~Energieträger~eq~'2497` is refused instead of becoming a second
 * condition.
 *
 *   buildFilter([{ name: "Ort", op: "eq", value: "Münster" },
 *                { name: "Energieträger", op: "eq", value: ["2497", "2498"] }])
 *   // → "Ort~eq~'Münster'~and~Energieträger~eq~'2497,2498'"
 */
export function buildFilter(conditions: readonly FilterCondition[]): string {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    throw new MastrValidationError("Invalid filter: expected at least one condition.");
  }
  const parts = conditions.map((c, index) => {
    const n = index + 1;
    if (typeof c?.name !== "string" || c.name.trim() === "" || c.name.includes("~")) {
      throw new MastrValidationError(
        `Invalid filter: condition ${n} needs a non-blank FilterName without "~", got ${JSON.stringify(c?.name)}.`,
      );
    }
    if (!OPERATORS.has(c.op)) {
      throw new MastrValidationError(
        `Invalid filter: unknown operator ${JSON.stringify(c.op)} in condition ${n}; expected one of ${FILTER_OPERATORS.join(", ")}.`,
      );
    }
    if (UNARY_OPERATORS.has(c.op)) return `${c.name}~${c.op}~''`;
    const items: readonly unknown[] = Array.isArray(c.value) ? c.value : [c.value];
    if (items.length === 0) {
      throw new MastrValidationError(`Invalid filter: condition ${n} ("${c.name}") has an empty value list.`);
    }
    const texts = items.map((item) => {
      if ((typeof item !== "string" && typeof item !== "number") || String(item).trim() === "") {
        throw new MastrValidationError(
          `Invalid filter: condition ${n} ("${c.name}") needs a non-blank value, got ${JSON.stringify(item)}.`,
        );
      }
      if (typeof item === "number" && !Number.isFinite(item)) {
        throw new MastrValidationError(
          `Invalid filter: condition ${n} ("${c.name}") needs a finite number, got ${String(item)}.`,
        );
      }
      const text = typeof item === "number" ? plainNumber(item) : item;
      if (text.includes("~")) {
        throw new MastrValidationError(
          `Invalid filter: the value ${JSON.stringify(text)} in condition ${n} contains "~", which the ` +
            "register reads as a separator (there is no escape).",
        );
      }
      if (items.length > 1 && text.includes(",")) {
        throw new MastrValidationError(
          `Invalid filter: the list item ${JSON.stringify(text)} in condition ${n} contains ",", which ` +
            "separates the codes of a list.",
        );
      }
      return text;
    });
    return `${c.name}~${c.op}~'${texts.join(",")}'`;
  });
  const spec = normalizeFilter(parts.join("~and~"));
  validateFilter(spec);
  return spec;
}

/**
 * A number as the register reads it: decimal point, no exponent, no grouping. `String()`
 * writes `1e-7` and `1e+21`, which the register answers with `{"Error":true}`.
 */
function plainNumber(n: number): string {
  const text = String(n);
  return /e/i.test(text) ? n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }) : text;
}

/**
 * Throw a {@link MastrValidationError} if {@link filterProblem} finds a problem. It checks
 * the spec as given; the client checks (and sends) the {@link normalizeFilter}ed spec.
 */
export function validateFilter(spec: string): void {
  const problem = filterProblem(spec);
  if (problem !== undefined) throw new MastrValidationError(`Invalid filter: ${problem}`);
}

/** Edit distance between two strings (Levenshtein), for "did you mean". */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** Up to three column names close to `name`, closest first. */
function closeNames(name: string, names: readonly string[]): string[] {
  const lower = name.toLowerCase();
  const limit = Math.max(2, Math.floor(name.length / 4));
  return names
    .map((candidate) => {
      const other = candidate.toLowerCase();
      const distance = other.includes(lower) || lower.includes(other) ? 0 : editDistance(lower, other);
      return { candidate, distance };
    })
    .filter(({ distance }) => distance <= limit)
    .sort((x, y) => x.distance - y.distance)
    .slice(0, 3)
    .map(({ candidate }) => candidate);
}

/** A value without its surrounding single quotes, when it has them. */
function unquote(value: string): string {
  return value.length >= 2 && value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value;
}

/**
 * Check a filter spec against the category's filter columns (`filterColumns()`) and return
 * it with every FilterName in the register's spelling, or throw a {@link MastrValidationError}.
 * The register silently ignores what it doesn't know, so these would otherwise give a wrong
 * count with exit 0:
 *
 * - a FilterName that is not a column of the category: the unfiltered set (live 2026-10-05:
 *   `energieträger~eq~'2495'` gave all 9 562 366 units, `Energieträger` on `gasverbrauch`
 *   all 937). A name that differs from a column only in case is written the register's way
 *   (the register's names don't collide in case); any other unknown name — `__proto__`
 *   included — is rejected with up to three close names;
 * - for `eq`/`neq` on a dropdown column, a value that is not one of its codes: an unknown
 *   code gives 0 rows, a label (`'Wind'`) or junk in a comma list `{"Error":true}`. A label
 *   is named with its code.
 *
 * `spec` must already pass {@link filterProblem} (the client normalises and checks it first).
 */
export function resolveFilter(spec: string, columns: readonly FilterColumn[], category: string): string {
  const byName = new Map<string, FilterColumn>();
  const byLowerName = new Map<string, FilterColumn[]>();
  for (const column of columns) {
    if (typeof column.FilterName !== "string") continue;
    byName.set(column.FilterName, column);
    const lower = column.FilterName.toLowerCase();
    byLowerName.set(lower, [...(byLowerName.get(lower) ?? []), column]);
  }
  const parts = spec.split("~");
  for (let i = 0, n = 1; i < parts.length; i += 4, n++) {
    const name = parts[i]!;
    let column = byName.get(name);
    if (column === undefined) {
      const sameCase = byLowerName.get(name.toLowerCase()) ?? [];
      if (sameCase.length === 1) column = sameCase[0]!;
    }
    if (column === undefined) {
      const near = closeNames(name, [...byName.keys()]);
      throw new MastrValidationError(
        `Invalid filter: unknown FilterName ${JSON.stringify(name)} in condition ${n}: ${category} has no such ` +
          "column, and the register would ignore it and return the unfiltered set." +
          (near.length > 0 ? ` Did you mean ${near.map((x) => JSON.stringify(x)).join(", ")}?` : "") +
          ` List the names with \`mastr filters ${category}\` (filterColumns() in the library).`,
      );
    }
    parts[i] = column.FilterName!;
    const op = parts[i + 1]!;
    const value = unquote(parts[i + 2]!.trim());
    const codes = (column.ListObject ?? []).filter(
      (o): o is { Name?: string; Value: string } => typeof o?.Value === "string",
    );
    if (column.Type === "multidropdown" && codes.length > 0 && (op === "eq" || op === "neq")) {
      for (const item of value.split(",").map((x) => x.trim())) {
        if (codes.some((o) => o.Value === item)) continue;
        const label = codes.find((o) => typeof o.Name === "string" && o.Name.toLowerCase() === item.toLowerCase());
        const shown = codes.slice(0, 8).map((o) => `${o.Value} (${o.Name ?? ""})`).join(", ");
        throw new MastrValidationError(
          `Invalid filter: ${JSON.stringify(item)} is not a code of the dropdown column ` +
            `${JSON.stringify(column.FilterName)} (condition ${n}). ` +
            (label !== undefined
              ? `It is the label of code ${label.Value}: a dropdown takes its code (${column.FilterName}~${op}~'${label.Value}').`
              : `The register would answer 0 rows or an error. Codes: ${shown}${codes.length > 8 ? ", …" : ""}; ` +
                `all of them with \`mastr filters ${category}\`.`),
        );
      }
    }
  }
  return parts.join("~");
}