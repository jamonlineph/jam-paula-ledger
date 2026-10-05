# Jam & Paula Ledger

The weekly budget split, on its own website. It works without Claude, Paula can sign in from her phone, and any AI can connect to it over MCP.

Every transaction has a budget category (Grocery, Eat Out, Rent…). The **2026 overview** button shows income, spending by category against each month's budget, what's left, each person's share, and your savings balances, the same way your 2026 Income & Expense workbook did.

```
browser ──login──▶  Cloudflare Worker (Hono)  ──▶  D1 (weeks, transactions, settings)
                     ├─ /           the app (public/index.html, one file, no build step)
                     ├─ /api/*      REST for the app (cookie session, KV)
                     ├─ /mcp        MCP server for Claude, ChatGPT, Gemini, Cursor… (per-AI tokens)
                     └─ cron 5 min  ──▶  Google Sheet (Apps Script receiver)
                                     ──▶  Notion (optional, when you click Sync)
```

Everything fits in Cloudflare's free plan: Workers, D1, KV and the cron trigger.

The ledger starts empty. Your names, cards, categories and 56/44 ratio come pre-set, and so do the links to your Notion page and Google Sheet. Step 2b loads January–September 2026 from your workbook.

---

## 1. Install and create the Cloudflare pieces

You need Node 20+ and a Cloudflare account.

```bash
npm install
npx wrangler login
npm run setup        # creates the D1 database + KV namespace, writes their ids into wrangler.jsonc, runs migrations
```

## 2. Create the two logins

```bash
npm run user:add -- jam "Jam"
npm run user:add -- paula "Paula"
```

You'll be asked for each password (10+ characters). Only a PBKDF2 hash is stored. Run the same command again to reset a password. Each person can also change their own password in **Settings → Account**.

## 2b. Load your 2026 workbook (optional, once)

```bash
npm run seed:2026
```

