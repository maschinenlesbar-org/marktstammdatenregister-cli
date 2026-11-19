// A mock of the register for the use-case tests (the client's operations and the MCP server): it
// answers the filter-columns endpoints with the live columns (live-register.ts) and the unit
// endpoints with the given rows, filtered, sorted and paged the way the register does it — the
// filter grammar split on "~", dropdowns by code (a comma list is any of them), gt/lt strict,
// dates by day, eq on text the whole text, sw/ct a part — so a use case that sends the wrong
// condition gets the wrong rows, as it would live.

import type { HttpRequest, HttpResponse } from "../src/http.js";
import type { MastrUnit, UnitCategory } from "../src/types.js";
import { jsonResponse } from "./helpers.js";
import { LIVE_COLUMNS, LIVE_ROWS } from "./live-register.js";

export { LIVE_COLUMNS, LIVE_ROWS };

const SUFFIX: Record<string, UnitCategory> = {
  Stromerzeugung: "stromerzeugung",
  Stromverbrauch: "stromverbrauch",
  Gaserzeugung: "gaserzeugung",
  Gasverbrauch: "gasverbrauch",
};

/** FilterName -> the row field it reads, for the columns the tests filter on. */
const FIELD: Record<string, string> = {
  "Betriebs-Status": "BetriebsStatusId",
  Bundesland: "BundeslandId",
  "Energieträger": "EnergietraegerId",
  "Inbetriebnahmedatum der Einheit": "InbetriebnahmeDatum",
  "Registrierungsdatum der Einheit": "EinheitRegistrierungsdatum",
  Ort: "Ort",
  Postleitzahl: "Plz",
  Landkreis: "Landkreis",
  Gemeinde: "Gemeinde",
  "Name des Anlagenbetreibers (nur Org.)": "AnlagenbetreiberName",
  "MaStR-Nr. des Anlagenbetreibers": "AnlagenbetreiberMaStRNummer",
  "Anzeige-Name der Einheit": "EinheitName",
  "MaStR-Nr. der Einheit": "MaStRNummer",
  "MaStR-Nr. der Speichereinheit": "SpeicherEinheitMastrNummer",
  "MaStR-Nr. der EEG-Anlage": "EegAnlageMastrNummer",
  "MaStR-Nr. der KWK-Anlage": "KwkAnlageMastrNummer",
  "Bruttoleistung der Einheit": "Bruttoleistung",
  "Nettonennleistung der Einheit": "Nettonennleistung",
  Gaserzeugungsleistung: "Erzeugungsleistung",
  "Maximale Gasbezugsleistung": "MaximaleGasbezugsLeistung",
  "Wind an Land oder auf See": "WindAnLandOderSeeId",
};

/** A register date (`/Date(ms)/`) as YYYY-MM-DD. */
const day = (value: unknown): string | undefined => {
  const ms = typeof value === "string" ? /\/Date\((-?\d+)\)\//.exec(value)?.[1] : undefined;
  return ms === undefined ? undefined : new Date(Number(ms)).toISOString().slice(0, 10);
};

/** `/Date(ms)/` of a day. */
export const msDate = (isoDay: string): string => `/Date(${Date.parse(`${isoDay}T00:00:00Z`)})/`;

/** True when `row` meets one condition (the register's reading of it). */
function meets(row: MastrUnit, name: string, op: string, raw: string): boolean {
  const field = FIELD[name];
  if (field === undefined) throw new Error(`mock register: no field for FilterName ${name}`);
  const value = raw.replace(/^'|'$/g, "");
  const cell = row[field];
  if (name.startsWith("Inbetriebnahmedatum") || name.startsWith("Registrierungsdatum")) {
    const d = day(cell);
    if (d === undefined) return op === "null";
    return op === "gt" ? d > value : op === "lt" ? d < value : op === "eq" ? d === value : d !== value;
  }
  if (typeof cell === "number" && !field.endsWith("Id")) {
    const n = Number(value);
    return op === "gt" ? cell > n : op === "lt" ? cell < n : op === "eq" ? cell === n : cell !== n;
  }
  if (field.endsWith("Id")) {
    const codes = value.split(",").map((c) => c.trim());
    const hit = codes.includes(String(cell));
    return op === "neq" ? !hit : hit;
  }
  const text = typeof cell === "string" ? cell : "";
  switch (op) {
    case "eq":
      return text === value;
    case "neq":
      return text !== value;
    case "sw":
      return text.startsWith(value);
    case "ct":
      return text.includes(value);
    case "null":
      return text === "";
    case "nn":
      return text !== "";
    default:
      throw new Error(`mock register: operator ${op} on ${name}`);
  }
}

/** The rows `filter` keeps. */
function filtered(rows: readonly MastrUnit[], filter: string): MastrUnit[] {
  if (filter === "") return [...rows];
  const parts = filter.split("~");
  return rows.filter((row) => {
    for (let i = 0; i < parts.length; i += 4) if (!meets(row, parts[i]!, parts[i + 1]!, parts[i + 2]!)) return false;
    return true;
  });
}

/** What the mock answered: every request, for the tests that count them. */
export interface RegisterLog {
  requests: HttpRequest[];
  unitRequests(): URLSearchParams[];
}

/**
 * A responder like the register for `rows` (each with its category in `_category`, see
 * {@link unit}); `log` records the requests.
 */
