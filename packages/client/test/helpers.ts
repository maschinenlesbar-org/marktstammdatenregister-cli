// Test helpers: build canned HTTP responses and a recording mock transport based
// on Node's built-in `node:test` mock facility. No real network is ever touched
// in the unit suite.

import { mock } from "node:test";
import type { Transport, HttpRequest, HttpResponse } from "../src/http.js";
import * as fx from "./fixtures.js";

export function jsonResponse(body: unknown, status = 200): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

export function rawResponse(data: string | Buffer, contentType: string, status = 200): HttpResponse {
  return {
    status,
    headers: { "content-type": contentType },
    body: Buffer.isBuffer(data) ? data : Buffer.from(data),
  };
}

/** True for a request to a `GetFilterColumns…` endpoint (the client's filter check). */
export function isColumnsRequest(req: HttpRequest): boolean {
  return new URL(req.url).pathname.includes("/GetFilterColumns");
}

/**
 * `responder` for the unit requests, with the filter-columns requests the client makes to
 * check a filter answered by `columns` (the fixture's columns by default).
 */
export function withColumns(
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
  columns: unknown = fx.filterColumns,
): (req: HttpRequest) => HttpResponse | Promise<HttpResponse> {
  return (req) => (isColumnsRequest(req) ? jsonResponse(columns) : responder(req));
}

/** The unit requests among `requests` (without the filter-columns requests). */
export function unitRequests(requests: readonly HttpRequest[]): HttpRequest[] {
  return requests.filter((req) => !isColumnsRequest(req));
}

/**
 * A responder that answers like the register: the unit envelope `page` with its rows cut to
 * the request's `pageSize` (the client rejects a page with more rows than asked for), and
 * the fixture's filter columns for the client's filter check.
 */
export function registerResponder(page: { Data: unknown[] | null; [key: string]: unknown }) {
  return (req: HttpRequest): HttpResponse => {
    if (isColumnsRequest(req)) return jsonResponse(fx.filterColumns);
    const pageSize = Number(new URL(req.url).searchParams.get("pageSize") ?? "25");
    return jsonResponse({ ...page, Data: page.Data === null ? null : page.Data.slice(0, pageSize) });
  };
}

export interface MockTransport {
  transport: Transport;
  /** All requests the transport has received, in order. */
  readonly calls: HttpRequest[];
  /** The most recent request. */
  last(): HttpRequest;
}

/**
 * Build a mock transport from a responder function. The returned object records
 * every request so tests can assert on method/url/headers.
 */
export function makeMockTransport(
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): MockTransport {
  const calls: HttpRequest[] = [];
  const fn = mock.fn(async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    return responder(req);
  });
  return {
    transport: fn as unknown as Transport,
    calls,
    last: () => {
      const c = calls[calls.length - 1];
      if (!c) throw new Error("mock transport has not been called");
      return c;
    },
  };
}

/** Parse the query string of a recorded request URL into a URLSearchParams. */
export function queryOf(req: HttpRequest): URLSearchParams {
  return new URL(req.url).searchParams;
}
