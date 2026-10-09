// Command group for the MaStR CLI: one command per unit category (electricity /
// gas × generation / consumption), each a paged, optionally-filtered search, plus a
// `filters` command to discover the filterable columns and their dropdown codes.

import { Argument, type Command } from "commander";
import { logOf, type CliDeps } from "../io.js";
import { MAX_PAGE, MAX_PAGE_SIZE, type MastrClient } from "../../client/client.js";
import type { CountQuery, UnitCategory, UnitQuery } from "../../client/types.js";
import { action, once, parseBoundedInt, parseFilter, parseSort, renderJson } from "../shared.js";

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

/** Build a CountQuery (filter and sort) from this command's parsed options. */
function buildCountQuery(opts: Record<string, unknown>): CountQuery {
  const q: CountQuery = {};
  if (typeof opts["sort"] === "string") q.sort = opts["sort"];
  if (typeof opts["filter"] === "string") q.filter = opts["filter"];
  return q;
}

/** Build a UnitQuery from this command's parsed options. */
function buildQuery(opts: Record<string, unknown>): UnitQuery {
  const q: UnitQuery = buildCountQuery(opts);
  if (typeof opts["page"] === "number") q.page = opts["page"];
  if (typeof opts["pageSize"] === "number") q.pageSize = opts["pageSize"];
  return q;
}

export function registerCommands(program: Command, deps: CliDeps): void {
  for (const cat of CATEGORIES) {
    program
      .command(cat.name)
      .description(cat.desc)
      .option("--page <n>", "1-based page number", once("--page", parseBoundedInt(1, MAX_PAGE)), 1)
      .option(
        "--page-size <n>",
        `rows per page (1..${MAX_PAGE_SIZE})`,
        once("--page-size", parseBoundedInt(1, MAX_PAGE_SIZE)),
        25,
      )
      .option(
        "--sort <spec>",
        "sort: FieldKey-asc | FieldKey-desc, where FieldKey is a record field name, not a " +
          `FilterName (e.g. ${cat.sortKey}-desc)`,
        once("--sort", parseSort),
      )
      .option(
        "--filter <spec>",
        "filter: FilterName~op~'value'~and~… (see `filters`; ops eq|neq|sw|ct|nct|ew|null|nn|gt|lt, " +
          "gt/lt strict; null/nn take ''). A malformed spec, an unknown op, a FilterName the " +
          "category doesn't have or a dropdown code it doesn't list is rejected. Repeatable: " +
          "several --filter are joined with ~and~. No ~or~: for several dropdown codes use one " +
          "comma list, e.g. Energieträger~eq~'2497,2498'",
        parseFilter,
      )
      .option(
        "--total",
        "print only the total match count, not the rows (a one-row request; --page and --page-size are ignored)",
      )
      .action(
        action(deps, async ({ client, global, opts }) => {
          // `--total` is the library's count(): a one-row request for the match count.
          const total =
            opts["total"] === true
              ? await client.count(cat.name, buildCountQuery(opts))
              : undefined;
          const page = total === undefined ? await RUN[cat.name](client, buildQuery(opts)) : { total };
          // 0 rows read like "no matches". An unknown --sort key used to give 0 rows; the
          // register refused one with {"Error":true} on 2026-10-09 (an ERROR naming the sort
          // key, from the library), but a 0 after adding --sort is still worth a look.
          // Sort keys are the record's field names (`Bruttoleistung`); the FilterNames
          // from `mastr filters` ("Bruttoleistung der Einheit") don't sort.
          if (page.total === 0 && typeof opts["sort"] === "string") {
            logOf(deps).info(
              "api",
              "0 results with --sort set. If you expected matches, check the sort key: " +
                `sort keys are record field names (e.g. ${cat.sortKey}), ` +
                "not the FilterNames from `mastr filters`; list them with " +
                `\`mastr ${cat.name} --page-size 1 --compact | jq '.data[0] | keys'\`.`,
            );
          }
          // An unknown operator, FilterName or dropdown code is already a usage error; what
          // is left that silently gives 0 rows is a value the register can't match.
          if (page.total === 0 && typeof opts["filter"] === "string") {
            logOf(deps).info(
              "api",
              "0 results with --filter set. If you expected matches, check the values: eq " +
                "on a text column matches the whole text (ct matches a part), decimals take a " +
                "point ('4999.999'), and gt/lt are strict.",
            );
          }
          renderJson(deps, global, total ?? page);
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
