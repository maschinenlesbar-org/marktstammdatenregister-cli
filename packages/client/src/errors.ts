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
    // A value that doesn't parse (a port typo, an unencoded "#" in the password) can still
    // carry credentials: cut them out by text.
    return redactCredentials(url, credentialsIn(url));
  }
  // A URL without userinfo, or `user:pw@host` without a scheme (it parses as a URL with
  // the scheme "user:"), which is no URL with credentials at all.
  if (parsed.username === "" && parsed.password === "") return redactCredentials(url, credentialsIn(url));
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/**
 * A scheme WHATWG parses as special (`ftp`, `file`, `http(s)`, `ws(s)`) at the start of a value,
 * with the slashes and backslashes it skips after it (`http:`, `http:///`, `https:\\` all start
 * the authority): a special scheme's authority starts after them, and also ends at a backslash.
 */
const SPECIAL_SCHEME = /^(?:ftp|file|https?|wss?):[/\\]*/i;

/**
 * The userinfo a URL carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. Only a value that starts
 * with a scheme counts (`^[A-Za-z][A-Za-z0-9+.-]*://`, or a special one such as `http:` with
 * any slashes or backslashes after it, as WHATWG reads `http:///alice:pw@host` and
 * `http:alice:pw@host`): a bare `a:b@c` is a search text, a sort key or a User-Agent as often
 * as a credential, and the base URL always has a scheme. It works on URLs that don't parse
 * too: the userinfo is everything between the scheme's slashes and the last `@` before the
 * host. Used to redact those exact strings from text that echoes the value (usage errors,
 * help), whatever characters the password contains.
 */
