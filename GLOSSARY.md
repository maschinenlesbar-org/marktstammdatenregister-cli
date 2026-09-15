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
| **Bruttoleistung / Nettonennleistung** | fields | Gross / net rated capacity, in **kW**. |
| **Betriebs-Status** | `BetriebsStatusName` / filter | Operating status — `In Betrieb` (in operation), `In Planung`, `Endgültig stillgelegt`, … (filtered by code, e.g. `35` = In Betrieb). |
| **Anlagenbetreiber / Netzbetreiber** | `AnlagenbetreiberName` / `NetzbetreiberNamen` | Plant operator / grid operator. Operator names are often **anonymised** (`natürliche Person (ABR…)`). |
| **Total** | `total` | The full number of units matching the query, across all pages (respects the filter). Returned for free — use `--total`. |
| **Filter / Sort** | `--filter` / `--sort` | Kendo-grid selection. Filter: `FilterName~op~'value'~and~…` (or `~or~`), with the `FilterName`s from `mastr filters` and the operators `eq`, `neq`, `sw`, `ct`, `nct`, `ew`, `null`, `nn`, `gt`, `lt` (an unknown operator returns 0 rows). Sort: `FieldKey-asc` or `FieldKey-desc`, where `FieldKey` is a record field name such as `Bruttoleistung`, not a `FilterName`. |
| **`/Date(ms)/`** | `--iso-dates` / `parseMsDate` | A Microsoft-AJAX date (epoch-milliseconds, UTC). `--iso-dates` rewrites them to ISO-8601. |

## Reading a record

- **Capacities are in kW**; divide by 1000 for MW. Gross (`Bruttoleistung`) ≠ net
  (`Nettonennleistung`) — say which.
- **Dates are `/Date(ms)/`** — convert with `--iso-dates` before showing a human.
- **Coordinates (`Breitengrad`/`Laengengrad`) may be null**, and some location data is
  withheld for small (< 30 kW) units — by law, not a defect.
- **Rows are wide and vary by category** — only read fields that are present.
