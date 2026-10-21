// The library's input rules, as pure functions. Each `<thing>Problem(value)`
// returns the reason a value is invalid, or `undefined` when it is valid. The
// library enforces them with assertValid() before any request; the CLI's
// commander parsers call the same functions and turn the reason into a usage
// error, so a rule is written once and the CLI and the library cannot drift apart.

import { MastrValidationError, cutForMessage, quoteValue } from "./errors.js";
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

/** A value as it appears in a validation message: strings quoted (and cut, `cutForMessage`), the rest as is. */
function show(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(cutForMessage(value)) : String(value);
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

/**
 * A free-text value as the register matches it, canonical: without surrounding whitespace and
 * in composed Unicode (NFC; a decomposed "Münster", u plus U+0308 as pasted from a macOS file
 * name). Inner whitespace is kept. `buildFilter` runs it on every string value it quotes; the
 * register trims and composes values itself (live 2026-10-05), so this changes what is sent,
 * never what matches. Ids and codes (SEE…/ABR… numbers, dropdown codes) are ASCII, where NFC
 * changes nothing. A `--filter` spec is not rewritten: its values are the user's, inside the
 * register's DSL.
 */
export function normalizeText(value: string): string {
  return value.trim().normalize("NFC");
}

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which URLSearchParams would send as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it holds only whitespace, control and
 * format characters (a zero-width space, a soft hyphen) and combining marks. Such a value reads
 * as "no filter" upstream, or matches nothing, so it is refused as blank.
 */
function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control character inside a text value: C0 and C1, but not TAB, LF or CR (whitespace in a pasted phrase). */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** A format character inside a text value, but not ZWNJ/ZWJ (U+200C/U+200D), which some scripts and emoji need. */
const TEXT_FORMAT = /(?![\u200c\u200d])\p{Cf}/u;

/**
 * Why `value` cannot be sent as a free-text value (a text value inside a filter), or undefined
 * when it can. Refused, before any request, as the register would match nothing or everything:
 * - a value that is blank once trimmed (Unicode whitespace, U+00A0 included), or that holds only
 *   invisible characters and combining marks (`isBlank`);
 * - a lone surrogate (half of a character, sent as U+FFFD);
 * - a control character (but TAB, LF and CR) or a format character (a zero-width space, a soft
 *   hyphen, a bidi control; ZWNJ and ZWJ are allowed): pasted along, it makes the search find
 *   nothing.
 * The reason quotes the value with every invisible character escaped (`quoteValue`).
 */
export function textProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  if (LONE_SURROGATE.test(value)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TEXT_CONTROL.test(value)) return `${quoteValue(value)} contains a control character (${codePointOf(value, TEXT_CONTROL)}).`;
  if (TEXT_FORMAT.test(value)) return `${quoteValue(value)} contains an invisible character (${codePointOf(value, TEXT_FORMAT)}).`;
  return undefined;
}

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be sent as a token, or undefined when it can. A token is a value the
 * register compares exactly: a FilterName, a sort key, a dropdown code. The rules apply to the
 * value with surrounding whitespace trimmed, as it is sent ({@link normalizeToken}): not blank
 * (and not only invisible characters or combining marks), no lone surrogate, and no control or
 * format character at all (a zero-width space, ZWJ, a soft hyphen, a bidi control), since an
 * invisible character in a name or a code only ever makes it match nothing. The reason quotes
 * the value visibly.
 */
export function tokenProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
}

/** A token as it is sent: trimmed and in composed Unicode (NFC). Check it with {@link tokenProblem} first. */
export function normalizeToken(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * The items of a comma-separated list, as typed: each item is checked (`listProblem`) and
 * canonicalised (`normalizeToken`) on its own, so `"a1, a2"` sends `a2`, and `"a1,,a2"`, `"a1,"`
 * and `","` are refused rather than sent as an empty item.
 */
export function splitList(value: string): string[] {
  return value.split(",");
}

/**
 * Why `items` cannot be sent as a list, or undefined when it can: not an array of strings, no
 * item at all, or an item that `itemProblem` refuses (by default {@link tokenProblem}: a blank
 * item is refused, never dropped). The reason names the item.
 */
export function listProblem(items: readonly string[], itemProblem: Problem<string> = tokenProblem): string | undefined {
  if (!Array.isArray(items)) return "Expected a list of strings.";
  if (items.length === 0) return "Expected at least one value.";
  for (let i = 0; i < items.length; i++) {
    const problem = itemProblem(items[i] as string);
    if (problem !== undefined) return items.length === 1 ? problem : `item ${i + 1} of ${items.length}: ${problem}`;
  }
  return undefined;
}

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
 * left to the register: it refused an unknown sort key with `{"Error":true}` (live
 * 2026-10-09; it used to answer 0 rows), which the client turns into a MastrApiError.
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
