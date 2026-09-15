# Examples

Real examples for the Claude Code skills of the `mastr` plugin, one per skill: a request,
the `mastr` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `mastr` 0.0.4.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [mastr-filters](#mastr-filters) · [mastr-search](#mastr-search) · [mastr-unit](#mastr-unit)

## mastr-filters

> How do I filter MaStR for battery storage in operation in Brandenburg above 10 MW, biggest first?

```bash
mastr filters stromerzeugung --compact
mastr stromerzeugung --filter "Bundesland~eq~'1400'" --total
mastr stromerzeugung --filter "Bundesland~eq~'1400'~and~Energieträger~eq~'2496'" --total
mastr stromerzeugung --filter "Bundesland~eq~'1400'~and~Energieträger~eq~'2496'~and~Betriebs-Status~eq~'35'" --total
F="Bundesland~eq~'1400'~and~Energieträger~eq~'2496'~and~Betriebs-Status~eq~'35'~and~Speichertechnologie~eq~'524'"
mastr stromerzeugung --filter "$F" --total
mastr stromerzeugung --filter "$F~and~Bruttoleistung~gt~'10000'" --total                    # unfiltered: not a FilterName
mastr stromerzeugung --filter "$F~and~Bruttoleistung der Einheit~gte~'10000'" --total       # 0: gte is not an operator
mastr stromerzeugung --filter "$F~and~Bruttoleistung der Einheit~gt~'10000'" --total
mastr stromerzeugung --filter "$F~and~Bruttoleistung der Einheit~gt~'10000'" --sort "Bruttoleistung der Einheit-desc" --page-size 3 --compact   # 0 rows
mastr stromerzeugung --filter "$F~and~Bruttoleistung der Einheit~gt~'10000'" --sort "Bruttoleistung-desc" --page-size 15 --iso-dates --compact
```

The skill's operator list has no "greater than". `gt` works, but `gte` returns 0 without any
warning. Sorting by the FilterName returned 0 rows and the CLI's stderr note. The sort key is the
record field `Bruttoleistung`.

```
Battery storage in operation in Brandenburg, > 10 MW, largest first

  FilterName                   op   Value   meaning
  Bundesland                   eq   1400    Brandenburg
  Energieträger                eq   2496    Speicher
  Betriebs-Status              eq   35      In Betrieb
  Speichertechnologie          eq   524     Batterie
  Bruttoleistung der Einheit   gt   10000   kW (number field; gt is strict)

  --filter "Bundesland~eq~'1400'~and~Energieträger~eq~'2496'~and~Betriebs-Status~eq~'35'~and~Speichertechnologie~eq~'524'~and~Bruttoleistung der Einheit~gt~'10000'"
  --sort   "Bruttoleistung-desc"

Check with --total: 300,199 → 94,302 → 92,789 → 92,773 → 11 units
First rows: Big Battery Lausitz 66,000 kW (SEE905930139120, Spremberg, 2020-11-19)
            BESS Kahsel 32,200 kW (SEE975222107571, 2026-07-27)
            BESS Löwenberger Land II 22,500 kW (SEE937755233493, 2026-07-05)
```

Next step offered: hand the filter to mastr-search for the full 11-row list.

## mastr-search

> How much offshore wind is in operation in Germany right now, and which wind farms are the biggest?

```bash
mastr stromerzeugung --total
mastr stromerzeugung --filter "Energieträger~eq~'2497'" --total
mastr stromerzeugung --filter "Energieträger~eq~'2497'~and~Wind an Land oder auf See~eq~'889'" --total
mastr stromerzeugung --filter "Energieträger~eq~'2497'~and~Wind an Land oder auf See~eq~'889'~and~Betriebs-Status~eq~'35'" --total
mastr stromerzeugung --filter "Energieträger~eq~'2497'~and~Wind an Land oder auf See~eq~'889'~and~Betriebs-Status~eq~'31'" --total
mastr stromerzeugung --filter "Energieträger~eq~'2497'~and~Wind an Land oder auf See~eq~'889'~and~Betriebs-Status~eq~'35'" --sort "Bruttoleistung-desc" --page-size 2000 --iso-dates --compact
```

MaStR can't sum capacity server-side. With 1,776 matches the skill fetched them all in one page
(7.3 MB) and summed `Bruttoleistung` locally, grouping by `WindparkName`.

```
Offshore wind in operation: 1,776 units, 11,013,743 kW gross ≈ 11.0 GW
  North Sea 9.19 GW · Baltic Sea 1.83 GW
  Register context: 9,458,587 generation units, 43,517 wind units, 1,909 offshore
  (133 more offshore units "In Planung")

Largest wind farms (47 in total)
  Borkum Riffgrund 3   83 units   958.6 MW   Siemens Gamesa   commissioned 2025-12-03 … 2026-08-17
  EnBW He Dreiht       51 units   765.0 MW   Vestas V236-15MW 2025-11-25 … 2026-08-21
  Windpark Hohe See    71 units   521.9 MW   Siemens          2019
  Baltic Eagle         50 units   476.3 MW   Vestas           2024
  Borkum Riffgrund 2   56 units   464.8 MW   MHI Vestas       2018
  OWP Veja Mate        67 units   422.1 MW   Siemens          2017
  … 41 more

Added in 2026 so far: 98 units, 1,280.3 MW (EnBW He Dreiht, Borkum Riffgrund 3, NC 1)
Largest single units: 15,000 kW, e.g. SEE920051579655 (HD A1, EnBW He Dreiht)
Source: © Bundesnetzagentur – Marktstammdatenregister (DL-DE-BY-2.0)
```

## mastr-unit

> What does MaStR unit SEE920051579655 tell me?

```bash
mastr stromerzeugung --filter "MaStR-Nr. der Einheit~eq~'SEE920051579655'" --iso-dates --compact
```

One call with `total: 1`. The record has 118 fields; the skill read the populated ones. The grid
operator's `NetzbetreiberMaStRNummer` arrives as an HTML link (`<a href="/MaStR/Akteur/…">`), so
it took the number from `NetzbetreiberNamen` instead.

```
HD A1 — offshore wind turbine, EnBW He Dreiht (SEE920051579655)
  Status:        In Betrieb (system status: Aktiviert)
  Capacity:      15,000 kW gross = 15,000 kW net (15 MW)
  Turbine:       Vestas Deutschland GmbH V236-15MW, Horizontalläufer,
                 hub height 144.6 m, rotor diameter 236 m
  Location:      Ausschließliche Wirtschaftszone — "Nordsee; Gebiet nach dem
                 Flächenentwicklungsplan des BSH: N-7"; 54.358732 N, 6.197874 E
  Dates:         commissioned 2026-02-24, registered 2026-02-27, last updated 2026-09-11
  Operator:      EnBW He Dreiht GmbH ＆ Co. KG (ABR912332201010) — a company, not anonymised
  Grid:          TenneT TSO GmbH (SNB970033313272), Höchstspannung, Volleinspeisung
  EEG:           EEG961890773712, tender award BK6-17-001-07
  Permit:        SGE959647687634, Bundesamt für Seeschifffahrt und Hydrographie
Source: © Bundesnetzagentur – Marktstammdatenregister (DL-DE-BY-2.0)
```

Next steps offered: the rest of the wind farm (`--filter "Name des Windparks~eq~'EnBW He Dreiht'"` matches 64 units, 51 of them in operation), or the linked EEG record.
