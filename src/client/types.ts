// Domain types for the Marktstammdatenregister (MaStR) public unit-search API
// (www.marktstammdatenregister.de/MaStR).

/**
 * A Microsoft-AJAX date string as MaStR returns them, e.g. `"/Date(1548979200000)/"`
 * (milliseconds since the Unix epoch, UTC). Use `parseMsDate()` to convert, or the
 * CLI's `--iso-dates` flag to rewrite every such field to ISO-8601.
 */
export type MastrDate = string;

/** The four datasets the public search exposes. */
export type UnitCategory = "stromerzeugung" | "stromverbrauch" | "gaserzeugung" | "gasverbrauch";

/**
 * A unit ("Einheit") record. The API returns a very wide row (~90 fields) whose
 * columns vary by category (a solar unit carries module fields a gas consumer does
 * not), so only broadly useful fields are typed — each says where it occurs when not
 * in every category; the index signature carries the rest. Natural-person and confidential data
 * are withheld upstream, so operator names may be anonymised (e.g.
 * `"natürliche Person (ABR…)"`).
 */
export interface MastrUnit {
  Id?: number;
  /** The unit's MaStR number, e.g. `"SEE984033548619"`. */
  MaStRNummer?: string;
  /** Display name of the unit. */
  EinheitName?: string;
  /** Operating status name, e.g. `"In Betrieb"`. */
  BetriebsStatusName?: string;
  BetriebsStatusId?: number;
  /** Energy carrier name, e.g. `"Solare Strahlungsenergie"` (`stromerzeugung`). */
  EnergietraegerName?: string;
  EnergietraegerId?: number;
  /** Gross capacity in kW. Only in `stromerzeugung` rows. */
  Bruttoleistung?: number;
  /** Net rated capacity in kW. Only in `stromerzeugung` rows. */
  Nettonennleistung?: number;
  /** Gas generation capacity (`gaserzeugung`; the rows state no unit). */
  Erzeugungsleistung?: number | null;
  /** Gas storage injection capacity in kWh/h (`gaserzeugung`). */
  MaxEinspeicherleistung?: number | null;
  /** Gas storage withdrawal capacity in kWh/h (`gaserzeugung`). */
  MaxAusspeicherleistung?: number | null;
  /** Gas storage working gas volume in kWh (`gaserzeugung`). */
  MaxArbeitsvolumen?: number | null;
  /** Maximum gas intake (`gasverbrauch`; the rows state no unit). */
  MaximaleGasbezugsLeistung?: number | null;
  Bundesland?: string;
  Landkreis?: string;
  Gemeinde?: string;
  Ort?: string;
  Plz?: string;
  /** Latitude (may be withheld for small units). */
  Breitengrad?: number | null;
  /** Longitude (may be withheld for small units). */
  Laengengrad?: number | null;
  /** Commissioning date. */
  InbetriebnahmeDatum?: MastrDate | null;
  /** Registration date in MaStR. */
  EinheitRegistrierungsdatum?: MastrDate;
  /** Final decommissioning date, if any. */
  EndgueltigeStilllegungDatum?: MastrDate | null;
  /** Operator name (often anonymised). */
  AnlagenbetreiberName?: string;
  AnlagenbetreiberMaStRNummer?: string;
  /** Grid operator name(s). */
  NetzbetreiberNamen?: string;
  /** Everything else the row carries (category-specific columns, IDs, ...). */
  [key: string]: unknown;
}

/** The raw response envelope of a data endpoint (Kendo UI Grid shape). */
export interface UnitResponse {
  Data: MastrUnit[] | null;
  /** Total number of matching units (across all pages). */
  Total: number;
  AggregateResults?: unknown;
  /** A logical error message (e.g. `"Die Anfrage ist Null."`); null on success. */
  Errors?: string | null;
}

/** A page of units plus the total match count — what the client returns. */
export interface UnitPage {
  /** Total matching units across all pages (respects the filter). */
  total: number;
  /** The units on this page. */
  data: MastrUnit[];
}

/** Query parameters for a unit search. `group` is always sent empty by the client. */
export interface UnitQuery {
  /** 1-based page number (default 1). */
  page?: number;
  /** Rows per page. */
  pageSize?: number;
  /** Sort spec: `FieldKey-asc` or `FieldKey-desc`, e.g. `"Bruttoleistung-desc"`. */
  sort?: string;
  /**
   * Filter spec: `FilterName~op~'value'~and~…` with ops
   * `eq|neq|sw|ct|nct|ew|null|nn|gt|lt`, e.g. `"Energieträger~eq~'2495'"`. There is
   * no working `~or~` (the register drops everything after it, so the client rejects
   * it); for several codes of one dropdown column list them in one value:
   * `"Energieträger~eq~'2497,2498'"`. Discover the `FilterName`s and dropdown codes
   * via {@link MastrClient.filterColumns}.
   */
  filter?: string;
}

/** A filterable column, from a `GetFilterColumns…` endpoint. */
export interface FilterColumn {
  /** Human-readable filter name (used as the field in a filter spec). */
  FilterName?: string;
  /** Filter type. */
  Type?: "text" | "number" | "multidropdown" | "date" | "boolean" | string;
  /** For dropdown filters: the allowed `{ Name, Value }` options (Value is the code to send). */
  ListObject?: { Name?: string; Value?: string }[];
  CustomSelectString?: string | null;
  FilterField?: string | null;
  Position?: number | null;
  OptionalFilterEntity?: unknown;
}
