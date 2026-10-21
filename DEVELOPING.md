# Developing `marktstammdatenregister-cli`

Architecture, testing, and the live-API quirks of the Marktstammdatenregister (MaStR)
public search API. Read this before changing the client or CLI.

## What this is

A typed client + CLI for the MaStR public unit-search backend, part of the `*-cli`
family. It follows the shared two-layer blueprint (a dependency-free client,
`packages/client`, usable as a library, and a commander CLI, `apps/cli`, over it) with the
family's two test seams. Where MaStR diverges from the family defaults, this file
documents why — **match this repo, not the generic blueprint.**

## Commands

```bash
npm install
npm run build       # compiles every workspace (tsc -b) to its dist/
npm run typecheck   # tsc -b over every workspace, as build
npm test            # pretest builds, then `node --test` over each workspace's dist/test
npm run coverage    # the same tests in one run, with a coverage report
npm start -- --help # run the CLI from the build (node apps/cli/dist/src/cli/index.js)
npm run bump -- <patch|minor|major>  # bump apps/cli, commit, tag vX.Y.Z
node --test apps/cli/dist/test/cli.test.js   # one file, after a build
```

CI (`ci.yml`) type-checks, builds and tests on Node 22/24/26, then packs the real tarball,
checks the pack left nothing behind, installs it globally with the registry out of reach and
runs the bin. `release.yml` (on a `v*` tag, made by `npm run bump`) verifies the tag against
`apps/cli/package.json`, writes the SBOMs (scoped to the `apps/cli` workspace) and runs
`npm pack --workspace apps/cli`; `publish.yml` runs `npm publish --workspace apps/cli`.

## Layout

The repository is an **npm workspace** with two folders: `apps/` holds the programs it
publishes, `packages/` the libraries they are built from.

```
package.json         # private workspace manifest: no version, never packed
apps/cli/            # @maschinenlesbar.org/marktstammdatenregister-cli — the published package
  package.json       # its version, bin, files (no workspace package in dependencies)
  src/index.ts       # library entry: re-exports @maschinenlesbar.org/marktstammdatenregister-client
  src/cli/           # the CLI (below)
  test/              # CLI tests and every conformance-*.test.ts
packages/client/     # @maschinenlesbar.org/marktstammdatenregister-client — private, shipped inside the CLI's tarball
  src/               # the API client (below)
  test/              # tests that only touch the client, + the transport helpers and fixtures
tools/pack/          # prepack/postpack: ship the client (dist/node_modules) and commander in the tarball
tools/bump.mjs       # version bump + commit + tag (npm run bump)
tsconfig.docs.json   # TypeDoc only: the package entry, with the client read from its sources
```

- **The client is its own package** so a later MCP app can share it with the CLI. It is
  never published on its own: `apps/cli`'s `prepack` copies it into
  `apps/cli/dist/node_modules/`, where the CLI's imports find it, and the tarball ships it
  as plain files — so npm lists only commander (bundled) as a dependency, never the
  private client. `apps/cli/package.json` therefore doesn't name the client; prepack finds
  it through `apps/cli/tsconfig.json`'s project references. The library
  entry re-exports the client's `"."`, so `import { MastrClient } from
  "@maschinenlesbar.org/marktstammdatenregister-cli"` is unchanged.
- **The client's exports:** `"."` is the public library surface (`src/index.ts`);
  `"./internal/*"` maps to any module (`…/marktstammdatenregister-client/internal/engine`)
  for what the CLI needs beyond that; `"./test/*"` reaches the client's test helpers and
  fixtures from the CLI's tests (not bundled). Only `"."` is part of the library.
- **Dependencies point one way:** the app depends on the client, the client on nothing
  in the workspace.
- **The version lives in `apps/cli/package.json`.** The root has none; a plain
  `npm version` at the root is refused. Release with `npm run bump -- <patch|minor|major>`,
  which bumps the app, commits (the bare version as the message) and tags `vX.Y.Z`.
- **TypeScript:** `tsconfig.base.json` holds the compiler options; every workspace has a
  `tsconfig.json` (`src/`) and a `tsconfig.test.json` (`test/`), and the root
  `tsconfig.json`/`tsconfig.test.json` reference them, built with `tsc -b`.

The client (`packages/client/src/`) and the CLI (`apps/cli/src/`):

```
packages/client/src/
    types.ts     # MastrUnit + the Kendo envelope + query/filter-column types
    query.ts     # dependency-free query-string builder (sends empty strings!)
    http.ts      # Transport interface + default node:http/https transport
    engine.ts    # URL building, GET, retry/backoff, JSON decode, error mapping
    errors.ts    # MastrError / MastrApiError / MastrNetworkError / MastrValidationError / MastrParseError
    validate.ts  # input rules (Problem functions) + assertValid(), shared by library and CLI
    client.ts    # MastrClient (+ parseMsDate / isoifyDates)
    index.ts     # the client's public surface (the library entry re-exports it)
