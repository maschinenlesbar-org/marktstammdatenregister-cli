---
name: mastr-filters
description: >
  Build MaStR filter and sort specifications for the marktstammdatenregister-cli —
  resolve the German field names and dropdown codes the register needs. Trigger when
  the user asks "how do I filter MaStR by Bundesland?", "what's the code for wind
  energy?", "filter units in operation only", "sort by capacity", or a mastr-search
  query needs a --filter/--sort string. Lists the filterable columns and their codes,
  and assembles the FilterName~op~'value' syntax.
compatibility: >
  Requires the `mastr` CLI (npm package
  @maschinenlesbar.org/marktstammdatenregister-cli) on PATH, installed by the
  user; the skill never installs it. Uses jq for JSON filtering. Network access
  to www.marktstammdatenregister.de.
---

# MaStR Filters

The MaStR filter syntax is arcane: German field names, coded dropdown values, and a
tilde-delimited grammar. This skill resolves the pieces and assembles a valid
`--filter` (and `--sort`) string for a **mastr-search** query.

## Tooling

This skill drives the `mastr` command. **Before anything else, validate it is available** — run `command -v mastr` (or `mastr --version`). If it is not on your PATH, STOP and inform the user that the `mastr` CLI (`@maschinenlesbar.org/marktstammdatenregister-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

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

`--filter "FilterName~op~'value'~and~FilterName~op~'value'~…"`

- **operators:** `eq` (=), `neq` (≠), `sw` (starts-with), `ct` (contains),
  `nct` (not-contains), `ew` (ends-with), `null` (is empty), `nn` (not empty) — these
  two on `text` columns only (the register refuses them on number, dropdown and boolean
  columns, so the CLI rejects that with exit 2) — and `gt` (>) and `lt` (<) for `number`
  and `date` columns. `gt`/`lt` are **strict**, and
  there is **no `gte`/`lte`** (the register returns 0 rows for `gte`, `ge`, `lte`, `le`,
  so the CLI rejects any unknown or upper-case operator with exit 2). For "at least
  5000 kW" use `gt` just below the bound: `~gt~'4999.999'`.
- **value:** in single quotes; for a dropdown use its **`Value` code**, not the label
  (the CLI rejects a label or an unlisted code with exit 2 and names the code).
  Decimals take a point (`'4999.999'`) and no thousands separator (`'5.000'` means 5);
  a decimal comma, an exponent or text in a number column gets the register's error reply
  (exit 1, "the register rejected the request"). Dates work as `'2025-01-01'` or
  `'01.01.2025'`; a slash date is read day-first (`'01/02/2025'` is 1 February), so prefer
  ISO. Booleans take `'1'`/`'0'` (`'true'` gets the register's error). Every operator but
  `null`/`nn` needs a non-blank value (`''` is rejected). `null`/`nn` still take a value:
  `Ort~null~''` (a bare `Ort~null` would be ignored upstream, so the CLI rejects it). **A value cannot contain
  `~`** — the register splits on every `~` and has no escape, so the CLI rejects it;
  match a part of the text without the `~` (e.g. `ct`). A single `'` inside a value is fine.
- **conjunction:** only `and` between conditions. **There is no working `or`:** the
  register keeps only the part before the first `~or~` and silently drops the rest, so
  the CLI rejects `~or~` (exit 2). For an OR between codes of **one dropdown column**,
  put them comma-separated in one value: `Energieträger~eq~'2497,2498'`. This works for
  dropdown codes only (`Ort~eq~'Münster,Berlin'` gives 0 rows); an OR across different
  columns needs one `--total` query per condition (and the overlap subtracted).
  Giving `--filter` several times is the same as joining the parts with `~and~`.

```bash
# Solar units in operation
mastr stromerzeugung --filter "Energieträger~eq~'2495'~and~Betriebs-Status~eq~'35'" --total

# Wind or solar units: several codes of one dropdown as a comma list
mastr stromerzeugung --filter "Energieträger~eq~'2497,2495'" --total

# Wind units above 5 MW gross (Bruttoleistung is in kW)
mastr stromerzeugung --filter "Energieträger~eq~'2497'~and~Bruttoleistung der Einheit~gt~'5000'" --total

# Wind units commissioned after 1 January 2025
mastr stromerzeugung --filter "Energieträger~eq~'2497'~and~Inbetriebnahmedatum der Einheit~gt~'2025-01-01'" --total
```

## Sorting

`--sort "FieldKey-asc"` or `--sort "FieldKey-desc"`, e.g. `--sort "Bruttoleistung-desc"`.
**The `FieldKey` is a record field name, not a `FilterName`** — `mastr filters` can't
tell you the keys (its `FilterField` is `null`). `Bruttoleistung der Einheit-desc` returns
0 rows; `Bruttoleistung-desc` works. List the keys from one row:

```bash
mastr stromerzeugung --page-size 1 --compact | jq '.data[0] | keys'
# → ["AktenzeichenGenehmigung", …, "Bruttoleistung", …, "InbetriebnahmeDatum", …]
```

Pick the key that matches the column (`Bruttoleistung`, `Nettonennleistung`,
`InbetriebnahmeDatum`, `EinheitRegistrierungsdatum`, …). **The keys differ per category:**
`Bruttoleistung`/`Nettonennleistung` exist only in `stromerzeugung`; gas generation and
storage sort by `Erzeugungsleistung`, `MaxEinspeicherleistung`, `MaxAusspeicherleistung`
or `MaxArbeitsvolumen`, gas consumption by `MaximaleGasbezugsLeistung`, and
`stromverbrauch` has no capacity key. List the keys of the category you query.
**A wrong sort key is worse than a wrong filter: it returns 0 rows** (not an error, not
the unfiltered set), so a query that goes to `total: 0` right after you add `--sort`
almost always has a bad sort key. The CLI prints a stderr note in that case.

## Traps

- **Use the dropdown `Value` code, not the display name** (`'2495'`, not `'Solar'`); the
  CLI rejects a label and tells you its code.
- **A FilterName the category doesn't have is a usage error** (exit 2, with "did you
  mean"): the register itself would ignore it and return the unfiltered set, so the CLI
  checks every name — and every `eq`/`neq` dropdown code — against the category's columns
  before sending (one extra request). Spacing, a decomposed umlaut and the case of a name
  are fixed for you. Still take the names from `mastr filters` and sanity-check with
  `--total` (the count should drop).
- **A malformed filter is a usage error (exit 2), not a query:** an unknown or upper-case
  operator (`~gte~`, `~EQ~`), a missing or `''` value, an unclosed quote, a dangling
  `~and~` or `~or~`, an unknown FilterName or code, `null`/`nn` on a non-text column. Read
  the message, fix the spec and rerun; no unit query was sent. Exit 1 with "the register
  rejected the request" means a value it can't read (decimal comma, bad date, `'true'`).
  If a well-formed filter drops to 0, check the values (`eq` on text matches the whole
  text; `ct` matches a part) — the CLI prints a stderr note.
- **Never use `~or~`** — the register would drop everything after it; the CLI refuses it.
  Use a comma list inside one dropdown value instead.
- **Columns differ per category** — run `mastr filters <category>` for the right one.
- **Field names are German with umlauts** (`Energieträger`, `Betriebs-Status`) — copy
  them verbatim, and quote the whole `--filter` value in the shell.
- Hand the assembled `--filter`/`--sort` to **mastr-search**.
