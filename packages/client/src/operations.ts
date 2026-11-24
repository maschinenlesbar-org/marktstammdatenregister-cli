// The use cases of the skills as library functions, built on the client: each composes the
// client's calls and carries the traps the skills document, so no caller (the MCP server's
// use-case tools, a library user) has to know them:
//
// - findFilterCodes (mastr-filters): the German FilterNames, their types and operators, and the
//   dropdown codes the register needs instead of the labels;
// - countUnits and searchUnits (mastr-search): structured filters (energy source and state by
//   name, inclusive capacity and date bounds, the operating status) turned into the register's
//   filter grammar; units in operation by default, a count per code of one dropdown column, the
//   capacity summed on this side for a set small enough to read;
// - getUnit (mastr-unit): one unit by its MaStR number, the category taken from the number's
//   prefix, its record read: dates as ISO, the grid operator's number without its HTML, the
//   full-width ampersand as "&", capacity with its unit, anonymised data said.
//
// The rules: ambiguity is reported, never guessed (a label that fits several codes, a number
// that names several units: `ambiguous` with the candidates); no bare "not found" (an empty
// answer says what was searched and what to change). The call signal reaches every request
// through the transport (the MCP server's limiter), so the functions take no options.

import { formatMastrDate, MAX_PAGE, parseMsDate, type MastrClient } from "./client.js";
import { cutForMessage, MastrParseError, MastrValidationError } from "./errors.js";
import { buildFilter, FILTER_OPERATORS, type FilterCondition, type FilterOperator } from "./filter.js";
import type { FilterColumn, MastrUnit, UnitCategory } from "./types.js";
import { assertValid, normalizeText, textProblem } from "./validate.js";

/** The register's four datasets. */
export const UNIT_CATEGORIES: readonly UnitCategory[] = ["stromerzeugung", "stromverbrauch", "gaserzeugung", "gasverbrauch"];

/** The operating statuses a count or search can ask for; `any` is every unit ever registered. */
export const UNIT_STATUSES = ["inOperation", "planned", "temporarilyClosed", "permanentlyClosed", "any"] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

/** The register's `Betriebs-Status` codes (live 2026-11-19, the same in all four categories). */
const STATUS_CODES: Record<Exclude<UnitStatus, "any">, { code: string; label: string }> = {
  inOperation: { code: "35", label: "In Betrieb" },
  planned: { code: "31", label: "In Planung" },
  temporarilyClosed: { code: "37", label: "Vorübergehend stillgelegt" },
  permanentlyClosed: { code: "38", label: "Endgültig stillgelegt" },
};

/** What a search can be sorted by; each is a record field (a sort key), per category. */
export const UNIT_SORTS = ["capacity", "netCapacity", "commissioned", "registered", "updated"] as const;
export type UnitSort = (typeof UNIT_SORTS)[number];

/** The FilterNames the structured filters use (the register's spelling, live 2026-11-19). */
const COLUMN = {
  status: "Betriebs-Status",
  state: "Bundesland",
  energySource: "Energieträger",
  commissioned: "Inbetriebnahmedatum der Einheit",
  registered: "Registrierungsdatum der Einheit",
  place: "Ort",
  postcode: "Postleitzahl",
  district: "Landkreis",
  municipality: "Gemeinde",
  operator: "Name des Anlagenbetreibers (nur Org.)",
  operatorNumber: "MaStR-Nr. des Anlagenbetreibers",
  name: "Anzeige-Name der Einheit",
  unitNumber: "MaStR-Nr. der Einheit",
} as const;

/** A category's capacity: the column a bound filters on, the record field, its sort key and unit. */
interface Capacity {
  column: string;
  field: string;
  unit: string;
}

/**
 * The capacity of each category. Electricity generation is in kW, gross and net; the gas rows
 * state no unit (the register's form doesn't say either); electricity consumption has none.
 */
const CAPACITY: Record<UnitCategory, Capacity | undefined> = {
  stromerzeugung: { column: "Bruttoleistung der Einheit", field: "Bruttoleistung", unit: "kW" },
  stromverbrauch: undefined,
  gaserzeugung: { column: "Gaserzeugungsleistung", field: "Erzeugungsleistung", unit: "not stated by the register" },
  gasverbrauch: { column: "Maximale Gasbezugsleistung", field: "MaximaleGasbezugsLeistung", unit: "not stated by the register" },
};

/** The sort keys per category (record field names, checked live 2026-11-19); a missing one isn't there. */
const SORT_KEYS: Record<UnitCategory, Partial<Record<UnitSort, string>>> = {
  stromerzeugung: { capacity: "Bruttoleistung", netCapacity: "Nettonennleistung", commissioned: "InbetriebnahmeDatum", registered: "EinheitRegistrierungsdatum", updated: "DatumLetzteAktualisierung" },
  stromverbrauch: { commissioned: "InbetriebnahmeDatum", registered: "EinheitRegistrierungsdatum", updated: "DatumLetzteAktualisierung" },
  gaserzeugung: { capacity: "Erzeugungsleistung", commissioned: "InbetriebnahmeDatum", registered: "EinheitRegistrierungsdatum", updated: "DatumLetzteAktualisierung" },
  gasverbrauch: { capacity: "MaximaleGasbezugsLeistung", commissioned: "InbetriebnahmeDatum", registered: "EinheitRegistrierungsdatum", updated: "DatumLetzteAktualisierung" },
};

/** The operators per column type, as the register takes them (mastr-filters). */
const OPERATORS_BY_TYPE: Record<string, readonly FilterOperator[]> = {
  text: ["eq", "neq", "sw", "ct", "nct", "ew", "null", "nn"],
  number: ["eq", "neq", "gt", "lt"],
  date: ["eq", "neq", "gt", "lt"],
  boolean: ["eq", "neq"],
  multidropdown: ["eq", "neq"],
  mastrnummer: ["eq", "neq", "sw", "ct"],
};

/** The grammar in one paragraph, for a caller that writes a raw filter. */
export const FILTER_GRAMMAR =
  "FilterName~op~'value', conditions joined by ~and~ (there is no working ~or~: several codes of one dropdown go comma-separated in one value, '2497,2498'). " +
  "A dropdown takes its code, not its label. gt/lt are strict and there is no gte/lte (at least 5000: gt '4999.999'); decimals with a point; dates as '2025-01-01'; booleans '1'/'0'. " +
  "null/nn (empty, not empty) work on text columns only and take ''. A value can't hold '~'.";

