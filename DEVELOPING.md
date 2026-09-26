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
| **Malformed 200 replies** | Only the envelope's top level is checked, never the ~90-field rows: a JSON object, a non-negative integer `Total`, a `Data` array (`null` allowed only with `Total: 0`). An empty body or 204 is `MastrParseError` `Empty response body from <path>`; anything else `Unexpected response shape from <path>: expected …` (exit 1) — a broken reply must not print as "0 matches". | `client.ts` `units()`, `engine.ts` `getJson()` |
| **`~or~` is silently truncated** | The search keeps only the part before the first `~or~` and drops every later condition, no error (2026-09-26: `2497` alone and `2497~or~…2498` both 43633). An OR between codes of one dropdown works as a comma list in one value (`Energieträger~eq~'2497,2498'` → 52448). | `filter.ts` `filterProblem()`: the client throws `MastrValidationError`, the CLI's `--filter` parser a usage error |
| **Microsoft dates** | Dates are `"/Date(ms)/"` strings, not ISO. | `parseMsDate()` / `isoifyDates()`; CLI `--iso-dates` |
| **No aggregate endpoint** | `AggregateResults` is null; there is no server-side capacity sum — only the `Total` count. | documented; the CLI offers `--total` (count) but not a sum |
| **Wide, category-varying rows** | ~90 fields; a solar unit carries columns a gas consumer lacks. | `MastrUnit` types the common fields + an index signature |
| **Withheld data** | Natural-person and confidential data are not published (operator names anonymised; some location data withheld for units < 30 kW). | documented; fields are optional/nullable |

The engine sends `X-Requested-With: XMLHttpRequest` (the endpoint is an XHR backend).
Redirects are **not** followed — a 3xx (e.g. a wrong base URL bouncing to a portal
page) surfaces as an error and maps to the usage exit code.

## Testing

`node --test` on the compiled `dist/test/`. Notable coverage:
- `query.test.ts` — the builder **sends empty-string values** (`sort=&group=&filter=`),
  the linchpin of the null-request fix.
- `client.test.ts` — `units()` ALWAYS sends the full Kendo param set; category routing;
  the `Errors` envelope throws; `parseMsDate`/`isoifyDates`.
- `cli.test.ts` — the 4 commands, paging bounds, `--total`, `--iso-dates`, the `filters`
  command, and the hardening guards (control-char UA, empty base URL, bounded retries).

## Conventions to keep

- **Zero runtime HTTP deps**; strict TS + ESM; passes on Node 20/22/24.
- **Exit codes** (`run.ts`): help/version → 0; usage → 2; 404 → 4; network → 6; other → 1.
- Retry transient `429`/`503` up to `maxRetries`; only `http:`/`https:` base URLs.
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
