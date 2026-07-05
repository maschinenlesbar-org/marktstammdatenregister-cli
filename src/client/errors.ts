// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

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
    const detailPart = args.detail ? `: ${args.detail}` : "";
    const head = args.status !== undefined ? `HTTP ${args.status}` : "MaStR error";
    super(`${head} for ${args.method} ${args.url}${detailPart}`);
    this.status = args.status;
    this.url = args.url;
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

/** A client-side validation error (e.g. a bad category) — no request made. */
export class MastrValidationError extends MastrError {}

/** The response body could not be parsed as the expected JSON shape. */
export class MastrParseError extends MastrError {}