/** Names of the Länder as people write them, folded (see `fold`), to the register's label. */
const STATE_ALIASES: Record<string, string> = {
  bw: "Baden-Württemberg", "baden wuerttemberg": "Baden-Württemberg",
  by: "Bayern", bavaria: "Bayern",
  be: "Berlin",
  bb: "Brandenburg",
  hb: "Bremen",
  hh: "Hamburg",
  he: "Hessen", hesse: "Hessen",
  mv: "Mecklenburg-Vorpommern", "mecklenburg western pomerania": "Mecklenburg-Vorpommern", "mecklenburg vorpommern": "Mecklenburg-Vorpommern",
  ni: "Niedersachsen", nds: "Niedersachsen", "lower saxony": "Niedersachsen",
  nw: "Nordrhein-Westfalen", nrw: "Nordrhein-Westfalen", "north rhine westphalia": "Nordrhein-Westfalen",
  rp: "Rheinland-Pfalz", rlp: "Rheinland-Pfalz", "rhineland palatinate": "Rheinland-Pfalz",
  sl: "Saarland",
  sn: "Sachsen", saxony: "Sachsen",
  st: "Sachsen-Anhalt", "saxony anhalt": "Sachsen-Anhalt",
  sh: "Schleswig-Holstein",
  th: "Thüringen", thuringia: "Thüringen",
  awz: "Ausschließliche Wirtschaftszone", eez: "Ausschließliche Wirtschaftszone", offshore: "Ausschließliche Wirtschaftszone",
};

/** Energy sources as people write them, folded, to the register's label. */
const ENERGY_ALIASES: Record<string, string> = {
  solar: "Solare Strahlungsenergie", pv: "Solare Strahlungsenergie", photovoltaik: "Solare Strahlungsenergie", photovoltaic: "Solare Strahlungsenergie", photovoltaics: "Solare Strahlungsenergie", sonne: "Solare Strahlungsenergie", solarstrom: "Solare Strahlungsenergie",
  "solar thermal": "Solarthermie",
  windkraft: "Wind", windenergie: "Wind", "wind power": "Wind", "wind energy": "Wind",
  storage: "Speicher", battery: "Speicher", batterie: "Speicher", batteriespeicher: "Speicher", stromspeicher: "Speicher", "battery storage": "Speicher",
  hydro: "Wasser", hydropower: "Wasser", wasserkraft: "Wasser", water: "Wasser",
  biomass: "Biomasse", biogas: "Biomasse",
  "natural gas": "Erdgas", gas: "Erdgas",
  lignite: "Braunkohle", "brown coal": "Braunkohle",
  "hard coal": "Steinkohle", coal: "Steinkohle",
  nuclear: "Kernenergie", kernkraft: "Kernenergie", atomkraft: "Kernenergie",
  geothermal: "Geothermie",
  oil: "Mineralölprodukte", "mineral oil": "Mineralölprodukte", heizoel: "Mineralölprodukte",
  hydrogen: "Wasserstoff",
  waste: "nicht biogener Abfall",
  "sewage sludge": "Klärschlamm",
  "mine gas": "Grubengas",
};

