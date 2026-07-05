// MastrClient — a typed client over the Marktstammdatenregister (MaStR) public
// unit-search API (www.marktstammdatenregister.de/MaStR): the Bundesnetzagentur's
// register of the German electricity & gas market (~9M generation/consumption units).
//
// No auth. Each category is a Kendo UI Grid endpoint; the client ALWAYS sends the
// full param set (sort/page/pageSize/group/filter) because omitting group/filter
// makes the server answer `{"Errors":"Die Anfrage ist Null."}`.
//
//   const c = new MastrClient();
//   const page = await c.stromerzeugung({ pageSize: 10, filter: "Energieträger~eq~'2495'" });
//   page.total; // total solar units

import { RequestEngine, type EngineOptions } from "./engine.js";
import { MastrApiError } from "./errors.js";
import type { QueryParams } from "./query.js";
import type { FilterColumn, MastrUnit, UnitCategory, UnitPage, UnitQuery, UnitResponse } from "./types.js";

const SERVICE = "/Einheit/EinheitJson";

/** Map a category to the PascalCase suffix used in the endpoint names. */
const CATEGORY_SUFFIX: Record<UnitCategory, string> = {
  stromerzeugung: "Stromerzeugung",
  stromverbrauch: "Stromverbrauch",
  gaserzeugung: "Gaserzeugung",
  gasverbrauch: "Gasverbrauch",
};

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;

/** Options for the MaStR client (engine options only — the API needs no auth). */
export type MastrClientOptions = EngineOptions;

/**
 * Parse a MaStR Microsoft-AJAX date string (`"/Date(1548979200000)/"`) into a Date.
 * Returns null if the string is not in that format.
 */
export function parseMsDate(value: string): Date | null {
  const m = /^\/Date\((-?\d+)\)\/$/.exec(value);
  if (!m) return null;
  return new Date(Number(m[1]));
}

/**
 * Recursively rewrite every `"/Date(ms)/"` string in a value to an ISO-8601 string,
 * returning a new value. Used by the CLI's `--iso-dates`.
 */
export function isoifyDates<T>(value: T): T {
  if (typeof value === "string") {
    const d = parseMsDate(value);
    return (d ? d.toISOString() : value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => isoifyDates(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = isoifyDates(v);
    return out as T;
  }
  return value;
}

export class MastrClient {
  private readonly engine: RequestEngine;

  constructor(options: MastrClientOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /**
   * Fetch one page of units for a category. Sends the full Kendo param set —
   * `sort`, `page`, `pageSize`, `group`, `filter` — always, because the server
   * rejects a request with `group`/`filter` missing ("Die Anfrage ist Null.").
   */
  async units(category: UnitCategory, query: UnitQuery = {}): Promise<UnitPage> {
    const params: QueryParams = {
      sort: query.sort ?? "",
      page: query.page ?? DEFAULT_PAGE,
      pageSize: query.pageSize ?? DEFAULT_PAGE_SIZE,
      group: "",
      filter: query.filter ?? "",
    };
    const path = `${SERVICE}/GetErweiterteOeffentlicheEinheit${CATEGORY_SUFFIX[category]}`;
    const res = await this.engine.getJson<UnitResponse | null>(path, params);
    if (res && typeof res.Errors === "string" && res.Errors.length > 0) {
      throw new MastrApiError({
        url: this.engine.buildUrl(path, params),
        method: "GET",
        body: JSON.stringify(res),
        detail: res.Errors,
      });
    }
    return { total: res?.Total ?? 0, data: (res?.Data ?? []) as MastrUnit[] };
  }

  /** Electricity-generation units (`Stromerzeugung`). */
  stromerzeugung(query?: UnitQuery): Promise<UnitPage> {
    return this.units("stromerzeugung", query);
  }
  /** Electricity-consumption units (`Stromverbrauch`). */
  stromverbrauch(query?: UnitQuery): Promise<UnitPage> {
    return this.units("stromverbrauch", query);
  }
  /** Gas-generation units (`Gaserzeugung`). */
  gaserzeugung(query?: UnitQuery): Promise<UnitPage> {
    return this.units("gaserzeugung", query);
  }
  /** Gas-consumption units (`Gasverbrauch`). */
  gasverbrauch(query?: UnitQuery): Promise<UnitPage> {
    return this.units("gasverbrauch", query);
  }

  /** The filterable columns (names, types, dropdown codes) for a category. */
  async filterColumns(category: UnitCategory): Promise<FilterColumn[]> {
    const path = `${SERVICE}/GetFilterColumnsErweiterteOeffentlicheEinheit${CATEGORY_SUFFIX[category]}`;
    const res = await this.engine.getJson<FilterColumn[] | null>(path);
    return Array.isArray(res) ? res : [];
  }
}