This adds January to September 2026 from the *2026 Income and Expense* workbook as nine month records: 862 transactions with their categories, the Split tab's splits for April to September, every paycheque, each month's budgets, the May 29 savings balances and your updated budget plan. Running it again puts those nine months back the way the workbook had them (weeks you added yourself aren't touched).

## 3. Deploy

```bash
npm run deploy
```

Wrangler prints the address, for example `https://jam-paula-ledger.<your-subdomain>.workers.dev`. Open it and sign in.

**Own domain:** if your domain is on Cloudflare, go to Workers & Pages → jam-paula-ledger → Settings → Domains & Routes → Add → Custom domain (for example `budget.yourdomain.com`). HTTPS is automatic.

## 4. Deploy from GitHub (optional)

Push this folder to a private repo, then add two repository secrets:

| Secret | Where to get it |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create → "Edit Cloudflare Workers" template, then add **Account → D1 → Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages (right side) |

Every push to `main` type-checks, applies new migrations and deploys (`.github/workflows/deploy.yml`). Commit `wrangler.jsonc` after `npm run setup` so the workflow has the database id.

## 5. Connect the Google Sheet

The sheet already exists in your Drive: **[Jam & Paula Budget Ledger](https://docs.google.com/spreadsheets/d/1v4DRN26RU83FICABoXKUs0T_uQ_6MEgdCbprSSXPsPA/edit)**. Its Transactions, Weeks, Months, Budget and Income tabs are rewritten on every sync. Build your own tabs, pivots and charts beside them.

1. Make a long random token: `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`
2. In the sheet: **Extensions → Apps Script**. Replace everything with `apps-script/Code.gs`, paste your token into `LEDGER_TOKEN`, then Save.
3. **Deploy → New deployment →** type **Web app**, Execute as **Me**, Who has access **Anyone** → Deploy → authorize → copy the **Web app URL** (ends in `/exec`).
4. Give both values to the Worker:
   ```bash
   npx wrangler secret put SHEETS_WEBHOOK_URL   # the /exec URL
   npx wrangler secret put SHEETS_TOKEN         # the same token as LEDGER_TOKEN
   ```
5. In the app, click **Sync sheet now** in the Google Sheet panel.

After that, the sheet updates by itself within 5 minutes of any change from the app or an AI. If you ever edit `Code.gs` (or pasted an older copy before the Months, Budget and Income tabs existed), use **Deploy → Manage deployments → Edit → New version** so the URL stays the same.

## 6. Notion (optional)

The **Jam & Paula Budget** page with its Budget Weeks and Budget Ledger databases is already set up. Here the website does the sync itself, using a Notion integration:

1. Go to notion.so/profile/integrations → **New integration** (internal) → copy the secret.
2. Open the **Jam & Paula Budget** page → **•••** → **Connections** → add your integration.
3. Run `npx wrangler secret put NOTION_TOKEN`.

Then **Sync this week to Notion** works in the app, and so does the `sync_notion` tool for AIs.

## 7. Connect your AIs (MCP)

In the app: **Settings → AI connections** → type a name (for example "ChatGPT") → **Create connection**. You get:

- a **link with key**: `https://…/mcp?key=jpl_…`, for apps that only take a URL;
- the **endpoint** `https://…/mcp` plus a **bearer token**, for apps that let you set headers;
- a ready-made **Claude Code** command.

Make one connection per AI so you can revoke them separately. A token gives full read and write access to the ledger, so treat it like a password.

| App | How to add it |
| --- | --- |
| Claude (claude.ai / desktop) | Settings → Connectors → Add custom connector → paste the link with key |
| ChatGPT | Settings → Connectors with Developer mode on → add an MCP server with the link with key, no authentication |
| Claude Code | `claude mcp add --transport http ledger https://…/mcp --header "Authorization: Bearer jpl_…"` |
| Gemini CLI | `~/.gemini/settings.json` → `{"mcpServers":{"ledger":{"httpUrl":"https://…/mcp","headers":{"Authorization":"Bearer jpl_…"}}}}` |
| Cursor | `~/.cursor/mcp.json` → `{"mcpServers":{"ledger":{"url":"https://…/mcp","headers":{"Authorization":"Bearer jpl_…"}}}}` |

Menu names in these apps change often. Look for "custom connector" or "MCP server".

To check a connection: `node scripts/mcp-check.mjs "https://…/mcp?key=jpl_…"`

**Tools the AI gets**

| Tool | What it does |
| --- | --- |
| `ledger_overview` | People, ratio, cards and who pays each bill, the categories, every week and month with totals and paid status |
| `get_week` | One week (or workbook month) in full, with every transaction and its id |
| `search_transactions` | Search everything by text, dates, card, split, category or amount |
| `add_transaction` | Add a hand-entered item (tagged **AI** in the app); the category is guessed from the merchant if you don't give one |
| `update_transaction` | Change split (paula / jam / shared / 50/50 / custom / skip), category, note, card, date, amount |
| `delete_transaction` | Remove one item |
| `import_transactions` | Add a card statement (CSV text or a list) with the same duplicate checks as the app |
| `create_week`, `update_week` | Start a week; rename, change ratio, mark paid |
| `settlement_summary` | The message for Paula, ready to send |
| `year_overview` | The year by month, or one month's budget vs spending by category, income and each person's share |
| `set_budget` | Set a category's monthly budget, for one month or a range (e.g. Oct–Dec) |
| `add_income`, `remove_income` | Record a paycheque (Paula, Jam or other) or remove one |
| `sync_google_sheet`, `sync_notion` | Push now instead of waiting |

For example, you could ask: *"Import this statement into this week as the Main credit card, split everything from Costco as shared, then give me the summary for Paula."* or *"How much did we spend on Eat Out each month this year, and are we over budget in October?"*

## 8. Ask AI (optional)

The **Ask AI** button opens a panel where you can ask about your money in plain words: *"What did we spend on groceries since June?"*, *"Which budgets did we go over in August?"*, *"Why is Paula's share higher this week?"* It reads the whole ledger (weeks, workbook months, categories, budgets, income, savings balances) with the same read-only lookups the MCP tools use. It can't change anything.

On this website it uses an Anthropic API key, billed to that key's account:

1. Make a key at console.anthropic.com → API keys.
2. `npx wrangler secret put ANTHROPIC_API_KEY`
3. Optional: `npx wrangler secret put ANTHROPIC_MODEL` to pick another model (the default is `claude-sonnet-5-5`).

Each person can ask up to 40 questions an hour. In the Claude version of the app, Ask AI uses the viewer's own Claude account instead and needs no key.

## 9. Install it as an app

The website is an installable app: its own icon, full screen, no browser tabs.

- **Android, Windows, Mac, ChromeOS (Chrome or Edge):** sign in, then click **Install app** at the top (or Settings → Use it as an app). You can also use the install icon in the address bar.
- **iPhone / iPad:** open the site in Safari → **Share** → **Add to Home Screen**.

The installed app has two shortcuts (long-press or right-click its icon): **2026 overview** and **Ask AI**. It opens even when you're offline, but your numbers always come live from the server.

## Working on it with Claude Code

`CLAUDE.md` tells Claude Code how the project fits together, which rules to keep in sync (the money math lives in both `src/core.ts` and `public/index.html`), and how to check changes (`npm run typecheck`, `npm run smoke`). Open the repo in Claude Code and ask for what you want changed.

## Local development

```bash
cp .dev.vars.example .dev.vars          # optional: sheet/Notion secrets for local testing
npm run db:migrate:local
npm run user:add -- jam "Jam" --local
npm run seed:2026:local                 # optional: the 2026 workbook months
npm run dev                             # http://localhost:8787
```

## Files

```
src/index.ts      routes: login, REST API, MCP, cron
src/mcp.ts        MCP server (Streamable HTTP, stateless) and the 12 tools
src/core.ts       ledger rules shared by API and MCP: splits, totals, duplicate checks, statement parsing
src/db.ts         D1 access
src/sync.ts       Google Sheets push and Notion sync
src/ai.ts         Ask AI (Anthropic API with the read-only MCP tools)
src/auth.ts       PBKDF2 passwords, KV sessions, login rate limit
public/index.html the app (same page that runs inside Claude; it switches to this server when opened here)
public/sw.js, manifest.json, icons/   what makes it installable as an app
CLAUDE.md         notes for Claude Code
apps-script/Code.gs   receiver to paste into the Google Sheet
migrations/       D1 schema
seed/             the 2026 workbook history (npm run seed:2026)
scripts/          setup, add-user, mcp-check, smoke (npm run smoke), build-artifact
```

## Good to know

- **Sign-in:** sessions last 30 days. After 8 wrong passwords, that username is locked for 15 minutes from that network.
- **Changes from an AI** show up in an open browser within about 20 seconds.
- **The Claude version** of the app keeps its own separate data. Pick one place to keep the real ledger. This website is the one that has the MCP endpoint and the Google Sheet sync.
- **Workbook months** (January–September 2026) have no card, so they never create a transfer. January to March aren't split because the workbook's Split tab starts in April; you can split them in the app if you want.
