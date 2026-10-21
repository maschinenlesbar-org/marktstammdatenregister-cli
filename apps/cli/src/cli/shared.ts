// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and JSON rendering (with the --iso-dates transform).

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { logOf, type CliDeps } from "./io.js";
import type { MastrClientOptions } from "@maschinenlesbar.org/marktstammdatenregister-client/internal/client";
import { isoifyDates } from "@maschinenlesbar.org/marktstammdatenregister-client/internal/client";
import { MastrParseError } from "@maschinenlesbar.org/marktstammdatenregister-client/internal/errors";
import { filterProblem, normalizeFilter } from "@maschinenlesbar.org/marktstammdatenregister-client/internal/filter";
import { DEFAULT_BASE_URL, cleartextProblem, isBidiControl } from "@maschinenlesbar.org/marktstammdatenregister-client/internal/engine";
import {
  baseUrlProblem,
  headerValueProblem,
  nonBlankProblem,
  sortProblem,
  type Problem,
} from "@maschinenlesbar.org/marktstammdatenregister-client/internal/validate";
import type { RetryEvent } from "@maschinenlesbar.org/marktstammdatenregister-client/internal/engine";

/**
 * commander value-parser: a plain base-10 non-negative integer.
 *
 * Uses a strict regex rather than `Number()` coercion, which would otherwise
 * accept empty/whitespace strings (`Number("") === 0`), hex/binary/scientific
 * literals (`0x10`, `0b10`, `1e3`), signs, padding and decimals.
 */
export function parseIntArg(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/**
 * Build a commander value-parser from a library rule: the rule's reason becomes the
 * usage error, a valid value passes unchanged.
 */
export function parseWith(problem: Problem<string>): (value: string) => string {
  return (value: string) => {
    const reason = problem(value);
    if (reason !== undefined) throw new InvalidArgumentError(reason);
    return value;
  };
}

/** commander value-parser: a non-empty (after trimming) string (the library's `nonBlankProblem`). */
export const parseNonEmpty = parseWith(nonBlankProblem);

/** commander value-parser for `--sort`: the library's `sortProblem` (not blank). */
export const parseSort = parseWith(sortProblem);

/**
 * commander value-parser for `--filter`: non-blank, and not a spec the register would
 * misread (see `filterProblem`, run on the `normalizeFilter`ed spec as the client sends
 * it), so it becomes a usage error before any request. The flag can be repeated: a second
 * `--filter` is joined to the first with `~and~` (it used to replace it silently, and
 * "solar in Bavaria" became "every unit in Bavaria"). The FilterNames and dropdown codes
 * are checked by the client against the category's columns.
 */
export function parseFilter(value: string, previous?: string): string {
  parseNonEmpty(value);
  const problem = filterProblem(normalizeFilter(value));
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return previous === undefined ? value : `${previous}~and~${value}`;
}

/**
 * Wrap a value-parser so its option may be given only once: commander keeps the last of a
 * repeated option and drops the others without a word (`--sort A --sort B` sorted by B,
 * `--page 2 --page 3` fetched page 3). A repeat is a usage error naming the flag. A fresh
 * program is built per `run()`, so the state lives as long as one parse.
 */
export function once<T>(flag: string, parse: (value: string) => T): (value: string) => T {
  let seen = false;
  return (value: string) => {
    if (seen) throw new InvalidArgumentError(`${flag} was given more than once; give it once.`);
    seen = true;
    return parse(value);
  };
}

/**
 * commander value-parser for `--base-url`: the library's `baseUrlProblem` (non-blank,
 * no whitespace, an absolute http(s) URL without a query or fragment), whose reason
 * becomes a usage error (exit 2) naming the value the user typed. The CLI keeps no
 * rules of its own; the client constructor enforces the same rule for library callers.
 */
export const parseBaseUrl = parseWith(baseUrlProblem);

/** Build a commander value-parser for an integer constrained to [min, max]. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = parseIntArg(value);
    if (n < min) throw new InvalidArgumentError(`Must be >= ${min}.`);
    if (n > max) throw new InvalidArgumentError(`Must be <= ${max}.`);
    return n;
  };
}

/**
 * commander value-parser for a value that ends up in an HTTP header (User-Agent):
 * the library's `headerValueProblem` (not blank, Latin-1 without control
 * characters; tab is fine), whose reason becomes the usage error. The engine runs
 * the same rule on `userAgent`.
 */
export const parseHeaderValue = parseWith(headerValueProblem);

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
  isoDates?: boolean;
}

