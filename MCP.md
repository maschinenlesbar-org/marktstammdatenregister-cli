# mastr-mcp

An [MCP](https://modelcontextprotocol.io/) server for the
[Marktstammdatenregister](https://www.marktstammdatenregister.de/MaStR) (MaStR), the
Bundesnetzagentur's register of every unit of the German electricity and gas market (about 9
million: solar, wind, storage, power plants, large consumers, gas generation, storage and
consumption), as tools for AI agents: counts, searches and unit records by name. Read-only, no
API key. The data is under the Datenlizenz Deutschland – Namensnennung 2.0 (see Licence).

It is the MCP side of [marktstammdatenregister-cli](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/marktstammdatenregister-mcp
```

This installs the **`mastr-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/marktstammdatenregister-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add mastr -- mastr-mcp
# or with the image:
claude mcp add mastr -- docker run -i --rm ghcr.io/maschinenlesbar-org/marktstammdatenregister-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "mastr": { "command": "mastr-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "mastr": { "type": "stdio", "command": "mastr-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
mastr-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http mastr http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/marktstammdatenregister-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/releases) instead of
`latest`: `…/marktstammdatenregister-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/marktstammdatenregister-mcp:<version> --repo maschinenlesbar-org/marktstammdatenregister-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `countUnits` | How many units match: energy source and Land by name (Wind, Solar, Bayern, NRW), place, postcode, operator, capacity and commissioning bounds; a count per Bundesland or Energieträger (`by`; `Land` is the country); the capacity summed for a set small enough to read. |
| `searchUnits` | The matching units a page at a time, sorted by capacity or date: MaStR number, name, status, energy source, gross and net kW, place, commissioning day, operator. |
| `getUnit` | One unit by its MaStR number (SEE, SSE, SVE, GEE, GVE; EEG and KWK installations), every published field read: ISO dates, the grid operator's number without HTML. |
| `findFilterCodes` | The register's German column names, their operators and the dropdown codes it needs instead of labels, with the category's sort keys. |

The register keeps every unit ever registered, so the tools count and list units in operation
(In Betrieb) unless asked for planned or shut-down ones, and every answer says which status it
counted. Names become the register's codes; a name that fits several codes is reported with the
candidates, never guessed. Capacity and date bounds are inclusive (the register's own `gt`/`lt`
are strict). The register can't sum: `countUnits` reads the matching units and sums their
capacity only up to `--max-pages` × 2,000 units (20,000 by default), and says so beyond. Capacity
is in kW for electricity generation; the gas figures have no unit stated in the register.
Operators that are natural persons are anonymised by law, and small units' locations withheld.

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from (whole, never cut like the data) and the data licence. A text over 2000
characters is cut and ends in `…[cut, N characters in all]`, and the answer says `truncated`. An
answer over `--max-result-chars` first loses entries from the end of its page (then `nextOffset`
says where to go on), then has its longest texts cut further (each with that mark) or, when that
isn't enough, its other lists shortened (`reason` names them); a list keeps its first entry, `notes`
stay whole, and the answer says `truncated`. One that can't be cut down so far is a tool error that
says to ask for less. A failure is a tool error that says what to change (one over 5000 characters
loses its middle, never its end, where the reason is).

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API base URL (default https://www.marktstammdatenregister.de/MaStR)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value (Latin-1, one line)
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages; a page on one of
  those origins gets CORS (its preflight answered, the answers readable). With `--auth-token-file
  <path>` every request must send `Authorization: Bearer <token>` (the file holds one token of at
  least 32 characters, mode 600, owned by the user the server runs as, a regular file (a FIFO is
  refused at once, never waited on); read once at start; `(umask 077; openssl rand -hex 32 >
  mcp-token)` makes one); anything else is answered 401. Exposed beyond localhost (it logs a warning
  then), it belongs behind a proxy that authenticates or at least terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses the requests to a host that answers HTTP 429 (as long as its Retry-After
  asks, at most 30 s; those to another host go on), and stops a tool call after its deadline (a tool
  that has read part of its answer by then may answer with that part, and says so). A request those
  limits would hold longer than it or its call may wait is not sent: the call fails at once, naming
  the limit and when to ask again (and the log says so).
- **Results are data.** Text from the API, keys included, is cleaned (control, bidi, zero-width, tag
  and other invisible characters removed, but an emoji keeps its joiners; a key that cleaning makes
  equal to another stays, as `name~2`), but it is still other people's text: a model can be told
  things in it. The server can't act on that (it has no tool that writes), but other tools in the
  same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new connection
  and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal ends it at
  once. On stdio a signal ends it at once; when stdin ends, it first answers the requests it has
  read (each within its call deadline), then exits.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol. A call that fails
  upstream or reaches its deadline leaves a WARN record naming the tool.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/blob/main/LICENSING.md)).
Data: the Bundesnetzagentur's Marktstammdatenregister, under the
[Datenlizenz Deutschland – Namensnennung – Version 2.0](https://www.govdata.de/dl-de/by-2-0)
(dl-de/by-2-0): commercial and non-commercial use, copying, distribution and modification are
allowed, provided the source is credited
([DATA_LICENSE.md](https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/blob/main/DATA_LICENSE.md)).
Every result carries that attribution in its `licence` field ("Datenquelle: Marktstammdatenregister
der Bundesnetzagentur", the licence and its link), with "eigene Bearbeitung": the tools count, sum
and read the data; add the day of retrieval when you publish it. Data of natural persons and
confidential data are not published by law; never try to re-identify them. We provide the tool,
not the data.
