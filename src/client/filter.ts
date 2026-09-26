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

/** Throw a {@link MastrValidationError} if {@link filterProblem} finds a problem. */
export function validateFilter(spec: string): void {
  const problem = filterProblem(spec);
  if (problem !== undefined) throw new MastrValidationError(`Invalid filter: ${problem}`);
}
