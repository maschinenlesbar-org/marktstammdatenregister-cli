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

## CLI

Four datasets, each paged and filterable. Prints `{ total, data }` (or just the
count with `--total`).

```bash
mastr stromerzeugung --total                       # how many electricity-generation units? → 9063887
mastr stromerzeugung --filter "Energieträger~eq~'2495'" --total   # …how many are solar? → 6267133
mastr stromerzeugung --sort "Bruttoleistung-desc" --page-size 20 --iso-dates
mastr gaserzeugung --page 1 --page-size 50
mastr filters stromerzeugung                        # the filterable columns + dropdown codes
```

Categories: `stromerzeugung`, `stromverbrauch`, `gaserzeugung`, `gasverbrauch`.

**Filtering** uses the register's own syntax — `FilterName~op~'value'~and~…`
(ops `eq|neq|sw|ct|nct|ew|null|nn`, plus the strict `gt`/`lt` for numbers and dates);
there is **no working `~or~`** (the register drops everything after it, so the CLI
rejects it) — for several codes of one dropdown, list them in one value:
`Energieträger~eq~'2497,2498'`. Discover the German field names and dropdown codes with `mastr filters <category>`. A
**wrong `FilterName` is silently ignored** (you get the unfiltered set), while a **wrong
operator** (e.g. `gte`) or a **wrong `--sort` key returns 0 rows**. Verify filter names
with `mastr filters` and sanity-check with `--total`; sort keys are record field names
(`Bruttoleistung`), not FilterNames — list them with
`mastr stromerzeugung --page-size 1 --compact | jq '.data[0] | keys'`. **Dates** come as Microsoft
`/Date(ms)/` strings — add `--iso-dates` to convert them to ISO-8601.

Global flags: `--base-url`, `--timeout`, `--user-agent`, `--max-retries`,
`--max-response-bytes`, `--compact`, `--iso-dates`. See [Usage.md](Usage.md).

## Library

```ts
import { MastrClient, parseMsDate } from "@maschinenlesbar.org/marktstammdatenregister-cli";

const mastr = new MastrClient();
const solar = await mastr.stromerzeugung({ filter: "Energieträger~eq~'2495'", pageSize: 10 });
solar.total; // total matching units
parseMsDate(String(solar.data[0]?.EinheitRegistrierungsdatum)); // Date | null
```

## Documentation

- [Usage.md](Usage.md) — commands, filter syntax, exit codes
- [DEVELOPING.md](DEVELOPING.md) — architecture, testing, the live-API quirks
- [GLOSSARY.md](GLOSSARY.md) — MaStR domain terms
- [DATA_LICENSE.md](DATA_LICENSE.md) — the DL-DE-BY-2.0 data terms
- [SKILLS.md](SKILLS.md) — the Claude Code skills this repo ships

## Licence

Code is dual-licensed **AGPL-3.0-or-later OR commercial** — see
[LICENSING.md](LICENSING.md). No external code contributions are accepted (see
[CONTRIBUTING.md](CONTRIBUTING.md)); bug reports and AGPL forks are welcome.
