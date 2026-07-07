// The request engine: turns logical (path, query) calls into HTTP GET requests via
// a Transport, applies retry/backoff for transient statuses (429, 503), and decodes
// JSON responses. MaStR's public search backend is an unauthenticated GET API whose
// parameters travel in the query string.

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { MastrApiError, MastrParseError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://www.marktstammdatenregister.de/MaStR";
const DEFAULT_USER_AGENT = "marktstammdatenregister-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /** Base URL of the API. Defaults to the canonical marktstammdatenregister.de base. */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /** Extra headers sent on every request. */
  defaultHeaders?: Record<string, string>;
  /** Per-request timeout in milliseconds (0 disables). */
  timeoutMs?: number;
  /** Number of automatic retries for transient (429/503) responses. */
  maxRetries?: number;
  /** Base backoff between retries in milliseconds (grows linearly). */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * Strip control characters (C0 except tab/newline, DEL, and C1) out of a string
 * that originates in an attacker-controlled response — the error `detail` and the
 * echoed Content-Type. `JSON.parse` decodes an escaped ESC in an error body into a
 * real ESC byte, so without this a hostile/MITM'd endpoint could drive ANSI/OSC
 * escape sequences into the user's terminal when the message is printed to stderr.
 * The success path is already safe (`JSON.stringify` escapes these), so this only
 * needs to cover text that flows into an error message. Implemented as a code-point
 * filter so no raw control byte ever appears in this source file.
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? realSleep;
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /**
   * Perform a GET with Accept negotiation and transient-error retries. Redirects
   * are NOT followed — the canonical host answers directly, so a 3xx (e.g. a bad
   * base URL bouncing to a portal page) surfaces as an error.
   */
  async request(path: string, query?: QueryParams, accept = "application/json"): Promise<RawResponse> {
    const url = this.buildUrl(path, query);
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      Accept: accept,
      "User-Agent": this.userAgent,
      // The MaStR search backend is a Kendo/DataTables endpoint that expects an
      // XHR-style request; send the header a browser would.
      "X-Requested-With": "XMLHttpRequest",
    };

    let attempt = 0;
    for (;;) {
      const response = await this.transport({
        method: "GET",
        url,
        headers,
        timeoutMs: this.timeoutMs,
        ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
      });

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleep(this.retryDelayMs * attempt);
        continue;
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(url, status, response.body);
      }

      return { data: response.body, contentType, status };
    }
  }

  /** GET a path with query params and parse the JSON reply into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request(path, query);
    const text = res.data.toString("utf8");
    if (res.status === 204 || text.trim().length === 0) {
      return null as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new MastrParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
  }

  private toApiError(url: string, status: number, body: Buffer): MastrApiError {
    const text = body.toString("utf8");
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { Errors?: unknown; message?: unknown; detail?: unknown };
      if (typeof parsed?.Errors === "string") detail = parsed.Errors;
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
    return new MastrApiError({ status, url, method: "GET", body: text, detail });
  }
}
