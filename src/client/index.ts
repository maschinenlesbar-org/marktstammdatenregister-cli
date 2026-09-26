// Public entry point for the API client library.

export { MastrClient, parseMsDate, isoifyDates } from "./client.js";
export type { MastrClientOptions } from "./client.js";
export { filterProblem, validateFilter } from "./filter.js";
export { RequestEngine, DEFAULT_BASE_URL, describeMastrErrors, sanitizeServerText } from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  MastrError,
  MastrApiError,
  MastrNetworkError,
  MastrValidationError,
  MastrParseError,
} from "./errors.js";

export * from "./types.js";
