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

import { RequestEngine, describeMastrErrors, optionsObject, type EngineOptions } from "./engine.js";
import { MastrApiError, MastrParseError, MastrValidationError } from "./errors.js";
import { normalizeFilter, resolveFilter, validateFilter } from "./filter.js";
import { COUNT_IGNORED_KEYS, assertValid, countQueryProblem, sortProblem } from "./validate.js";
import type { QueryParams } from "./query.js";
import type { CountQuery, FilterColumn, MastrUnit, UnitCategory, UnitPage, UnitQuery } from "./types.js";

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

/** A query as given (null counts as none), or a MastrValidationError for a non-object. */
function queryObject<T extends object>(query: T | null | undefined): T {
  if (query === undefined || query === null) return {} as T;
  if (typeof query !== "object" || Array.isArray(query)) {
    throw new MastrValidationError(
      `Invalid query: expected an object, got ${Array.isArray(query) ? "an array" : `a ${typeof query}`}.`,
    );
  }
  return query;
}

/** Options for the MaStR client: the engine options (the API needs no auth) plus one of its own. */
export interface MastrClientOptions extends EngineOptions {
  /**
   * Send filters without checking their FilterNames and dropdown codes against the
   * category's columns, and so without the one `filterColumns()` request per category that
   * check costs. Default `false`: a name the category doesn't have, or a code its dropdown
   * doesn't list, is a `MastrValidationError`, because the register ignores an unknown name
   * (the unfiltered set) and answers an unknown code with 0 rows. The shape check and the
   * name normalisation apply either way.
   */
  allowUnknownFilters?: boolean;
}

/** The UnitQuery keys; any other key is refused (a misspelled `filtr` was ignored: the unfiltered set). */
const UNIT_QUERY_KEYS = ["page", "pageSize", "sort", "filter"] as const;
/** The CountQuery keys (`page`/`pageSize` get their own message, see countQueryProblem). */
const COUNT_QUERY_KEYS = ["sort", "filter", ...COUNT_IGNORED_KEYS] as const;

/**
 * Throw for a query key that isn't one of `allowed`. A JavaScript caller's typo (`filtr`,
 * `Filter`) or a key from parsed JSON (`__proto__`) was ignored silently, and the call
 * answered with the whole unfiltered register.
 */
function assertQueryKeys(query: object, allowed: readonly string[]): void {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || allowed.includes(key)) continue;
    const lower = key.toLowerCase();
    const hint = allowed.find((name) => name.toLowerCase() === lower || editHint(lower, name.toLowerCase()));
    throw new MastrValidationError(
      `Invalid query: unknown key ${JSON.stringify(key)}` +
        (hint === undefined ? `; the keys are ${allowed.join(", ")}.` : ` (did you mean ${hint}?).`),
    );
  }
}

