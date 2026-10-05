# Jam & Paula Ledger

Household budget app for Jam and Paula. Each week Jam imports credit-card statements, decides whose expense each charge is (Paula / Jam / Shared by salary ratio 56/44 / 50/50 / Custom / Skip) and sends Paula what she owes. It also holds January–September 2026 from their Excel workbook as month records, a year overview for any year (income, budgets vs spending by category, savings balances), an Ask AI panel, an MCP server for outside AIs, and syncs to a Google Sheet and Notion.

Runs on Cloudflare Workers (Hono) + D1 + KV. The front end is one HTML file with no build step. It is an installable web app (manifest + service worker).

## Commands

```bash
npm install
npm run db:migrate:local                 # local D1
npm run user:add -- jam "Jam" --local    # asks for a password (or set LEDGER_PASSWORD)
npm run seed:2026:local                  # optional: the 2026 workbook months
npm run dev                              # http://localhost:8787
npm run typecheck                        # must pass before every commit
npm test                                 # src/core.ts and public/index.html must give the same numbers
npm run smoke                            # API + MCP checks against the running dev server (needs LEDGER_PASSWORD)
npm run build:artifact                   # writes dist/ledger-artifact.html for the Claude version
npm run deploy                           # migrations + deploy (production)
```

`.dev.vars` (never committed) holds local secrets; see `.dev.vars.example`.

## Layout

```
public/index.html   the whole front end (HTML + CSS + JS in one file)
public/sw.js        service worker; public/manifest.json and public/icons/ make it installable
src/index.ts        Hono routes: login, REST API, /mcp, cron
src/core.ts         money rules shared by the API and MCP (splits, totals, duplicate checks, parsing, year math, Notion props)
src/db.ts           D1 access (weeks, txns, kv documents)
src/mcp.ts          MCP server (Streamable HTTP, stateless JSON-RPC) and its tools
src/ai.ts           Ask AI on the website: @anthropic-ai/sdk, answers streamed as NDJSON, the read-only MCP tools
src/sync.ts         Google Sheets push (cron every 5 min when dirty) and Notion sync
src/auth.ts         PBKDF2 passwords, KV sessions, login rate limit
apps-script/Code.gs receiver the user pastes into the Google Sheet
migrations/         D1 schema, append-only
seed/               the 2026 workbook history as SQL (real personal data)
scripts/            setup, add-user, mcp-check, smoke, build-artifact, parity-test (npm test)
.github/workflows/  check.yml (typecheck + npm test on pull requests), deploy.yml (main)
```

## Rules that matter