/** `text` folded for matching: lower case, umlauts and ß spelt out, everything else but letters and digits one space. */
function fold(text: string): string {
  return text
    .normalize("NFC")
    .toLocaleLowerCase("de")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A label and code of a dropdown column, with the column's name. */
export interface FilterCode {
  column: string;
  label: string;
  code: string;
  /** The condition as the register takes it: `Bundesland~eq~'1403'`. */
  example: string;
}

/** Several codes fit a value the caller gave: the answer is `ambiguous`, never a guess. */
class AmbiguousValue extends Error {
  constructor(
    readonly field: string,
    readonly value: string,
    readonly candidates: FilterCode[],
  ) {
    super(`${field} ${JSON.stringify(value)} fits several codes`);
  }
}

/** The `{ label, code }` pairs of a dropdown column. */
function codesOf(column: FilterColumn): { label: string; code: string }[] {
  return (column.ListObject ?? [])
    .filter((o): o is { Name: string; Value: string } => typeof o?.Name === "string" && typeof o?.Value === "string")
    .map((o) => ({ label: o.Name, code: o.Value }));
}

const codeOf = (column: string, label: string, code: string): FilterCode => ({ column, label, code, example: `${column}~eq~'${code}'` });

/** The column named `name` in `columns` (the register's spelling), or a validation error naming the category. */
function columnNamed(columns: readonly FilterColumn[], name: string, category: UnitCategory, what: string): FilterColumn {
  const column = columns.find((c) => c.FilterName === name);
  if (column === undefined) {
    const others = UNIT_CATEGORIES.filter((c) => c !== category && (c === "stromerzeugung" || name !== COLUMN.energySource));
    throw new MastrValidationError(
      `Invalid ${what}: the ${category} units have no column ${JSON.stringify(name)}` +
        (name === COLUMN.energySource ? "; only stromerzeugung (electricity generation) has an energy source." : `; see findFilterCodes for its columns (other categories: ${others.join(", ")}).`),
    );
  }
  return column;
}

/**
 * The columns the structured filters and getUnit build on, in `category` (each checked live on
 * 2026-11-19): a list without one of them is an odd answer of the register, not a caller's mistake.
 */
function knownColumns(category: UnitCategory): string[] {
  const capacity = CAPACITY[category];
  return [
    COLUMN.status, COLUMN.state, COLUMN.commissioned, COLUMN.registered, COLUMN.place, COLUMN.postcode, COLUMN.district,
    COLUMN.municipality, COLUMN.operator, COLUMN.operatorNumber, COLUMN.name, COLUMN.unitNumber,
    ...(category === "stromerzeugung" ? [COLUMN.energySource] : []),
    ...(capacity === undefined ? [] : [capacity.column]),
    ...Object.values(NUMBER_KINDS).filter((k) => k.category === category).map((k) => k.column),
  ].filter((name, i, all) => all.indexOf(name) === i);
}

/**
 * The category's filter columns from the client's cache, checked: an empty list (the client
 * refuses it), one without a column the category has (`knownColumns`), or a dropdown the tools
 * resolve names against without its codes is the register's odd answer. Then the kept list is
 * dropped, so the next call asks again, and the error says it is the register's answer: kept, it
 * failed every later call of the process with errors that blamed the caller's input.
 */
async function columnsOf(client: MastrClient, category: UnitCategory): Promise<FilterColumn[]> {
  const columns = await client.cachedFilterColumns(category);
  const named = new Map(columns.map((c) => [c.FilterName, c]));
  const missing = knownColumns(category).filter((name) => !named.has(name)).map((name) => JSON.stringify(name));
  const dropdowns: string[] = [COLUMN.status, COLUMN.state, ...(category === "stromerzeugung" ? [COLUMN.energySource] : [])];
  const noCodes = dropdowns.filter((name) => named.has(name) && codesOf(named.get(name)!).length === 0).map((name) => `the codes of ${JSON.stringify(name)}`);
  if (missing.length > 0 || noCodes.length > 0) {
    client.forgetFilterColumns(category);
    throw new MastrParseError(
      `Unexpected answer: the register's filter columns of ${category} came without ${[...missing, ...noCodes].join(", ")} (which the category has, checked live): ` +
        "an odd answer, not the input; they are asked for again at the next call.",
    );
  }
  return columns;
}

/**
 * The codes of a dropdown column for one value a caller wrote: a code, a label (case, umlauts and
 * punctuation aside), a known alias (`aliases`), else the labels that start with it, then those
 * that contain it. One fits: its code. Several: `AmbiguousValue`. None: a validation error listing
 * the labels.
 */
function resolveLabel(column: FilterColumn, value: string, field: string, aliases: Record<string, string> = {}): FilterCode {
  const name = column.FilterName ?? field;
  const codes = codesOf(column);
  const wanted = fold(value);
  const byCode = codes.find((c) => c.code === value.trim());
  if (byCode !== undefined) return codeOf(name, byCode.label, byCode.code);
  const exact = codes.filter((c) => fold(c.label) === wanted);
  const alias = aliases[wanted];
  const aliased = alias === undefined ? [] : codes.filter((c) => c.label === alias);
  const starts = codes.filter((c) => fold(c.label).startsWith(wanted));
  const contains = codes.filter((c) => fold(c.label).includes(wanted));
  const found = [exact, aliased, starts, contains].find((list) => list.length > 0) ?? [];
  if (found.length === 1) return codeOf(name, found[0]!.label, found[0]!.code);
  if (found.length > 1) throw new AmbiguousValue(field, value, found.map((c) => codeOf(name, c.label, c.code)));
  throw new MastrValidationError(
    `Invalid ${field}: ${JSON.stringify(cutForMessage(value))} is none of the ${JSON.stringify(name)} codes: ` +
      cutForMessage(codes.map((c) => `${c.label} (${c.code})`).join(", "), 1500) +
      ".",
  );
}

/** The items of a comma-separated list, trimmed, without blanks. */
function listOf(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter((item) => item !== "");
}

/** The filters a count and a search take. */
export interface UnitFilterInput {
  /** The dataset (default `stromerzeugung`, electricity generation). */
  category?: UnitCategory | undefined;
  /** Energy sources by name, alias or code, comma-separated: "Wind", "Solar, Wind", "2495" (stromerzeugung only). */
  energySource?: string | undefined;
  /** Länder by name, abbreviation or code, comma-separated: "Bayern", "BY, BW", "NRW". */
  state?: string | undefined;
  /** The operating status (default `inOperation`); `any` counts every unit ever registered. */
  status?: UnitStatus | undefined;
  /** The town (`Ort`), the whole name as the register spells it: the postal town ("Frankfurt", not "Frankfurt am Main"). */
  place?: string | undefined;
  /** A postcode, or its first digits (1–5). */
  postcode?: string | undefined;
  /** The district (`Landkreis`), the whole name. */
  district?: string | undefined;
  /** The municipality (`Gemeinde`), the whole official name ("Frankfurt am Main"). */
  municipality?: string | undefined;
  /** Part of the operator's name (organisations only; natural persons are anonymised). */
  operator?: string | undefined;
  /** The operator's MaStR number (ABR…). */
  operatorNumber?: string | undefined;
  /** Part of the unit's display name. */
  name?: string | undefined;
  /** Capacity at least this (inclusive; stromerzeugung: gross kW). */
  minCapacity?: number | undefined;
  /** Capacity at most this (inclusive). */
  maxCapacity?: number | undefined;
  /** Commissioned on or after this day (YYYY-MM-DD). */
  commissionedFrom?: string | undefined;
  /** Commissioned on or before this day. */
  commissionedTo?: string | undefined;
  /** Registered in the MaStR on or after this day. */
  registeredFrom?: string | undefined;
  /** Registered on or before this day. */
  registeredTo?: string | undefined;
  /** More conditions in the register's grammar, ANDed (see {@link FILTER_GRAMMAR}). */
  filter?: string | undefined;
}

/** What a count or a search asked, in words: each condition with its code. */
export interface UnitSearched {
  category: UnitCategory;
  /** The status counted: "In Betrieb (35)", or "any (every status)". */
  status: string;
  conditions: string[];
  /** The filter as sent (before the client's own check), empty when none. */
  filter: string;
}

/** A filter the structured input made. */
interface BuiltFilter {
  category: UnitCategory;
  spec: string | undefined;
  searched: UnitSearched;
}

const DAY_MS = 86_400_000;

/**
 * `YYYY-MM-DD` moved by `days`, or undefined when that leaves the years 1 to 9999 (a bound at the
 * calendar's end, "on or before 9999-12-31", restricts nothing); a validation error for a day that
 * isn't one. The year is set as written: `Date.UTC` reads 0–99 as 1900–1999.
 */
function shiftDay(field: string, value: string, days: number): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  const day = new Date(0);
  if (match !== null) day.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (match === null || Number(match[1]) < 1 || day.toISOString().slice(0, 10) !== value.trim()) {
    throw new MastrValidationError(`Invalid ${field}: expected a day from 0001-01-01 to 9999-12-31 as YYYY-MM-DD, got ${JSON.stringify(cutForMessage(value))}.`);
  }
  const moved = new Date(day.getTime() + days * DAY_MS);
  const year = moved.getUTCFullYear();
  return year < 1 || year > 9999 ? undefined : moved.toISOString().slice(0, 10);
}

/** A capacity bound, checked: finite and not negative. */
function capacityBound(field: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new MastrValidationError(`Invalid ${field}: expected a number of at least 0, got ${String(value)}.`);
  }
  return value;
}

/** `n` with at most three decimals (the register's capacities have three), so a bound reads exactly. */
const thousandths = (n: number): number => Math.round(n * 1000) / 1000;

/** A free-text input, checked and canonical. */
function textInput(field: string, value: string): string {
  return normalizeText(assertValid(field, value, textProblem));
}

/**
 * The register's filter for `input`: every structured filter as a condition, names resolved to
 * codes against the category's columns (one cached request), the inclusive bounds made strict
 * (gt/lt are strict: at least 5000 kW is `gt '4999.999'`, from 2025-01-01 is `gt '2024-12-31'`),
 * units in operation unless `status` says otherwise, and the raw `filter` ANDed. The client checks
 * the result against the columns again before it is sent.
 */
