// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/**
 * Replace the userinfo of a URL (`https://user:secret@host/...`) with `***`, so a
 * credential in a base URL never reaches an error message, a log or CI output.
 * A URL without userinfo, or one that does not parse, is returned unchanged.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.username === "" && parsed.password === "") return url;
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/** Base class for every error originating from this client. */
export class MastrError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The API signalled a failure. MaStR is unusual: it answers HTTP 200 even when a
 * request logically failed, carrying the message in the envelope's `Errors` field
 * (e.g. "Die Anfrage ist Null."). This error models both worlds:
 *  - `status` is set for a genuine transport/HTTP failure (non-2xx);
 *  - otherwise it is a logical error taken from the response `Errors` string.
 * `detail` holds the human-readable message in either case.
 */
export class MastrApiError extends MastrError {
  readonly status: number | undefined;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;

  constructor(args: {
    url: string;
    method: string;
    body: string;
    status?: number;
    detail?: string;
  }) {
    // The URL is shown without userinfo: a credential in --base-url must not leak.
    const url = redactUrl(args.url);
    const detailPart = args.detail ? `: ${args.detail}` : "";
    const head = args.status !== undefined ? `HTTP ${args.status}` : "MaStR error";
    super(`${head} for ${args.method} ${url}${detailPart}`);
    this.status = args.status;
    this.url = url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
  }

  /** True for HTTP statuses the API treats as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }

  /** True for a transport-level HTTP 404. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class MastrNetworkError extends MastrError {}

/**
 * A client-side validation error — an unknown category, a page or pageSize out of
 * range, a filter the register would misread — thrown before any request.
 */
export class MastrValidationError extends MastrError {}

/** The response body could not be parsed as the expected JSON shape. */
export class MastrParseError extends MastrError {}
