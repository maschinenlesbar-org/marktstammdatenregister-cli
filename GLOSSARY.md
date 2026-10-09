# Glossary

MaStR domain terms, as the CLI surfaces them. Field labels in the data are German;
keep them verbatim.

| Term | In the CLI | What it is |
|---|---|---|
| **MaStR** | — | Marktstammdatenregister, the Bundesnetzagentur's register of the German electricity & gas market: master data on ~9M generation/consumption units and market actors. |
| **Einheit** (unit) | a row | A single registered unit — a PV system, wind turbine, storage, CHP block, consumer, etc. Keyed by its `MaStRNummer` (e.g. `SEE984033548619`). |
| **Stromerzeugung / Stromverbrauch** | `stromerzeugung` / `stromverbrauch` | Electricity generation / consumption units. |
| **Gaserzeugung / Gasverbrauch** | `gaserzeugung` / `gasverbrauch` | Gas generation / consumption units. |
| **Energieträger** | `EnergietraegerName` / filter | Energy carrier — Solare Strahlungsenergie (solar), Wind, Biomasse, … Filtered by a numeric code (e.g. `2495` = solar). |
| **Bruttoleistung / Nettonennleistung** | fields | Gross / net rated capacity, in **kW**. Only `stromerzeugung` rows have them. |
| **Gas capacities** | fields | `gaserzeugung`: `Erzeugungsleistung` (gas generation), and for gas storage `MaxEinspeicherleistung` / `MaxAusspeicherleistung` (injection / withdrawal, **kWh/h**) and `MaxArbeitsvolumen` (working gas volume, **kWh**). `gasverbrauch`: `MaximaleGasbezugsLeistung` (maximum gas intake). The rows state no unit for `Erzeugungsleistung` and `MaximaleGasbezugsLeistung`. `stromverbrauch` rows carry no capacity field. |
| **Betriebs-Status** | `BetriebsStatusName` / filter | Operating status — `In Betrieb` (in operation), `In Planung`, `Endgültig stillgelegt`, … (filtered by code, e.g. `35` = In Betrieb). |
| **Anlagenbetreiber / Netzbetreiber** | `AnlagenbetreiberName` / `NetzbetreiberNamen` | Plant operator / grid operator. Operator names are often **anonymised** (`natürliche Person (ABR…)`). |
| **Total** | `total` | The full number of units matching the query, across all pages (respects the filter). Returned for free — use `--total` (library: `count()`, a one-row request). |
| **Filter / Sort** | `--filter` / `--sort` | Kendo-grid selection. Filter: `FilterName~op~'value'~and~…`, with the `FilterName`s from `mastr filters` and the operators `eq`, `neq`, `sw`, `ct`, `nct`, `ew`, `null`, `nn`, `gt`, `lt` (`null`/`nn` take `''` and work on text columns only; `gt`/`lt` are strict and meant for number and date columns, but the register applies them to text and dropdown columns too, comparing the text or the code; a value cannot contain `~`; a malformed spec, an unknown operator, a `FilterName` the category doesn't have or a dropdown code it doesn't list is rejected before sending, as the register would return a wrong count; FilterNames are matched in Unicode NFC, without padding and in any case; several `--filter` flags are joined with `~and~`). There is no working `~or~` (the register drops everything after it, so the CLI rejects it); several codes of one dropdown go in one comma list, `Energieträger~eq~'2497,2498'`. Sort: `FieldKey-asc` or `FieldKey-desc`, where `FieldKey` is a record field name such as `Bruttoleistung`, not a `FilterName`; a blank sort is rejected before sending (CLI and library alike). |
| **`/Date(ms)/`** | `--iso-dates` / `parseMsDate` / `formatMastrDate` | A Microsoft-AJAX date (epoch-milliseconds, UTC). `--iso-dates` rewrites them to ISO-8601: a date-only value (UTC midnight, e.g. `InbetriebnahmeDatum`) as `YYYY-MM-DD`, a timestamp (`DatumLetzteAktualisierung`) in German time with an explicit offset, `2020-02-20T17:28:35.250+01:00`. |
| **Log record** | stderr / `--log-format` | Every diagnostic line the CLI writes to stderr: a timestamp, a level (`ERROR`, `WARN`, `INFO`) and a topic `mastr.<area>`, as text (log4j style) or with `--log-format jsonl` as one JSON object per line. The areas: `cli` (usage errors, commander's messages, unexpected errors), `api` (the register's answers: an error status, the `{"Error":true}` envelope, and a malformed answer — bad JSON, the wrong shape, an empty body — and the notes on an empty answer), `http` (the connection, the size-cap hint, the cleartext warning, and one WARN per retry before it waits) and `output` (a failed write to stdout). A record is always one line; control characters in it are escaped. |

## Reading a record

- **Electricity capacities are in kW**; divide by 1000 for MW. Gross (`Bruttoleistung`) ≠
  net (`Nettonennleistung`) — say which. Both exist only in `stromerzeugung`; the gas
  categories have their own capacity fields (see *Gas capacities*), which are not kW.
- **Dates are `/Date(ms)/`** — convert with `--iso-dates` before showing a human.
- **Coordinates (`Breitengrad`/`Laengengrad`) may be null**, and some location data is
  withheld for small (< 30 kW) units — by law, not a defect.
- **Rows are wide and vary by category** — only read fields that are present.
