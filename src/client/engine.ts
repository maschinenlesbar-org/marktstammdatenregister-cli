// The request engine: turns logical (path, query) calls into HTTP GET requests via
// a Transport, applies retry/backoff for transient statuses (429, 503), and decodes
// JSON responses. MaStR's public search backend is an unauthenticated GET API whose
// parameters travel in the query string.

import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  sizeLimitMessage,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  MastrApiError,
  MastrError,
  MastrNetworkError,
  MastrParseError,
  credentialsIn,
  redactCredentials,
  redactUrl,
} from "./errors.js";
import {
  assertValid,
  baseUrlProblem,
  headerNameProblem,
  headerValueProblem,
  intRangeProblem,
} from "./validate.js";

export const DEFAULT_BASE_URL = "https://www.marktstammdatenregister.de/MaStR";
const DEFAULT_USER_AGENT = "marktstammdatenregister-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /**
   * Base URL of the API. Defaults to the canonical marktstammdatenregister.de base.
   * A value that breaks a rule of {@link validateBaseUrl} (blank, whitespace or
   * control characters, not an absolute http(s) URL, a query or fragment) throws a
   * MastrValidationError.
   */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /**
   * Value of the User-Agent header: not blank, Latin-1 without control characters
   * (tab is fine), else a MastrValidationError.
   */
  userAgent?: string;
  /** Extra headers sent on every request; names must be tokens, values follow the `userAgent` rule. */
  defaultHeaders?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps: an integer 0..`MAX_TIMEOUT_MS` (2^31 - 1 ms); 0 disables.
   * Defaults to 30000.
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses and reset
   * connections (`isTransientNetworkError`), an integer
   * 0..`MAX_RETRIES` (10); defaults to 2. Each waits `retryDelayMs * attempt`, or the
   * response's `Retry-After` when that is longer. A `Retry-After` above
   * `MAX_RETRY_AFTER_MS` is not retried: the MastrApiError names the requested wait.
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly: `retryDelayMs * attempt`),
   * an integer 0..`MAX_RETRY_AFTER_MS` (30 000). Defaults to 200. It is also the floor: a
   * `Retry-After` can make a wait longer, never shorter.
   */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint), a non-negative integer. Defaults to 100 MiB;
   * set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/** Most retries `maxRetries` may ask for (each may wait up to `MAX_RETRY_AFTER_MS`). */
export const MAX_RETRIES = 10;

/**
 * A numeric engine option: `fallback` when undefined, else an integer in 0..max,
 * or a MastrValidationError (`Invalid <name>: expected an integer …`).
 */
function intOption(name: string, value: number | undefined, max: number, fallback: number): number {
  return value === undefined ? fallback : assertValid(name, value, intRangeProblem(0, max));
}

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/**
 * True for the Unicode bidirectional formatting characters: ALM (U+061C), LRM/RLM
 * (U+200E/U+200F), the embeddings and overrides U+202A–U+202E and the isolates
 * U+2066–U+2069. A terminal applies them to the text that follows, so an override
 * in server text can reorder what the user sees ("Trojan Source" spoofing).
 */
export function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Make a string that originates in an attacker-controlled response — the error
 * `detail` (a JSON field, an `Errors` value or a text snippet) and the echoed
 * Content-Type — safe to print into an error message on stderr:
 *
 * - C0 and C1 controls and DEL are dropped. `JSON.parse` decodes an escaped ESC into
 *   a real ESC byte; printed raw, a hostile or MITM'd endpoint could drive ANSI/OSC
 *   sequences into the terminal.
 * - Bidi formatting characters (isBidiControl) are dropped, so server text cannot
 *   reorder the visible message.
 * - Every run of whitespace — newlines, tabs, U+2028/U+2029 included — becomes one
 *   space and the ends are trimmed, so the text stays on one line and a server
 *   cannot forge an `Error:` line of its own.
 *
 * The CLI's JSON output is escaped separately (`escapeControlChars` in
 * cli/shared.ts): `JSON.stringify` alone leaves DEL, C1 and bidi characters raw.
 * Written as a code-point filter so no raw control byte appears in this source.
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    const whitespaceControl = n >= 0x09 && n <= 0x0d;
    if (!whitespaceControl && (n <= 0x1f || (n >= 0x7f && n <= 0x9f) || isBidiControl(n))) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Describe a Kendo `Errors` value for an error message: a string as is; otherwise
 * (a ModelState object such as `{"": {"errors": ["Invalid filter"]}}`, or an array)
 * every string found in it, sanitised, blanks and repeats dropped, joined "; ".
 * Returns `undefined` when nothing readable is left. `clean` runs on each raw string
 * first (the engine passes its credential scrubber).
 */
