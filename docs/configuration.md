# Configuration: CLI flags & environment variables

Full reference for configuring the [Zendesk MCP Server](../README.md): the CLI
flags and the environment variables. Each variable has its own anchor, so you can
deep-link a specific setting (e.g.
[`docs/configuration.md#zendesk_max_attachment_bytes`](#zendesk_max_attachment_bytes)).

CLI flags generally take precedence over the matching environment variable. The
one exception is `--cors-origin`, which is additive and *extends* `CORS_ORIGIN`
rather than replacing it. The server uses per-user OAuth 2.1 PKCE by default on
every transport; a static API-token mode exists as a stdio-only escape hatch
(see [What this server does *not* do](../README.md#what-this-server-does-not-do)
and [`docs/api-token-stdio.md`](api-token-stdio.md)).

## CLI reference

```
zendesk-mcp-server <subdomain> [options]

Options:
  --mode <mode>           single | namespace (default) | all
  --namespace <ns>        Filter by namespace (repeatable): tickets, help_center,
                          users, admin (admin exists only with --export-dir)
  --tool <name>           Filter by tool name (repeatable, forces --mode all)
  --read-only             Only expose read operations (stdio OAuth: also sign
                          in with Zendesk's read scopes only)
  --no-topology           Disable the Help Center structural context
                          (instructions + zendesk-hc://topology resource)
  --no-promoted-articles  Disable the promoted-article PRE-LISTING (the
                          <scheme>://article/{id} list scan + the
                          list_promoted_articles tool). Reading a known
                          article by id stays available.
  --hc-resource-scheme <scheme>
                          URI scheme of the Help Center resources
                          (default: zendesk-hc, i.e. zendesk-hc://topology);
                          bare RFC 3986 scheme, e.g. "wiki" — no "://"
  --log-level <level>     debug | info (default) | warn | error
  --transport <t>         stdio (default) | http
  --host <host>           HTTP bind host (default: 0.0.0.0)
  --port <port>           HTTP bind port (default: 3000; 0 = OS-assigned)
  --public-url <url>      Public URL clients use to reach the server (HTTP mode,
                          required behind a TLS reverse proxy)
  --cors-origin <url>     Extra browser origin allowed by CORS (repeatable;
                          adds to the default allowlist of major web MCP
                          clients + localhost-any-port)
  --callback-port <port>  Local OAuth callback port for stdio (default 27439)
  --export-dir <path>     Absolute local directory for export_account_config
                          snapshots; enables the admin namespace (stdio only)
  --dev                   Dev-only: expose a reload_tools tool that hot-reloads
                          edited tool code on demand (stdio only; see "Dev mode"
                          below)
```

`--namespace` and `--read-only` are applied before the proxies are registered, so they narrow the surface in every mode. In the default `namespace` mode, `--namespace help_center` registers a single proxy (`zendesk_help_center`) instead of the full set of namespace proxies.

### Read-only all the way to Zendesk

Over stdio with OAuth, `--read-only` also signs in with read scopes only
(`read side_conversations:read`) instead of the read-write set, so Zendesk itself
rejects any write made with the token, not just the write tools this server knows
about. The read-scoped token lives in
its own file (`<subdomain>.read.json`, next to the read-write `<subdomain>.json`),
so a read-only and a read-write server on the same subdomain each keep their own
sign-in. A read-only server refuses any token it cannot prove is read-scoped,
such as one persisted by an older version or a read-write file reached through
[`ZENDESK_TOKEN_FILE`](#zendesk_token_file), and signs in afresh instead.

### OAuth scopes

| Mode | Requested scope |
| ---- | --------------- |
| default (read-write) | `read write side_conversations:read side_conversations:write` |
| `--read-only` | `read side_conversations:read` |

Side conversations sit outside the global `read` and `write` scopes: the
[Side Conversations API reference](https://developer.zendesk.com/api-reference/ticketing/side_conversation/side_conversation/)
lists `side_conversations:read` and `side_conversations:write` as the scopes its
endpoints accept, and a token holding only `read` gets HTTP 403 there (the
`side_conversation_events` stream of [`export-data`](#bulk-data-export-export-data)).
A token signed in before these scopes were requested keeps working for everything
else, so no running session is forced to sign in again; re-authorize it with
[`login`](#re-authorize-login) when you need side conversations.

The scope cannot narrow two credentials the server does not mint: a static API
token ([`docs/api-token-stdio.md`](api-token-stdio.md)) always carries its
issuer's full rights, and over HTTP the client brings its own bearer. There,
`--read-only` narrows the tool surface only.

### A malformed invocation fails at startup

The server refuses to boot rather than run with config it cannot honour. These
shapes are rejected, each naming the knob at fault:

| Invocation | Why it is rejected |
| --- | --- |
| `--mode` (nothing after it) | the value was forgotten |
| `--mode ""` or `--mode=` | an empty value, typically `--mode "$VAR"` with `VAR` unset |
| `--host --read-only` | the value is another flag, so `--host` would swallow it |
| `--read-only=false` | a standalone flag takes no value |
| `--moed all` | an unknown flag. A typo is not silently ignored |
| `mycompany extra` | a second positional argument, so one of them would be dropped |

Values are never echoed back in these messages, so an unsupported flag written
as `--anything=<secret>` is reported by name alone, with the value withheld. For
the flags that take a value, both `--flag value` and `--flag=value` work;
standalone flags such as `--read-only` accept no value in either form.

Exactly one positional argument is read, as the subdomain. A repeatable flag
(`--namespace`, `--tool`, `--cors-origin`) has to be repeated:
`--namespace tickets --namespace help_center`. Writing
`--namespace tickets help_center` instead leaves `help_center` sitting where the
subdomain belongs.

**Examples:**

```bash
# Local single-tool mode — minimal context, every operation in one tool
zendesk-mcp-server acme --mode single

# Read-only tickets only
zendesk-mcp-server acme --read-only --namespace tickets

# Cherry-pick specific tools
zendesk-mcp-server acme --tool get_ticket --tool search_tickets --tool get_current_user

# Remote HTTP, read-only Help Center surface
zendesk-mcp-server acme --transport http --port 8080 \
  --namespace help_center --read-only
```

## Dev mode (`--dev`)

A development-loop convenience for iterating on tool code. With `--dev` the
server exposes one extra tool, **`reload_tools`**. Calling it re-imports the
tool modules from source and re-registers the toolset **in place** on the
running server: the client is notified via `notifications/tools/list_changed`
and refetches, so tool descriptions, schemas and handlers you just edited take
effect without restarting the process or reconnecting the client. Unlike a file
watcher, the reload happens only when *you* call `reload_tools`, at the end of
an edit cycle and right before testing. That keeps the reload explicit and the
notification noise down to one burst per cycle. Point an MCP client's server
command at the source and add the flag:

```jsonc
// .mcp.json
{
  "command": "pnpm",
  "args": ["exec", "tsx", "src/index.ts", "--mode", "all", "--dev"],
  "env": { "ZENDESK_SUBDOMAIN": "acme" }
}
```

Scope and limits, by design:

- **stdio only.** HTTP builds a fresh server per request, so there is nothing
  long-lived to hot-swap; the flag is ignored (with a warning) in HTTP mode.
- **Tool code only.** Reload re-imports the leaf tool modules
  (`src/tools/{tickets,search,help-center,users}.ts`). Edits to shared
  infrastructure below them (the HTTP client, `definitions.ts`, guidance, or the
  server wiring itself) still require a full restart. A reload that throws, say
  on a syntax error caught mid-edit, returns a tool error and leaves the
  previous tools live: fix it and call `reload_tools` again.
- **Dev-only.** `reload_tools` is not part of the product tool surface and is
  never exposed without `--dev`; the published package ships compiled JS with no
  sources to reload. It is meant for `tsx`-from-source development.

## Environment variables

An **empty** variable is a misconfiguration, not "unset": `PORT=` in a compose
file, and `PORT="$VAR"` with `VAR` unset, both arrive as an empty string, and
applying the default there would boot a server whose config silently disagrees
with the deployment. Every single-value variable below therefore fails at
startup when set but empty, naming the variable. Unset it to get the default.

Three deliberate exceptions:

- `CORS_ORIGIN` is a *list*, where an empty value legitimately means "no extra
  origins" on top of the built-in allowlist.
- A variable that the command line overrides is never consulted, so `--port
  8080` alongside a stray `PORT=` still boots, and so does the positional
  `<subdomain>` alongside an empty `ZENDESK_SUBDOMAIN`. Validation applies to
  the value the server actually uses.
- The **numeric tuning caps** — `ZENDESK_CHARACTER_LIMIT`,
  `ZENDESK_MAX_ATTACHMENT_BYTES`, `ZENDESK_MAX_UPLOAD_BYTES`, `ZENDESK_MAX_EMBEDDED_IMAGES`,
  `ZENDESK_MAX_COMMENT_PAGES`, `ZENDESK_REORDER_CONFIRM_THRESHOLD` and
  `ZENDESK_ARTICLE_RESOURCES_SCAN_MAX_PAGES` — read through a shared parser that
  treats an empty value as unset and falls back to the default, along with any
  value that is not a positive safe integer. They bound response sizes and scan
  depth rather than describing the deployment, so a typo there degrades a
  guardrail instead of misrouting traffic, and refusing to boot over one would
  be the harsher failure.

### `ZENDESK_SUBDOMAIN`
**Required:** yes (or the CLI `<subdomain>` argument) · **Default:** none

Zendesk subdomain (e.g. `acme` for `acme.zendesk.com`).

### `ZENDESK_OAUTH_CLIENT_ID`
**Required:** no · **Default:** `<subdomain>_zendesk`

OAuth client identifier.

### `ZENDESK_OAUTH_CALLBACK_PORT`
**Required:** no · **Default:** `27439`

Local port for the OAuth browser callback (also `--callback-port`). Must match the redirect URL registered in Zendesk. **stdio only.**

### `ZENDESK_TOKEN_FILE`
**Required:** no · **Default:** OS config dir

Path to the persisted OAuth token file (`0600`). One explicit file serves one
server: with mixed read-only and read-write servers, keep the default layout,
which gives each its own file (see [Read-only all the way to Zendesk](#read-only-all-the-way-to-zendesk)).

### `ZENDESK_EXPORT_DIR`
**Required:** no · **Default:** none (the account export is off)

Absolute local directory where `export_account_config` writes its snapshots,
one new `<subdomain>-<timestamp>` folder per export; the same as
`--export-dir`, which wins over it. Setting it is what registers the `admin`
namespace: the directory is the operator's choice, never the model's, so a
prompt cannot steer where files land. stdio only (refused at boot over HTTP,
where the files would land on the server host); a relative path or a network
share (`\\host\share`, `//host/share`) is refused at boot too.

The export writes local files, so its `readOnlyHint` is `false` while it stays
available with `--read-only` (it only reads from Zendesk). In `single` mode,
enabling it therefore makes the one `zendesk` proxy report `readOnlyHint: false`
as well; prefer the default `namespace` mode, where only `zendesk_admin` does.

Macro snapshots request `include=usage_7d,usage_30d` on every page, preserving
the usage counters on each macro. Zendesk supports these sideloads on Support
Professional or Suite Growth and above, with up to 100 macros per page.
Cursor pagination remains the default: the restriction on usage-based sorting
does not apply to requesting usage sideloads. See [List Macros](https://developer.zendesk.com/api-reference/ticketing/business-rules/macros/#list-macros)
and [side-loading](https://developer.zendesk.com/documentation/api-basics/working-with-data/side_loading/).

`ticket_form_statuses.json` holds the account's form-to-status associations
(`id`, `ticket_form_id`, `custom_status_id`), which decide the custom statuses
the agent's status picker offers on each ticket form; snapshots taken before
this resource existed lack the file. See [Ticket Form Statuses](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_form_statuses/).

The same admin namespace includes `list_api_tokens`, a read-only inventory that
follows all pages and returns metadata including `last_used` (null for a token
never used). It filters out full and truncated token values and writes no files.
Requires an admin or an agent with Manage APIs permission. The [official OpenAPI
contract](https://developer.zendesk.com/zendesk/oas.yaml) documents the fields and
marks the endpoint deprecated, with removal scheduled for April 30, 2027.

### `ZENDESK_EMAIL`
**Required:** only to activate stdio API-token auth (paired with `ZENDESK_API_TOKEN`) · **Default:** none

Zendesk agent email for Basic auth. **stdio only** — refused at boot if both this and `ZENDESK_API_TOKEN` are set in HTTP mode. Setting only one of the two falls back to OAuth rather than erroring. See [`docs/api-token-stdio.md`](api-token-stdio.md).

### `ZENDESK_API_TOKEN`
**Required:** only to activate stdio API-token auth (paired with `ZENDESK_EMAIL`) · **Default:** none

Zendesk API token for Basic auth. **stdio only** — refused at boot if both this and `ZENDESK_EMAIL` are set in HTTP mode. Setting only one of the two falls back to OAuth rather than erroring. See [`docs/api-token-stdio.md`](api-token-stdio.md).

### `TRANSPORT`
**Required:** no · **Default:** `stdio`

`stdio` or `http`.

### `HOST`
**Required:** no · **Default:** `0.0.0.0`

HTTP bind host.

### `PORT`
**Required:** no · **Default:** `3000`

HTTP bind port (`0` to let the OS pick).

### `PUBLIC_URL`
**Required:** recommended in HTTP behind a proxy · **Default:** derived from `host:port`

Public URL advertised in OAuth discovery metadata. See [Public URL](http-deployment.md#public-url).

### `CORS_ORIGIN`
**Required:** no · **Default:** none

Comma-separated browser origins added to the default CORS allowlist.

### `HC_RESOURCE_SCHEME`
**Required:** no · **Default:** `zendesk-hc`

URI scheme of the Help Center MCP resources (also `--hc-resource-scheme`, which
takes precedence). With the default, the topology resource is
`zendesk-hc://topology`; set `wiki`, for instance, to expose it as
`wiki://topology` and have the `instructions` blob cite that URI. It must be a
**bare RFC 3986 scheme**: a lowercase letter followed by lowercase letters,
digits, `+`, `-` or `.`. Anything else (`wiki://`, `Wiki`, `-wiki`, `1wiki`) is
rejected at startup. The WHATWG-special schemes (`http`, `https`, `ws`, `wss`,
`ftp`, `file`) are rejected too, because URL normalization appends a trailing
slash to them and that would make the advertised resource URI unreadable by MCP
clients. A generic scheme like `wiki` is safe collision-wise, since MCP resource
URIs are scoped per server; it is just less self-descriptive in a client
connected to several servers.

### `LOG_LEVEL`
**Required:** no · **Default:** `info`

Log verbosity (`debug` surfaces the full OAuth flow trace).

### `ZENDESK_CHARACTER_LIMIT`
**Required:** no · **Default:** `25000`

Ceiling on the characters a single tool response may carry. Past it the text is cut and a notice says what to do about it — the notice names a lever the tool in question actually accepts (a page parameter, a narrower filter, or the tool that pages the same data), so it differs per tool.

Raising it is rarely what you want: the default exists to protect the client's own context budget, and a larger response mostly moves the problem downstream. **Lowering it is the useful direction** — it is how the truncation paths get exercised on a tenant whose real data never reaches 25 000 characters. Set it to a few hundred and any ordinary response trips the notice:

```bash
ZENDESK_CHARACTER_LIMIT=2000 pnpm dev -- <your-subdomain> --mode all
```

### `ZENDESK_MAX_ATTACHMENT_BYTES`
**Required:** no · **Default:** `5242880` (5 MB)

Per-image size cap for inline (multimodal) ticket attachments. Images larger than this are returned as text references instead of embedded image content. The default is aligned with the Anthropic vision API per-image limit.

### `ZENDESK_MAX_UPLOAD_BYTES`
**Required:** no · **Default:** `52428800` (50 MiB)

Per-file size cap for the files `add_private_note` and `add_public_comment` read from disk (`attachment_paths`). The default is Zendesk's attachment size limit. Every path is checked before anything is uploaded, so one file over the cap fails the call with nothing uploaded or posted. `attachment_paths` itself is **stdio only**: over HTTP a path would resolve on the server host, so the tools refuse it there.

### `ZENDESK_MAX_EMBEDDED_IMAGES`
**Required:** no · **Default:** `10`

Maximum number of images embedded as native image content in a single tool call. Remaining images are returned as text references.

### `ZENDESK_MAX_COMMENT_PAGES`
**Required:** no · **Default:** `10`

Hard cap on the number of comment pages fetched when collecting a ticket's attachments (raise it for tickets with very long comment threads).

### `ZENDESK_REORDER_CONFIRM_THRESHOLD`
**Required:** no · **Default:** `20`

Safety threshold for `reorder_article`. When moving an article would rewrite more than this many article positions (for example moving an article to the top of a large or heavily tied section), the tool refuses and reports the count until the call is retried with `confirm: true`. Lower it to be prompted sooner, raise it to reorder large sections without confirmation.

### `ZENDESK_ARTICLE_RESOURCES_SCAN_MAX_PAGES`
**Required:** no · **Default:** `20`

Hard cap on the number of article pages scanned to find promoted ("featured") articles. This backs both the `<scheme>://article/{id}` resource listing (`resources/list`) and the `list_promoted_articles` tool. The Help Center API has no server-side promoted filter, so the scan pages through the articles and filters them client-side; this bounds that scan on a very large Help Center (promoted articles beyond the cap are omitted, and the truncation is flagged). Raise it if promoted articles live deep in a large catalog.

**Cost note.** Each scanned page is one Zendesk API request, and Zendesk rate-limits every plan, so on a large Help Center a single listing or tool call can fan out to several requests. The resource-listing scan is cached per session for a few minutes (`ARTICLE_RESOURCES_TTL_MS`) so repeated `resources/list` calls coalesce; the `list_promoted_articles` tool performs a fresh, uncached scan on every call. The scan runs only when a resource-capable client calls `resources/list` or the LLM calls `list_promoted_articles`, never at connect. The worst case is a large catalog with few or no promoted articles: a full-cap scan for little result. If that matters for your tenant's quota, lower this cap or disable the pre-listing with **`--no-promoted-articles`**, which turns off the resource `list` scan **and** the `list_promoted_articles` tool, so the server makes **zero** preloading requests. It does **not** disable reading a known article by id (`<scheme>://article/{id}` stays registered): that is a cheap, on-demand single fetch, not a preload.

---

← Back to the [README](../README.md).

## Re-authorize (`login`)

The server signs in lazily, on the first tool call without a usable token, and
then reuses that token. To give an existing token a scope added since it was
granted, or to switch accounts, sign in again explicitly:

```bash
zendesk-mcp-server login acme               # the read-write server's token
zendesk-mcp-server login acme --read-only   # the read-only server's and export-data's token
```

`login` always runs the browser OAuth flow with the scope the server now
requests for that mode (see [OAuth scopes](#oauth-scopes)) and replaces the
stored token in the file that mode uses (`<subdomain>.json`, `<subdomain>.read.json`,
or [`ZENDESK_TOKEN_FILE`](#zendesk_token_file)). It reads the same
[`ZENDESK_OAUTH_CLIENT_ID`](#zendesk_oauth_client_id) and callback port as the
server, and also takes `--callback-port` and `--log-level`. It prints the token
file path and the scope Zendesk granted, never the token, and warns when the
grant lacks `side_conversations:read`. A read-only login refuses a grant that can
write and saves nothing. Restart running servers on that subdomain to use the new
grant right away.

## Bulk data export (`export-data`)

Use the standalone subcommand for long account snapshots without starting an MCP
server:

```bash
zendesk-mcp-server export-data acme --export-dir /absolute/local/backups
zendesk-mcp-server export-data acme --export-dir /absolute/local/backups \
  --since 2025-01-01T00:00:00Z --only tickets --only ticket_events --rate 200
zendesk-mcp-server export-data acme --export-dir /absolute/local/backups \
  --resume acme-data-2026-01-01T00-00-00-000Z
```

An admin sign-in is required. Authentication uses the same API-token environment
pair as stdio, or OAuth with **read scope only**. If OAuth needs authorization,
the CLI prints the authorization URL to stderr and polls every three seconds for
up to ten minutes. Progress goes to stderr; stdout receives a final JSON summary
with the snapshot path, per-stream file line/byte counts, status and duration.
Exit code is 1 if a stream failed, otherwise 0 (unavailable streams are skipped).
Unknown flags and invalid arguments fail before authentication or network access.

| Flag | Meaning |
| ---- | ------- |
| `--export-dir <absolute-local-path>` | Required destination parent directory; snapshots use a new `<subdomain>-data-<UTC timestamp>` folder and never overwrite an earlier snapshot. Network paths and symlink directories are refused. |
| `--since <ISO-date-or-epoch-seconds>` | Incremental start time, default 0 (all available history). List streams and configuration always export in full. |
| `--only <stream>` | Repeat to select streams; omit for all streams below. |
| `--resume <snapshot-folder-name>` | Resume inside the same export directory. Folder names cannot contain separators or `..`. The original start time is preserved; any supplied `--since` must match. Only originally selected streams can be resumed. |
| `--rate <requests-per-minute>` | Standard request bucket, default 300. All incremental endpoints share a separate bucket of 10 requests/minute. |
| `--log-level <debug\|info\|warn\|error>` | Stderr progress verbosity, default `info`. Authorization URLs remain visible at every level. |

Streams run sequentially in this order:

| Stream | Files |
| ------ | ----- |
| `tickets` | `tickets.ndjson` (including deleted tickets and AI-agent tickets via `support_type_scope=all` on every request), `ticket_metrics.ndjson`; `ticket_slas.ndjson` only when returned by the sideload. Ticket includes fall back from `metric_sets,dates,slas` to `metric_sets`, then no include on HTTP 400. |
| `users` | `users.ndjson`; `user_identities.ndjson` when sideloaded. Falls back without identities on HTTP 400. |
| `organizations` | `organizations.ndjson` |
| `ticket_events` | `ticket_events.ndjson`, derived `comments.ndjson` and `attachments.ndjson`. Sends `support_type_scope=all` on every request. Attachments contain metadata only; content URLs are never downloaded. Boundary event IDs are deduplicated across adjacent pages, including after resume. |
| `ticket_metric_events` | `ticket_metric_events.ndjson` |
| `side_conversation_events` | Raw incremental events in `side_conversation_events.ndjson`, with boundary deduplication and resume. Referenced conversations are fetched once per `(ticket_id, side_conversation_id)` in the snapshot and written to `side_conversations.ndjson` with `ticket_id`. Enabled by default; 403/404 on the events marks the stream unavailable (`skipped`) and continues. A 403/404 on one conversation's lookup (say, on a deleted ticket) only skips that conversation: its events stay, and the stream lists it in `unreadable_conversations` (`ticket_id`, `side_conversation_id`, `status`, `zendesk_error`), committed with its page and not looked up again on resume. Needs `side_conversations:read` on an OAuth token: a 403 that skips the stream adds a `hint` to re-authorize with [`login`](#re-authorize-login) and export the stream again. |
| `groups` | `groups.ndjson` |
| `group_memberships` | `group_memberships.ndjson` |
| `organization_memberships` | `organization_memberships.ndjson` |
| `satisfaction_ratings` | `satisfaction_ratings.ndjson` |
| `custom_object_records` | `custom_object_records.ndjson`, with `custom_object_key` on every record. Lists objects and cursor-pages all their undeleted records with `page[size]=100`. Always exports in full, including with `--since`; resume continues the saved object and record cursor. |
| `config` | Existing account-configuration JSON export under `config/`, with its own resource manifest. |

These snapshots reflect what Zendesk makes available during the run; account
changes during a long export are not an atomic database backup. NDJSON stores
one raw object per line, plus derived comment and attachment metadata. The top-level
`manifest.json` records the current user, effective includes, rates, per-stream
status, requests, pages, file byte/line counts, next position and timings. It is
replaced atomically after each page. Resume truncates unfinished NDJSON files to
the recorded byte offsets before continuing, removing partial/uncommitted pages.
Configuration progress is saved per resource. Completed and skipped streams are
left intact; failed streams are retried. A 403/404 skips a stream with a reason;
a 403 also records what Zendesk's response body said in `zendesk_error` (its
`error` and `description`, or the first 500 characters of a body without them,
`""` for an empty one; never request headers or the token) and, in
`failed_path`, the API path of the request that got it (under `/api/v2`, without
the query), whether the first page or a later one. Other failures are recorded
and the remaining streams continue. A 401 aborts only
when `/users/me` also rejects the token.

After the client's own retry policy is exhausted, the exporter waits 60 seconds
on HTTP 429 and retries up to ten times; server/network failures wait 30 seconds
and retry up to five times. Pacing applies between attempts. Pagination links
are followed only inside the account API. Only GET requests are issued.

The opt-in admin tool `export_data` provides the same snapshot export on a stdio
server configured with `--export-dir`. It accepts `since`, `streams` and `resume`,
returns immediately after reserving the snapshot, and runs in the server process.
While an export is running, subsequent calls return that job's manifest progress
instead of creating another job. Read `<snapshot>/manifest.json` for progress
without invoking a tool. Stopping the server interrupts the export; restart and
supply the returned folder name as `resume`. The tool remains available on
`--read-only` servers because it only reads Zendesk, though its local file writes
are reflected by `readOnlyHint: false`.

### Golden observations (`record-goldens`)

After `export-data`, record how Zendesk behaves against that data snapshot for
characterization tests of a replacement system:

```bash
zendesk-mcp-server record-goldens acme --export-dir /absolute/local/backups \
  --data-snapshot acme-data-2026-01-01T00-00-00-000Z
zendesk-mcp-server record-goldens acme --export-dir /absolute/local/backups \
  --data-snapshot acme-data-2026-01-01T00-00-00-000Z \
  --only views --only macros --view-row-cap 2000 --macro-sample 25
```

The input folder stays inside `--export-dir`. Tickets are read line by line;
when an ID repeats, its last version determines sampling and search statistics.
Deleted tickets are excluded. Samples round-robin across deterministic strata
ordered by size and key, with descending ticket IDs inside each stratum.

The new `<subdomain>-goldens-<UTC timestamp>` folder contains:

| Stage | Observations |
| ----- | ------------ |
| `context` | `context.json`: the complete `/users/me` response, all group memberships and recording time. Views using current-user conditions depend on this identity. |
| `views` | Active shared views (unrestricted or Group restriction), live definitions, raw counts, every ordered ticket ID and execute columns/groups/rows in `views/<id>.json`; `views/index.json` records statuses and counts. |
| `macros` | Active macros, generic apply responses and ticket-specific previews in `macros/<id>.json`; `macros/index.json` and `macros/sample.json` describe outcomes and sampled ticket strata. Apply endpoints preview changes without modifying tickets. |
| `slas` | `slas.ndjson` contains ticket fields, SLAs and matched metric sideloads from batches of up to 100 tickets. `audits.ndjson` contains all audit pages per sampled ticket; `slas/sample.json` records strata. Unrecognized metric-event sideload shapes are preserved raw. |
| `search` | `search.json` records counts and ordered first-page IDs by relevance and descending creation date, with query origins and recording times. Generated searches use non-deleted latest tickets, names/emails from the snapshot, top subject terms and dates relative to the data snapshot's start time. |

`--only` repeats to select stages; the default runs the stages above in order.
`--view-row-cap` defaults to 2000 (execute rows only; ticket IDs are uncapped).
`--macro-sample` defaults to 25, stratified by status, form and brand.
`--sla-sample` defaults to 500: 90% non-closed and 10% closed, stratified by status,
priority, group and form. The closed allocation is rounded down; unavailable
strata produce a smaller sample. Caps and sample sizes accept nonnegative integers.

`--queries /absolute/path/queries.json` replaces generated searches with a JSON
array of unique `{ "id": "open", "query": "type:ticket status:open" }` entries.
Each query must begin with `type:ticket `. Query text contains names/emails and
is written only to observation files, never info-level progress logs.

Authentication, sign-in polling, `--rate`, `--log-level`, stderr progress, stdout
JSON summary and exit codes follow `export-data`. Only GET requests are used.
Each view, macro and page checkpoints the atomic manifest. Errors on individual
views/previews/queries are recorded and other observations continue. A 403/404
skips an inaccessible stage with a reason; other stage failures are resumable.
A 401 aborts only if `/users/me` also rejects the token.

Resume with `--resume <golden-folder-name>` and the same `--data-snapshot` and
recording user. Completed stages and written view/macro files are skipped;
unfinished SLA/audit output truncates to its committed offsets. Supplied sample
options must match the original manifest. Folder names cannot contain separators
or `..`; snapshot directories and input files must not be symlinks.

The opt-in admin tool `record_goldens` accepts required `data_snapshot`, optional
`stages` and `resume`. It shares the background-job reservation with `export_data`
for the same account/export directory, returns immediately and reports the
running job on repeated calls. Server shutdown interrupts it; resume after restart.
It remains available with `--read-only`, with `readOnlyHint: false` for its local
writes. Use the CLI for custom sample sizes or query files.