async function buildUnitFilter(client: MastrClient, input: UnitFilterInput, omitStatus = false): Promise<BuiltFilter> {
  const category = input.category ?? "stromerzeugung";
  if (!UNIT_CATEGORIES.includes(category)) {
    throw new MastrValidationError(`Invalid category: expected one of ${UNIT_CATEGORIES.join(", ")}, got ${JSON.stringify(cutForMessage(String(category)))}.`);
  }
  const status = input.status ?? "inOperation";
  if (!UNIT_STATUSES.includes(status)) {
    throw new MastrValidationError(`Invalid status: expected one of ${UNIT_STATUSES.join(", ")}, got ${JSON.stringify(cutForMessage(String(status)))}.`);
  }
  const columns = await columnsOf(client, category);
  const conditions: FilterCondition[] = [];
  const words: string[] = [];
  const dropdown = (field: string, value: string | undefined, columnName: string, aliases?: Record<string, string>): void => {
    if (value === undefined) return;
    const items = listOf(textInput(field, value));
    if (items.length === 0) throw new MastrValidationError(`Invalid ${field}: expected a name or code.`);
    const column = columnNamed(columns, columnName, category, field);
    const codes = items.map((item) => resolveLabel(column, item, field, aliases));
    conditions.push({ name: columnName, op: "eq", value: codes.map((c) => c.code) });
    words.push(`${columnName}: ${codes.map((c) => `${c.label} (${c.code})`).join(" or ")}`);
  };
  const text = (field: string, value: string | undefined, columnName: string, op: FilterOperator): void => {
    if (value === undefined) return;
    const clean = textInput(field, value);
    columnNamed(columns, columnName, category, field);
    conditions.push({ name: columnName, op, value: clean });
    words.push(`${columnName} ${op === "eq" ? "is" : op === "sw" ? "starts with" : "contains"} "${clean}"`);
  };
  dropdown("energySource", input.energySource, COLUMN.energySource, ENERGY_ALIASES);
  dropdown("state", input.state, COLUMN.state, STATE_ALIASES);
  text("place", input.place, COLUMN.place, "eq");
  if (input.postcode !== undefined) {
    const postcode = textInput("postcode", input.postcode);
    if (!/^\d{1,5}$/.test(postcode)) throw new MastrValidationError(`Invalid postcode: expected 1 to 5 digits, got ${JSON.stringify(cutForMessage(postcode))}.`);
    text("postcode", postcode, COLUMN.postcode, postcode.length === 5 ? "eq" : "sw");
  }
  text("district", input.district, COLUMN.district, "eq");
  text("municipality", input.municipality, COLUMN.municipality, "eq");
  text("operator", input.operator, COLUMN.operator, "ct");
  if (input.operatorNumber !== undefined) {
    const number = textInput("operatorNumber", input.operatorNumber).toUpperCase();
    if (!/^ABR\d{12}$/.test(number)) throw new MastrValidationError(`Invalid operatorNumber: expected ABR and 12 digits, got ${JSON.stringify(cutForMessage(number))}.`);
    text("operatorNumber", number, COLUMN.operatorNumber, "eq");
  }
  text("name", input.name, COLUMN.name, "ct");
  if (input.minCapacity !== undefined || input.maxCapacity !== undefined) {
    const capacity = CAPACITY[category];
    if (capacity === undefined) {
      throw new MastrValidationError("Invalid minCapacity/maxCapacity: the stromverbrauch (electricity consumption) units have no capacity in the register.");
    }
    columnNamed(columns, capacity.column, category, "minCapacity");
    if (input.minCapacity !== undefined) {
      const min = capacityBound("minCapacity", input.minCapacity);
      if (min > 0) conditions.push({ name: capacity.column, op: "gt", value: thousandths(min - 0.001) });
      words.push(`${capacity.column} at least ${min} (${capacity.unit})`);
    }
    if (input.maxCapacity !== undefined) {
      const max = capacityBound("maxCapacity", input.maxCapacity);
      conditions.push({ name: capacity.column, op: "lt", value: thousandths(max + 0.001) });
      words.push(`${capacity.column} at most ${max} (${capacity.unit})`);
    }
    if (input.minCapacity !== undefined && input.maxCapacity !== undefined && input.minCapacity > input.maxCapacity) {
      throw new MastrValidationError(`Invalid minCapacity: ${input.minCapacity} is more than maxCapacity ${input.maxCapacity}.`);
    }
  }
  const dayBounds = (from: string | undefined, to: string | undefined, column: string, what: string): void => {
    if (from === undefined && to === undefined) return;
    columnNamed(columns, column, category, `${what}From`);
    if (from !== undefined) {
      const before = shiftDay(`${what}From`, from, -1);
      if (before !== undefined) conditions.push({ name: column, op: "gt", value: before });
      words.push(`${column} on or after ${from.trim()}`);
    }
    if (to !== undefined) {
      const after = shiftDay(`${what}To`, to, 1);
      if (after !== undefined) conditions.push({ name: column, op: "lt", value: after });
      words.push(`${column} on or before ${to.trim()}`);
    }
    if (from !== undefined && to !== undefined && from.trim() > to.trim()) {
      throw new MastrValidationError(`Invalid ${what}From: ${from.trim()} is after ${what}To ${to.trim()}.`);
    }
  };
  dayBounds(input.commissionedFrom, input.commissionedTo, COLUMN.commissioned, "commissioned");
  dayBounds(input.registeredFrom, input.registeredTo, COLUMN.registered, "registered");
  let statusWords = "any (every status: in operation, planned and shut down)";
  if (status !== "any" && !omitStatus) {
    const { code, label } = STATUS_CODES[status];
    columnNamed(columns, COLUMN.status, category, "status");
    conditions.push({ name: COLUMN.status, op: "eq", value: code });
    statusWords = `${label} (${code})`;
  }
  let spec = conditions.length === 0 ? undefined : buildFilter(conditions);
  if (input.filter !== undefined) {
    const raw = assertValid("filter", input.filter, textProblem).trim();
    spec = spec === undefined ? raw : `${spec}~and~${raw}`;
    words.push(`filter ${raw}`);
  }
  return { category, spec, searched: { category, status: statusWords, conditions: words, filter: spec ?? "" } };
}

/** The candidates of an ambiguous value as an answer, or rethrow anything else. */
function ambiguousAnswer(err: unknown, category: UnitCategory | undefined): { status: "ambiguous"; searched: Record<string, unknown>; candidates: FilterCode[]; reason: string } {
  if (!(err instanceof AmbiguousValue)) throw err;
  return {
    status: "ambiguous",
    searched: { category: category ?? "stromerzeugung", [err.field]: err.value },
    candidates: err.candidates,
    reason: `${err.field} "${err.value}" fits ${err.candidates.length} codes of ${err.candidates[0]?.column ?? "the column"}: ask which one is meant and call again with its label or code (several, comma-separated, count as any of them).`,
  };
}

// ---------------------------------------------------------------------------------------------
// findFilterCodes (mastr-filters)

/** The input of {@link findFilterCodes}. */
export interface FindFilterCodesInput {
  /** The dataset (default `stromerzeugung`): the columns differ per category. */
  category?: UnitCategory | undefined;
  /** A FilterName, or part of it ("Bundesland", "Energietraeger", "Leistung"). */
  column?: string | undefined;
  /** A label, or part of it, to find among the dropdown codes ("Bayern", "Wind"). */
  value?: string | undefined;
}

/** A column as {@link findFilterCodes} lists it. */
export interface FilterColumnInfo {
  name: string;
  type: string;
  operators: readonly string[];
  /** For a dropdown: how many codes it has (all of them with `column`). */
  codeCount?: number;
  codes?: FilterCode[];
}

/** The answer of {@link findFilterCodes}. */
export type FilterCodesAnswer =
  | { status: "ok"; searched: Record<string, string>; columns?: FilterColumnInfo[]; codes?: FilterCode[]; sortKeys: Record<string, string>; grammar: string }
  | { status: "ambiguous"; searched: Record<string, string>; candidates: string[]; reason: string }
  | { status: "empty"; searched: Record<string, string>; reason: string; columns?: string[] };

