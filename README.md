# marktstammdatenregister-cli

[![CI](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/marktstammdatenregister-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/marktstammdatenregister-cli)

**Website:** [English](https://maschinenlesbar.org/marktstammdatenregister-cli/) · [Deutsch](https://maschinenlesbar.org/marktstammdatenregister-cli/de/) — command reference, guides and API docs

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

### Docker

From 0.9.0 every release is also a container image for linux/amd64 and linux/arm64 on the
GitHub Container Registry, made from the same tarball as the npm package. It needs no Node.js and no
install:

```bash
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/maschinenlesbar-org/marktstammdatenregister-cli:latest stromerzeugung --total
```

The image's entrypoint is the program, so the command follows the image name directly;
`… marktstammdatenregister-cli:latest mastr stromerzeugung --total` works too.

In a container with a memory limit (`--memory`) the default `--max-response-bytes` is an eighth
of that limit (at most the usual 100 MiB), so an oversized answer is refused with a clear
error instead of the container being killed for memory. A unit row is about 4 KB, so a page of
`--page-size 5000` is about 20 MB: give such pulls `--memory 256m` or more, or page smaller.
The CLI needs at least 12 processes and threads (`--pids-limit 12`): below that it refuses with
an error, and with 4 or fewer Node.js itself hangs before the CLI can check.

`latest` is the newest release. For scripts, name a release and pin its digest, which the
[release notes](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/releases) give:
`…/marktstammdatenregister-cli:0.9.0@sha256:<digest>`. Each image carries signed build provenance;
check it with

```bash
gh attestation verify oci://ghcr.io/maschinenlesbar-org/marktstammdatenregister-cli:latest \
  --repo maschinenlesbar-org/marktstammdatenregister-cli
```

### MCP server

From 0.9.0 the register is also an [MCP](https://modelcontextprotocol.io/) server for AI agents,
`@maschinenlesbar.org/marktstammdatenregister-mcp` (command `mastr-mcp`, image
`ghcr.io/maschinenlesbar-org/marktstammdatenregister-mcp`): four read-only tools, counting units
(with a breakdown per Bundesland or energy source and a capacity sum), searching them, one unit by its
MaStR number, and the column names and codes, with the register's traps handled (units in
operation unless asked, names to codes, inclusive bounds, no server-side sum, the record read),
on stdio or Streamable HTTP. Setup for Claude Code, Claude Desktop and VS Code:
[MCP.md](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/blob/main/MCP.md).

```bash
npm i -g @maschinenlesbar.org/marktstammdatenregister-mcp
claude mcp add mastr -- mastr-mcp
```

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
padding or in another case is sent the register's way. A **value** is sent as text: trimmed
inside its quotes and in NFC (the register trims codes, not text: `' Münster '` matched
nothing), and one with an invisible, control or half character is rejected. A malformed spec
or an unknown operator (e.g. `gte`) is rejected too. Several `--filter` flags are joined with `~and~`;
any other option given twice is a usage error. **`--sort` takes `FieldKey-asc` or
`FieldKey-desc`** (several joined by `~`), sent trimmed; any other form (no direction, `-down`,
a name with spaces) is a usage error before any request, since the register sorted it ascending
or not at all without a word. A **wrong `--sort` field name is refused by the
register** (live 2026-10-09: `{"Error":true}`, exit 1 with an `ERROR` record of `mastr.api`
that names the sort key; it used to answer 0 rows, so sanity-check a sorted query with
`--total`); sort keys are record field names (`Bruttoleistung`), not FilterNames — list them with
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
`mastr.api` for the register's answers, a malformed one included, and the notes about them — also a `WARN` when characters of an answer that were not valid text (invalid bytes, a lone surrogate) were replaced with U+FFFD, so stdout stays well-formed JSON —, `mastr.http` for the
connection, `mastr.output` for a failed write to stdout and an answer that can't be printed — nested too deeply or too large). By default it is written log4j style; `--log-format jsonl` writes one JSON
object per line instead. A record is always one line: a line break, a control character
or a bidi control in a message (a server's text, a value you typed) is written as an
escape (`\n`, `\u001b`, `\u202e`), so it can neither split a record nor forge another
one, nor steer the terminal; a message longer than 4000 characters is cut and ends in
`… (N more characters)`:

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
condition. `buildFilter` quotes each value, sends a text value trimmed and in Unicode NFC
(`normalizeText`), and throws `MastrValidationError` for a `~` or a blank value:

```ts
import { buildFilter } from "@maschinenlesbar.org/marktstammdatenregister-cli";

const filter = buildFilter([
  { name: "Ort", op: "eq", value: town },                        // quoted, ~ refused
  { name: "Energieträger", op: "eq", value: ["2497", "2498"] },  // comma list = any of
]);
await mastr.stromerzeugung({ filter, pageSize: 1 });
```

The skills' use cases are library functions too, with the register's traps built in (units in
operation unless asked, names to codes, inclusive bounds, the record read):

```ts
import { countUnits, getUnit, searchUnits } from "@maschinenlesbar.org/marktstammdatenregister-cli";

await countUnits(mastr, { energySource: "Wind", state: "Bayern", by: "Betriebs-Status" });
await searchUnits(mastr, { energySource: "Solar", minCapacity: 10_000, sortBy: "commissioned", limit: 10 });
await getUnit(mastr, { mastrNumber: "SEE984033548619" }); // ISO dates, the grid operator's number without HTML
```

## Documentation

- [Usage.md](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/blob/main/Usage.md) — commands, filter syntax, exit codes
- [DEVELOPING.md](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/blob/main/DEVELOPING.md) — architecture, testing, the live-API quirks
- [GLOSSARY.md](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/blob/main/GLOSSARY.md) — MaStR domain terms
- [DATA_LICENSE.md](DATA_LICENSE.md) — the DL-DE-BY-2.0 data terms
- [SKILLS.md](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/blob/main/SKILLS.md) — the Claude Code skills this repo ships
- [MCP.md](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/blob/main/MCP.md) — the MCP server: tools, setup, options

## Licence

Code is dual-licensed **AGPL-3.0-or-later OR commercial** — see
[LICENSING.md](LICENSING.md). No external code contributions are accepted (see
[CONTRIBUTING.md](CONTRIBUTING.md)); bug reports and AGPL forks are welcome.