/** True when `a` and `b` differ by one inserted, dropped or changed character. */
function editHint(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i) || a.slice(i) === b.slice(i + 1);
}

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
  readonly #allowUnknownFilters: boolean;
  /** Each category's filter columns, fetched once per client for the filter check. */
  readonly #columns = new Map<UnitCategory, Promise<FilterColumn[]>>();

  constructor(options: MastrClientOptions = {}) {
    const { allowUnknownFilters, ...engineOptions } = optionsObject(options);
    if (allowUnknownFilters !== undefined && typeof allowUnknownFilters !== "boolean") {
      throw new MastrValidationError(`Invalid allowUnknownFilters: expected a boolean, got ${typeof allowUnknownFilters}.`);
    }
    this.engine = new RequestEngine(engineOptions);
    this.#allowUnknownFilters = allowUnknownFilters === true;
  }

  /** The category's filter columns, fetched on first use and kept; a failed fetch is not kept. */
  private columnsOf(category: UnitCategory): Promise<FilterColumn[]> {
    let columns = this.#columns.get(category);
    if (columns === undefined) {
      columns = this.filterColumns(category);
      this.#columns.set(category, columns);
      columns.catch(() => this.#columns.delete(category));
    }
    return columns;
  }

  /**
   * The filter as it is sent: FilterNames normalised (`normalizeFilter`), the shape checked
   * (`filterProblem`), then — unless `allowUnknownFilters` — the names and dropdown codes
   * checked against the category's columns (`resolveFilter`, one cached `filterColumns()`
   * request), all before the unit request.
   */
  private async checkedFilter(category: UnitCategory, spec: string): Promise<string> {
    const filter = normalizeFilter(spec);
    validateFilter(filter);
    if (this.#allowUnknownFilters) return filter;
    return resolveFilter(filter, await this.columnsOf(category), category);
  }

  /**
   * Fetch one page of units for a category. Sends the full Kendo param set —
   * `sort`, `page`, `pageSize`, `group`, `filter` — always, because the server
   * rejects a request with `group`/`filter` missing ("Die Anfrage ist Null.").
   * An unknown category, a `page` outside 1..`MAX_PAGE`, a `pageSize` outside
   * 1..`MAX_PAGE_SIZE`, a blank `sort` ({@link sortProblem}) or a filter the register
   * would misread (e.g. `~or~`, see {@link validateFilter}) is rejected with a
   * `MastrValidationError` before any request.
   */
  async units(category: UnitCategory, query: UnitQuery = {}): Promise<UnitPage> {
    const suffix = categorySuffix(category);
    query = queryObject(query);
    assertQueryKeys(query, UNIT_QUERY_KEYS);
    checkPaging("page", query.page, MAX_PAGE);
    checkPaging("pageSize", query.pageSize, MAX_PAGE_SIZE);
    if (query.sort !== undefined) assertValid("sort", query.sort, sortProblem);
    // The register ignores a FilterName it doesn't match exactly and answers with the
    // unfiltered set, so the filter is normalised and checked first (checkedFilter).
    const filter = query.filter === undefined ? undefined : await this.checkedFilter(category, query.filter);
    const params: QueryParams = {
      sort: query.sort ?? "",
      page: query.page ?? DEFAULT_PAGE,
      pageSize: query.pageSize ?? DEFAULT_PAGE_SIZE,
      group: "",
      filter: filter ?? "",
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
        body: this.engine.scrub(JSON.stringify(res)),
        detail: describeMastrErrors(res["Errors"], (text) => this.engine.scrub(text)),
      });
    }
    if (res["Error"] === true) throw this.registerRejected(path, params, res);
    const total = res["Total"];
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
      throw shapeError(path, "a numeric Total");
    }
    const data = res["Data"];
    // A reply with no matches may carry `Data: null`; with a positive Total it must be an array.
    if (data === null && total === 0) return { total, data: [] };
    if (!Array.isArray(data)) throw shapeError(path, "a Data array");
    // A page can't hold more rows than match, nor more than were asked for: such a reply
    // would print rows next to `"total": 0` (and the CLI's "0 results" note), or a page
    // larger than --page-size.
    if (data.length > total) {
      throw shapeError(path, `a Total of at least the ${data.length} rows on the page, got ${total}`);
    }
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    if (data.length > pageSize) {
      throw shapeError(path, `at most ${pageSize} rows (the pageSize), got ${data.length}`);
    }
    return { total, data: data as MastrUnit[] };
  }

  /**
   * The register's second error envelope, `{"Error":true,"Message":…,"Type":"danger"}`
   * (HTTP 200), as a MastrApiError: its answer to a filter value it can't read. It used to
   * surface as "Unexpected response shape … expected a numeric Total", which reads like a
   * broken server or client and doesn't say what to fix.
   */
  private registerRejected(path: string, query: QueryParams | undefined, res: Record<string, unknown>): MastrApiError {
    const message = typeof res["Message"] === "string" ? describeMastrErrors(res["Message"], (t) => this.engine.scrub(t)) : undefined;
    return new MastrApiError({
      url: this.engine.buildUrl(path, query),
      method: "GET",
      body: this.engine.scrub(JSON.stringify(res)),
      detail:
        `the register rejected the request${message === undefined ? "" : ` (${message})`}. It answers so ` +
        "to a filter value it can't read: a dropdown label instead of its code (the Value from " +
        "`mastr filters` / filterColumns()), a decimal comma ('4999,999'; use a point), an exponent " +
        "or text in a number column, an invalid date, a boolean other than '1'/'0', or null/nn on a " +
        "column that isn't text",
    });
  }

  /**
   * The number of units in a category that match `filter` (all units without one).
   * Fetches a single row (`page=1`, `pageSize=1`) and returns the envelope's
   * `Total`, which counts every match regardless of the page. `sort` is forwarded:
   * an unknown sort key makes the register answer 0. Paging options are refused
   * (`countQueryProblem`), as are the inputs `units()` refuses, all with a
   * `MastrValidationError` before any request.
   */
  async count(category: UnitCategory, query: CountQuery = {}): Promise<number> {
    query = queryObject(query);
    assertQueryKeys(query, COUNT_QUERY_KEYS);
    assertValid("count query", query as UnitQuery, countQueryProblem);
    const q: UnitQuery = { page: 1, pageSize: 1 };
    if (query.sort !== undefined) q.sort = query.sort;
    if (query.filter !== undefined) q.filter = query.filter;
    return (await this.units(category, q)).total;
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
    if (isObject(res) && res["Error"] === true) throw this.registerRejected(path, undefined, res);
    if (isObject(res) && res["Errors"] !== undefined && res["Errors"] !== null) {
      throw new MastrApiError({
        url: this.engine.buildUrl(path),
        method: "GET",
        body: this.engine.scrub(JSON.stringify(res)),
        detail: describeMastrErrors(res["Errors"], (text) => this.engine.scrub(text)),
      });
    }
    if (!Array.isArray(res) || !res.every(isObject)) {
      throw shapeError(path, "a JSON array of filter columns");
    }
    return res as FilterColumn[];
  }
}