export function registerOf(rows: readonly (MastrUnit & { _category?: UnitCategory })[], log?: RegisterLog): (req: HttpRequest) => HttpResponse {
  return (req) => {
    log?.requests.push(req);
    const url = new URL(req.url);
    const columns = /GetFilterColumnsErweiterteOeffentlicheEinheit(\w+)$/.exec(url.pathname);
    if (columns !== null) return jsonResponse(LIVE_COLUMNS[SUFFIX[columns[1]!]!]);
    const units = /GetErweiterteOeffentlicheEinheit(\w+)$/.exec(url.pathname);
    if (units === null) return jsonResponse({ Errors: "unknown path" }, 404);
    const category = SUFFIX[units[1]!]!;
    const params = url.searchParams;
    let hits = filtered(rows.filter((r) => (r._category ?? "stromerzeugung") === category), params.get("filter") ?? "");
    const sort = /^(\w+)-(asc|desc)$/.exec(params.get("sort") ?? "");
    if (sort !== null) {
      const key = sort[1]!;
      const sign = sort[2] === "asc" ? 1 : -1;
      const of = (r: MastrUnit): number | string => {
        const v = r[key];
        return typeof v === "number" ? v : (day(v) ?? String(v ?? ""));
      };
      hits = hits.sort((a, b) => (of(a) > of(b) ? sign : of(a) < of(b) ? -sign : 0));
    }
    const page = Number(params.get("page") ?? "1");
    const pageSize = Number(params.get("pageSize") ?? "25");
    const data = hits.slice((page - 1) * pageSize, page * pageSize).map(({ _category, ...row }) => row);
    return jsonResponse({ Data: data, Total: hits.length, AggregateResults: null, Errors: null });
  };
}

/** A fresh request log. */
export function registerLog(): RegisterLog {
  const requests: HttpRequest[] = [];
  return {
    requests,
    unitRequests: () => requests.filter((r) => !r.url.includes("GetFilterColumns")).map((r) => new URL(r.url).searchParams),
  };
}

let serial = 0;

/**
 * A unit row of `category` from the live row of that kind (`base`, default the category's own),
 * with `overrides`; a fresh MaStR number unless given.
 */
export function unit(category: UnitCategory, overrides: Partial<MastrUnit> = {}, base: keyof typeof LIVE_ROWS = category): MastrUnit & { _category: UnitCategory } {
  serial += 1;
  const prefix = { stromerzeugung: "SEE", stromverbrauch: "SVE", gaserzeugung: "GEE", gasverbrauch: "GVE" }[category];
  return { ...LIVE_ROWS[base], MaStRNummer: `${prefix}${String(900000000000 + serial)}`, ...overrides, _category: category };
}

/** States and energy sources as the register codes them (live). */
export const STATE = { Bayern: 1403, Saarland: 1412, "Nordrhein-Westfalen": 1409, "Baden-Württemberg": 1402, Sachsen: 1413, "Sachsen-Anhalt": 1414, Niedersachsen: 1408 } as const;
export const ENERGY = { Wind: 2497, Solar: 2495, Speicher: 2496, Wasser: 2498, Solarthermie: 2404 } as const;
export const STATUS = { inOperation: 35, planned: 31, temporarilyClosed: 37, permanentlyClosed: 38 } as const;

/**
 * A small register: wind in Bayern and the Saarland (in operation, planned, shut down, with
 * capacities from 2 to 6 MW and commissioning days around new year 2025), PV of natural persons,
 * a battery, and one unit of each other category.
 */
export function sampleRegister(): (MastrUnit & { _category: UnitCategory })[] {
  const wind = (state: number, status: number, kw: number, commissioned: string, name: string) =>
    unit("stromerzeugung", {
      BundeslandId: state,
      Bundesland: Object.entries(STATE).find(([, code]) => code === state)?.[0] ?? "",
      BetriebsStatusId: status,
      BetriebsStatusName: Object.entries({ "In Betrieb": 35, "In Planung": 31, "Endgültig stillgelegt": 38 }).find(([, c]) => c === status)?.[0] ?? "",
      Bruttoleistung: kw,
      Nettonennleistung: kw - 100,
      InbetriebnahmeDatum: msDate(commissioned),
      EinheitName: name,
    });
  return [
    wind(STATE.Bayern, STATUS.inOperation, 5000, "2024-12-31", "WEA Bayern 1"),
    wind(STATE.Bayern, STATUS.inOperation, 6000, "2025-01-01", "WEA Bayern 2"),
    wind(STATE.Bayern, STATUS.inOperation, 2000, "2025-01-02", "WEA Bayern 3"),
    wind(STATE.Bayern, STATUS.planned, 7000, "2027-06-01", "WEA Bayern geplant"),
    wind(STATE.Saarland, STATUS.inOperation, 3000, "2018-06-14", "EH-01"),
    wind(STATE.Saarland, STATUS.permanentlyClosed, 4999.999, "2001-03-01", "WEA Saar alt"),
    unit("stromerzeugung", {}, "pv"),
    unit("stromerzeugung", { BundeslandId: STATE.Bayern, Bundesland: "Bayern", Ort: "München", Plz: "80331" }, "pv"),
    unit("stromerzeugung", {}, "storage"),
    unit("stromverbrauch"),
    unit("gaserzeugung"),
    unit("gasverbrauch"),
  ];
}
