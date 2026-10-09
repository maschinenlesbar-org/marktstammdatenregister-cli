# Usage

`mastr` — a CLI for the Marktstammdatenregister (MaStR). No API key needed.

```bash
mastr [global options] <command> [command options]
```

## Global options

| Option | Description |
|---|---|
| `--base-url <url>` | API base URL (default `https://www.marktstammdatenregister.de/MaStR`; http/https, a path prefix is fine, no `?query`, `#fragment`, whitespace or control characters; a `user:password@` is sent as Basic auth, never printed, and a literal `%` in it is written `%25`). A remote plain-`http:` URL logs one `WARN` record of `mastr.http` on stderr before the first request, `requests to <host> are sent unencrypted (http:, not https:)` — `the base URL's credentials are sent unencrypted to <host> …` when it carries a `user:password@`; loopback hosts (`localhost`, `127.0.0.0/8`, `::1`) and `https:` don't warn, and stdout and the exit code are unchanged |
| `--timeout <ms>` | time limit per request in ms, whole response included (0 = no timeout; at most 2147483647) |
| `--user-agent <ua>` | User-Agent header value (not blank; Latin-1 without control characters, tab is fine) |
| `--max-retries <n>` | retries for transient 429/503 responses and reset connections (0..10; each waits 200 ms, 400 ms, … or the server's `Retry-After` when that is longer, up to 30 s — a longer one waits the 30 s cap, then retries) |
| `--max-response-bytes <n>` | cap the response body size in bytes (0 = unlimited; default 100 MiB) |
| `--log-format <format>` | how errors, warnings and notes are written to stderr: `text` (default; log4j style, `2026-10-09T14:03:12.481Z WARN  [mastr.http] …`) or `jsonl` (one JSON object per line: `ts`, `level`, `topic`, `msg`). stdout is not affected |
| `--compact` | print JSON on a single line (for piping to `jq`) |
| `--iso-dates` | rewrite MaStR `/Date(ms)/` timestamps to ISO-8601: a date-only value (sent as UTC midnight) as `YYYY-MM-DD`, a timestamp in German time (`Europe/Berlin`) with an explicit offset, e.g. `2020-02-20T17:28:35.250+01:00` (milliseconds only when not zero) |
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
| `--filter <spec>` | filter expression (see below); repeatable — several are joined with `~and~` |
| `--total` | print only the total match count, not the rows (a one-row request, the library's `count()`; `--page` and `--page-size` are ignored) |

Each data command prints `{ total, data }`: `total` is the full match count (respects
the filter), `data` is the current page.

## Filter syntax

```
FilterName~op~'value'~and~FilterName~op~'value'~…
```

- **operators:** `eq` (=), `neq` (≠), `sw` (starts-with), `ct` (contains),
  `nct` (not-contains), `ew` (ends-with), `null` (empty) and `nn` (not empty) — these two
  on text columns only: the register refuses them on number, dropdown and boolean columns,
  so the CLI rejects that (exit 2) — and for
  `number`/`date` columns `gt` (>) and `lt` (<). `gt`/`lt` are strict; there is no
  `gte`/`lte`. The register applies them to text and dropdown columns as well (checked live
  2026-10-05: `Ort~gt~'A'` keeps a Münster unit, `Ort~gt~'Z'` drops it; on a dropdown they
  compare the code, `Energieträger~gt~'2000'`) — the text comparison is the register's own
  (its order for umlauts and case isn't documented), so prefer `eq`/`sw`/`ct` there. An unknown or upper-case operator is rejected (exit 2) — the register
  would return 0 rows for it
- **value:** single-quoted; for a dropdown use its **code** (`Value`), not its label;
  decimals take a point (`'4999.999'`) and no thousands separator (`'5.000'` means 5),
  dates work as `'2025-01-01'` or `'01.01.2025'` (a slash date is read day-first:
  `'01/02/2025'` is 1 February), booleans take `'1'`/`'0'`. A value the register can't read
  (a decimal comma, an exponent, an invalid date, `'true'`) gets its error reply: exit 1,
  "the register rejected the request".
  `null`/`nn` still need a value: `Ort~null~''` (a bare `Ort~null` is ignored upstream
  and returns the unfiltered register, so the CLI rejects it). Every other operator needs a
  non-blank value: `''` or `' '` is rejected (on a dropdown the register did not even
  answer). **A value cannot contain
  `~`:** the register splits the whole filter on every `~` and has no escape or quoting
  for it (`ct 'a~b'` would silently become `ct 'a'`), so the CLI rejects it; search for a
  part of the text without the `~` instead. A single `'` inside a value is fine
  (`ct 'd'Arc'`). Library users build specs from input with `buildFilter()`
- **whitespace:** next to a `~` it means nothing and is dropped — around a FilterName, an
  operator or `and`, and outside a quoted value (`'Münster' ~and~…`); inside the quotes it
  is kept
- **checked before sending:** every condition needs a FilterName, a known operator and
  a value, a value that opens a single quote must close it, conditions are joined by
  `~and~` only, and nothing may dangle at the end (`…~and~`). Anything else is a usage
  error (exit 2)
- **checked against the category's columns** (one extra request for the column list): a
  FilterName the category doesn't have, and for `eq`/`neq` a dropdown code its list
  doesn't have (a label such as `'Wind'` is named with its code), are a usage error
  (exit 2) — the register would ignore the name and return the unfiltered set, and answer
  an unknown code with 0 rows. A name is matched in Unicode NFC (a decomposed `ä` from
  macOS input counts as `ä`), without surrounding whitespace and in any case, and sent the
  register's way
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

> **The register ignores a FilterName it doesn't know** and returns the unfiltered
> result; the CLI refuses such a name before sending (with "did you mean"). `--filter` may
> be given several times; the conditions are joined with `~and~`. Every other option given
> twice is a usage error (exit 2).

## Examples

```bash
mastr stromerzeugung --total                        # 9562366 (2026-10-05)
mastr stromerzeugung --page-size 5 --iso-dates      # first 5 units, ISO dates
mastr filters stromerzeugung --compact | jq '.[] | {FilterName, Type}'
mastr gasverbrauch --sort "MaximaleGasbezugsLeistung-desc" --page-size 10 --compact | jq '.data'
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success (help/version included); an empty result also exits 0 |
| `1` | API/logical error (e.g. the server's `Errors` field), or a catch-all |
| `2` | usage error (bad flags, unknown command, an option other than `--filter` given twice, a malformed `--filter` — shape, operator, `~or~`, a FilterName the category doesn't have, a dropdown code it doesn't list — or a bad `--page-size`, redirecting base URL) |
| `4` | HTTP 404 |
| `6` | network / transport failure (DNS, connection, timeout, response size-cap) |

## Notes

- **A wrong `--sort` field returns 0 results, not an error.** An unknown sort column
  key makes the server answer with zero rows (`total: 0`), which reads like "no
  matches". If a query returns 0 only after you add `--sort`, check the column key —
  the CLI logs a note (an `INFO` record of `mastr.api`) to stderr in this case. Sort keys are the record's field names
  (`Bruttoleistung`, `InbetriebnahmeDatum`), not the FilterNames from `mastr filters`
  (`Bruttoleistung der Einheit-desc` returns 0 rows); list them with
  `mastr stromerzeugung --page-size 1 --compact | jq '.data[0] | keys'`. (Contrast
  `--filter`, where a wrong field or operator is rejected before sending; a filter that
  still gives 0 rows gets a stderr note, an `INFO` record, about its values.)
- **Dates** are Microsoft `/Date(ms)/` strings; `--iso-dates` converts them, or use the
  library's `parseMsDate()` (a `Date`) and `formatMastrDate()` (the `--iso-dates` text).
  Date-only fields (`InbetriebnahmeDatum`, `EinheitRegistrierungsdatum`, …) arrive as UTC
  midnight and print as `YYYY-MM-DD`; timestamps (`DatumLetzteAktualisierung`) print in German
  time with their offset (`+01:00` winter, `+02:00` summer) — the same instant as the UTC
  value, so the calendar day is the German one. A timestamp that happens to fall on UTC
  midnight exactly prints as a date.
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
