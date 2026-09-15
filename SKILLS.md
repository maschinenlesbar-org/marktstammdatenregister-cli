# Skills

`marktstammdatenregister-cli` ships **Claude Code Agent Skills** as a Claude Code
plugin, so Claude can drive the `mastr` CLI for common energy-register tasks. The
skills **validate** that the `mastr` CLI is on your PATH and tell you if it is missing
— they never install anything.

| Skill | Use it when you want to… |
|---|---|
| **mastr-search** | Search and count units — "how many solar plants in Germany?", list wind turbines, page through a category, get a match total. |
| **mastr-filters** | Build the `--filter`/`--sort` spec — resolve the German field names and dropdown codes the register needs (the arcane part). |
| **mastr-unit** | Read a unit record — capacity, energy carrier, status, location, the `/Date(ms)/` dates, and the anonymised/withheld-data caveats. |

They compose: **mastr-filters → mastr-search → mastr-unit**.

## Requirements

- The `mastr` CLI on PATH: `npm install -g @maschinenlesbar.org/marktstammdatenregister-cli`.
- **No API key** — the public MaStR search is open.
- **Notes:** filtering uses the register's own `FilterName~op~'value'` syntax (a wrong
  field name is silently ignored — verify with `mastr filters` and `--total`; a wrong
  operator returns 0 rows, and ranges use the strict `gt`/`lt`); a sort key is a record
  field name such as `Bruttoleistung`, not a FilterName (a wrong one returns 0 rows); dates
  come as `/Date(ms)/` (use `--iso-dates`); there is no server-side capacity sum, only
  the `--total` count.

## Installing the plugin

This repo is a Claude Code plugin (`.claude-plugin/plugin.json` + `skills/`),
published as `mastr` in the
[maschinenlesbar.org plugin marketplace](https://github.com/maschinenlesbar-org/plugins).
Install it inside Claude Code to enable the three skills:

```
/plugin marketplace add maschinenlesbar-org/plugins
/plugin install mastr@maschinenlesbar
```

The `skills/` and `.claude-plugin/` files are **not** shipped in the npm tarball — the
published package is the client/CLI only.

The data these skills surface is the Bundesnetzagentur's, under **DL-DE-BY-2.0**
(attribution required) — see [DATA_LICENSE.md](DATA_LICENSE.md). Cite the source.
