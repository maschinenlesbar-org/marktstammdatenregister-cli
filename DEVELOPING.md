# Developing `marktstammdatenregister-cli`

Architecture, testing, and the live-API quirks of the Marktstammdatenregister (MaStR)
public search API. Read this before changing the client or CLI.

## What this is

A typed client + CLI for the MaStR public unit-search backend, part of the `*-cli`
family. It follows the shared two-layer blueprint (a dependency-free `client/` usable
as a library, and a commander `cli/` over it) with the family's two test seams. Where
MaStR diverges from the family defaults, this file documents why — **match this repo,
not the generic blueprint.**

## Commands

```bash
npm install
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit
npm test            # pretest builds, then `node --test dist/test/*.test.js`
npm start -- --help
```

## Layout

```
src/
  client/        # typed API client, usable independently of the CLI
    types.ts     # MastrUnit + the Kendo envelope + query/filter-column types
    query.ts     # dependency-free query-string builder (sends empty strings!)
    http.ts      # Transport interface + default node:http/https transport
    engine.ts    # URL building, GET, retry/backoff, JSON decode, error mapping
    errors.ts    # MastrError / MastrApiError / MastrNetworkError / MastrValidationError / MastrParseError
    validate.ts  # input rules (Problem functions) + assertValid(), shared by library and CLI
    client.ts    # MastrClient (+ parseMsDate / isoifyDates)
    index.ts
  cli/
    io.ts        # injectable I/O (CliDeps / CliIO) — no env seam (no auth)
    shared.ts    # option parsers, global->engine mapping, JSON render (+ --iso-dates)
    commands/units.ts  # the 4 category commands + the `filters` command
    program.ts   # assembles the commander program
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
  index.ts       # library entry
```

Two seams make it testable in-process: **`Transport`** (the only HTTP seam) and
**`CliDeps`** (client factory + I/O; `run.ts` returns an exit code).

## How the API works (and where it bites)

MaStR's public search is an **unauthenticated GET** API. Each category is a Kendo UI
Grid endpoint under `/Einheit/EinheitJson/GetErweiterteOeffentlicheEinheit<Cat>`,
returning `{ Data, Total, AggregateResults, Errors }`. All the following were verified
live — the OpenAPI spec is thin, so trust the live behaviour:

| Quirk | Reality | Where handled |
|---|---|---|
| **The Kendo null-request trap** | The endpoint binds a `[DataSourceRequest]`. Omit `group`/`filter` and the whole request binds to null → `{"Errors":"Die Anfrage ist Null."}`. **All five params (`sort`, `page`, `pageSize`, `group`, `filter`) must be present, even empty.** | `client.ts` `units()` always sends the full set; `query.ts` sends empty strings (not dropped) |
| **Logical errors on HTTP 200** | Failures come back as HTTP 200 with a non-null `Errors` — a string, or a Kendo ModelState object (`{"": {"errors": [...]}}`). | `client.ts` throws `MastrApiError` for any non-null `Errors` (messages collected by `describeMastrErrors`) |
| **A second error envelope** | A filter value the register can't read (a dropdown label, a decimal comma, `'5e3'`, an invalid date, `'true'` for a boolean, `null`/`nn` on a non-text column) gets HTTP 200 `{"Error":true,"Message":null,"Type":"danger",…}` — no `Total`, no `Errors`. | `client.ts` `registerRejected()`: a `MastrApiError` (exit 1) that names the usual causes and the `Message` when there is one |
| **Malformed 200 replies** | Only the envelope's top level is checked, never the ~90-field rows: a JSON object, a non-negative integer `Total`, a `Data` array (`null` allowed only with `Total: 0`) with no more rows than `Total` and than the `pageSize` asked for. An empty body or 204 is `MastrParseError` `Empty response body from <path>`; anything else `Unexpected response shape from <path>: expected …` (exit 1) — a broken reply must not print as "0 matches". | `client.ts` `units()`, `engine.ts` `getJson()` |
| **`~or~` is silently truncated** | The search keeps only the part before the first `~or~` and drops every later condition, no error (2026-09-26: `2497` alone and `2497~or~…2498` both 43633). An OR between codes of one dropdown works as a comma list in one value (`Energieträger~eq~'2497,2498'` → 52448). | `filter.ts` `filterProblem()`: the client throws `MastrValidationError`, the CLI's `--filter` parser a usage error |
| **No escape for `~` in a value** | The register splits the filter on every `~`, even inside quotes: `ct 'a~b'` gives the same count as `ct 'a'`, and interpolated input (`Ort~eq~'${input}'`) can add conditions. | `filterProblem()` names a `~` inside a quoted value; library callers use `buildFilter()`, which quotes values and refuses a `~` |
| **Malformed filters are misread, not refused** | A spec that is not `FilterName~op~value(~and~…)*` goes through: `foo` or a dangling `~and~` gives the unfiltered set, an unknown or upper-case operator (`gte`, `EQ`) 0 rows, `Ort~null` without `''` is ignored. | `filterProblem()` checks the shape the register splits on `~` (FilterName, known lower-case operator, value, `and`) before any request. |
| **Unknown FilterNames and codes are ignored** | A FilterName the category doesn't have (a typo, another case, a name of another category) is ignored: the unfiltered set, exit 0 (live 2026-10-05: `energieträger~eq~'2495'` → all 9 562 366). An unknown dropdown code gives 0 rows; a label (`'Wind'`) or junk in a comma list `{"Error":true}`. | `client.ts` `checkedFilter()` → `filter.ts` `resolveFilter()`: every name (case-insensitively, then written the register's way) and every `eq`/`neq` dropdown code is checked against `filterColumns()` (fetched once per client and category; a failed fetch is not cached) before the unit request; `MastrValidationError` with "did you mean". `allowUnknownFilters: true` skips it. Query keys other than `page`/`pageSize`/`sort`/`filter` (`filtr`, `__proto__`) are refused too |
| **Repeated options** | commander keeps the last of a repeated option: `--filter A --filter B` sent only `B` ("solar in Bavaria" became every unit in Bavaria, 2 042 883 instead of 1 456 625). | `shared.ts`: `parseFilter` joins repeated `--filter`s with `~and~`; every other value option is wrapped in `once()`, a repeat is a usage error |
| **Charset** | The register sends `application/json; charset=utf-8`; a mirror or re-encoding proxy may not. | `engine.ts` `getJson()` decodes by the declared charset (`TextDecoder`, BOM dropped); an unknown label is `MastrParseError` |
| **FilterNames match exactly** | A FilterName with a decomposed umlaut (macOS input), a leading/trailing space (`~and~ Bundesland`) or two spaces in a row is ignored like an unknown one: the unfiltered set (live 2026-10-05: 9 562 366 instead of 6 545 851). Values are normalised by the register itself (`'Mu\u0308nster'` = `'Münster'`, `' 2495 '` = `'2495'`). | `filter.ts` `normalizeFilter()`/`normalizeFilterName()` (NFC, trim, one space; operators and `and`s trimmed; whitespace outside a quoted value dropped, so `'Münster' ~and~…` isn't misread as a value holding `~`); `units()` and `buildFilter()` send the normalised spec, the CLI's `--filter` parser checks it |
| **Microsoft dates** | Dates are `"/Date(ms)/"` strings, not ISO (the offset form `/Date(ms+hhmm)/` is accepted too; not seen live). | `parseMsDate()` (null for an out-of-range value) / `isoifyDates()`; CLI `--iso-dates` |
| **No aggregate endpoint** | `AggregateResults` is null; there is no server-side capacity sum — only the `Total` count. | documented; `MastrClient.count()` (the CLI's `--total`) returns the count with a one-row request, but there is no sum |
| **Wide, category-varying rows** | ~90 fields; a solar unit carries columns a gas consumer lacks. | `MastrUnit` types the common fields + an index signature |
| **Withheld data** | Natural-person and confidential data are not published (operator names anonymised; some location data withheld for units < 30 kW). | documented; fields are optional/nullable |

The engine sends `X-Requested-With: XMLHttpRequest` (the endpoint is an XHR backend).
Redirects are **not** followed — a 3xx (e.g. a wrong base URL bouncing to a portal
page) surfaces as an error and maps to the usage exit code.

**Custom transports.** The engine enforces the transport contract itself, so the
documented limits hold for a `fetch` or `node:http` transport too. Every call runs under
the overall `timeoutMs` deadline: the request carries an `AbortSignal`
(`HttpRequest.signal`, honoured by the default transport) that fires at the deadline, and
the call rejects then whether the transport stops or not. `maxResponseBytes` is checked on
the body any transport returns (the message names `--max-response-bytes` too). A body may be
a Buffer, any `ArrayBuffer` view (fetch's `Uint8Array`, from any realm) or an `ArrayBuffer`;
headers a plain record in any case, a `Headers` object or a `Map`. Whatever a transport
throws, and a response without a valid status, headers or body, becomes a
`MastrNetworkError`; a reset reported as `ECONNRESET`/`EPIPE`/`ECONNABORTED` or undici's
`UND_ERR_SOCKET` anywhere in the `cause` chain is retried like a 503.

**Credentials in the base URL.** A `user:password@` in `--base-url` (a mirror behind a
login) is sent as HTTP Basic auth and never printed. `run()` starts with
`withRedactedOutput(deps, argv)`: it collects the exact userinfo of every argument and of
the value part of every `--opt=value` token (`credentialsIn`, which also handles values that
don't parse as a URL and the scheme-less `user:pw@host`) and redacts those strings, raw and
JSON-quoted, from every line the CLI prints — commander's usage errors echo rejected values,
and a pattern can't delimit a password holding a space, quote, `#`, `?` or `/`.
`redactUrl` falls back to the same exact-string redaction for a value that doesn't parse.
In the library the engine keeps the base URL and the default headers in real `#private`
fields, so `console.log(client)`, `util.inspect` and `JSON.stringify` never show them, and
it scrubs the base URL's userinfo (raw and percent-decoded) from error bodies and details,
`Errors` envelopes, transport error text and the `cause` chain it attaches.

The client validates its own inputs before any request, for library callers the CLI's
parsers don't cover: an unknown category, `page` outside 1..`MAX_PAGE` (1 000 000),
`pageSize` outside 1..`MAX_PAGE_SIZE` (5000), a blank or whitespace-only `sort`
(`sortProblem`) and a malformed filter throw
`MastrValidationError` (`Invalid <name>: expected …, got <v>.`). The client
constructor range-checks the engine options the same way (`intRangeProblem`):
`timeoutMs` 0..`MAX_TIMEOUT_MS`, `maxRetries` 0..`MAX_RETRIES` (10),
`retryDelayMs` 0..30 000, `maxResponseBytes` a non-negative integer — a negative, `NaN` or
fractional value would otherwise silently disable the timeout or the size cap. The
CLI's `--max-retries` parser reads the same exported `MAX_RETRIES`. `userAgent` and
every `defaultHeaders` value must pass `headerValueProblem` (not blank, Latin-1, no
control characters but tab; `defaultHeaders` names must be tokens), so a CR/LF never
reaches a custom transport; `--user-agent` uses the same rule. The default transport
turns a header Node still refuses into a `MastrNetworkError`, never a raw `TypeError`.
The constructor checks `baseUrl` with the exported `validateBaseUrl` (`baseUrlProblem`:
blank, surrounding or inner whitespace or control characters, not an absolute
http(s) URL, a query or fragment, a `%` in the userinfo that isn't an escape — Node would
fail to decode it for the Authorization header at request time) and throws `MastrValidationError` — a configuration
error, not a `MastrNetworkError`, which stays for transport failures (the default
transport still gates the scheme per request). It runs on the raw value, before the
trailing-slash strip: `new URL()` would trim whitespace silently while the engine joins
the raw string to each path (`/MaStR%20/...`). `--base-url` uses the same rule. Wrong types are `MastrValidationError` too, never a raw `TypeError`: options that
aren't an object, an unknown option key (`timeout` for `timeoutMs`, with a "did you mean"),
a `transport` or `sleep` that isn't a function, `defaultHeaders` that isn't an object, a
query that isn't an object, a filter that isn't a string (`null` counts as "none" for
options and queries). Server text in an error message is cut at 500 characters
(`MAX_DETAIL_LENGTH`); `MastrApiError.body` keeps all of it. `count(category, { filter, sort })` refuses `page` and
`pageSize` (`countQueryProblem`): the count is the same on every page.

**The library owns every input rule.** A rule is a pure, exported `…Problem(value)`
function (the reason a value is invalid, or `undefined`), in `validate.ts` or next to
the code it guards (`filterProblem` in `filter.ts`). The library enforces it with
`assertValid(name, value, problem)`, which throws `MastrValidationError` with
`Invalid <name>: <reason>` before any request (constructors throw, async methods
reject). The CLI's commander parsers call the same function and turn the reason into a
usage error; a `MastrValidationError` raised during an action exits 2 with
`Error: <message>`. Parity tests (`parity()` in `test/helpers.ts`) send one input
through `run()` and through the library on one mock transport and expect the same
outcome.

## Testing

`node --test` on the compiled `dist/test/`. Notable coverage:
- `query.test.ts` — the builder **sends empty-string values** (`sort=&group=&filter=`),
  the linchpin of the null-request fix.
- `client.test.ts` — `units()` ALWAYS sends the full Kendo param set; category routing;
  the `Errors` envelope throws; `parseMsDate`/`isoifyDates`.
- `cli.test.ts` — the 4 commands, paging bounds, `--total`, `--iso-dates`, the `filters`
  command, and the hardening guards (control-char UA, empty base URL, bounded retries).

## Conventions to keep

- **Zero runtime HTTP deps**; strict TS + ESM; passes on Node 22/24 (`engines`: Node.js 22.12 or later, the floor commander 15 declares).
- **Exit codes** (`run.ts`): help/version → 0; usage → 2; 404 → 4; network → 6; other → 1.
- **Closed pipes** (`io.ts` `handleOutputErrors`, installed by the bin shim before `run()`):
  an EPIPE on stdout (`| head`, `| jq` stopping early) exits 0 quietly, any other stdout
  error prints `Output error: …` and exits 1; an EPIPE on stderr is ignored, so a failed run
  keeps its own exit code (`2>&1 | true` after a usage error still exits 2). A stdout closed
  with `>&-` can't be told apart from `> /dev/null` (Node reopens the closed descriptor on
  `/dev/null`), so that run exits 0.
- Retry transient `429`/`503` (and reset connections, `isTransientNetworkError`) up to
  `maxRetries`, waiting `retryDelayMs * attempt` (200 ms, 400 ms, …) or the `Retry-After`
  (seconds or an IMF-fixdate, `parseRetryAfter`) when that is longer — the backoff is the
  floor, so `Retry-After: 0` or a past date never makes a burst. Above
  `MAX_RETRY_AFTER_MS` = 30 s there is no retry: the `MastrApiError` names the requested wait
  and says retrying sooner won't help. `retryDelayMs` is at most 30 000. Only
  `http:`/`https:` base URLs.
- **Scaffold origin:** scaffolded from `entgeltatlas-cli` (GET + query transport); the
  X-API-Key auth machinery was stripped because MaStR's public search needs no auth.

## Website

The project website — <https://maschinenlesbar-org.github.io/marktstammdatenregister-cli/> in
English and <https://maschinenlesbar-org.github.io/marktstammdatenregister-cli/de/> in German —
is built from `site/` with [Jekyll](https://jekyllrb.com/),
[banira](https://sebs.github.io/banira/) web components and [Fylgja](https://fylgja.dev/) CSS,
and deployed by `docs.yml` together with the TypeDoc API reference under `/api/`. Its content
comes from this repository: the README intro and quick start, the command tree of the built CLI
(`site/scripts/cli-reference.mjs`), `Usage.md`, `GLOSSARY.md` and its German version
`GLOSSARY.de.md`, the skills, and the skill examples in `EXAMPLE.md` and `EXAMPLE.de.md`. The
only repo-specific files are `site/_config.yml` and `site/_data/project.yml` (the German intro
and the access requirements); the rest of `site/` is identical in every maschinenlesbar.org
CLI, so change it in all of them together. When the README intro changes, update the German
intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/marktstammdatenregister-cli/
```
