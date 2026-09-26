// Command group for the MaStR CLI: one command per unit category (electricity /
// gas × generation / consumption), each a paged, optionally-filtered search, plus a
// `filters` command to discover the filterable columns and their dropdown codes.

import { Argument, type Command } from "commander";
import type { CliDeps } from "../io.js";
import { MAX_PAGE, MAX_PAGE_SIZE, type MastrClient } from "../../client/client.js";
import type { UnitCategory, UnitQuery } from "../../client/types.js";
import { action, parseBoundedInt, parseFilter, parseNonEmpty, renderJson } from "../shared.js";

// `sortKey` is a record field that exists in that category's rows (live 2026-09-26):
// only stromerzeugung rows carry Bruttoleistung/Nettonennleistung, so the stderr hint
// must not suggest it for the other three.
const CATEGORIES: { name: UnitCategory; desc: string; sortKey: string }[] = [
  { name: "stromerzeugung", desc: "Electricity-generation units (Stromerzeugung)", sortKey: "Bruttoleistung" },
  { name: "stromverbrauch", desc: "Electricity-consumption units (Stromverbrauch)", sortKey: "InbetriebnahmeDatum" },
  { name: "gaserzeugung", desc: "Gas-generation units (Gaserzeugung)", sortKey: "Erzeugungsleistung" },
  { name: "gasverbrauch", desc: "Gas-consumption units (Gasverbrauch)", sortKey: "MaximaleGasbezugsLeistung" },
];

const RUN: Record<UnitCategory, (c: MastrClient, q: UnitQuery) => ReturnType<MastrClient["units"]>> = {
  stromerzeugung: (c, q) => c.stromerzeugung(q),
  stromverbrauch: (c, q) => c.stromverbrauch(q),
  gaserzeugung: (c, q) => c.gaserzeugung(q),
  gasverbrauch: (c, q) => c.gasverbrauch(q),
};

/** Build a UnitQuery from this command's parsed options. */
function buildQuery(opts: Record<string, unknown>): UnitQuery {
  const q: UnitQuery = {};
  if (typeof opts["page"] === "number") q.page = opts["page"];
  if (typeof opts["pageSize"] === "number") q.pageSize = opts["pageSize"];
  if (typeof opts["sort"] === "string") q.sort = opts["sort"];
  if (typeof opts["filter"] === "string") q.filter = opts["filter"];
  // `--total` needs only the match count (returned regardless of page size), so
  // request a single row instead of fetching and discarding a full page.
  if (opts["total"] === true) q.pageSize = 1;
  return q;
}

export function registerCommands(program: Command, deps: CliDeps): void {
  for (const cat of CATEGORIES) {
    program
      .command(cat.name)
      .description(cat.desc)
      .option("--page <n>", "1-based page number", parseBoundedInt(1, MAX_PAGE), 1)
      .option("--page-size <n>", `rows per page (1..${MAX_PAGE_SIZE})`, parseBoundedInt(1, MAX_PAGE_SIZE), 25)
      .option(
        "--sort <spec>",
        "sort: FieldKey-asc | FieldKey-desc, where FieldKey is a record field name, not a " +
          `FilterName (e.g. ${cat.sortKey}-desc)`,
        parseNonEmpty,
      )
      .option(
        "--filter <spec>",
        "filter: FilterName~op~'value'~and~… (see `filters`; ops eq|neq|sw|ct|nct|ew|null|nn|gt|lt, " +
          "gt/lt strict; null/nn take ''). A malformed spec or unknown op is rejected. No ~or~: " +
          "for several dropdown codes use one comma list, e.g. Energieträger~eq~'2497,2498'",
        parseFilter,
      )
      .option("--total", "print only the total match count, not the rows")
      .action(
        action(deps, async ({ client, global, opts }) => {
          const page = await RUN[cat.name](client, buildQuery(opts));
          // An unknown --sort key or --filter operator makes the server return 0 rows
          // (not an error), which reads like "no matches". Nudge the user toward the
          // likely cause. Sort keys are the record's field names (`Bruttoleistung`);
          // the FilterNames from `mastr filters` ("Bruttoleistung der Einheit") don't sort.
          if (page.total === 0 && typeof opts["sort"] === "string") {
            deps.io.err(
              "Note: 0 results with --sort set. If you expected matches, an unknown sort " +
                `key returns 0 rows. Sort keys are record field names (e.g. ${cat.sortKey}), ` +
                "not the FilterNames from `mastr filters`; list them with " +
                `\`mastr ${cat.name} --page-size 1 --compact | jq '.data[0] | keys'\`.`,
            );
          }
          // An unknown operator is already a usage error (filterProblem); what is left
          // that silently gives 0 rows is a value the register can't match.
          if (page.total === 0 && typeof opts["filter"] === "string") {
            deps.io.err(
              "Note: 0 results with --filter set. If you expected matches, check the values: a " +
                "dropdown takes its code (the Value from `mastr filters`), not its label, decimals " +
                "take a point ('4999.999'), and gt/lt are strict.",
            );
          }
          renderJson(deps, global, opts["total"] === true ? page.total : page);
        }),
      );
  }

  program
    .command("filters")
    .description("List the filterable columns (names, types, dropdown codes) for a category")
    .addArgument(
      new Argument("<category>", "unit category").choices(CATEGORIES.map((c) => c.name)),
    )
    .action(
      action(deps, async ({ client, global }, [category]) => {
        renderJson(deps, global, await client.filterColumns(category as UnitCategory));
      }),
    );
}
