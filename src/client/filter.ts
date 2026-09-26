// Checks for MaStR filter specs (`FilterName~op~'value'~and~…`), shared by the
// client (library callers) and the CLI's `--filter` parser. The register never
// reports a filter it misreads: it answers with a plausible but wrong count, so the
// forms it is known to misread are refused before any request.

import { MastrValidationError } from "./errors.js";

/**
 * Describe why the register would misread a filter spec, or return `undefined` when
 * the spec is fine.
 *
 * `~or~` is refused: the live search keeps only the part before the first `~or~` and
 * drops every later condition without an error (checked 2026-09-26: wind `2497` alone
 * 43633, `2497~or~…2498` also 43633). An OR between codes of one dropdown column works
 * as a comma list inside one value: `Energieträger~eq~'2497,2498'` (52448 = 43633 + 8815).
 */
export function filterProblem(spec: string): string | undefined {
  const parts = spec.split("~");
  if (parts.some((part) => part.toLowerCase() === "or")) {
    return (
      '"~or~" is not supported: the register ignores everything after the first ~or~ and ' +
      "returns a wrong count. For several codes of one dropdown column, list them in one " +
      "value: Energieträger~eq~'2497,2498'."
    );
  }
  return undefined;
}

/** Throw a {@link MastrValidationError} if {@link filterProblem} finds a problem. */
export function validateFilter(spec: string): void {
  const problem = filterProblem(spec);
  if (problem !== undefined) throw new MastrValidationError(`Invalid filter: ${problem}`);
}
