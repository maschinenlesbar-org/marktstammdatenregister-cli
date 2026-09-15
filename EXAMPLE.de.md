# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `mastr`, eines pro Skill: eine
Anfrage, die `mastr`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `mastr` 0.0.4 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [mastr-filters](#mastr-filters) · [mastr-search](#mastr-search) · [mastr-unit](#mastr-unit)

## mastr-filters

> Wie filtere ich im MaStR nach Batteriespeichern in Betrieb in Brandenburg über 10 MW, die größten zuerst?

```bash
mastr filters stromerzeugung --compact
mastr stromerzeugung --filter "Bundesland~eq~'1400'" --total
mastr stromerzeugung --filter "Bundesland~eq~'1400'~and~Energieträger~eq~'2496'" --total
mastr stromerzeugung --filter "Bundesland~eq~'1400'~and~Energieträger~eq~'2496'~and~Betriebs-Status~eq~'35'" --total
F="Bundesland~eq~'1400'~and~Energieträger~eq~'2496'~and~Betriebs-Status~eq~'35'~and~Speichertechnologie~eq~'524'"
mastr stromerzeugung --filter "$F" --total
mastr stromerzeugung --filter "$F~and~Bruttoleistung~gt~'10000'" --total                    # ungefiltert: kein FilterName
mastr stromerzeugung --filter "$F~and~Bruttoleistung der Einheit~gte~'10000'" --total       # 0: gte ist kein Operator
mastr stromerzeugung --filter "$F~and~Bruttoleistung der Einheit~gt~'10000'" --total
mastr stromerzeugung --filter "$F~and~Bruttoleistung der Einheit~gt~'10000'" --sort "Bruttoleistung der Einheit-desc" --page-size 3 --compact   # 0 Zeilen
mastr stromerzeugung --filter "$F~and~Bruttoleistung der Einheit~gt~'10000'" --sort "Bruttoleistung-desc" --page-size 15 --iso-dates --compact
```

Die Operatorliste des Skills kennt kein „größer als". `gt` funktioniert, `gte` liefert dagegen
ohne Warnung 0. Die Sortierung nach dem FilterName ergab 0 Zeilen und den Hinweis der CLI auf
stderr. Der Sortierschlüssel ist das Datensatzfeld `Bruttoleistung`.

```
Batteriespeicher in Betrieb in Brandenburg, > 10 MW, größte zuerst

  FilterName                   op   Value   Bedeutung
  Bundesland                   eq   1400    Brandenburg
  Energieträger                eq   2496    Speicher
  Betriebs-Status              eq   35      In Betrieb
  Speichertechnologie          eq   524     Batterie
  Bruttoleistung der Einheit   gt   10000   kW (Zahlenfeld; gt ist echt größer)

  --filter "Bundesland~eq~'1400'~and~Energieträger~eq~'2496'~and~Betriebs-Status~eq~'35'~and~Speichertechnologie~eq~'524'~and~Bruttoleistung der Einheit~gt~'10000'"
  --sort   "Bruttoleistung-desc"

Kontrolle mit --total: 300.199 → 94.302 → 92.789 → 92.773 → 11 Einheiten
Erste Zeilen: Big Battery Lausitz 66.000 kW (SEE905930139120, Spremberg, 2020-11-19)
              BESS Kahsel 32.200 kW (SEE975222107571, 2026-07-27)
              BESS Löwenberger Land II 22.500 kW (SEE937755233493, 2026-07-05)
```

Als Nächstes angeboten: den Filter an mastr-search übergeben, um alle 11 Zeilen zu listen.

## mastr-search

> Wie viel Offshore-Wind ist in Deutschland derzeit in Betrieb, und welche Windparks sind die größten?

```bash
mastr stromerzeugung --total
mastr stromerzeugung --filter "Energieträger~eq~'2497'" --total
mastr stromerzeugung --filter "Energieträger~eq~'2497'~and~Wind an Land oder auf See~eq~'889'" --total
mastr stromerzeugung --filter "Energieträger~eq~'2497'~and~Wind an Land oder auf See~eq~'889'~and~Betriebs-Status~eq~'35'" --total
mastr stromerzeugung --filter "Energieträger~eq~'2497'~and~Wind an Land oder auf See~eq~'889'~and~Betriebs-Status~eq~'31'" --total
mastr stromerzeugung --filter "Energieträger~eq~'2497'~and~Wind an Land oder auf See~eq~'889'~and~Betriebs-Status~eq~'35'" --sort "Bruttoleistung-desc" --page-size 2000 --iso-dates --compact
```

Das MaStR kann Leistungen nicht serverseitig summieren. Bei 1.776 Treffern holte der Skill alle
auf einer Seite (7,3 MB) und summierte `Bruttoleistung` lokal, gruppiert nach `WindparkName`.

```
Offshore-Wind in Betrieb: 1.776 Einheiten, 11.013.743 kW brutto ≈ 11,0 GW
  Nordsee 9,19 GW · Ostsee 1,83 GW
  Zum Vergleich: 9.458.587 Stromerzeugungseinheiten, 43.517 Windeinheiten, 1.909 offshore
  (weitere 133 Offshore-Einheiten „In Planung")

Größte Windparks (47 insgesamt)
  Borkum Riffgrund 3   83 Einheiten   958,6 MW   Siemens Gamesa   in Betrieb seit 2025-12-03 … 2026-08-17
  EnBW He Dreiht       51 Einheiten   765,0 MW   Vestas V236-15MW 2025-11-25 … 2026-08-21
  Windpark Hohe See    71 Einheiten   521,9 MW   Siemens          2019
  Baltic Eagle         50 Einheiten   476,3 MW   Vestas           2024
  Borkum Riffgrund 2   56 Einheiten   464,8 MW   MHI Vestas       2018
  OWP Veja Mate        67 Einheiten   422,1 MW   Siemens          2017
  … 41 weitere

Neu in 2026 bisher: 98 Einheiten, 1.280,3 MW (EnBW He Dreiht, Borkum Riffgrund 3, NC 1)
Größte Einzelanlagen: 15.000 kW, z. B. SEE920051579655 (HD A1, EnBW He Dreiht)
Quelle: © Bundesnetzagentur – Marktstammdatenregister (DL-DE-BY-2.0)
```

## mastr-unit

> Was steht im MaStR zur Einheit SEE920051579655?

```bash
mastr stromerzeugung --filter "MaStR-Nr. der Einheit~eq~'SEE920051579655'" --iso-dates --compact
```

Ein Aufruf mit `total: 1`. Der Datensatz hat 118 Felder; der Skill las die befüllten. Das Feld
`NetzbetreiberMaStRNummer` kommt als HTML-Link (`<a href="/MaStR/Akteur/…">`), die Nummer stammt
deshalb aus `NetzbetreiberNamen`.

```
HD A1 – Offshore-Windenergieanlage, EnBW He Dreiht (SEE920051579655)
  Status:        In Betrieb (Systemstatus: Aktiviert)
  Leistung:      15.000 kW brutto = 15.000 kW netto (15 MW)
  Anlage:        Vestas Deutschland GmbH V236-15MW, Horizontalläufer,
                 Nabenhöhe 144,6 m, Rotordurchmesser 236 m
  Standort:      Ausschließliche Wirtschaftszone – „Nordsee; Gebiet nach dem
                 Flächenentwicklungsplan des BSH: N-7"; 54.358732 N, 6.197874 E
  Daten:         Inbetriebnahme 2026-02-24, registriert 2026-02-27, zuletzt aktualisiert 2026-09-11
  Betreiber:     EnBW He Dreiht GmbH ＆ Co. KG (ABR912332201010) – Unternehmen, nicht anonymisiert
  Netz:          TenneT TSO GmbH (SNB970033313272), Höchstspannung, Volleinspeisung
  EEG:           EEG961890773712, Zuschlag BK6-17-001-07
  Genehmigung:   SGE959647687634, Bundesamt für Seeschifffahrt und Hydrographie
Quelle: © Bundesnetzagentur – Marktstammdatenregister (DL-DE-BY-2.0)
```

Als Nächstes angeboten: der übrige Windpark (`--filter "Name des Windparks~eq~'EnBW He Dreiht'"` ergibt 64 Einheiten, davon 51 in Betrieb) oder die verknüpfte EEG-Anlage.