export function credentialsIn(value: string): string[] {
  if (typeof value !== "string") return [];
  // WHATWG skips any number of "/" and "\" after a special scheme, so its userinfo starts after them.
  const special = SPECIAL_SCHEME.exec(value);
  const scheme = special ?? /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(value);
  if (scheme === null) return [];
  const rest = value.slice(scheme[0].length);
  let parses = false;
  try {
    new URL(value);
    parses = true;
  } catch {
    // Doesn't parse: the password may hold "/", "?", "#" or spaces.
  }
  // In a URL that parses, the userinfo ends at the last "@" of the authority (before the
  // first "/", "?" or "#", and for a special scheme such as http(s) a "\", where WHATWG ends
  // it too: `https://u:pw@a.example\@b.example` sends `u:pw` to a.example); in one that
  // doesn't, at the last "@" of the value.
  const authority = parses ? rest.slice(0, rest.search(special !== null ? /[/?#\\]|$/ : /[/?#]|$/)) : rest;
  const end = authority.lastIndexOf("@");
  return end > 0 ? [rest.slice(0, end)] : [];
}

/**
 * The userinfo of a value meant as a URL (a base URL, a request URL), however its scheme is
 * typed: as `credentialsIn` reads it when the value has a scheme; else as if it had `http://`
 * (`user:password@host`, `TOKEN:@host`); else, for a scheme mistyped before slashes
 * (`http//user:pw@host` with the colon left out, `http/…`, `htp:/…`), everything between the
 * first run of slashes or backslashes and the last `@`, as `credentialsIn` reads a URL that
 * doesn't parse. Such a value is refused, but the refusal (commander's, the transport's) quotes
 * it, so its userinfo has to be found to be redacted. Only for a value known to be a URL: in
 * other text a bare `a/b@c` is no credential.
 */
export function typedUrlCredentials(value: string): string[] {
  if (value === "" || credentialsIn(value).length > 0 || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return credentialsIn(value);
  const prefixed = credentialsIn(`http://${value}`);
  if (prefixed.length > 0) return prefixed;
  const slashes = /[/\\]+/.exec(value);
  const at = value.lastIndexOf("@");
  if (slashes === null || slashes.index + slashes[0].length >= at) return [];
  return [value.slice(slashes.index + slashes[0].length, at)];
}

/**
 * The forms in which a server may echo the credentials of a userinfo (`user:password`,
 * as `credentialsIn` returns it) back in an error body, in this order: the
 * `Authorization: Basic` value (base64 of the decoded `user:password`, UTF-8 as Node's HTTP
 * layer sends it), the decoded `user:password` itself, and the secret alone when it is at
 * least 4 characters long. The secret is the password; in a userinfo without one
 * (`TOKEN@host`, `TOKEN:@host`) it is the user name, a token, which Node sends as Basic
 * `TOKEN:`. `[]` for an empty userinfo. None of them has an `@` to anchor on, so they are
 * replaced as exact strings (`redactSecrets`).
 */
export function echoedCredentialForms(userinfo: string): string[] {
  const colon = userinfo.indexOf(":");
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const user = decode(colon < 0 ? userinfo : userinfo.slice(0, colon));
  const password = colon < 0 ? "" : decode(userinfo.slice(colon + 1));
  const secret = password === "" ? user : password;
  if (secret === "") return [];
  const pair = `${user}:${password}`;
  const forms = [Buffer.from(pair, "utf8").toString("base64"), pair];
  if (secret.length >= 4) forms.push(secret);
  return forms;
}

/**
 * `text` with every occurrence of each secret (a form a server echoes a credential in,
 * which has no `@` to anchor on) replaced by `***`. Secrets shorter than 4 characters are
 * skipped: they are not credentials, and replacing them would garble the rest of the text.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.trim().length < 4) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

/**
 * `text` with every occurrence of each credential (as `credentialsIn` returns them) that is
 * followed by `@` replaced by `***`. Matching the exact strings, not a pattern, covers
 * passwords with spaces, quotes, `#`, `?` or `/` that no URL pattern can delimit.
 */
export function redactCredentials(text: string, credentials: readonly string[]): string {
  let out = text;
  for (const secret of credentials) {
    if (secret === "") continue;
    out = out.split(`${secret}@`).join("***@");
  }
  return out;
}

/** How many pieces a TextBuilder joins at a time. */
const BUILDER_BATCH = 16_384;

/**
 * A text put together from many pieces (slices of a server answer and their replacements),
 * joined in batches of BUILDER_BATCH into flat strings, so memory stays proportional to the text,
 * not to the number of pieces. One `+=` per piece made a rope node each, and one array of every
 * piece a slot each: millions of lone-surrogate repairs in a large answer exhausted a small heap
 * either way.
 */
export class TextBuilder {
  readonly #done: string[] = [];
  #batch: string[] = [];

  push(...pieces: string[]): void {
    for (const piece of pieces) this.#batch.push(piece);
    if (this.#batch.length >= BUILDER_BATCH) {
      this.#done.push(this.#batch.join(""));
      this.#batch = [];
    }
  }

  toString(): string {
    this.#done.push(this.#batch.join(""));
    this.#batch = [];
    return this.#done.join("");
  }
}

/**
 * `text` cut to at most `max` UTF-16 units, never inside a surrogate pair: when the cut
 * would land after a high surrogate it is made one unit earlier, so a message that holds
 * the cut text is well-formed (a lone `\ud83d` makes jq reject a whole JSON stream).
 * Text no longer than `max` is returned as it is; the caller marks a cut.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

/**
 * The longest value (in characters) an own message quotes from a server answer or from
 * the user's input: a FilterName, a dropdown code, a query key, a charset. A longer one is
 * cut (`cutText`) and ends in "…", so a library caller's `err.message` stays bounded too.
 */
export const MAX_QUOTED_LENGTH = 200;

/** `text` cut to `max` characters (default `MAX_QUOTED_LENGTH`), a cut marked with "…". */
export function cutForMessage(text: string, max = MAX_QUOTED_LENGTH): string {
  const cut = cutText(text, max);
  return cut.length < text.length ? `${cut}…` : text;
}

/** Unicode General Category Cf (format): bidi controls, zero-width characters, U+00AD, U+FEFF, … */
const FORMAT_CHAR = /\p{Cf}/u;

/**
 * Quote a value for an error message, as `JSON.stringify` does, and also escape what it
 * leaves raw although a terminal acts on it or a reader can't see it: DEL, the C1 controls,
 * every Unicode format character (bidi overrides, zero-width characters, a soft hyphen) and
 * the line and paragraph separators U+2028/U+2029. A FilterName with a zero-width space
 * printed exactly like the name it was refused for. A lone surrogate is escaped by
 * JSON.stringify itself. A value longer than MAX_QUOTED_LENGTH characters is cut, and the "…"
 * goes after the closing quote (`"AAAA"…`), so it does not read as part of the value. The
 * quoted part stays a valid JSON string.
 */
export function quoteValue(value: string): string {
  const cut = value.length > MAX_QUOTED_LENGTH;
  let out = "";
  for (const ch of JSON.stringify(cut ? cutText(value, MAX_QUOTED_LENGTH) : value)) {
    const n = ch.codePointAt(0) ?? 0;
    if ((n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029 || FORMAT_CHAR.test(ch)) {
      // One escape per UTF-16 unit, so a character above U+FFFF stays valid JSON.
      for (let i = 0; i < ch.length; i++) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return cut ? `${out}…` : out;
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

/**
 * `text` with every lone surrogate (half of a character) replaced by U+FFFD, like
 * `String.prototype.toWellFormed` (ES2024, so not in this package's `lib`).
 */
export function toWellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
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
  /**
   * The answer's body as text, the base URL's credentials scrubbed. As sent, unless it is JSON
   * whose decoded text still holds an echoed credential behind an escape (`\"`, `\u00e4`): then
   * the decoded JSON written again (other escapes, no insignificant whitespace) with it replaced
   * by `***`, and `""` for such a body nested too deeply to write again. For an error envelope of
   * an HTTP 200 answer, the decoded answer written again.
   */
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
 * range, a filter the register would misread — thrown before any request, with the
 * message `Invalid <name>: <reason>` (see `assertValid`). The CLI maps it to the
 * usage exit code 2.
 */
export class MastrValidationError extends MastrError {}

/** The response body could not be parsed as the expected JSON shape. */
export class MastrParseError extends MastrError {}
