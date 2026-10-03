// Test helpers: build canned HTTP responses and a recording mock transport based
// on Node's built-in `node:test` mock facility. No real network is ever touched
// in the unit suite.

import { mock } from "node:test";
import type { Transport, HttpRequest, HttpResponse } from "../src/client/http.js";
import { run } from "../src/cli/run.js";
import { defaultDeps } from "../src/cli/program.js";
import type { CliDeps } from "../src/cli/io.js";

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

// ---- CLI <-> library parity ----

/** What the CLI did with one argv: exit code, captured output, requests sent. */
export interface CliOutcome {
  code: number;
  out: string;
  err: string;
  requests: HttpRequest[];
}

/** What the library call did: its value or error, and the requests it sent. */
export type LibOutcome =
  | { ok: true; value: unknown; requests: HttpRequest[] }
  | { ok: false; error: unknown; requests: HttpRequest[] };

/**
 * Drive one input through the CLI (`run(argv)` with the real `defaultDeps`, only the
 * transport and the I/O swapped) and through a library call, on ONE recording mock
 * transport, and return both outcomes. A synchronous throw in `call` (a constructor
 * rejecting an option) is captured like a rejected promise. Parity means: both
 * reject and neither sent a request, or both sent the identical requests.
 *
 *   const { cli, lib } = await parity(["stromerzeugung", "--sort", " "],
 *     (transport) => new MastrClient({ transport }).stromerzeugung({ sort: " " }));
 */
export async function parity(
  argv: string[],
  call: (transport: Transport) => unknown,
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () =>
    jsonResponse({ Data: [], Total: 0, Errors: null }),
): Promise<{ cli: CliOutcome; lib: LibOutcome }> {
  const mt = makeMockTransport(responder);
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    ...defaultDeps,
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) => defaultDeps.createClient({ ...opts, transport: mt.transport }),
  };
  const code = await run(argv, deps);
  const cli: CliOutcome = { code, out: out.join("\n"), err: err.join("\n"), requests: mt.calls.slice() };

  const before = mt.calls.length;
  let lib: LibOutcome;
  try {
    const value: unknown = await call(mt.transport);
    lib = { ok: true, value, requests: mt.calls.slice(before) };
  } catch (error) {
    lib = { ok: false, error, requests: mt.calls.slice(before) };
  }
  return { cli, lib };
}

/** The method + URL + headers of each request, for comparing the two sides. */
export function requestShapes(requests: HttpRequest[]): { method: string; url: string; headers: unknown }[] {
  return requests.map((r) => ({ method: r.method, url: r.url, headers: r.headers }));
}
