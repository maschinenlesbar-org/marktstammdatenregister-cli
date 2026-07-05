# Usage

`mastr` — a CLI for the Marktstammdatenregister (MaStR). No API key needed.

```bash
mastr [global options] <command> [command options]
```

## Global options

| Option | Description |
|---|---|
| `--base-url <url>` | API base URL (default `https://www.marktstammdatenregister.de/MaStR`) |
| `--timeout <ms>` | per-request timeout in ms (0 = no timeout) |
| `--user-agent <ua>` | User-Agent header value |
| `--max-retries <n>` | retries for transient 429/503 responses (0..10) |
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
| `--sort <spec>` | `FieldKey-asc` or `FieldKey-desc`, e.g. `Bruttoleistung-desc` |
| `--filter <spec>` | filter expression (see below) |
| `--total` | print only the total match count, not the rows |

Each data command prints `{ total, data }`: `total` is the full match count (respects
the filter), `data` is the current page.

## Filter syntax

```
FilterName~op~'value'~[and|or]~FilterName~op~'value'~…
```

- **operators:** `eq` (=), `neq` (≠), `sw` (starts-with), `ct` (contains),
  `nct` (not-contains), `ew` (ends-with), `null` (empty), `nn` (not empty)
- **value:** single-quoted; for a dropdown use its **code** (`Value`), not its label
- discover the `FilterName`s and codes with `mastr filters <category>`

```bash
# Solar (Energieträger 2495) units in operation (Betriebs-Status 35)
mastr stromerzeugung --filter "Energieträger~eq~'2495'~and~Betriebs-Status~eq~'35'" --total
```

> **A wrong/misspelled FilterName is silently ignored** and you get the unfiltered
> result — always confirm the exact name via `mastr filters` and sanity-check with
> `--total` (the count should change).

## Examples

```bash
mastr stromerzeugung --total                        # 9063887
mastr stromerzeugung --page-size 5 --iso-dates      # first 5 units, ISO dates
mastr filters stromerzeugung --compact | jq '.[] | {FilterName, Type}'
mastr gasverbrauch --sort "Bruttoleistung-desc" --page-size 10 --compact | jq '.data'
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success (help/version included); an empty result also exits 0 |
| `1` | API/logical error (e.g. the server's `Errors` field), or a catch-all |
| `2` | usage error (bad flags, unknown command, bad `--filter`/`--page-size`, redirecting base URL) |
| `4` | HTTP 404 |
| `6` | network / transport failure (DNS, connection, timeout, response size-cap) |

## Notes

- **Dates** are Microsoft `/Date(ms)/` strings; `--iso-dates` converts them, or use the
  library's `parseMsDate()`.
- **You cannot sum capacity server-side** — there is no aggregate endpoint. Use `--total`
  for counts; sum `Bruttoleistung` client-side only for small result sets.
- The data is © the Bundesnetzagentur under DL-DE-BY-2.0 — see
  [DATA_LICENSE.md](DATA_LICENSE.md); attribution is required.