/** A column's description, with its codes when `withCodes`. */
function columnInfo(column: FilterColumn, withCodes: boolean, value?: string): FilterColumnInfo {
  const name = column.FilterName ?? "";
  const type = String(column.Type ?? "");
  const info: FilterColumnInfo = { name, type, operators: OPERATORS_BY_TYPE[type] ?? FILTER_OPERATORS };
  if (type === "multidropdown") {
    const codes = codesOf(column);
    info.codeCount = codes.length;
    if (withCodes) {
      const wanted = value === undefined ? undefined : fold(value);
      info.codes = codes.filter((c) => wanted === undefined || fold(c.label).includes(wanted) || c.code === value?.trim()).map((c) => codeOf(name, c.label, c.code));
    }
  }
  return info;
}

/**
 * The filterable columns of a category, one column with its codes, or the codes whose label
 * matches a value: the FilterName and the code the register needs, never the label. A column
 * named by part of its name that fits several is `ambiguous`; a value no dropdown has is `empty`.
 */
export async function findFilterCodes(client: MastrClient, input: FindFilterCodesInput = {}): Promise<FilterCodesAnswer> {
  const category = input.category ?? "stromerzeugung";
  if (!UNIT_CATEGORIES.includes(category)) {
    throw new MastrValidationError(`Invalid category: expected one of ${UNIT_CATEGORIES.join(", ")}, got ${JSON.stringify(cutForMessage(String(category)))}.`);
  }
  const columnText = input.column === undefined ? undefined : textInput("column", input.column);
  const value = input.value === undefined ? undefined : textInput("value", input.value);
  const searched: Record<string, string> = { category, ...(columnText === undefined ? {} : { column: columnText }), ...(value === undefined ? {} : { value }) };
  const columns = (await columnsOf(client, category)).filter((c) => typeof c.FilterName === "string");
  const sortKeys = SORT_KEYS[category] as Record<string, string>;
  const done = (rest: { columns?: FilterColumnInfo[]; codes?: FilterCode[] }): FilterCodesAnswer => ({ status: "ok", searched, ...rest, sortKeys, grammar: FILTER_GRAMMAR });
  if (columnText !== undefined) {
    const wanted = fold(columnText);
    const exact = columns.filter((c) => fold(c.FilterName!) === wanted);
    const words = wanted.split(" ");
    const partial = columns.filter((c) => words.every((w) => fold(c.FilterName!).includes(w)));
    const found = exact.length > 0 ? exact : partial;
    if (found.length === 0) {
      return { status: "empty", searched, reason: `The ${category} units have no column whose name contains "${columnText}". The columns are listed; take a name from there.`, columns: columns.map((c) => c.FilterName!) };
    }
    if (found.length > 1) {
      return { status: "ambiguous", searched, candidates: found.map((c) => c.FilterName!), reason: `"${columnText}" is part of ${found.length} column names: pick one and call again with it.` };
    }
    const info = columnInfo(found[0]!, true, value);
    if (value !== undefined && info.type === "multidropdown" && (info.codes ?? []).length === 0) {
      return { status: "empty", searched, reason: `No code of ${info.name} has a label containing "${value}". Call again without value for all ${info.codeCount ?? 0} codes.` };
    }
    return done({ columns: [info] });
  }
  if (value !== undefined) {
    const wanted = fold(value);
    const codes: FilterCode[] = [];
    for (const column of columns) {
      for (const c of codesOf(column)) if (fold(c.label).includes(wanted) || c.code === value) codes.push(codeOf(column.FilterName!, c.label, c.code));
    }
    if (codes.length === 0) {
      return { status: "empty", searched, reason: `No dropdown code of the ${category} columns has a label containing "${value}". A text column (Ort, Gemeinde, Landkreis, …) takes the text itself; call without value for the columns.` };
    }
    // The exact labels first: "Sachsen" is that Land before Niedersachsen and Sachsen-Anhalt.
    codes.sort((a, b) => Number(fold(b.label) === wanted) - Number(fold(a.label) === wanted));
    return done({ codes });
  }
  return done({ columns: columns.map((c) => columnInfo(c, false)) });
}

// ---------------------------------------------------------------------------------------------
// countUnits (mastr-search)

/** The rows a page of the capacity sum reads: about 4 KB each, so a page stays near 8 MB. */
export const SUM_PAGE_SIZE = 2000;

/** The most codes a count `by` a column makes (one request each). */
export const MAX_GROUPS = 20;

/** Names of the `by` columns as people write them, folded, to the register's FilterName. */
const BY_ALIASES: Record<string, string> = {
  state: "Bundesland", states: "Bundesland", "federal state": "Bundesland", "federal states": "Bundesland", laender: "Bundesland", bundeslaender: "Bundesland",
  "energy source": "Energieträger", "energy sources": "Energieträger", energietraeger: "Energieträger",
  status: "Betriebs-Status", "operating status": "Betriebs-Status",
};

/** The input of {@link countUnits}. */
export interface CountUnitsInput extends UnitFilterInput {
  /** A dropdown column (name or part of it) to count per code: "Bundesland", "Energieträger". */
  by?: string | undefined;
  /** Also sum the capacity of the matching units, read here (the register has no sum). */
  sumCapacity?: boolean | undefined;
  /** The most units read for the sum (default 20,000); a larger set gets no sum, said so. */
  maxSumUnits?: number | undefined;
}

/** One code's count. */
export interface CountGroup {
  label: string;
  code: string;
  total: number;
}

/** The capacity of a set, summed here. */
export type CapacitySum =
  | { summed: true; unit: string; units: number; gross: number; net?: number; withoutFigure: number }
  | { summed: false; reason: string };

/** The answer of {@link countUnits}. */
export type UnitCount =
  | { status: "ok" | "empty"; searched: UnitSearched; total: number; by?: string; groups?: CountGroup[]; capacity?: CapacitySum; reason?: string; notes: string[] }
  | { status: "ambiguous"; searched: Record<string, unknown>; candidates: FilterCode[] | string[]; reason: string };

/** Notes every count and search carries: what the status means, and how the register counts. */
function statusNotes(searched: UnitSearched): string[] {
  return searched.status.startsWith("any")
    ? ["Every status is counted: units in operation, planned, and temporarily or permanently shut down. Say so in the answer."]
    : [`Only units with status ${searched.status} are counted (the register keeps every unit ever registered). Say which status the answer counts; status 'any' counts all.`];
}

/** Why a count found nothing, in words that say what to change. */
function emptyReason(searched: UnitSearched): string {
  const hints = [
    "Places, municipalities and districts are matched whole, in the register's spelling: the place (Ort) is the postal town ('Frankfurt', not 'Frankfurt am Main'), the municipality (Gemeinde) the official name ('Frankfurt am Main'); a raw filter with sw or ct matches a part (\"Ort~sw~'Frankfurt'\").",
    searched.status.startsWith("any") ? undefined : `Only status ${searched.status} was counted; status 'any' counts planned and shut-down units too.`,
  ].filter((h): h is string => h !== undefined);
  return `No ${searched.category} unit matches ${searched.conditions.length === 0 ? "the status" : searched.conditions.join("; ")}. ${hints.join(" ")}`;
}

