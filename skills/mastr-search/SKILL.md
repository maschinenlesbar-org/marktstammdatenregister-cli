---
name: mastr-search
description: >
  Search and count German electricity & gas units in the Marktstammdatenregister
  (MaStR) using the marktstammdatenregister-cli. Trigger when the user asks "how
  many solar plants are in Germany?", "list wind turbines in Bavaria", "count
  battery storage units", "how much PV was registered in 2023?", "find gas
  generation units", or wants rows or totals from the register. Handles the four
  categories (electricity/gas × generation/consumption), paging, and match counts.
compatibility: >
  Requires the `mastr` CLI (npm package
  @maschinenlesbar.org/marktstammdatenregister-cli) on PATH, installed by the
  user; the skill never installs it. Uses jq for JSON filtering. Network access
  to www.marktstammdatenregister.de.
---

# MaStR Search

The Marktstammdatenregister is the Bundesnetzagentur's register of every unit in the
German electricity & gas market (~9M). This skill searches and counts them.

## Tooling

This skill drives the `mastr` command. **Before anything else, validate it is available** — run `command -v mastr` (or `mastr --version`). If it is not on your PATH, STOP and inform the user that the `mastr` CLI (`@maschinenlesbar.org/marktstammdatenregister-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

**No API key is required.** Each command searches ONE category — `stromerzeugung` (electricity generation, ~9M units), `stromverbrauch`, `gaserzeugung`, `gasverbrauch` — paged with `--page`/`--page-size` (default 25, max 5000). `--total` returns just the match count. Narrow with `--filter` (see the **mastr-filters** skill for the arcane syntax). Timestamps arrive as `/Date(ms)/`; add `--iso-dates` for ISO-8601. `--compact` for `jq`. Data © Bundesnetzagentur – Marktstammdatenregister under DL-DE-BY-2.0 (attribution required) — see DATA_LICENSE.md.

## Commands

```bash
mastr stromerzeugung   # electricity generation (solar, wind, storage, CHP, …)
mastr stromverbrauch   # electricity consumption
mastr gaserzeugung     # gas generation
mastr gasverbrauch     # gas consumption
```

Each prints `{ total, data }` — `total` is the full match count (respects the
filter), `data` is the current page.

## Recipes

```bash
# How many electricity-generation units exist? (just the count)
mastr stromerzeugung --total

# How many are solar? (Energieträger code 2495 — see mastr-filters)
mastr stromerzeugung --filter "Energieträger~eq~'2495'" --total

# First page of the largest units, dates as ISO
mastr stromerzeugung --sort "Bruttoleistung-desc" --page-size 20 --iso-dates --compact \
  | jq '.data[] | {MaStRNummer, EinheitName, Bruttoleistung, Bundesland, Ort}'

# Page through results
mastr stromerzeugung --page 1 --page-size 100 --compact
mastr stromerzeugung --page 2 --page-size 100 --compact
```

## Traps

- **Prefer `--total` for "how many?"** — never page through 9M rows to count. The
  server returns the exact total for free.
- **You cannot sum capacity server-side.** There is no aggregate endpoint; to total
  `Bruttoleistung` you would have to fetch (and cap) pages and sum client-side — only
  feasible for small result sets. Say so rather than pretending.
- **`--page-size` is capped at 5000.** For big pulls, page; don't crank it arbitrarily.
- **Filtering needs the exact FilterName + code** — resolve them with **mastr-filters**;
  a wrong field name is ignored and you silently get the unfiltered total.
- **A wrong `--sort` field returns 0 rows, not an error.** If a query drops to
  `total: 0` only after you add `--sort`, the sort column key is probably wrong (the
  CLI prints a stderr note). Sort keys are record field names (`Bruttoleistung`), not
  the FilterNames from `mastr filters` (`Bruttoleistung der Einheit` gives 0 rows); list
  them with `mastr stromerzeugung --page-size 1 --compact | jq '.data[0] | keys'`.
- **A wrong filter operator also returns 0 rows.** Range filters use `gt`/`lt`
  (strict; there is no `gte`/`lte`) — see **mastr-filters**.
- **Reading a record** (fields, dates, anonymisation) → the **mastr-unit** skill.
- Cite the source: © Bundesnetzagentur – Marktstammdatenregister (DL-DE-BY-2.0).
