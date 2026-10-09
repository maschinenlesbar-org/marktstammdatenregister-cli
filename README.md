# marktstammdatenregister-cli

[![CI](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/marktstammdatenregister-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/marktstammdatenregister-cli)

**Website:** [English](https://maschinenlesbar-org.github.io/marktstammdatenregister-cli/) · [Deutsch](https://maschinenlesbar-org.github.io/marktstammdatenregister-cli/de/) — command reference, guides and API docs

A dependency-light **TypeScript client + CLI** for the **Marktstammdatenregister
(MaStR)** — the Bundesnetzagentur's register of the German electricity & gas market:
~9 million generation and consumption units (solar, wind, storage, CHP, …). Wraps
the public "erweiterte öffentliche Einheitensuche". A [bund.dev](https://bund.dev) API.

- **No API key.** The public search is open.
- **Zero runtime HTTP dependencies.** Built on `node:http`/`https`; the CLI's only
  runtime dependency is `commander`.
- **Library + CLI.** Use the typed `MastrClient`, or the `mastr` command.

> **We provide the tool, not the data.** MaStR data is © the Bundesnetzagentur under
> **DL-DE-BY-2.0** — free to use with attribution. See [DATA_LICENSE.md](DATA_LICENSE.md).

## Install

```bash
npm install -g @maschinenlesbar.org/marktstammdatenregister-cli   # the `mastr` command
# or as a library:
npm install @maschinenlesbar.org/marktstammdatenregister-cli
```

Requires **Node.js 22.12+**.

## CLI

Four datasets, each paged and filterable. Prints `{ total, data }` (or just the
count with `--total`).

```bash
mastr stromerzeugung --total                       # how many electricity-generation units? → 9562366 (2026-10-05; it grows)
mastr stromerzeugung --filter "Energieträger~eq~'2495'" --total   # …how many are solar? → 6545851
mastr stromerzeugung --sort "Bruttoleistung-desc" --page-size 20 --iso-dates
mastr gaserzeugung --page 1 --page-size 50
mastr filters stromerzeugung                        # the filterable columns + dropdown codes
```

Categories: `stromerzeugung`, `stromverbrauch`, `gaserzeugung`, `gasverbrauch`.

**Filtering** uses the register's own syntax — `FilterName~op~'value'~and~…`
(ops `eq|neq|sw|ct|nct|ew|null|nn`, plus the strict `gt`/`lt` — meant for numbers and dates,
but the register applies them to text and dropdown columns too, comparing the text or the code);
there is **no working `~or~`** (the register drops everything after it, so the CLI
rejects it) — for several codes of one dropdown, list them in one value:
`Energieträger~eq~'2497,2498'`. Discover the German field names and dropdown codes with `mastr filters <category>`.
The register silently ignores a FilterName it doesn't know (you'd get the unfiltered set)
and answers an unknown dropdown code with 0 rows, so the CLI checks every FilterName and
every `eq`/`neq` dropdown code against the category's columns (one extra request) and
rejects an unknown one (exit 2, with "did you mean"); a name typed with a decomposed umlaut,
padding or in another case is sent the register's way. A malformed spec or an unknown
operator (e.g. `gte`) is rejected too. Several `--filter` flags are joined with `~and~`;
any other option given twice is a usage error. A **wrong `--sort` key returns 0 rows**:
sanity-check with `--total`; sort keys are record field names
(`Bruttoleistung`), not FilterNames — list them with
`mastr stromerzeugung --page-size 1 --compact | jq '.data[0] | keys'`. **Dates** come as Microsoft
`/Date(ms)/` strings — add `--iso-dates` to convert them to ISO-8601: date-only fields
(`InbetriebnahmeDatum`, …) as `YYYY-MM-DD`, timestamps (`DatumLetzteAktualisierung`) in German
time with an explicit offset, `2020-02-20T17:28:35.250+01:00`.

Global flags: `--base-url`, `--timeout`, `--user-agent`, `--max-retries`,
`--max-response-bytes`, `--log-format`, `--compact`, `--iso-dates`. See [Usage.md](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/blob/main/Usage.md). A `--base-url`
on plain `http:` to a host other than loopback logs one `WARN` record of `mastr.http`
(`… sent unencrypted …`) on stderr before the first request (stdout and the exit code are
unchanged); the library's check is `cleartextProblem(baseUrl)`.

Each line on stderr is a **log record**: a timestamp (UTC), a level (`ERROR`, `WARN`,
`INFO`) and a topic, the program and the area it comes from (`mastr.cli` for usage errors,
`mastr.api` for the register's answers and the notes about them, `mastr.http` for the
connection). By default it is written log4j style; `--log-format jsonl` writes one JSON
object per line instead:

```text
2026-10-09T14:03:12.481Z WARN  [mastr.http] requests to mirror.test are sent unencrypted (http:, not https:)
2026-10-09T14:03:12.902Z INFO  [mastr.api] 0 results with --filter set. If you expected matches, check the values: …
```

```bash
mastr --log-format jsonl stromerzeugung --filter "Ort~eq~'Nirgendwo'" --total 2>log.jsonl   # {"ts":"…","level":"INFO","topic":"mastr.api","msg":"0 results with --filter set. …"}
```

## Library

```ts
import { MastrClient, parseMsDate } from "@maschinenlesbar.org/marktstammdatenregister-cli";

const mastr = new MastrClient();
const solar = await mastr.stromerzeugung({ filter: "Energieträger~eq~'2495'", pageSize: 10 });
solar.total; // total matching units
await mastr.count("stromerzeugung", { filter: "Energieträger~eq~'2495'" }); // just the count, one-row request
parseMsDate(String(solar.data[0]?.EinheitRegistrierungsdatum)); // Date | null
```

The client checks a filter's FilterNames and dropdown codes against the category's columns
(`filterColumns()`, fetched once per client and category) and throws `MastrValidationError`
for one the register would ignore; `new MastrClient({ allowUnknownFilters: true })` skips that
check and its request. A query key it doesn't know (`filtr`) is refused the same way.

Build filters from user input with `buildFilter`, not string interpolation: a filter
value cannot contain `~` (the register splits on it and has no escape), so
`` `Ort~eq~'${input}'` `` lets an input like `Münster'~and~Energieträger~eq~'2497` add a
condition. `buildFilter` quotes each value and throws `MastrValidationError` for a `~`:

```ts
import { buildFilter } from "@maschinenlesbar.org/marktstammdatenregister-cli";

const filter = buildFilter([
  { name: "Ort", op: "eq", value: town },                        // quoted, ~ refused
  { name: "Energieträger", op: "eq", value: ["2497", "2498"] },  // comma list = any of
]);
await mastr.stromerzeugung({ filter, pageSize: 1 });
```

## Documentation

- [Usage.md](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/blob/main/Usage.md) — commands, filter syntax, exit codes
- [DEVELOPING.md](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/blob/main/DEVELOPING.md) — architecture, testing, the live-API quirks
- [GLOSSARY.md](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/blob/main/GLOSSARY.md) — MaStR domain terms
- [DATA_LICENSE.md](DATA_LICENSE.md) — the DL-DE-BY-2.0 data terms
- [SKILLS.md](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/blob/main/SKILLS.md) — the Claude Code skills this repo ships

## Licence

Code is dual-licensed **AGPL-3.0-or-later OR commercial** — see
[LICENSING.md](LICENSING.md). No external code contributions are accepted (see
[CONTRIBUTING.md](CONTRIBUTING.md)); bug reports and AGPL forks are welcome.