/**
 * How many units match: the register's exact total for the filter (one one-row request). `by`
 * counts per code of one dropdown column (one request per code, at most {@link MAX_GROUPS}; a
 * filter on that column narrows the codes). `sumCapacity` reads the matching units in pages of
 * {@link SUM_PAGE_SIZE} and sums their capacity (gross and net kW for stromerzeugung), when there
 * are at most `maxSumUnits`; beyond that the answer says there is no sum, never a guess.
 */
export async function countUnits(client: MastrClient, input: CountUnitsInput = {}): Promise<UnitCount> {
  let built: BuiltFilter;
  let byColumn: FilterColumn | undefined;
  try {
    const category = input.category ?? "stromerzeugung";
    if (input.by !== undefined && UNIT_CATEGORIES.includes(category)) {
      const by = textInput("by", input.by);
      const columns = await columnsOf(client, category);
      const wanted = fold(by);
      const dropdowns = columns.filter((c) => c.Type === "multidropdown" && typeof c.FilterName === "string");
      const alias = BY_ALIASES[wanted];
      const exact = dropdowns.filter((c) => fold(c.FilterName!) === wanted || c.FilterName === alias);
      const found = exact.length > 0 ? exact : dropdowns.filter((c) => fold(c.FilterName!).includes(wanted));
      if (found.length > 1) {
        return { status: "ambiguous", searched: { category, by }, candidates: found.map((c) => c.FilterName!), reason: `"${by}" is part of ${found.length} dropdown column names: pick one.` };
      }
      if (found.length === 0) {
        throw new MastrValidationError(`Invalid by: the ${category} units have no dropdown column like ${JSON.stringify(cutForMessage(by))}; the dropdown columns are ${dropdowns.map((c) => c.FilterName).join(", ")}.`);
      }
      byColumn = found[0]!;
    }
    // A count per status counts every status, unless a status is asked: then the total and the
    // one group count the same units (the filter's own condition narrows the codes, below).
    built = await buildUnitFilter(client, input, byColumn?.FilterName === COLUMN.status && input.status === undefined);
  } catch (err) {
    return ambiguousAnswer(err, input.category);
  }
  const { category, spec, searched } = built;
  const notes = statusNotes(searched);
  const total = await client.count(category, spec === undefined ? {} : { filter: spec });
  const answer: UnitCount & { status: "ok" | "empty" } = { status: total === 0 ? "empty" : "ok", searched, total, notes };
  if (total === 0) answer.reason = emptyReason(searched);
  if (byColumn !== undefined && total > 0) {
    const name = byColumn.FilterName!;
    // A filter on the same column (state "BY, BW" with by Bundesland) narrows the groups to its codes.
    const own = new RegExp(`(?:^|~and~)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}~eq~'([^']*)'`).exec(spec ?? "");
    const allowed = own === null ? undefined : new Set(listOf(own[1]!));
    const codes = codesOf(byColumn).filter((c) => allowed === undefined || allowed.has(c.code));
    if (codes.length > MAX_GROUPS) {
      throw new MastrValidationError(`Invalid by: ${name} has ${codes.length} codes, more than the ${MAX_GROUPS} counts one call makes. Narrow it with a filter on that column, or count single codes.`);
    }
    const groups: CountGroup[] = [];
    // One after the other: the register is a public service, and the limiter spaces them anyway.
    for (const c of codes) {
      const condition = buildFilter([{ name, op: "eq", value: c.code }]);
      const filter = spec === undefined ? condition : `${spec}~and~${condition}`;
      groups.push({ label: c.label, code: c.code, total: await client.count(category, { filter }) });
    }
    groups.sort((a, b) => b.total - a.total);
    answer.by = name;
    answer.groups = groups;
    const sum = groups.reduce((n, g) => n + g.total, 0);
    if (sum !== total) notes.push(`The groups add up to ${sum}, the total is ${total}: ${sum < total ? "some units have no value in" : "a unit can have several values of"} ${name}.`);
    if (byColumn.FilterName === COLUMN.status && searched.status.startsWith("any")) notes.splice(0, 1, "Counted per operating status (every status).");
    if (name === "Land") notes.push("Land is the register's country column (Deutschland, Belgien, …); a count per German Land (state): by Bundesland.");
  }
  if (input.sumCapacity === true) answer.capacity = await sumCapacity(client, category, spec, total, input.maxSumUnits ?? 20_000);
  return answer;
}

/** The capacity of the `total` units matching `spec`, read in pages, or why there is no sum. */
async function sumCapacity(client: MastrClient, category: UnitCategory, spec: string | undefined, total: number, maxUnits: number): Promise<CapacitySum> {
  const capacity = CAPACITY[category];
  if (capacity === undefined) return { summed: false, reason: "The stromverbrauch (electricity consumption) units have no capacity in the register." };
  if (total > maxUnits) {
    return {
      summed: false,
      reason: `${total} units match, more than the ${maxUnits} read here to sum their capacity (the register has no sum of its own). Narrow the filter (a Land, a year, a capacity range) and add the parts up.`,
    };
  }
  let gross = 0;
  let net = 0;
  let units = 0;
  let withoutFigure = 0;
  // Each unit once, by its number: a page that comes back short, or a set that changes while the
  // pages are read (a unit commissioned or shut down shifts the rest), would sum other units.
  const seen = new Set<string>();
  const pages = Math.ceil(total / SUM_PAGE_SIZE);
  for (let page = 1; page <= pages && page <= MAX_PAGE; page++) {
    const { data } = await client.units(category, { page, pageSize: SUM_PAGE_SIZE, ...(spec === undefined ? {} : { filter: spec }) });
    for (const row of data) {
      const number = typeof row.MaStRNummer === "string" ? row.MaStRNummer : `row ${seen.size}`;
      if (seen.has(number)) continue;
      seen.add(number);
      units++;
      const value = row[capacity.field];
      if (typeof value === "number" && Number.isFinite(value)) gross += value;
      else withoutFigure++;
      if (typeof row.Nettonennleistung === "number" && Number.isFinite(row.Nettonennleistung)) net += row.Nettonennleistung;
    }
  }
  if (units !== total) {
    return {
      summed: false,
      reason: `${total} units match, but the register's pages held ${units} of them (a page came back short, or the set changed while it was read): no sum, never a part of one. Ask again, or narrow the filter.`,
    };
  }
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  return category === "stromerzeugung"
    ? { summed: true, unit: capacity.unit, units, gross: round(gross), net: round(net), withoutFigure }
    : { summed: true, unit: capacity.unit, units, gross: round(gross), withoutFigure };
}

// ---------------------------------------------------------------------------------------------
// searchUnits (mastr-search)

/** The input of {@link searchUnits}. */
export interface SearchUnitsInput extends UnitFilterInput {
  /** What to sort by (default: the register's order). */
  sortBy?: UnitSort | undefined;
  /** `desc` (default: largest, newest first) or `asc`. */
  order?: "asc" | "desc" | undefined;
  /** Where the page starts (default 0). */
  offset?: number | undefined;
  /** How many units (1–100, default 20). */
  limit?: number | undefined;
}

