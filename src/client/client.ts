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

import { RequestEngine, describeMastrErrors, type EngineOptions } from "./engine.js";
import { MastrApiError, MastrParseError, MastrValidationError } from "./errors.js";
import { validateFilter } from "./filter.js";
import type { QueryParams } from "./query.js";
import type { FilterColumn, MastrUnit, UnitCategory, UnitPage, UnitQuery } from "./types.js";

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
/** Largest `page` the client (and the CLI's `--page`) accepts. */
export const MAX_PAGE = 1_000_000;
/** Largest `pageSize` the client (and the CLI's `--page-size`) accepts. */
export const MAX_PAGE_SIZE = 5000;

/** The category's endpoint suffix; an unknown category (from plain JS) throws. */
function categorySuffix(category: UnitCategory): string {
  if (typeof category !== "string" || !Object.hasOwn(CATEGORY_SUFFIX, category)) {
    throw new MastrValidationError(
      `Invalid category: expected one of ${Object.keys(CATEGORY_SUFFIX).join(", ")}, got ${JSON.stringify(category)}.`,
    );
  }
  return CATEGORY_SUFFIX[category];
}

/** Check an optional integer paging option against 1..max. */
function checkPaging(name: string, value: unknown, max: number): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new MastrValidationError(
      `Invalid ${name}: expected an integer from 1 to ${max}, got ${typeof value === "string" ? JSON.stringify(value) : String(value)}.`,
    );
  }
}

/** Options for the MaStR client (engine options only — the API needs no auth). */
export type MastrClientOptions = EngineOptions;

/**
 * Parse a MaStR Microsoft-AJAX date string (`"/Date(1548979200000)/"`) into a Date.
 * The offset form `"/Date(1548979200000+0100)/"` is accepted too; its milliseconds
 * are UTC already, the offset only names the sender's zone. Returns null if the
 * string is not in that format or the value is outside the Date range.
 */
export function parseMsDate(value: string): Date | null {
  const m = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  if (!m) return null;
  const date = new Date(Number(m[1]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Recursively rewrite every `"/Date(ms)/"` string in a value to an ISO-8601 string,
 * returning a new value. Used by the CLI's `--iso-dates`.
 */
export function isoifyDates<T>(value: T): T {
  if (typeof value === "string") {
    // parseMsDate returns null for an out-of-range value, so `.toISOString()` never
    // throws; such a string is left as-is.
    const d = parseMsDate(value);
    return (d ? d.toISOString() : value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => isoifyDates(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    // Build with a null prototype so an attacker-controlled response key literally
    // named `__proto__` (or `constructor`/`prototype`) becomes an ordinary own
    // property via assignment, instead of hitting the `Object.prototype.__proto__`
    // setter and silently reparenting this object. JSON.stringify still renders a
    // null-prototype object's own enumerable keys, so downstream output is unchanged.
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(value)) out[k] = isoifyDates(v);
    return out as T;
  }
  return value;
}

/** True for a JSON object (not null, not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shapeError(path: string, expected: string): MastrParseError {
  return new MastrParseError(`Unexpected response shape from ${path}: expected ${expected}.`);
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
   * An unknown category, a `page` outside 1..`MAX_PAGE`, a `pageSize` outside
   * 1..`MAX_PAGE_SIZE` or a filter the register would misread (e.g. `~or~`, see
   * {@link validateFilter}) is rejected with a `MastrValidationError` before any request.
   */
  async units(category: UnitCategory, query: UnitQuery = {}): Promise<UnitPage> {
    const suffix = categorySuffix(category);
    checkPaging("page", query.page, MAX_PAGE);
    checkPaging("pageSize", query.pageSize, MAX_PAGE_SIZE);
    if (query.filter !== undefined) validateFilter(query.filter);
    const params: QueryParams = {
      sort: query.sort ?? "",
      page: query.page ?? DEFAULT_PAGE,
      pageSize: query.pageSize ?? DEFAULT_PAGE_SIZE,
      group: "",
      filter: query.filter ?? "",
    };
    const path = `${SERVICE}/GetErweiterteOeffentlicheEinheit${suffix}`;
    const res = await this.engine.getJson<unknown>(path, params);
    if (!isObject(res)) throw shapeError(path, "a JSON object with Data and Total");
    // MaStR answers HTTP 200 with a logical error in `Errors`: a string such as "Die
    // Anfrage ist Null.", or a Kendo ModelState object. Anything but null is an error
    // (a broken reply must not read as "no matches"). The text is server-controlled
    // and reaches stderr, so describeMastrErrors sanitises it.
    if (res["Errors"] !== undefined && res["Errors"] !== null) {
      throw new MastrApiError({
        url: this.engine.buildUrl(path, params),
        method: "GET",
        body: JSON.stringify(res),
        detail: describeMastrErrors(res["Errors"]),
      });
    }
    const total = res["Total"];
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
      throw shapeError(path, "a numeric Total");
    }
    const data = res["Data"];
    // A reply with no matches may carry `Data: null`; with a positive Total it must be an array.
    if (data === null && total === 0) return { total, data: [] };
    if (!Array.isArray(data)) throw shapeError(path, "a Data array");
    return { total, data: data as MastrUnit[] };
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

  /**
   * The filterable columns (names, types, dropdown codes) for a category. An `Errors`
   * envelope throws `MastrApiError`, any other non-array reply `MastrParseError` —
   * never an empty list, which would read as "this category has no filters".
   */
  async filterColumns(category: UnitCategory): Promise<FilterColumn[]> {
    const path = `${SERVICE}/GetFilterColumnsErweiterteOeffentlicheEinheit${categorySuffix(category)}`;
    const res = await this.engine.getJson<unknown>(path);
    if (isObject(res) && res["Errors"] !== undefined && res["Errors"] !== null) {
      throw new MastrApiError({
        url: this.engine.buildUrl(path),
        method: "GET",
        body: JSON.stringify(res),
        detail: describeMastrErrors(res["Errors"]),
      });
    }
    if (!Array.isArray(res) || !res.every(isObject)) {
      throw shapeError(path, "a JSON array of filter columns");
    }
    return res as FilterColumn[];
  }
}
