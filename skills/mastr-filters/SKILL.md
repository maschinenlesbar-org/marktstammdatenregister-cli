---
name: mastr-filters
description: >
  Build MaStR filter and sort specifications for the marktstammdatenregister-cli —
  resolve the German field names and dropdown codes the register needs. Trigger when
  the user asks "how do I filter MaStR by Bundesland?", "what's the code for wind
  energy?", "filter units in operation only", "sort by capacity", or a mastr-search
  query needs a --filter/--sort string. Lists the filterable columns and their codes,
  and assembles the FilterName~op~'value' syntax.
version: 1.0.0
userInvocable: true
---

# MaStR Filters

The MaStR filter syntax is arcane: German field names, coded dropdown values, and a
tilde-delimited grammar. This skill resolves the pieces and assembles a valid
`--filter` (and `--sort`) string for a **mastr-search** query.

## Tooling

This skill drives the `mastr` command. **Before anything else, validate it is available** — run `command -v mastr` (or `mastr --version`). If it is not on your PATH, STOP and inform the user that the `mastr` CLI (`@maschinenlesbar.org/marktstammdatenregister-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required.** Use `mastr filters <category>` (category = `stromerzeugung` | `stromverbrauch` | `gaserzeugung` | `gasverbrauch`) to list the filterable columns for that dataset. `--compact` for `jq`. Data © Bundesnetzagentur – Marktstammdatenregister under DL-DE-BY-2.0 — see DATA_LICENSE.md.

## Discover the columns

```bash
mastr filters stromerzeugung --compact | jq '.[] | {FilterName, Type}'
```

Each column has a `FilterName` (the German field name you filter on), a `Type`
(`text`, `number`, `date`, `boolean`, `multidropdown`), and — for dropdowns — a
`ListObject` of `{ Name, Value }`: **`Value` is the code you must send**, not the Name.

```bash
# The codes for the "Energieträger" (energy carrier) dropdown
mastr filters stromerzeugung --compact \
  | jq '.[] | select(.FilterName=="Energieträger") | .ListObject[] | {Name, Value}'
# → { "Name": "Solare Strahlungsenergie", "Value": "2495" }, { "Name": "Wind", ... }, …
```

## The filter grammar

`--filter "FilterName~op~'value'~[and|or]~FilterName~op~'value'~…"`

- **operators:** `eq` (=), `neq` (≠), `sw` (starts-with), `ct` (contains),
  `nct` (not-contains), `ew` (ends-with), `null` (is empty), `nn` (not empty).
- **value:** in single quotes; for a dropdown use its **`Value` code**, not the label.
- **conjunctions:** `and` / `or` between conditions.

```bash
# Solar units in operation
mastr stromerzeugung --filter "Energieträger~eq~'2495'~and~Betriebs-Status~eq~'35'" --total
```

## Sorting

`--sort "FieldKey-asc"` or `--sort "FieldKey-desc"`, e.g. `--sort "Bruttoleistung-desc"`.

## Traps

- **Use the dropdown `Value` code, not the display name** (`'2495'`, not `'Solar'`).
- **A wrong/misspelled FilterName is silently ignored** — you get the unfiltered set.
  Always confirm the exact `FilterName` from `mastr filters` first, and sanity-check
  with `--total` (the count should drop).
- **Columns differ per category** — run `mastr filters <category>` for the right one.
- **Field names are German with umlauts** (`Energieträger`, `Betriebs-Status`) — copy
  them verbatim, and quote the whole `--filter` value in the shell.
- Hand the assembled `--filter`/`--sort` to **mastr-search**.