/** A unit as a list shows it: the fields a person asks about, read. */
export interface UnitSummary {
  mastrNumber: string;
  name?: string;
  status?: string;
  energySource?: string;
  /** Gross capacity in kW (stromerzeugung). */
  grossKw?: number;
  /** Net rated capacity in kW (stromerzeugung). */
  netKw?: number;
  /** The gas capacity (gaserzeugung: generation; gasverbrauch: maximum intake), no unit stated. */
  gasCapacity?: number;
  state?: string;
  district?: string;
  place?: string;
  postcode?: string;
  /** Commissioning day (YYYY-MM-DD). */
  commissioned?: string;
  /** Day of registration in the MaStR. */
  registered?: string;
  operator?: string;
  operatorNumber?: string;
}

/** The answer of {@link searchUnits}. */
export type UnitSearch =
  | { status: "ok" | "empty"; searched: UnitSearched & { sort?: string }; total: number; units: UnitSummary[]; nextOffset?: number; reason?: string; notes: string[] }
  | { status: "ambiguous"; searched: Record<string, unknown>; candidates: FilterCode[]; reason: string };

/** A register date (`/Date(ms)/`) as ISO (a day as YYYY-MM-DD), or undefined. */
function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const date = parseMsDate(value);
  return date === null ? undefined : formatMastrDate(date);
}

/** Text from the register as shown: the full-width ampersand (U+FF06) of company names as "&". */
function shown(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value.replace(/＆/g, "&") : undefined;
}

/**
 * The texts of a value that is nothing but HTML links, joined with ", " (the grid operator's
 * number comes as `<a href=…>SNB…</a>`, one link per grid operator: a large plant has several),
 * else the value as it is. One pass with a sticky pattern, so text that opens links and never
 * closes them costs a scan, not one per character.
 */
function withoutHtml(value: string): string {
  if (!/^\s*<a\b/i.test(value)) return value;
  const link = /\s*(?:,\s*)?<a\b[^>]*>([^<]*)<\/a>/iy;
  const texts: string[] = [];
  let end = 0;
  for (let match = link.exec(value); match !== null; match = link.exec(value)) {
    texts.push(match[1]!.trim());
    end = link.lastIndex;
  }
  return texts.length > 0 && /^\s*$/.test(value.slice(end)) ? texts.join(", ") : value;
}

/** The fields a list shows, read from a row of `category`. */
export function summarizeUnit(row: MastrUnit, category: UnitCategory): UnitSummary {
  const summary: UnitSummary = { mastrNumber: String(row.MaStRNummer ?? "") };
  const set = <K extends keyof UnitSummary>(key: K, value: UnitSummary[K] | undefined): void => {
    if (value !== undefined && value !== null) summary[key] = value;
  };
  set("name", shown(row.EinheitName));
  set("status", shown(row.BetriebsStatusName));
  set("energySource", shown(row.EnergietraegerName));
  if (category === "stromerzeugung") {
    if (typeof row.Bruttoleistung === "number") set("grossKw", row.Bruttoleistung);
    if (typeof row.Nettonennleistung === "number") set("netKw", row.Nettonennleistung);
  }
  const gas = category === "gaserzeugung" ? row.Erzeugungsleistung : category === "gasverbrauch" ? row.MaximaleGasbezugsLeistung : undefined;
  if (typeof gas === "number") set("gasCapacity", gas);
  set("state", shown(row.Bundesland));
  set("district", shown(row.Landkreis));
  set("place", shown(row.Ort));
  set("postcode", shown(row.Plz));
  set("commissioned", isoDate(row.InbetriebnahmeDatum));
  set("registered", isoDate(row.EinheitRegistrierungsdatum));
  set("operator", shown(row.AnlagenbetreiberName));
  set("operatorNumber", shown(row.AnlagenbetreiberMaStRNummer));
  return summary;
}

/**
 * A page of the units that match, read (see {@link summarizeUnit}), with the total. `sortBy`
 * takes the category's sort key (capacity is gross kW for stromerzeugung; stromverbrauch has
 * none). An offset that isn't a multiple of `limit` reads two of the register's pages.
 */
export async function searchUnits(client: MastrClient, input: SearchUnitsInput = {}): Promise<UnitSearch> {
  let built: BuiltFilter;
  try {
    built = await buildUnitFilter(client, input);
  } catch (err) {
    return ambiguousAnswer(err, input.category) as UnitSearch;
  }
  const { category, spec, searched } = built;
  const limit = input.limit ?? 20;
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new MastrValidationError(`Invalid limit: expected a whole number from 1 to 100, got ${String(limit)}.`);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new MastrValidationError(`Invalid offset: expected a whole number from 0 to 1000000, got ${String(offset)}.`);
  let sort: string | undefined;
  if (input.sortBy !== undefined) {
    const key = SORT_KEYS[category][input.sortBy];
    if (key === undefined) {
      const keys = Object.keys(SORT_KEYS[category]);
      throw new MastrValidationError(`Invalid sortBy: the ${category} units can't be sorted by ${input.sortBy}; they sort by ${keys.join(", ")}.`);
    }
    const order = input.order ?? "desc";
    if (order !== "asc" && order !== "desc") throw new MastrValidationError(`Invalid order: expected asc or desc, got ${JSON.stringify(cutForMessage(String(order)))}.`);
    sort = `${key}-${order}`;
  }
  const page = Math.floor(offset / limit) + 1;
  const query = { pageSize: limit, ...(spec === undefined ? {} : { filter: spec }), ...(sort === undefined ? {} : { sort }) };
  const first = await client.units(category, { ...query, page });
  let rows = first.data;
  const skip = offset - (page - 1) * limit;
  if (skip > 0 && offset + limit > page * limit && page * limit < first.total) {
    rows = rows.concat((await client.units(category, { ...query, page: page + 1 })).data);
  }
  const units = rows.slice(skip, skip + limit).map((row) => summarizeUnit(row, category));
  const next = offset + units.length;
  const notes = statusNotes(searched);
  if (category === "stromerzeugung") notes.push("grossKw/netKw are gross and net capacity in kW (divide by 1000 for MW).");
  else if (category !== "stromverbrauch") notes.push("gasCapacity: the register states no unit for it.");
  if (units.some((u) => u.operator?.startsWith("natürliche Person"))) notes.push("Operators that are natural persons are anonymised by law (natürliche Person); don't try to find out who they are.");
  const answer: UnitSearch & { status: "ok" | "empty" } = {
    status: first.total === 0 ? "empty" : "ok",
    searched: { ...searched, ...(sort === undefined ? {} : { sort }) },
    total: first.total,
    units,
    notes,
  };
  if (next < first.total) answer.nextOffset = next;
  if (first.total === 0) answer.reason = emptyReason(searched);
  else if (units.length === 0) answer.reason = `${first.total} units match; offset ${offset} is past the last of them.`;
  return answer;
}

