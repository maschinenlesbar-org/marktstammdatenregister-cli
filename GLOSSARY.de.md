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
| **Bruttoleistung / Nettonennleistung** | Felder | Brutto- bzw. Nettonennleistung, in **kW**. Nur Zeilen aus `stromerzeugung` haben sie. |
| **Gasleistungen** | Felder | `gaserzeugung`: `Erzeugungsleistung` (Gaserzeugung), bei Gasspeichern `MaxEinspeicherleistung` / `MaxAusspeicherleistung` (Ein- bzw. Ausspeicherleistung, **kWh/h**) und `MaxArbeitsvolumen` (Arbeitsgasvolumen, **kWh**). `gasverbrauch`: `MaximaleGasbezugsLeistung` (maximale Gasbezugsleistung). Für `Erzeugungsleistung` und `MaximaleGasbezugsLeistung` nennen die Zeilen keine Einheit. Zeilen aus `stromverbrauch` haben kein Leistungsfeld. |
| **Betriebs-Status** | `BetriebsStatusName` / Filter | Betriebsstatus – `In Betrieb`, `In Planung`, `Endgültig stillgelegt`, … (gefiltert über einen Code, z. B. `35` = In Betrieb). |
| **Anlagenbetreiber / Netzbetreiber** | `AnlagenbetreiberName` / `NetzbetreiberNamen` | Betreiber der Anlage bzw. des Netzes. Betreibernamen sind oft **anonymisiert** (`natürliche Person (ABR…)`). |
| **Total** | `total` | Die Gesamtzahl der Einheiten, die zur Abfrage passen, über alle Seiten (berücksichtigt den Filter). Wird ohne Zusatzaufwand mitgeliefert – nutzen Sie `--total` (Bibliothek: `count()`, eine Abfrage mit einer Zeile). |
| **Filter / Sortierung** | `--filter` / `--sort` | Auswahl im Stil eines Kendo-Grids. Filter: `FilterName~op~'value'~and~…`, mit den `FilterName`s aus `mastr filters` und den Operatoren `eq`, `neq`, `sw`, `ct`, `nct`, `ew`, `null`, `nn`, `gt`, `lt` (`null`/`nn` erhalten `''` und funktionieren nur bei Textspalten; `gt`/`lt` sind strikt und für Zahlen- und Datumsspalten gedacht, das Register wendet sie aber auch auf Text- und Auswahlspalten an und vergleicht dann den Text bzw. den Code; ein Wert darf kein `~` enthalten; eine fehlerhafte Angabe, ein unbekannter Operator, ein `FilterName`, den die Kategorie nicht hat, oder ein Code, den ihre Auswahlliste nicht kennt, wird vor dem Senden abgelehnt, weil das Register sonst eine falsche Anzahl liefert; FilterNames werden in Unicode-NFC, ohne umgebende Leerzeichen und unabhängig von Groß- und Kleinschreibung erkannt; mehrere `--filter` werden mit `~and~` verknüpft). Ein funktionierendes `~or~` gibt es nicht (das Register verwirft alles danach, daher lehnt die CLI es ab); mehrere Codes einer Auswahlliste stehen als Kommaliste in einem Wert, `Energieträger~eq~'2497,2498'`. Sortierung: `FieldKey-asc` oder `FieldKey-desc`, wobei `FieldKey` ein Feldname des Datensatzes wie `Bruttoleistung` ist, kein `FilterName`; eine leere Sortierung wird vor dem Senden abgelehnt (in CLI und Bibliothek gleichermaßen). |
| **`/Date(ms)/`** | `--iso-dates` / `parseMsDate` / `formatMastrDate` | Ein Microsoft-AJAX-Datum (Millisekunden seit der Unix-Epoche, UTC). `--iso-dates` wandelt es in ISO-8601 um: ein reines Datum (UTC-Mitternacht, z. B. `InbetriebnahmeDatum`) als `YYYY-MM-DD`, einen Zeitpunkt (`DatumLetzteAktualisierung`) in deutscher Zeit mit ausdrücklichem Offset, `2020-02-20T17:28:35.250+01:00`. |
| **Log-Eintrag** (log record) | stderr / `--log-format` | Jede Diagnosezeile, die die CLI nach stderr schreibt: ein Zeitstempel, eine Stufe (`ERROR`, `WARN`, `INFO`) und ein Thema `mastr.<Bereich>`, als Text (im Stil von log4j) oder mit `--log-format jsonl` als ein JSON-Objekt pro Zeile. Die Bereiche: `cli` (Bedienfehler, Meldungen von commander, unerwartete Fehler), `api` (die Antworten des Registers: ein Fehlerstatus, die Hülle `{"Error":true}` und eine fehlerhafte Antwort – ungültiges JSON, die falsche Form, ein leerer Body – sowie die Hinweise bei einer leeren Antwort), `http` (die Verbindung, der Hinweis zur Größengrenze, die Klartext-Warnung) und `output` (ein Schreibfehler auf stdout). Ein Eintrag ist immer eine Zeile; Steuerzeichen darin werden maskiert. |

## Einen Datensatz lesen

- **Elektrische Leistungen sind in kW angegeben**; für MW durch 1.000 teilen. Brutto
  (`Bruttoleistung`) ≠ netto (`Nettonennleistung`) – geben Sie an, welche gemeint ist. Beide gibt
  es nur in `stromerzeugung`; die Gaskategorien haben eigene Leistungsfelder (siehe
  *Gasleistungen*), die nicht in kW angegeben sind.
- **Datumsangaben haben die Form `/Date(ms)/`** – wandeln Sie sie mit `--iso-dates` um, bevor Sie
  sie Menschen zeigen.
- **Koordinaten (`Breitengrad`/`Laengengrad`) können null sein**, und bei kleinen Einheiten
  (< 30 kW) werden manche Standortdaten zurückgehalten – gesetzlich so vorgesehen, kein Fehler.
- **Zeilen sind breit und unterscheiden sich je nach Kategorie** – lesen Sie nur Felder, die
  vorhanden sind.