apps/cli/src/cli/
    io.ts        # injectable I/O (CliDeps / CliIO), the logger and the clock — no env seam (no auth)
    log.ts       # the stderr log: records with ts, level, topic; --log-format text|jsonl
    shared.ts    # option parsers, global->engine mapping, action()
    output.ts    # JSON render to stdout (+ --iso-dates), terminal controls escaped; an answer
                 # too deep or too large to print is an OutputError naming the cause, with
                 # "try --compact" only where --compact prints it (probed); --compact takes
                 # V8's fast path unless the answer holds a string of 64 Mi characters or more
    commands/units.ts  # the 4 category commands + the `filters` command
    program.ts   # assembles the commander program
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
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
| **Malformed 200 replies** | Only the envelope's top level is checked, never the ~90-field rows: a JSON object, a non-negative integer `Total`, a `Data` array (`null` allowed only with `Total: 0`) with no more rows than `Total` and than the `pageSize` asked for. Every error about an answer names the request, as K3's network errors do: `GET <url>: …` (absolute, with the query, userinfo redacted). An empty body or 204 is `MastrParseError` `GET <url>: empty response body.`, a body that isn't JSON `GET <url>: the answer is not valid JSON` (with `(expected JSON, got Content-Type "text/html")` for a maintenance page); a number JSON.parse can't carry exactly (past 2^53 one that doesn't print as written — `12345678901234567890` would print as `…7000`, while `1e23` passes —, out of a double's range, non-zero but too small, or subnormal — below 2.2250738585072014e-308 — and not printing as written, so `4e-324` (printed `5e-324`) is refused and `5e-324` passes: `firstInexactNumber`) is `GET <url>: the number <N> cannot be represented exactly.` — never a changed value (capacities are decimals below 2^53 and pass). The kit's engine option `bigIntegerKeys` (a set of member names whose numbers are delivered as their exact literal, as a string) exists for a register field past 2^53; mastr declares none, and the one linear scan (`scanNumbers`) does both jobs; anything else `GET <url>: unexpected response shape: expected …` (exit 1) — a broken reply must not print as "0 matches". | `client.ts` `units()`, `engine.ts` `getJson()` |
| **`~or~` is silently truncated** | The search keeps only the part before the first `~or~` and drops every later condition, no error (2026-09-26: `2497` alone and `2497~or~…2498` both 43633). An OR between codes of one dropdown works as a comma list in one value (`Energieträger~eq~'2497,2498'` → 52448). | `filter.ts` `filterProblem()`: the client throws `MastrValidationError`, the CLI's `--filter` parser a usage error |
| **No escape for `~` in a value** | The register splits the filter on every `~`, even inside quotes: `ct 'a~b'` gives the same count as `ct 'a'`, and interpolated input (`Ort~eq~'${input}'`) can add conditions. | `filterProblem()` names a `~` inside a quoted value; library callers use `buildFilter()`, which quotes values and refuses a `~` |
| **Malformed filters are misread, not refused** | A spec that is not `FilterName~op~value(~and~…)*` goes through: `foo` or a dangling `~and~` gives the unfiltered set, an unknown or upper-case operator (`gte`, `EQ`) 0 rows, `Ort~null` without `''` is ignored. | `filterProblem()` checks the shape the register splits on `~` (FilterName, known lower-case operator, value, `and`) before any request. |
| **Unknown FilterNames and codes are ignored** | A FilterName the category doesn't have (a typo, another case, a name of another category) is ignored: the unfiltered set, exit 0 (live 2026-10-05: `energieträger~eq~'2495'` → all 9 562 366). An unknown dropdown code gives 0 rows; a label (`'Wind'`) or junk in a comma list `{"Error":true}`. | `client.ts` `checkedFilter()` → `filter.ts` `resolveFilter()`: every name (case-insensitively, then written the register's way) and every `eq`/`neq` dropdown code is checked against `filterColumns()` (fetched once per client and category; a failed fetch is not cached) before the unit request; `MastrValidationError` with "did you mean". `allowUnknownFilters: true` skips it. Query keys other than `page`/`pageSize`/`sort`/`filter` (`filtr`, `__proto__`) are refused too |
| **Repeated options** | commander keeps the last of a repeated option: `--filter A --filter B` sent only `B` ("solar in Bavaria" became every unit in Bavaria, 2 042 883 instead of 1 456 625). | `shared.ts`: `parseFilter` joins repeated `--filter`s with `~and~`; every other value option is wrapped in `once()`, a repeat is a usage error |
| **Charset** | The register sends `application/json; charset=utf-8`; a mirror or re-encoding proxy may not. | `engine.ts` `getJson()` decodes by the declared charset (`TextDecoder`, BOM dropped). Text is never changed silently: bytes not valid in the charset, and a lone surrogate written as a JSON escape (`\ud800`, which `jq` refuses, and with it the whole output), become U+FFFD, and the engine option `onWarning` gets `GET <url>: N characters of the answer were not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.` — the CLI's `WARN` record of `mastr.api`; the run succeeds; a body too large to become one string (512 MB and more, possible only with `--max-response-bytes 0`) is a `MastrParseError`, `GET <url>: the answer is too large to read as text (N bytes; the longest string is 536870888 characters).`, not "Unexpected error", and an error status with such a body keeps its `MastrApiError` without the body; an unknown label is `MastrParseError` `GET <url>: unsupported response charset "…".` |
| **FilterNames match exactly** | A FilterName with a decomposed umlaut (macOS input), a leading/trailing space (`~and~ Bundesland`) or two spaces in a row is ignored like an unknown one: the unfiltered set (live 2026-10-05: 9 562 366 instead of 6 545 851). The register composes a decomposed value (`'Mu\u0308nster'` = `'Münster'`) and trims a dropdown code (`' 2495 '` = `'2495'`), but **not a text value**: `' Münster '` matched nothing (live 2026-10-21: 0 instead of 27 181). | `filter.ts` `normalizeFilter()`/`normalizeFilterName()` (NFC, trim, one space; operators and `and`s trimmed; whitespace outside a quoted value dropped, so `'Münster' ~and~…` isn't misread as a value holding `~`); `units()` and `buildFilter()` send the normalised spec, the CLI's `--filter` parser checks it. Every value is free text (decision D8, 2026-10-21; it was sent as typed before, P60): `normalizeFilter()` sends it trimmed inside its quotes and in NFC (`normalizeText`), and `filterProblem()` refuses one that is only invisible characters or holds a control, format or half character (`textProblem`), on the `--filter` spec and in `buildFilter()` alike — the DSL's structure is checked, never rearranged |
| **Microsoft dates** | Dates are `"/Date(ms)/"` strings, not ISO (the offset form `/Date(ms+hhmm)/` is accepted too; not seen live). | `parseMsDate()` (null for an out-of-range value) / `isoifyDates()` via `formatMastrDate()`: date-only values (UTC midnight, live 2026-10-06) → `YYYY-MM-DD`, timestamps → `Europe/Berlin` with offset (Intl, so DST follows the tz database; UTC `Z` fallback for years outside 1–9999 and pre-1893 local mean time); CLI `--iso-dates` |
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
`MastrNetworkError` that names the request — `GET <url> failed: <reason>` (userinfo redacted)
for a timeout, the size cap, a refused connection, a DNS failure and a reset alike, the
original kept as its `cause`; a reset reported as `ECONNRESET`/`EPIPE`/`ECONNABORTED` or undici's
`UND_ERR_SOCKET` anywhere in the `cause` chain is retried like a 503.

**Credentials in the base URL.** A `user:password@` in `--base-url` (a mirror behind a
login) is sent as HTTP Basic auth and never printed. `run()` starts with
`withRedactedOutput(deps, argv)`, which builds the log too: the log replaces the secrets in
each record's *message*, before the record is cut and escaped, and writes it to the raw
stderr, so the frame (time, level, topic) is never touched and a password with DEL, C1 or
bidi characters is matched in its raw form. `redactionFor(argv)` collects the exact userinfo of every URL argument and of
the value part of every `--opt=value` token, and of every URL that starts inside an argument
(`urlsWithin`: a `--filter` value `Ort~eq~'https://u:pw@host'`, a padded or mid-phrase one, a
`--sort` spec) (`credentialsIn`, which also handles values that don't parse as a URL), plus its
percent-encoded form, which an error record's request URL carries. Only a value that starts with a scheme counts (a bare `a:b@c` is a
search text, a sort key or a User-Agent as often as a credential), except as the
`--base-url` value, where a scheme-less `user:pw@host` is still read as one. It redacts those strings, raw and
JSON-quoted, from every line the CLI prints — commander's usage errors echo rejected values,
and a pattern can't delimit a password holding a space, quote, `#`, `?` or `/`. The forms
a server echoes a userinfo back in are replaced too: the `Basic` value and the decoded
`user:password` on stdout and stderr, the password alone (4 characters or more) on stderr
only, since it may well occur in the data.
`redactUrl` falls back to the same exact-string redaction for a value that doesn't parse.
In the library the engine keeps the base URL and the default headers in real `#private`
fields, so `console.log(client)`, `util.inspect` and `JSON.stringify` never show them, and
it scrubs the base URL's userinfo (raw and percent-decoded) and the forms a server echoes
it back in (the `Basic` value, the decoded `user:password`, the password alone from 4
characters: `echoedCredentialForms`) from error bodies and details,
`Errors` envelopes, transport error text and the `cause` chain it attaches.

The client validates its own inputs before any request, for library callers the CLI's
parsers don't cover: an unknown category, `page` outside 1..`MAX_PAGE` (1 000 000),
`pageSize` outside 1..`MAX_PAGE_SIZE` (5000), a `sort` that is not `FieldKey-asc|desc`
(several joined by `~`; `sortProblem`, a token: sent trimmed and NFC — live 2026-10-21 the
register sorted `Bruttoleistung-desc ` with a trailing space and `Bruttoleistung-down`
ascending, and `Bruttoleistung` not at all, silently) and a malformed filter throw
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
(`MAX_DETAIL_LENGTH`), a text body's snippet at 200, never inside a surrogate pair
(`cutText`), so the message stays well-formed; `MastrApiError.body` keeps all of it.
Any other value an own message quotes from a server answer or a caller's input (a
FilterName, a dropdown code, a filter part, a query or option key, a charset) is cut at
`MAX_QUOTED_LENGTH` (200, `cutForMessage` in `errors.ts`), so `err.message` stays bounded
for a library caller. The filter check (`resolveFilter`) quotes the register's own
filter-columns reply — FilterNames in a "did you mean", dropdown codes and labels — through
`serverTextForMessage` (exported from `engine.ts`): `sanitizeServerText`, then cut at 200,
and the list of codes at 500. A hostile reply's line break used to forge log records, its
ESC/OSC sequences reached the terminal, and a 200 000-character label made a 300 KB record.
`filterColumns()` and the `filters` command keep the values as the register sent them. `count(category, { filter, sort })` refuses `page` and
`pageSize` (`countQueryProblem`): the count is the same on every page.

