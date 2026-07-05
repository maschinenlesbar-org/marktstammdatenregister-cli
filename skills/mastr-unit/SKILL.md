---
name: mastr-unit
description: >
  Read and interpret a MaStR unit record from the marktstammdatenregister-cli — its
  capacity, energy carrier, status, location and dates. Trigger when the user asks
  "what does this MaStR record mean?", "get the details for MaStR number SEE…", "what
  is the capacity/commissioning date of this plant?", "why is the operator name
  hidden?", or needs help understanding a unit's fields, the /Date(ms)/ timestamps, or
  the withheld/anonymised data.
version: 1.0.0
userInvocable: true
---

# MaStR Unit Record

A MaStR unit ("Einheit") is a wide (~90-field) record whose populated columns vary by
category. This skill reads the important fields and explains the quirks.

## Tooling

This skill drives the `mastr` command. **Before anything else, validate it is available** — run `command -v mastr` (or `mastr --version`). If it is not on your PATH, STOP and inform the user that the `mastr` CLI (`@maschinenlesbar.org/marktstammdatenregister-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required.** Records come from the four search commands (see **mastr-search**). Add `--iso-dates` to convert the `/Date(ms)/` timestamps to ISO-8601, and `--compact` to pipe to `jq`. Data © Bundesnetzagentur – Marktstammdatenregister under DL-DE-BY-2.0 (attribution required) — see DATA_LICENSE.md.

## Key fields

| Field | Meaning |
|---|---|
| `MaStRNummer` | the unit's registry number (e.g. `SEE984033548619`) |
| `EinheitName` | display name |
| `EnergietraegerName` | energy carrier (Solare Strahlungsenergie, Wind, …) |
| `Bruttoleistung` / `Nettonennleistung` | gross / net rated capacity, in **kW** |
| `BetriebsStatusName` | operating status (`In Betrieb`, `In Planung`, …) |
| `Bundesland` / `Ort` / `Plz` | federal state / town / postcode |
| `Breitengrad` / `Laengengrad` | latitude / longitude (may be withheld) |
| `InbetriebnahmeDatum` | commissioning date |
| `EinheitRegistrierungsdatum` | date registered in MaStR |
| `AnlagenbetreiberName` | operator (often anonymised) |
| `NetzbetreiberNamen` | grid operator |

## Fetch one unit by its number

There is no by-id endpoint; filter by `MaStRNummer`:

```bash
mastr stromerzeugung --filter "MaStR-Nr. der Einheit~eq~'SEE984033548619'" --iso-dates --compact \
  | jq '.data[0] | {MaStRNummer, EinheitName, EnergietraegerName, Bruttoleistung, BetriebsStatusName, Bundesland, Ort, InbetriebnahmeDatum}'
```

(Confirm the exact filter FilterName with the **mastr-filters** skill.)

## Traps

- **Dates are Microsoft `/Date(ms)/` strings** — always pass `--iso-dates` (or note
  they are epoch-milliseconds) before showing a date to a human.
- **Capacities are in kW**, gross (`Bruttoleistung`) vs net (`Nettonennleistung`) — say
  which; divide by 1000 for MW.
- **Operator names are often anonymised** (`natürliche Person (ABR…)`) and **some
  location data is withheld** for units < 30 kW — this is by law (natural-person /
  confidential data are not published), not a bug. Don't try to de-anonymise.
- **Coordinates may be null** — handle before mapping.
- **Fields vary by category** — a gas consumer lacks the solar/wind columns; only read
  fields that are present.
- Cite the source: © Bundesnetzagentur – Marktstammdatenregister (DL-DE-BY-2.0).