// ---------------------------------------------------------------------------------------------
// getUnit (mastr-unit)

/** The MaStR numbers getUnit reads: the prefix, the category and the column it is filtered by. */
const NUMBER_KINDS: Record<string, { category: UnitCategory; column: string; kind: string }> = {
  SEE: { category: "stromerzeugung", column: COLUMN.unitNumber, kind: "electricity generation unit" },
  SSE: { category: "stromerzeugung", column: "MaStR-Nr. der Speichereinheit", kind: "electricity storage unit" },
  EEG: { category: "stromerzeugung", column: "MaStR-Nr. der EEG-Anlage", kind: "EEG installation" },
  KWK: { category: "stromerzeugung", column: "MaStR-Nr. der KWK-Anlage", kind: "CHP (KWK) installation" },
  SVE: { category: "stromverbrauch", column: COLUMN.unitNumber, kind: "electricity consumption unit" },
  GEE: { category: "gaserzeugung", column: COLUMN.unitNumber, kind: "gas generation or storage unit" },
  GVE: { category: "gasverbrauch", column: COLUMN.unitNumber, kind: "gas consumption unit" },
};

/** Prefixes of numbers that are no unit, and what to do instead. */
const OTHER_NUMBERS: Record<string, string> = {
  ABR: "an operator (Anlagenbetreiber): search its units with operatorNumber",
  SNB: "a grid operator (Netzbetreiber): search with the raw filter \"MaStR-Nr. des Anschluss-Netzbetreibers~eq~'SNB…'\"",
  SEL: "an electricity generation location: search with the raw filter \"MaStR-Nr. der Lokation~eq~'SEL…'\"",
  SVL: "an electricity consumption location: search category stromverbrauch with the raw filter \"MaStR-Nr. der Lokation~eq~'SVL…'\"",
  GEL: "a gas generation location: search category gaserzeugung with the raw filter \"MaStR-Nr. der Lokation~eq~'GEL…'\"",
  GVL: "a gas consumption location: search category gasverbrauch with the raw filter \"MaStR-Nr. der Lokation~eq~'GVL…'\"",
};

/** The input of {@link getUnit}. */
export interface GetUnitInput {
  /** The MaStR number: SEE…, SSE…, EEG…, KWK…, SVE…, GEE… or GVE… with 12 digits. */
  mastrNumber: string;
}

/** The answer of {@link getUnit}. */
export type UnitRecord =
  | { status: "ok"; searched: { mastrNumber: string; category: UnitCategory; kind: string }; unit: UnitSummary; record: Record<string, unknown>; notes: string[] }
  | { status: "ambiguous"; searched: { mastrNumber: string; category: UnitCategory; kind: string }; total: number; candidates: UnitSummary[]; reason: string }
  | { status: "empty"; searched: { mastrNumber: string; category: UnitCategory; kind: string }; reason: string };

/**
 * A row as shown whole: dates as ISO (days as YYYY-MM-DD, instants in German time), the grid
 * operator's number without its HTML link, "＆" as "&", and the empty fields left out.
 */
export function readRecord(row: MastrUnit): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "string") {
      record[key] = isoDate(value) ?? withoutHtml(shown(value) ?? value);
    } else {
      record[key] = value;
    }
  }
  return record;
}

/** What a record's reader must know: capacity units, anonymised and withheld data. */
function recordNotes(row: MastrUnit, category: UnitCategory): string[] {
  const notes: string[] = [];
  if (category === "stromerzeugung") notes.push("Bruttoleistung and Nettonennleistung are gross and net capacity in kW (divide by 1000 for MW); say which one you give.");
  if (category === "gaserzeugung") notes.push("Gas storage: MaxEinspeicherleistung/MaxAusspeicherleistung in kWh/h, MaxArbeitsvolumen in kWh; Erzeugungsleistung has no unit stated in the register.");
  if (category === "gasverbrauch") notes.push("MaximaleGasbezugsLeistung has no unit stated in the register; don't call it kW.");
  if (category === "stromverbrauch") notes.push("Electricity consumption units carry no capacity in the register.");
  const operator = typeof row.AnlagenbetreiberName === "string" ? row.AnlagenbetreiberName : "";
  if (operator.startsWith("natürliche Person") || row["IsAnonymisiert"] === true) {
    notes.push("The operator is a natural person and anonymised by law; don't try to find out who it is.");
  }
  if (row.Breitengrad === null || row.Breitengrad === undefined) {
    notes.push("The exact location (street, coordinates) is withheld or missing: the register publishes it only for larger units (by law, not a gap in the data).");
  }
  return notes;
}

/**
 * One unit by its MaStR number, read: the prefix names the category (SEE/SSE/EEG/KWK
 * electricity generation, SVE consumption, GEE gas generation and storage, GVE gas consumption),
 * the number is looked up with the register's filter (there is no by-id endpoint). An installation
 * number (EEG, KWK) that covers several units is `ambiguous` with them; no match is `empty`
 * naming the number and the dataset searched. Another kind of number (an operator's ABR…, a
 * location) is a validation error saying how to search for it.
 */
export async function getUnit(client: MastrClient, input: GetUnitInput): Promise<UnitRecord> {
  const number = textInput("mastrNumber", input.mastrNumber).replace(/\s+/g, "").toUpperCase();
  const prefix = number.slice(0, 3);
  const other = OTHER_NUMBERS[prefix];
  if (other !== undefined && /^[A-Z]{3}\d{12}$/.test(number)) {
    throw new MastrValidationError(`Invalid mastrNumber: ${number} is the number of ${other}.`);
  }
  const kind = NUMBER_KINDS[prefix];
  if (kind === undefined || !/^[A-Z]{3}\d{12}$/.test(number)) {
    throw new MastrValidationError(
      `Invalid mastrNumber: expected a unit's MaStR number, three letters (${Object.keys(NUMBER_KINDS).join(", ")}) and 12 digits, like SEE984033548619; got ${JSON.stringify(cutForMessage(number))}.`,
    );
  }
  const searched = { mastrNumber: number, category: kind.category, kind: kind.kind };
  // The same columns the client checks the filter against (kept, no request of its own), checked.
  await columnsOf(client, kind.category);
  const filter = buildFilter([{ name: kind.column, op: "eq", value: number }]);
  const { total, data } = await client.units(kind.category, { filter, pageSize: 10 });
  if (total === 0 || data.length === 0) {
    return {
      status: "empty",
      searched,
      reason: `No ${kind.kind} with the number ${number} in the register's ${kind.category} units (any status). Check the number: three letters and 12 digits, as the register's pages or another answer give it.`,
    };
  }
  if (data.length > 1) {
    return {
      status: "ambiguous",
      searched,
      total,
      candidates: data.map((row) => summarizeUnit(row, kind.category)),
      reason: `The ${kind.kind} ${number} comprises ${total} units: say which one (call again with its SEE number), or describe them all.`,
    };
  }
  const row = data[0]!;
  return { status: "ok", searched, unit: summarizeUnit(row, kind.category), record: readRecord(row), notes: recordNotes(row, kind.category) };
}
