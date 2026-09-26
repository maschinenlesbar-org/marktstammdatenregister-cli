# Glossar

Fachbegriffe des MaStR, so wie die CLI sie ausgibt. Die Feldbezeichnungen in den Daten sind
deutsch; übernehmen Sie sie unverändert.

| Begriff | In der CLI | Was es ist |
|---|---|---|
| **MaStR** | – | Marktstammdatenregister, das Register der Bundesnetzagentur für den deutschen Strom- und Gasmarkt: Stammdaten zu rund 9 Mio. Erzeugungs- und Verbrauchseinheiten sowie Marktakteuren. |
| **Einheit** | eine Zeile | Eine einzelne registrierte Einheit – eine PV-Anlage, eine Windenergieanlage, ein Speicher, ein KWK-Block, ein Verbraucher usw. Identifiziert über ihre `MaStRNummer` (z. B. `SEE984033548619`). |
| **Stromerzeugung / Stromverbrauch** | `stromerzeugung` / `stromverbrauch` | Einheiten zur Stromerzeugung bzw. zum Stromverbrauch. |
| **Gaserzeugung / Gasverbrauch** | `gaserzeugung` / `gasverbrauch` | Einheiten zur Gaserzeugung bzw. zum Gasverbrauch. |
| **Energieträger** | `EnergietraegerName` / Filter | Solare Strahlungsenergie, Wind, Biomasse, … Gefiltert wird über einen numerischen Code (z. B. `2495` = Solar). |
| **Bruttoleistung / Nettonennleistung** | Felder | Brutto- bzw. Nettonennleistung, in **kW**. |
| **Betriebs-Status** | `BetriebsStatusName` / Filter | Betriebsstatus – `In Betrieb`, `In Planung`, `Endgültig stillgelegt`, … (gefiltert über einen Code, z. B. `35` = In Betrieb). |
| **Anlagenbetreiber / Netzbetreiber** | `AnlagenbetreiberName` / `NetzbetreiberNamen` | Betreiber der Anlage bzw. des Netzes. Betreibernamen sind oft **anonymisiert** (`natürliche Person (ABR…)`). |
| **Total** | `total` | Die Gesamtzahl der Einheiten, die zur Abfrage passen, über alle Seiten (berücksichtigt den Filter). Wird ohne Zusatzaufwand mitgeliefert – nutzen Sie `--total`. |
| **Filter / Sortierung** | `--filter` / `--sort` | Auswahl im Stil eines Kendo-Grids. Filter: `FilterName~op~'value'~and~…`, mit den `FilterName`s aus `mastr filters` und den Operatoren `eq`, `neq`, `sw`, `ct`, `nct`, `ew`, `null`, `nn`, `gt`, `lt` (ein unbekannter Operator liefert 0 Zeilen). Ein funktionierendes `~or~` gibt es nicht (das Register verwirft alles danach, daher lehnt die CLI es ab); mehrere Codes einer Auswahlliste stehen als Kommaliste in einem Wert, `Energieträger~eq~'2497,2498'`. Sortierung: `FieldKey-asc` oder `FieldKey-desc`, wobei `FieldKey` ein Feldname des Datensatzes wie `Bruttoleistung` ist, kein `FilterName`. |
| **`/Date(ms)/`** | `--iso-dates` / `parseMsDate` | Ein Microsoft-AJAX-Datum (Millisekunden seit der Unix-Epoche, UTC). `--iso-dates` wandelt es in ISO-8601 um. |

## Einen Datensatz lesen

- **Leistungen sind in kW angegeben**; für MW durch 1.000 teilen. Brutto (`Bruttoleistung`) ≠ netto
  (`Nettonennleistung`) – geben Sie an, welche gemeint ist.
- **Datumsangaben haben die Form `/Date(ms)/`** – wandeln Sie sie mit `--iso-dates` um, bevor Sie
  sie Menschen zeigen.
- **Koordinaten (`Breitengrad`/`Laengengrad`) können null sein**, und bei kleinen Einheiten
  (< 30 kW) werden manche Standortdaten zurückgehalten – gesetzlich so vorgesehen, kein Fehler.
- **Zeilen sind breit und unterscheiden sich je nach Kategorie** – lesen Sie nur Felder, die
  vorhanden sind.
