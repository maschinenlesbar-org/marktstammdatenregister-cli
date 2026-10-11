#!/usr/bin/env node
// Bin shim: parse argv, run the CLI, and set the process exit code. All real
// logic lives in run.ts (testable without spawning a subprocess).

import { handleOutputErrors } from "./io.js";
import { installWarningLog } from "./log.js";
import { processLogger, run } from "./run.js";

const argv = process.argv.slice(2);
// What happens outside run() is logged too, in the format argv asks for.
const log = processLogger(argv);
installWarningLog(process, log);
// Before run(): a reader that closes the pipe early (`| head`) must not end in a stack trace.
handleOutputErrors(process, undefined, log);
run(argv).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // run() reports its own errors; this is the last resort, a log record all the same.
    log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
