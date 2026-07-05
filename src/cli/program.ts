// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { MastrClient } from "../client/client.js";
import { parseIntArg, parseBoundedInt, parseHeaderValue, parseNonEmpty } from "./shared.js";
import { registerCommands } from "./commands/units.js";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new MastrClient(options),
};

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("mastr")
    .description(
      "CLI for the Marktstammdatenregister (MaStR) — the Bundesnetzagentur's register " +
        "of the German electricity & gas market (~9M generation/consumption units). No " +
        "API key needed. Each command searches one dataset, paged with --page/--page-size " +
        "and narrowed with --filter (see `filters` for the field names and codes). Use " +
        "--total for just the match count, and --iso-dates to convert /Date(…)/ timestamps.",
    )
    .version(VERSION)
    .option(
      "--base-url <url>",
      "API base URL",
      parseNonEmpty,
      "https://www.marktstammdatenregister.de/MaStR",
    )
    .option("--timeout <ms>", "per-request timeout in ms (0 = no timeout)", parseIntArg)
    .option("--user-agent <ua>", "User-Agent header value", parseHeaderValue)
    .option("--max-retries <n>", "retries for transient 429/503 responses (0..10)", parseBoundedInt(0, 10))
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .option("--iso-dates", "rewrite MaStR /Date(ms)/ timestamps to ISO-8601")
    .showHelpAfterError();

  registerCommands(program, deps);

  return program;
}