**The library owns every input rule.** A rule is a pure, exported `…Problem(value)`
function (the reason a value is invalid, or `undefined`), in `validate.ts` or next to
the code it guards (`filterProblem` in `filter.ts`). Every value that goes into a request
passes one rule for its kind (the kit's D8): `tokenProblem`/`normalizeToken` for what the
register compares exactly — a FilterName, a sort key, a dropdown code (trimmed, NFC; refused
when blank or only invisible characters and combining marks, with a lone surrogate, or with any
control or format character: a zero-width space, a soft hyphen, a bidi control);
`textProblem`/`normalizeText` for free text (the same, but TAB/LF/CR and ZWJ/ZWNJ are allowed
inside); `splitList`/`listProblem` for a comma list (per item; an empty item refuses the list).
A refusal quotes the value with `quoteValue` (`errors.ts`): JSON-quoted, cut at 200 characters,
and DEL, C1, U+2028/2029, lone surrogates and every format character escaped (`\u200b`), so a
refused name never prints like the one it was refused for; commander's own echo of a rejected
argument is escaped the same way (`escapeTerminalText` in `run.ts`). The library enforces it with
`assertValid(name, value, problem)`, which throws `MastrValidationError` with
`Invalid <name>: <reason>` before any request (constructors throw, async methods
reject). The CLI's commander parsers call the same function and turn the reason into a
usage error; a `MastrValidationError` raised during an action exits 2 and is
logged as an `ERROR` record of `mastr.cli`. Parity tests (`parity()` in `apps/cli/test/helpers.ts`) send one input
through `run()` and through the library on one mock transport and expect the same
outcome.

## Testing

`node --test` on each workspace's compiled `dist/test/`. The client's tests are in
`packages/client/test/` (`query`, `http`, `engine`, `client`, `filter`, `types`), with the transport
helpers and the fixtures (`helpers.ts`, `fixtures.ts`); everything that drives the CLI is in
`apps/cli/test/`, and `apps/cli/test/helpers.ts` re-exports the client's helpers next to the
CLI's own. Notable coverage:
- `query.test.ts` — the builder **sends empty-string values** (`sort=&group=&filter=`),
  the linchpin of the null-request fix.
- `client.test.ts` — `units()` ALWAYS sends the full Kendo param set; category routing;
  the `Errors` envelope throws; `parseMsDate`/`isoifyDates`/`formatMastrDate` (incl. the
  2024 DST edges).
- `types.test.ts` — every optional field of the exported option and query types is
  `?: T | undefined` (a consumer compiled by `tsc` with `exactOptionalPropertyTypes`, which
  starts a process: 30 s), and an option given as `undefined` means its default.
- `cli.test.ts` — the 4 commands, paging bounds, `--total`, `--iso-dates`, the `filters`
  command, and the hardening guards (control-char UA, empty base URL, bounded retries).
- `log.test.ts` — the record helpers of `apps/cli/src/cli/log.ts` on their own
  (`escapeForRecord`, `formatLogRecord`); the CLI-level checks are P23's.
- `conformance-p*.test.ts` — the checks shared across the `*-cli` repos (fix plan
  2026-10-06; only the adapter block at the top is repo-specific): P1/P2 credential
  redaction, P4 base-URL rules (the P19 env-var case is skipped: mastr reads no environment
  variable), P5 the transport contract, P6 the retry floor (a `Retry-After` above 30 s waits
  the 30 s cap, then retries), P7 pipes (spawns the built bin), P8/P9/P13
  charset, envelopes and error classes, and **P10 strict filters**, written here first: an
  unknown, misspelled or `__proto__` key or FilterName, arrays and NaN, unnormalised names,
  a repeated `--filter` and a repeated single-value option. Test helpers answer the client's
  filter-columns request from `fixtures.filterColumns` (`registerResponder`, `withColumns`).
  **P20** the plain-`http:` warning (follow-up round 2026-10-06): one `WARN` record of
  `mastr.http` on stderr for a remote `http:` base URL, naming the host and, without printing them, the
  URL's credentials; none for `https:`, loopback or `--help`; stdout unchanged; the library
  exports `cleartextProblem` (the env-var and other-secret cases are skipped: mastr reads no
  environment variable and sends no key). **P21** README links: every relative link in
  `README.md` (shown on npmjs.com) must target a file `package.json` `files` ships
  (`DATA_LICENSE.md`, `LICENSING.md`, `CONTRIBUTING.md`, plus README/LICENSE); the other
  documents are linked as `https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/blob/main/<path>`.
  **P24** the input corpus (kit rollout 2026-10-21, D8/D10 since the fix round): every text
  and every token that goes into a request is sent canonical or refused (visibly), alike on the
  CLI and in the library; mastr's inputs are a `--filter` value (text), a FilterName and a
  `--sort` key (tokens); it has no list option. The adapter leaves the filter-columns requests
  out, so "before any request" means before the unit request. **P25** the
  response corpus: a number a double can't carry exactly, and an empty answer, are errors
  (exit 1, an ERROR of `mastr.api`), never a changed value. Both adapters use `kitParity`
  (`apps/cli/test/helpers.ts`), `parity` in the kit's shape. P26 (`-o`) does not apply: mastr
  has no `-o`.

Each retry is announced: the engine option `onRetry(event: RetryEvent)` (exported type:
`{ retry` (1-based), `maxRetries`, `delayMs`, `status?` (absent for a reset), `url` (userinfo
redacted) `}`) is called once per retry right before the sleep, never when there is none, and
a throw in it is swallowed. The CLI's `action()` sets it to log one `WARN` record of
`mastr.http`, `HTTP 503 from <host>: retry 1 of 3 in 2 s` (`retryMessage`; host only, whole
seconds, ms under 1 s). Tests: `apps/cli/test/retry-log.test.ts`.

## Conventions to keep

- **Zero runtime HTTP deps**; strict TS + ESM; passes on Node 22/24/26 (`engines`: Node.js 22.12 or later, the floor commander 15 declares).
- **Plain `http:`** (`engine.ts` `cleartextProblem`, called once per run by `shared.ts`
  `action()` before the client is built): a remote `http:` base URL gets one
  `WARN` record of `mastr.http` on stderr; stdout and the exit code don't change.
- **Exit codes** (`run.ts`): help/version → 0; usage → 2; 404 → 4; network → 6; other → 1.
- **Closed pipes** (`io.ts` `handleOutputErrors`, installed by the bin shim before `run()`):
  an EPIPE on stdout (`| head`, `| jq` stopping early) exits 0 quietly — so does ENOTCONN,
  which is what a socket stdout reports when its reader has gone (a Node parent with piped
  stdio on macOS) — any other stdout
  error is an ERROR record of `mastr.output` (`Could not write to stdout: …`, in the format
  argv asks for: `processLogger`) and exits 1; an EPIPE/ENOTCONN on stderr is ignored, so a failed run
  keeps its own exit code (`2>&1 | true` after a usage error still exits 2). A stdout closed
  with `>&-` can't be told apart from `> /dev/null` (Node reopens the closed descriptor on
  `/dev/null`), so that run exits 0. stdout redirected to a regular file (`> out.json`) is written
  with every byte or an error (`stdoutWriter`: Node's stream ignored a short write, so a
  file-size limit or a full disk cut the output with exit 0): EFBIG or ENOSPC is that ERROR
  record and exit 1 (P26).
