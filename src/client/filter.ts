// Checks for MaStR filter specs (`FilterName~op~'value'~and~…`), shared by the
// client (library callers) and the CLI's `--filter` parser. The register never
// reports a filter it misreads: it answers with a plausible but wrong count (an
// unfiltered total, a truncated condition list, or 0 rows), so specs it would
// misread are refused before any request.

import { MastrValidationError } from "./errors.js";

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
 *   returns the unfiltered register; a blank value for the other operators);
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
      const text = String(item);
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
  const spec = parts.join("~and~");
  validateFilter(spec);
  return spec;
}

/** Throw a {@link MastrValidationError} if {@link filterProblem} finds a problem. */
export function validateFilter(spec: string): void {
  const problem = filterProblem(spec);
  if (problem !== undefined) throw new MastrValidationError(`Invalid filter: ${problem}`);
}
