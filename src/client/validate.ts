// The library's input rules, as pure functions. Each `<thing>Problem(value)`
// returns the reason a value is invalid, or `undefined` when it is valid. The
// library enforces them with assertValid() before any request; the CLI's
// commander parsers call the same functions and turn the reason into a usage
// error, so a rule is written once and the CLI and the library cannot drift apart.

import { MastrValidationError } from "./errors.js";

/** A rule: the reason `value` is invalid, or `undefined` when it is valid. */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Throw a {@link MastrValidationError} with the message `Invalid <name>: <reason>`
 * when `problem(value)` finds a reason; otherwise return `value` unchanged. Call it
 * before any request, so a rejected input sends nothing. Async methods call it
 * inside their body, so the rejection arrives as a rejected promise rather than a
 * synchronous throw; constructors throw.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new MastrValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/** A value as it appears in a validation message: strings quoted, the rest as is. */
function show(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * A rule for an integer option: a safe integer from `min` to `max`. Anything else
 * (a negative, NaN, Infinity, a fraction, a non-number) gets the reason
 * `expected an integer from <min> to <max>, got <value>.`
 */
export function intRangeProblem(min: number, max: number): Problem<number> {
  return (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
      ? undefined
      : `expected an integer from ${min} to ${max}, got ${show(value)}.`;
}

/**
 * A string that is not blank: `""` or whitespace only is refused, because the
 * register reads an empty parameter as "not set" rather than as an error.
 */
export const nonBlankProblem: Problem<string> = (value) => {
  if (typeof value !== "string") return `Expected a string, got ${show(value)}.`;
  if (value.trim() === "") return "Expected a non-empty value.";
  return undefined;
};

/**
 * A rule for a value that goes into an HTTP header (User-Agent, `defaultHeaders`):
 * not blank, no control characters (a CR/LF or other C0 byte, DEL; tab is fine)
 * and no code units above U+00FF. That is what Node's HTTP layer accepts; anything
 * else it refuses with an opaque `ERR_INVALID_CHAR`, and a CR/LF handed to a custom
 * transport could inject a header. Checked by char code so the source stays free
 * of control bytes.
 */
export const headerValueProblem: Problem<string> = (value) => {
  const blank = nonBlankProblem(value);
  if (blank !== undefined) return blank;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/** A rule for an HTTP header name: an RFC 9110 token (`X-Trace-Id`). */
export const headerNameProblem: Problem<string> = (name) =>
  typeof name === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
    ? undefined
    : `Expected an HTTP header name (a token), got ${show(name)}.`;

/**
 * A `sort` spec (`FieldKey-asc` / `FieldKey-desc`): not blank. A blank one would go
 * out as `sort=` (the same as no sort) or `sort=%20%20`, and an explicitly blank
 * sort is a mistake rather than a request for the default order. The shape itself is
 * left to the register: an unknown sort key there answers 0 rows.
 */
export const sortProblem: Problem<string> = (value) => nonBlankProblem(value);