- Retry transient `429`/`503` (and reset connections, `isTransientNetworkError`) up to
  `maxRetries`, waiting `retryDelayMs * attempt` (200 ms, 400 ms, …) or the `Retry-After`
  (seconds or an IMF-fixdate, `parseRetryAfter`) when that is longer — the backoff is the
  floor, so `Retry-After: 0` or a past date never makes a burst. A `Retry-After` above
  `MAX_RETRY_AFTER_MS` = 30 s waits the 30 s cap and retries (the choice of most `*-cli`
  repos; `maxRetries` still bounds the run). `retryDelayMs` is at most 30 000. Only
  `http:`/`https:` base URLs.
- **Scaffold origin:** scaffolded from `entgeltatlas-cli` (GET + query transport); the
  X-API-Key auth machinery was stripped because MaStR's public search needs no auth.

## Website

The project website — <https://maschinenlesbar.org/marktstammdatenregister-cli/> in
English and <https://maschinenlesbar.org/marktstammdatenregister-cli/de/> in German —
is built from `site/` with [Jekyll](https://jekyllrb.com/),
[banira](https://sebs.github.io/banira/) web components and [Fylgja](https://fylgja.dev/) CSS,
and deployed by `docs.yml` together with the TypeDoc API reference under `/api/`. Its content
comes from this repository: the README intro and quick start, the command tree of the built CLI
(`site/scripts/cli-reference.mjs`), `Usage.md`, `GLOSSARY.md` and its German version
`GLOSSARY.de.md`, the skills, and the skill examples in `EXAMPLE.md` and `EXAMPLE.de.md`. The
only repo-specific files are `site/_config.yml` (which also says where the published manifest
and the built program are: `manifest: apps/cli/package.json`, `program:
apps/cli/dist/src/cli/program.js`) and `site/_data/project.yml` (the German intro and the
access requirements); the rest of `site/` is identical in every maschinenlesbar.org
CLI, so change it in all of them together. When the README intro changes, update the German
intro in `site/_data/project.yml`.

The build also writes `sitemap.xml`: every page in both languages, and `/api/`. Crawlers
find it through `robots.txt` at the root of maschinenlesbar.org, which only the
organisation website can serve; its `site/_data/sites.yml` lists every site's sitemap, so a
new CLI gets a line there.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/marktstammdatenregister-cli/
```

## The log on stderr

Every diagnostic line on stderr is a log record (`apps/cli/src/cli/log.ts`): a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic, `mastr.<area>`. `--log-format text` (the default)
writes it log4j style, `<ISO 8601 UTC> <LEVEL padded to 5> [<topic>] <message>`;
`--log-format jsonl` writes one JSON object per line with exactly `ts`, `level`, `topic`
and `msg`. A record is always one line: `formatLogRecord` runs `escapeForRecord` over
the message (text) or the whole JSON object (jsonl), which writes CR and LF as `\r`/`\n`,
every other C0 control but TAB, DEL and C1 as `\u00XX`, and U+2028, U+2029 and the bidi
controls as `\uXXXX`, so no text that reaches a record, by whatever path, can split it,
forge another one or steer the terminal. Before that a lone surrogate (half a
character, which jq rejects, stopping the whole stream) becomes U+FFFD (`toWellFormed`),
and a message longer than `MAX_RECORD_MESSAGE` (4000 characters, exported) is cut at a
code point and ends in `… (N more characters)`. The areas are `cli` (usage errors, commander's messages, unexpected errors),
`api` (the register's answers: HTTP errors, the `{"Error":true}` and `Errors` envelopes
with HTTP 200, a malformed answer — a `MastrParseError`: bad JSON, the wrong shape, an empty
body, an unknown charset —, the notes on an empty answer with `--sort` or `--filter`, and the
`WARN` for text replaced with U+FFFD), `http` (the connection: network errors, the size-cap hint, the
cleartext warning) and `output` (a failed write to stdout; an answer that can't be printed, an
`OutputError`: `The answer is nested too deeply to pretty-print[; try --compact].`, `… too large
(more than 536870888 characters of JSON) to print.`, `… nested too deeply for --iso-dates.`; the
hint only when `--compact` prints this very answer, which is probed; and `The answer is too large
to print (N characters once its control characters are escaped).` when escaping DEL, C1 and bidi
controls as `\uXXXX` would pass V8's longest string — the escaping is measured first and built in
64 Ki chunks, so 20 MB of DEL prints within a 512 MB heap). A failed write to stdout other
than a closed pipe (`handleOutputErrors`, in the bin shim, outside `run()`) is an ERROR
record of `mastr.output` (`Could not write to stdout: …`), and the shim's last-resort
`Unexpected error: …`, should `run()` itself ever reject, an ERROR of `mastr.cli`, both in
the format argv asks for and redacted like the run's log (`processLogger`). Code logs through `logOf(deps)` and never writes diagnostics with
`io.err` directly. `run()` builds the logger from argv before commander parses it
(`logFormatFromArgv`, used only for the records of a parse error: the first `--log-format`,
skipping the value of each of the program's own value options; a `preAction` hook then
sets the format commander parsed, so `--user-agent --log-format=jsonl` logs text), so
commander's own usage errors are records too: its `error: …` an ERROR of `cli` (a
`(Did you mean …?)` line joined to it), the help it shows after one an INFO record per
line, and the program run with options but without a command (`mastr --compact`) an ERROR
"missing command: `mastr <subcommand>`" before that help, so every failed run has an ERROR
record (`writeCommanderErr`). `run.ts` replaces commander's built-in `help [command]` with
its own `help [command...]` (`addHelpCommand`, in `configureTree`, so the tree the website
documents is unchanged): it walks every name, and an unknown one is reported like
`mastr nope` (`error: unknown command 'nope'`, exit 2), where the built-in one showed the
root help after a "missing command" error that never named it. The log is built with the run's redaction
(`withRedactedOutput`), which replaces a secret in the message only, before it is
escaped: the frame is never touched, and a secret is kept out of the log in either format.
Node's own process warnings (`NODE_TLS_REJECT_UNAUTHORIZED=0`) are WARN records of
`mastr.cli` too: the bin shim installs `installWarningLog`, which removes Node's default
`warning` listener and logs `(node) <name>: <message>` through `processLogger(argv)`.
In `defaultDeps` a record waits for stdout (`stderrAfterStdout`): it is held while stdout
has a backlog and written, in order, once it is gone, so with `2>&1 |` and a slow reader
it never lands inside the data. `CliDeps.now` makes the timestamps
testable. stdout carries data only. Conformance test P23 checks all of this, and its body
is shared across the *-cli repos.