export function describeMastrErrors(errors: unknown, clean: (text: string) => string = (text) => text): string | undefined {
  const found: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (typeof value === "string") {
      const text = sanitizeServerText(clean(value));
      if (text !== "" && !found.includes(text)) found.push(text);
    } else if (value !== null && typeof value === "object" && depth < 5) {
      for (const v of Object.values(value)) walk(v, depth + 1);
    }
  };
  walk(errors, 0);
  return found.length > 0 ? found.join("; ") : undefined;
}

/**
 * Check a base URL against every rule of {@link baseUrlProblem} — blank, whitespace
 * or control characters, not an absolute URL, a scheme other than `http:`/`https:`,
 * a query or fragment — and return it with trailing slashes stripped. A bad value
 * throws a MastrValidationError (`Invalid baseUrl: <reason>`): it is a configuration
 * error, not a transport failure. The default transport still gates the scheme per
 * request, but the engine may be handed a custom transport that does no such check,
 * so the configured value is checked here, on the raw string.
 */
export function validateBaseUrl(raw: string): string {
  return assertValid("baseUrl", raw, baseUrlProblem).replace(/\/+$/, "");
}

/**
 * Check a value bound for an HTTP header (`headerValueProblem`) and return it, or
 * throw a MastrValidationError (`Invalid <name>: <reason>`). The engine runs it on
 * `userAgent` and every `defaultHeaders` value before any request.
 */
export function assertHeaderValue(name: string, value: string): string {
  return assertValid(name, value, headerValueProblem);
}