- **The money rules exist twice**: in `src/core.ts` and in the `<script>` of `public/index.html`, between the `/* ===== money rules` and `/* ===== end money rules` markers (`applyMode`, `calc`, `mkey`/`merchantStats`/`suggest`, `catStats`/`suggestCat`, statement parsing with `dateOrder`, `classifyImport`, `NotionRec`, `applyYearOps`, and `aggYear` = core's `yearAgg`). Change both together and keep the numbers identical; `npm test` (scripts/parity-test.mjs) runs both copies on the same inputs. Code in those blocks may only use the `/* ===== helpers` block above it.
- **Transfer**: `calc` only counts rows that have a card toward the transfer ("Paula pays Jam"). Workbook months (`kind: 'month'`) have no card, so they never create one. Shares = own items + ratio % of shared.
- **Row shape**: `{id, date, desc, amt, card, mode, p, j, s, note, src, sug, imp, dupOk, cat}`. `mode` is `P J S H C X` or null (not split). `src` is `csv`, `manual`, `ai` or `sheet` (workbook). `cat` is a category name from settings.
- **Year document**: kv key `year:<YYYY>` → `{year, months: {"01": {budget: {cat: amt}, income: [{id,date,source,who,amt,note}], pct: {needs,wants,savings}, saved: {cat: amt}, budgetFrom?}}, snapshots: [{id,date,accounts:[{name,amt}]}], plan}`. `normalizeYear` in core.ts validates it. Changes are **operations** (`budget`, `pct`, `budgetFrom`, `month`, `incomeAdd`, `incomeDel`, `snap`, `renameCat`) applied by `applyYearOps` to the latest saved copy: `PATCH /api/years/:year {ops}`, `patchYear` in db.ts and in both page stores. Never save a whole year document from the page (two people would undo each other); the ops must stay idempotent because the page re-applies unsaved ones on top of each reload.
- **Never hard-code the year**: use `thisYear(env.TZ)`/`todayISO(env.TZ)` on the server (the Worker clock is UTC) and `S.year.y` (the year picked in the overview) in the page. The Google Sheet's Months/Budget/Income tabs hold every year.
- **Weeks are saved by field**: `PUT /api/weeks/:id` keeps every field the body leaves out; the website store sends only what changed since the server copy it last saw (`weekDiff`), and the imported-files list changes through `importsAdd` / `importsRemove`. Rows go through `PATCH …/rows` with only changed rows.
- **Polling**: the page asks `GET /api/version` every 20 s and reloads only what changed (settings and year docs by `kv.updated_at`, weeks and their rows by `weeks.updated_at`). Any server write that changes what a week shows must move that week's `updated_at` (`recomputeWeek` and `moveRefs` do).
- **D1 allows 50 queries per request on the free plan**: no per-week query loops (see `recomputeAll`: three reads, one batch). `GET /api/rows?weeks=a,b` loads many weeks in one query.
- **Two runtimes, one page**: `public/index.html` also runs inside Claude as an artifact. `HOSTED` is false there and the page uses `window.claude.use('db' | 'downloads' | 'user' | 'mcp' | 'sample')` instead of `/api`. Every feature needs both paths (or must hide itself cleanly in one). The body of index.html is what gets published; `npm run build:artifact` extracts it.
- **API**: every non-GET `/api/*` request needs the `x-ledger: 1` header and a session cookie (`requireUser`). Errors are `{error: "plain sentence"}`.
- **MCP tools**: add the schema to `TOOLS` and the case to `callTool` in `src/mcp.ts`. Read-only tools that Ask AI may use are listed in `READ_TOOLS` in `src/ai.ts`; never add write tools there.
- **Ask AI** (`POST /api/ask`) streams newline-delimited JSON (`status`, `delta`, `clear`, `done`, `error`) and uses the official SDK. The system prompt is the instructions plus the ledger data with a cache breakpoint; what the page has open (`body.context`) goes after the question as a mid-conversation system note, never into the cached prompt. Keep `tools` and the system prompt deterministic.
- **Settings**: `PUT /api/settings` also takes `cardMoves {oldCardId: newCardId}` and `catMoves {oldName: newName | ""}`; the server moves the transactions and year budgets (`moveRefs`). Password changes end the person's other sessions (`endOtherSessions`).
- **Google Sheet**: the payload in `src/sync.ts` and the column formats in `apps-script/Code.gs` are matched by column number. Change them together, and tell the user to redeploy the Apps Script.
- **Notion**: property names in `NotionRec` must exist in the Budget Ledger / Budget Weeks databases (Category, Source options "Bank file", "Added by hand", "Added by AI", "2026 workbook"; Transfer option "No transfer (month record)").
- **Migrations are append-only**: never edit an applied file; add `000N_name.sql`.
- **Service worker** never caches `/api`, `/mcp` or `/healthz`. Bump `VERSION` in `public/sw.js` when you add shell files.
- **Privacy**: this repo must stay private (seed/ has real transactions). Never commit `.dev.vars`, tokens or API keys.

## Front-end style

Swiss brutalist on sage: tokens on `:root` (`--field #B3C1A4`, `--paper`, `--ink`, `--paula #C2411B`, `--jam #2140A6`, `--shared`), Archivo + IBM Plex Mono, no border radius, heavy rules, dark mode via the same tokens. No frameworks or build tools. Plain sentences in UI copy. At 390px wide there must be no horizontal page scroll.

## Checking your work

1. `npm run typecheck` and `npm test`
2. With `npm run dev` running and a local user: `LEDGER_PASSWORD=… npm run smoke`
3. Open http://localhost:8787, sign in, and click through: a week (split buttons, category box, import a CSV, search with All weeks), the year overview (pick a year, a month, edit a budget), Ask AI (needs `ANTHROPIC_API_KEY` in `.dev.vars`; `ANTHROPIC_API_BASE` can point at a fake server), Settings. Check a 390px-wide window too: the slip and transactions come before the report panels.
