// The library's input rules, as pure functions. Each `<thing>Problem(value)`
// returns the reason a value is invalid, or `undefined` when it is valid. The
// library enforces them with assertValid() before any request; the CLI's
// commander parsers call the same functions and turn the reason into a usage
// error, so a rule is written once and the CLI and the library cannot drift apart.

import { MastrValidationError } from "./errors.js";
import type { UnitQuery } from "./types.js";

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
 * A base URL must not carry whitespace or control characters. `new URL()` trims
 * surrounding whitespace and drops tab/CR/LF silently, but the engine joins the raw
 * string to each request path, so "https://h/MaStR " would request `/MaStR%20/...`
 * and a custom transport would see the raw value. Reject rather than guess.
 */
export const baseUrlWhitespaceProblem: Problem<string> = (value) => {
  if (typeof value !== "string") return `Expected a string, got ${show(value)}.`;
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return "A base URL cannot contain whitespace or control characters.";
  return undefined;
};

/**
 * Every rule for a base URL, in order: a non-blank string, no whitespace or control
 * characters ({@link baseUrlWhitespaceProblem}), an absolute URL, the `http:` or
 * `https:` scheme, and no query or fragment — request paths are appended to the
 * base URL as a string, so a `?` or `#` would swallow every path (`http://h/?x=1`
 * requests `/?x=1/Einheit/...`, `http://h/#f` requests `/`), and a `%` in the user name or
 * password that doesn't start a valid escape (Node fails to decode it for the Authorization
 * header at request time; a literal one is `%25`). Userinfo is allowed (error messages
 * redact it). The reasons never echo the URL.
 */
export const baseUrlProblem: Problem<string> = (value) => {
  const blank = nonBlankProblem(value);
  if (blank !== undefined) return blank;
  const spacing = baseUrlWhitespaceProblem(value);
  if (spacing !== undefined) return spacing;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Expected an absolute http(s) URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http and https URLs are supported.";
  if (/[?#]/.test(value)) return "A base URL cannot have a query (?) or fragment (#).";
  // Node decodes the userinfo into the Authorization header and throws "URI malformed" for a
  // "%" that isn't an escape — at request time, as a network error. Reject it here.
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  return undefined;
};

/**
 * A `sort` spec (`FieldKey-asc` / `FieldKey-desc`): not blank. A blank one would go
 * out as `sort=` (the same as no sort) or `sort=%20%20`, and an explicitly blank
 * sort is a mistake rather than a request for the default order. The shape itself is
 * left to the register: an unknown sort key there answers 0 rows.
 */
export const sortProblem: Problem<string> = (value) => nonBlankProblem(value);

/**
 * The `UnitQuery` keys that page the rows. The match count is the same on every
 * page, so `count()` refuses them rather than silently ignore them.
 */
export const COUNT_IGNORED_KEYS = ["page", "pageSize"] as const;

/** Why `query` cannot be counted: it sets a paging option. */
export const countQueryProblem: Problem<UnitQuery> = (query) => {
  const keys = COUNT_IGNORED_KEYS.filter((key) => query[key] !== undefined);
  if (keys.length === 0) return undefined;
  return `${keys.join(", ")} cannot be combined with count(): it counts every match, so paging does not apply.`;
};
