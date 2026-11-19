// Test helpers of this server's own tests and the adapters of the conformance tests: a mock of the
// register (the client's register.ts: the live filter columns of 2026-11-19 and live-shaped unit
// rows, filtered, sorted and paged the way the register does it), and the client's transport
// helpers. The generic harness (a connection, a config, a log recorder, the HTTP server) is
// harness.ts.

import { makeMockTransport, type MockTransport } from "@maschinenlesbar.org/marktstammdatenregister-client/test/helpers";
import { registerOf, sampleRegister } from "@maschinenlesbar.org/marktstammdatenregister-client/test/register";
import type { MastrUnit } from "@maschinenlesbar.org/marktstammdatenregister-client";

export * from "@maschinenlesbar.org/marktstammdatenregister-client/test/helpers";
export * from "@maschinenlesbar.org/marktstammdatenregister-client/test/register";

/** A mock transport on the register with `rows` (the sample register by default). */
export function mastr(rows: MastrUnit[] = sampleRegister()): MockTransport {
  return makeMockTransport(registerOf(rows));
}
