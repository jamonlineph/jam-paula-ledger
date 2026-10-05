# Jam & Paula Ledger

Household budget app for Jam and Paula. Each week Jam imports credit-card statements, decides whose expense each charge is (Paula / Jam / Shared by salary ratio 56/44 / 50/50 / Custom / Skip) and sends Paula what she owes. It also holds January–September 2026 from their Excel workbook as month records, a year overview (income, budgets vs spending by category, savings balances), an Ask AI panel, an MCP server for outside AIs, and syncs to a Google Sheet and Notion.

Runs on Cloudflare Workers (Hono) + D1 + KV. The front end is one HTML file with no build step. It is an installable web app (manifest + service worker).

## Commands

```bash
npm install
npm run db:migrate:local                 # local D1
npm run user:add -- jam "Jam" --local    # asks for a password (or set LEDGER_PASSWORD)
npm run seed:2026:local                  # optional: the 2026 workbook months
npm run dev                              # http://localhost:8787
npm run typecheck                        # must pass before every commit
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
src/ai.ts           Ask AI on the website: Anthropic Messages API + the read-only MCP tools
src/sync.ts         Google Sheets push (cron every 5 min when dirty) and Notion sync
src/auth.ts         PBKDF2 passwords, KV sessions, login rate limit
apps-script/Code.gs receiver the user pastes into the Google Sheet
migrations/         D1 schema, append-only
seed/               the 2026 workbook history as SQL (real personal data)
scripts/            setup, add-user, mcp-check, smoke, build-artifact
```

## Rules that matter

- **The money rules exist twice**: in `src/core.ts` and in the `<script>` of `public/index.html` (`applyMode`, `calc`, `mkey`/`merchantStats`/`suggest`, `catStats`/`suggestCat`, the import duplicate checks, `NotionRec`, the year aggregation). Change both together and keep the numbers identical.
- **Transfer**: `calc` only counts rows that have a card toward the transfer ("Paula pays Jam"). Workbook months (`kind: 'month'`) have no card, so they never create one. Shares = own items + ratio % of shared.
- **Row shape**: `{id, date, desc, amt, card, mode, p, j, s, note, src, sug, imp, dupOk, cat}`. `mode` is `P J S H C X` or null (not split). `src` is `csv`, `manual`, `ai` or `sheet` (workbook). `cat` is a category name from settings.
- **Year document**: kv key `year:<YYYY>` → `{year, months: {"01": {budget: {cat: amt}, income: [{id,date,source,who,amt,note}], pct: {needs,wants,savings}, saved: {cat: amt}, budgetFrom?}}, snapshots: [{id,date,accounts:[{name,amt}]}], plan}`. `normalizeYear` in core.ts validates it.
- **Two runtimes, one page**: `public/index.html` also runs inside Claude as an artifact. `HOSTED` is false there and the page uses `window.claude.use('db' | 'downloads' | 'user' | 'mcp' | 'sample')` instead of `/api`. Every feature needs both paths (or must hide itself cleanly in one). The body of index.html is what gets published; `npm run build:artifact` extracts it.
- **API**: every non-GET `/api/*` request needs the `x-ledger: 1` header and a session cookie (`requireUser`). Errors are `{error: "plain sentence"}`.
- **MCP tools**: add the schema to `TOOLS` and the case to `callTool` in `src/mcp.ts`. Read-only tools that Ask AI may use are listed in `READ_TOOLS` in `src/ai.ts`; never add write tools there.
- **Google Sheet**: the payload in `src/sync.ts` and the column formats in `apps-script/Code.gs` are matched by column number. Change them together, and tell the user to redeploy the Apps Script.
- **Notion**: property names in `NotionRec` must exist in the Budget Ledger / Budget Weeks databases (Category, Source options "Bank file", "Added by hand", "Added by AI", "2026 workbook"; Transfer option "No transfer (month record)").
- **Migrations are append-only**: never edit an applied file; add `000N_name.sql`.
- **Service worker** never caches `/api`, `/mcp` or `/healthz`. Bump `VERSION` in `public/sw.js` when you add shell files.
- **Privacy**: this repo must stay private (seed/ has real transactions). Never commit `.dev.vars`, tokens or API keys.

## Front-end style

Swiss brutalist on sage: tokens on `:root` (`--field #B3C1A4`, `--paper`, `--ink`, `--paula #C2411B`, `--jam #2140A6`, `--shared`), Archivo + IBM Plex Mono, no border radius, heavy rules, dark mode via the same tokens. No frameworks or build tools. Plain sentences in UI copy. At 390px wide there must be no horizontal page scroll.

## Checking your work

1. `npm run typecheck`
2. With `npm run dev` running and a local user: `LEDGER_PASSWORD=… npm run smoke`
3. Open http://localhost:8787, sign in, and click through: a week (split buttons, category box, import a CSV), the 2026 overview (a month, edit a budget), Ask AI (needs `ANTHROPIC_API_KEY` in `.dev.vars`), Settings. Check a 390px-wide window too.