/** Check every `defaultHeaders` name (a token) and value; returns a copy. */
function checkedHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    assertValid("defaultHeaders name", name, headerNameProblem);
    out[name] = assertHeaderValue(`defaultHeaders["${name}"]`, value);
  }
  return out;
}

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by internal
 * slot, not `instanceof`, so a value from another realm (a vm context, a Jest test) counts.
 * Undefined for anything else.
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return Buffer.from(value as ArrayBuffer);
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names. A transport built on
 * `fetch` returns its `Headers` object, which has no plain properties (the engine then saw
 * no Retry-After and no Content-Type at all); such an object, or a `Map` (anything with
 * `get` and `forEach`), is copied into a record. A custom transport may also not
 * lower-case the names ("Retry-After").
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  const record: Record<string, string | string[] | undefined> = {};
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    (h.forEach as (cb: (value: string, name: string) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = value;
    });
    return record;
  }
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * True for a failure caused by a reset or aborted connection, which the engine retries —
 * whichever transport raised it (a Node error, fetch's TypeError with an undici cause), the
 * code anywhere in the `cause` chain. A refused connection, a DNS failure or a timeout is
 * not transient in that sense and is not retried.
 */
export function isTransientNetworkError(err: unknown): boolean {
  return hasTransientCode(err);
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  // Real private fields (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show them, so a password in the base URL (or a
  // credential in a default header) can't be logged by accident.
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  readonly #defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    // The raw value is checked before the trailing-slash strip, so "https://h/ "
    // cannot slip past it; only an omitted baseUrl selects the default.
    const baseUrl = options.baseUrl === undefined ? DEFAULT_BASE_URL : options.baseUrl;
    this.#baseUrl = validateBaseUrl(baseUrl);
    this.#credentials = credentialsIn(baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    this.transport = options.transport ?? nodeHttpTransport;
    // Header values are checked up front: a blank one would be sent as is, and a
    // CR/LF or a character above U+00FF would reach a custom transport raw or make
    // Node's HTTP layer throw an untyped ERR_INVALID_CHAR. Only an omitted
    // userAgent selects the default.
    this.userAgent =
      options.userAgent === undefined ? DEFAULT_USER_AGENT : assertHeaderValue("userAgent", options.userAgent);
    this.#defaultHeaders = checkedHeaders(options.defaultHeaders ?? {});
    // Range-check the numeric options: a negative, NaN or fractional value would
    // otherwise silently disable the timeout or the size cap, and an unbounded
    // maxRetries would keep retrying against the production register.
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, MAX_TIMEOUT_MS, 30_000);
    this.maxRetries = intOption("maxRetries", options.maxRetries, MAX_RETRIES, 2);
    // Bounded like a Retry-After wait: a larger value would stall the CLI, and one above
    // 2^31 - 1 ms would overflow Node's timer and retry after 1 ms.
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, MAX_RETRY_AFTER_MS, 200);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.sleep = options.sleep ?? realSleep;
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL) and transport text (fetch's "Failed to fetch <url>") can carry them. The
   * client runs it on the `Errors` envelopes it turns into errors.
   */
  scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactCredentials(text, this.#credentials);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original when its
   * text carries no credentials, otherwise a copy with them scrubbed (message, `code` and the
   * cause chain kept), so logging the error with its causes can't reveal the base URL's
   * password.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if (this.#credentials.length === 0 || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    if (message === cause.message && inner === cause.cause && !this.scrub(cause.stack ?? "").includes("***@")) {
      return cause;
    }
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /**
   * Call the transport under the overall deadline (`timeoutMs`): the request gets an
   * AbortSignal that fires at the deadline, and the call rejects then whether the transport
   * stops or not — a custom transport (fetch, a node:http wrapper) that ignores `timeoutMs`
   * can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new MastrNetworkError(`Request timed out after ${this.timeoutMs}ms`);
        controller.abort(err);
        reject(err);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Perform a GET with Accept negotiation and transient-error retries. Redirects
   * are NOT followed — the canonical host answers directly, so a 3xx (e.g. a bad
   * base URL bouncing to a portal page) surfaces as an error.
   *
   * The engine enforces the transport contract itself, so it holds for a custom
   * transport too: `timeoutMs` (an AbortSignal deadline), `maxResponseBytes` (checked on
   * the body it gets back), any byte-array body, `Headers`/`Map`/any-case headers. Whatever
   * a transport throws becomes a `MastrNetworkError`, and so does a malformed response; a
   * reset connection (`isTransientNetworkError`) is retried like a 503.
   */
  async request(path: string, query?: QueryParams, accept = "application/json"): Promise<RawResponse> {
    const url = this.buildUrl(path, query);
    const headers: Record<string, string> = {
      ...this.#defaultHeaders,
      Accept: accept,
      "User-Agent": this.userAgent,
      // The MaStR search backend is a Kendo/DataTables endpoint that expects an
      // XHR-style request; send the header a browser would.
      "X-Requested-With": "XMLHttpRequest",
    };

    let attempt = 0;
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.callTransport({
          method: "GET",
          url,
          headers,
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a gateway) reset is the network-level twin of a 503:
        // retry it, whichever transport reported it. Timeouts are not retried.
        if (hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(this.retryDelayMs * attempt);
          continue;
        }
        // The default transport rejects with MastrNetworkError only; an injected one may
        // throw anything (fetch's TypeError, a string, null). Keep the library's contract:
        // every failure is a MastrError.
        if (cause instanceof MastrNetworkError) {
          // Its text may echo the request URL; re-raise it scrubbed when it does.
          const message = this.scrub(cause.message);
          const inner = this.scrubCause(cause.cause);
          if (message === cause.message && inner === cause.cause) throw cause;
          throw new MastrNetworkError(message, inner === undefined ? undefined : { cause: inner });
        }
        if (cause instanceof MastrError) throw cause;
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new MastrNetworkError(`GET ${redactUrl(url)} failed: ${sanitizeServerText(this.scrub(reason))}`, {
          cause: this.scrubCause(cause),
        });
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface as a raw TypeError, or a missing status as a success.
      const invalid = responseProblem(response);
      if (invalid !== undefined) {
        throw new MastrNetworkError(
          `GET ${redactUrl(url)} failed: the transport returned an invalid response (${invalid}).`,
        );
      }
      const status = response.status;
      const responseHeaders = plainHeaders(response.headers);
      const body = bodyBytes(response.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a
      // custom one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new MastrNetworkError(sizeLimitMessage(this.maxResponseBytes));
      }

      const retryable = status === 429 || status === 503;
      // A Retry-After beyond MAX_RETRY_AFTER_MS is not retried: retrying early would land
      // inside the window the server asked us to wait out, and a hostile value must not stall
      // the CLI. The error then names the requested wait, so a script knows when to try again.
      const retryAfter = retryable ? parseRetryAfter(responseHeaders["retry-after"]) : undefined;
      if (retryable && attempt < this.maxRetries) {
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          // The linear backoff is the floor: a Retry-After can make a wait longer, never
          // shorter. `Retry-After: 0` or a date in the past turned the retries into a
          // zero-delay burst against a register that had just answered 429/503.
          const backoff = this.retryDelayMs * attempt;
          await this.sleep(retryAfter === undefined ? backoff : Math.max(retryAfter, backoff));
          continue;
        }
        throw this.toApiError(
          url,
          status,
          body,
          `the server asked to wait ${Math.ceil(retryAfter / 1000)} s (Retry-After) before trying again, ` +
            `longer than the ${MAX_RETRY_AFTER_MS / 1000} s the client waits, so it was not retried; ` +
            "retrying sooner won't help",
        );
      }

      const contentType = String(responseHeaders["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(url, status, body);
      }

      return { data: body, contentType, status };
    }
  }

  /**
   * GET a path with query params and parse the JSON reply into `T`. Every MaStR
   * endpoint answers with a JSON document, so an empty body or a 204 is a
   * `MastrParseError`, never a silent `null`.
   */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request(path, query);
    const text = res.data.toString("utf8");
    if (res.status === 204 || text.trim().length === 0) {
      throw new MastrParseError(`Empty response body from ${path}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new MastrParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
  }

  /** The MastrApiError for a non-2xx answer; `note` is appended to the detail. */
  private toApiError(url: string, status: number, body: Buffer, note?: string): MastrApiError {
    const text = this.scrub(body.toString("utf8"));
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { Errors?: unknown; message?: unknown; detail?: unknown };
      if (parsed?.Errors !== undefined && parsed.Errors !== null) detail = describeMastrErrors(parsed.Errors);
      else if (typeof parsed?.message === "string") detail = parsed.message;
      else if (typeof parsed?.detail === "string") detail = parsed.detail;
    } catch {
      // Not JSON (e.g. an HTML portal error page). Surface a short, whitespace-
      // collapsed snippet of a textual body; skip HTML pages (start with "<").
      const snippet = text.trim().replace(/\s+/g, " ");
      if (snippet.length > 0 && !snippet.startsWith("<")) {
        detail = snippet.length > 200 ? `${snippet.slice(0, 200)}…` : snippet;
      }
    }
    // `detail` came from the response body (JSON field or text snippet); the `\s+`
    // collapse above does not remove ESC, so strip control characters before it can
    // reach stderr and inject terminal escape sequences.
    if (detail !== undefined) detail = sanitizeServerText(detail);
    if (note !== undefined) detail = detail === undefined || detail === "" ? note : `${detail}; ${note}`;
    return new MastrApiError({ status, url, method: "GET", body: text, detail });
  }
}
