# Usage

`mastr` — a CLI for the Marktstammdatenregister (MaStR). No API key needed.

```bash
mastr [global options] <command> [command options]
```

## Global options

| Option | Description |
|---|---|
| `--base-url <url>` | API base URL (default `https://www.marktstammdatenregister.de/MaStR`) |
| `--timeout <ms>` | time limit per request in ms, whole response included (0 = no timeout; at most 2147483647) |
| `--user-agent <ua>` | User-Agent header value |
| `--max-retries <n>` | retries for transient 429/503 responses (0..10; each waits the server's `Retry-After`, up to 30 s — a longer one is not retried; without one: 200 ms, 400 ms, …) |
| `--max-response-bytes <n>` | cap the response body size in bytes (0 = unlimited; default 100 MiB) |
| `--compact` | print JSON on a single line (for piping to `jq`) |
| `--iso-dates` | rewrite MaStR `/Date(ms)/` timestamps to ISO-8601 |
| `-V, --version` / `-h, --help` | version / help |

## Commands

| Command | Dataset |
|---|---|
| `mastr stromerzeugung` | electricity-generation units (~9.06M) |
| `mastr stromverbrauch` | electricity-consumption units |
| `mastr gaserzeugung` | gas-generation units |
| `mastr gasverbrauch` | gas-consumption units |
| `mastr filters <category>` | the filterable columns (names, types, dropdown codes) for a category |

### Search options (the four data commands)

| Option | Description |
|---|---|
| `--page <n>` | 1-based page (default 1) |
| `--page-size <n>` | rows per page (1..5000, default 25) |
| `--sort <spec>` | `FieldKey-asc` or `FieldKey-desc`, e.g. `Bruttoleistung-desc`. `FieldKey` is a record field name of **that category**, not a `FilterName` (`Bruttoleistung` exists only in `stromerzeugung`; see [Capacity fields](#capacity-fields-per-category)) |
| `--filter <spec>` | filter expression (see below) |
| `--total` | print only the total match count, not the rows |

Each data command prints `{ total, data }`: `total` is the full match count (respects
the filter), `data` is the current page.

## Filter syntax

```
FilterName~op~'value'~and~FilterName~op~'value'~…
```

- **operators:** `eq` (=), `neq` (≠), `sw` (starts-with), `ct` (contains),
  `nct` (not-contains), `ew` (ends-with), `null` (empty), `nn` (not empty), and for
  `number`/`date` columns `gt` (>) and `lt` (<). `gt`/`lt` are strict; there is no
  `gte`/`lte`. An unknown or upper-case operator is rejected (exit 2) — the register
  would return 0 rows for it
- **value:** single-quoted; for a dropdown use its **code** (`Value`), not its label;
  decimals take a point (`'4999.999'`), dates work as `'2025-01-01'` or `'01.01.2025'`.
  `null`/`nn` still need a value: `Ort~null~''` (a bare `Ort~null` is ignored upstream
  and returns the unfiltered register, so the CLI rejects it). **A value cannot contain
  `~`:** the register splits the whole filter on every `~` and has no escape or quoting
  for it (`ct 'a~b'` would silently become `ct 'a'`), so the CLI rejects it; search for a
  part of the text without the `~` instead. A single `'` inside a value is fine
  (`ct 'd'Arc'`). Library users build specs from input with `buildFilter()`
- **checked before sending:** every condition needs a FilterName, a known operator and
  a value, a value that opens a single quote must close it, conditions are joined by
  `~and~` only, and nothing may dangle at the end (`…~and~`). Anything else is a usage
  error (exit 2). The FilterName itself can't be checked (see below)
- **conjunction:** only `and`. **There is no working `or`:** the register keeps only the
  part before the first `~or~` and silently drops the rest (a wrong count, no error), so
  the CLI rejects `~or~` (exit 2). For an OR between codes of **one dropdown column**,
  list them comma-separated in one value: `Energieträger~eq~'2497,2498'`. The comma
  list works only for dropdown codes (`Ort~eq~'Münster,Berlin'`
  returns 0 rows); OR across different columns needs one query per condition
- discover the `FilterName`s and codes with `mastr filters <category>`

```bash
# Solar (Energieträger 2495) units in operation (Betriebs-Status 35)
mastr stromerzeugung --filter "Energieträger~eq~'2495'~and~Betriebs-Status~eq~'35'" --total

# Wind (2497) or solar (2495) units: a comma list inside one dropdown value
mastr stromerzeugung --filter "Energieträger~eq~'2497,2495'" --total

# Wind (2497) units above 5,000 kW gross
mastr stromerzeugung --filter "Energieträger~eq~'2497'~and~Bruttoleistung der Einheit~gt~'5000'" --total
```

> **A wrong/misspelled FilterName is silently ignored** and you get the unfiltered
> result — always confirm the exact name via `mastr filters` and sanity-check with
> `--total` (the count should change).

## Examples

```bash
mastr stromerzeugung --total                        # 9063887
mastr stromerzeugung --page-size 5 --iso-dates      # first 5 units, ISO dates
mastr filters stromerzeugung --compact | jq '.[] | {FilterName, Type}'
mastr gasverbrauch --sort "MaximaleGasbezugsLeistung-desc" --page-size 10 --compact | jq '.data'
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success (help/version included); an empty result also exits 0 |
| `1` | API/logical error (e.g. the server's `Errors` field), or a catch-all |
| `2` | usage error (bad flags, unknown command, a malformed `--filter` — shape, operator, `~or~` — or a bad `--page-size`, redirecting base URL) |
| `4` | HTTP 404 |
| `6` | network / transport failure (DNS, connection, timeout, response size-cap) |

## Notes

- **A wrong `--sort` field returns 0 results, not an error.** An unknown sort column
  key makes the server answer with zero rows (`total: 0`), which reads like "no
  matches". If a query returns 0 only after you add `--sort`, check the column key —
  the CLI prints a note to stderr in this case. Sort keys are the record's field names
  (`Bruttoleistung`, `InbetriebnahmeDatum`), not the FilterNames from `mastr filters`
  (`Bruttoleistung der Einheit-desc` returns 0 rows); list them with
  `mastr stromerzeugung --page-size 1 --compact | jq '.data[0] | keys'`. (Contrast
  `--filter`, where a wrong field is silently *ignored* and you get the unfiltered set,
  and a wrong operator is rejected before sending; a filter that still gives 0 rows
  gets a stderr note about its values.)
- **Dates** are Microsoft `/Date(ms)/` strings; `--iso-dates` converts them, or use the
  library's `parseMsDate()`.
- **You cannot sum capacity server-side** — there is no aggregate endpoint. Use `--total`
  for counts; sum the capacity field client-side only for small result sets.

## Capacity fields per category

The rows differ per category; `Bruttoleistung`/`Nettonennleistung` exist **only** in
`stromerzeugung` (sorting another category by them returns 0 rows).

| Category | Capacity fields (record keys, usable in `--sort`) | Unit |
|---|---|---|
| `stromerzeugung` | `Bruttoleistung` (gross), `Nettonennleistung` (net) | kW |
| `stromverbrauch` | none in the rows (only the flag `EinheitenUeber50MW`) | — |
| `gaserzeugung` | `Erzeugungsleistung` (gas generation); gas storage: `MaxEinspeicherleistung`, `MaxAusspeicherleistung` (injection / withdrawal) and `MaxArbeitsvolumen` (working gas volume) | storage: kWh/h, volume kWh (as the register's detail page shows); `Erzeugungsleistung`: not stated in the rows |
| `gasverbrauch` | `MaximaleGasbezugsLeistung` (maximum gas intake) | not stated in the rows |

The matching filters are `Bruttoleistung der Einheit` (stromerzeugung),
`Gaserzeugungsleistung` and `Maximale Gasbezugsleistung` — check the exact names with
`mastr filters <category>`.
- The data is © the Bundesnetzagentur under DL-DE-BY-2.0 — see
  [DATA_LICENSE.md](DATA_LICENSE.md); attribution is required.