/** Translate resolved global CLI options into client options. */
export function toEngineOptions(global: GlobalOptions): MastrClientOptions {
  const options: MastrClientOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Escape the characters JSON.stringify leaves raw although a terminal acts on them.
 * It escapes C0 (including ESC) but not DEL, the C1 range U+0080–U+009F (U+009B is
 * the 8-bit form of CSI) or the bidi formatting characters (isBidiControl), which
 * reorder the text that follows. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if ((c >= 0x7f && c <= 0x9f) || isBidiControl(c)) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * Render a JSON value to stdout, pretty by default and compact with --compact.
 * With --iso-dates, every MaStR `"/Date(ms)/"` string is rewritten to ISO-8601 first.
 *
 * An answer nested too deeply (within the size cap, which JSON.parse reads) can exhaust the
 * call stack in the recursive isoifyDates transform or in JSON.stringify, throwing a
 * RangeError: it becomes a MastrParseError (an ERROR record of `mastr.api`, exit 1, nothing on
 * stdout), consistent with a JSON.parse depth failure, rather than "Unexpected error". The
 * pretty printer's message suggests --compact, whose printer goes deeper.
 */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  let shaped: unknown;
  try {
    shaped = global.isoDates ? isoifyDates(value) : value;
  } catch (cause) {
    if (cause instanceof RangeError) throw new MastrParseError("Response is too deeply nested to render.", { cause });
    throw cause;
  }
  deps.io.out(escapeControlChars(stringifyJson(shaped, global.compact === true)));
}

/**
 * JSON.stringify, pretty or compact; a RangeError (nesting too deep) is a MastrParseError.
 *
 * Compact output takes V8's fast path (no gap) unless the answer holds a huge string: on Node 26
 * the fast path aborts the process ("Zone Allocation failed", exit 134, a native dump on stderr)
 * on a string of some 250 MB that JSON.parse made, while the gap path (an empty gap, the same
 * text) prints it. The fast path stays the default because on Node 26 only it is iterative and
 * prints nesting the gap path refuses (~7,000 levels).
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    if (!compact) return JSON.stringify(value, null, 2);
    return holdsHugeString(value) ? JSON.stringify(value, null, "") : JSON.stringify(value);
  } catch (cause) {
    if (!(cause instanceof RangeError)) throw cause;
    throw new MastrParseError(
      compact ? "Response is too deeply nested to render." : "Response is too deeply nested to pretty-print; try --compact.",
      { cause },
    );
  }
}

/** A string or key this long sends --compact through the gap path: a quarter of where Node 26's fast path aborts. */
const HUGE_STRING_LENGTH = 64 * 1024 * 1024;

/** Whether `value` holds a string or key of HUGE_STRING_LENGTH or more. Iterative, so nesting costs no stack. */
function holdsHugeString(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === "string") {
      if (item.length >= HUGE_STRING_LENGTH) return true;
    } else if (typeof item === "object" && item !== null) {
      for (const [key, element] of Object.entries(item)) {
        if (key.length >= HUGE_STRING_LENGTH) return true;
        if (typeof element === "string" || (typeof element === "object" && element !== null)) stack.push(element);
      }
    }
  }
  return false;
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/** `HTTP 503 from host: retry 1 of 3 in 2 s` (host only; whole seconds, ms under 1 s). */
export function retryMessage(event: RetryEvent): string {
  let host: string;
  try {
    host = new URL(event.url).host;
  } catch {
    host = "the server";
  }
  const why = event.status === undefined ? "connection reset" : `HTTP ${event.status}`;
  const wait = event.delayMs < 1000 ? `${event.delayMs} ms` : `${Math.round(event.delayMs / 1000)} s`;
  return `${why} from ${host}: retry ${event.retry} of ${event.maxRetries} in ${wait}`;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    // Once per run, before the first request: a remote plain-http base URL sends every
    // request (and any userinfo in it) unencrypted. stderr only; the run goes ahead.
    const cleartext = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL);
    if (cleartext !== undefined) logOf(deps).warn("http", cleartext);
    const options = toEngineOptions(global);
    options.onRetry = (event) => logOf(deps).warn("http", retryMessage(event));
    const client = deps.createClient(options);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
