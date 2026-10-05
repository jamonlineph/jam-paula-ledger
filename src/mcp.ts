// MCP server (Streamable HTTP, stateless JSON responses) so any AI client can
// read and update the ledger: Claude, ChatGPT, Gemini, Cursor, Claude Code…
// Auth: a per-client token, sent as "Authorization: Bearer <token>" or in the
// URL as /mcp?key=<token> (for clients that only take a URL).

import {
  applyMode, calc, catGroup, catOf, catStats, classifyImport, dShort, GROUPS, merchantStats, modeFrom, modeLabel, money, MONTH_KEYS, MONTH_LONG,
  monthBudgetLines, normalizeYear, parts, parseGrid, parseStatement, r2, rid, suggest, suggestCat, todayISO, yearAgg,
  type ParsedLine, type Row, type Settings, type WeekMeta,
} from './core';
import { findWeek, getAllRows, getRow, getRows, getSettings, getYear, HttpError, listWeeks, newWeekId, patchRows, putWeek, saveYear, type Env } from './db';
import { sha256 } from './auth';
import { notionSyncWeek, pushSheets, sheetsState } from './sync';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Accept',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS, ...extra } });

const INSTRUCTIONS = `This is Jam and Paula's household budget ledger. Each week they import credit-card statements and decide, per transaction, whose expense it is:
- "paula" = Paula's alone, "jam" = Jam's alone
- "shared" = household cost split by salary ratio (Paula's % is the week's ratio, e.g. 56/44)
- "50/50" = split evenly, "custom" = give paula_amount and jam_amount (the rest is shared), "skip" = not part of the budget.
"Paula pays Jam" (the transfer) = Paula's share of everything on cards whose bill Jam pays, minus Jam's share of cards Paula pays.
Every transaction can also have a budget category (Grocery, Eat Out, Rent…, grouped as needs, wants, savings and debt). January to September 2026 came from their 2026 workbook as month records ("January 2026"…): those have no card and no transfer, and January to March aren't split.
The year view (year_overview) shows income, spending by category against each month's budget, what's left, and each person's share. Change budgets with set_budget and record pay with add_income.
Start with ledger_overview, then get_week or year_overview. Transactions added through these tools are tagged as added by AI. When importing, payments to the card and charges already in the ledger are skipped; likely duplicates are reported and skipped unless you pass add_possible_duplicates.`;

/* ---------- tool catalogue ---------- */
const SPLIT_ENUM = ['paula', 'jam', 'shared', '50/50', 'custom', 'skip'];
const weekProp = { type: 'string', description: 'Week id, week name (e.g. "Oct 1" or "September 2026"), or "latest". Defaults to the latest week.' };
const catProp = { type: 'string', description: 'Budget category name, e.g. "Grocery", "Eat Out", "Rent". Use ledger_overview to see them all. Empty string clears it.' };
const monthProp = { type: 'string', description: 'Month: 1–12, "Sep", "September" or "2026-09". Defaults to this month.' };
const TOOLS = [
  { name: 'ledger_overview', title: 'Ledger overview', description: 'Start here. The two people, the default salary ratio, the cards (and who pays each bill), and every week with its total, transfer and paid status.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'get_week', title: 'Get a week', description: 'One week in full: totals, each person’s share, the transfer, and every transaction with its id, split and note.', inputSchema: { type: 'object', properties: { week: weekProp } }, annotations: { readOnlyHint: true, openWorldHint: false } },
  {
    name: 'search_transactions', title: 'Search transactions', description: 'Find transactions across all weeks by text (merchant or note), dates, card, split or amount. Returns up to `limit` rows, newest first, plus the total of what matched.',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string', description: 'Words to look for in the merchant description or note.' },
      from: { type: 'string', description: 'Earliest date, YYYY-MM-DD.' }, to: { type: 'string', description: 'Latest date, YYYY-MM-DD.' },
      card: { type: 'string', description: 'Card name or id.' }, split: { type: 'string', enum: [...SPLIT_ENUM, 'not split'] },
      category: { type: 'string', description: 'Category name, or "none" for uncategorized.' },
      min_amount: { type: 'number' }, max_amount: { type: 'number' }, week: { type: 'string', description: 'Limit to one week (id or name).' },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
    } }, annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'add_transaction', title: 'Add a transaction', description: 'Add one item by hand (e.g. a Costco run or cash). Positive amount = a charge, negative = a refund.',
    inputSchema: { type: 'object', required: ['date', 'description', 'amount'], properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' }, description: { type: 'string' }, amount: { type: 'number' },
      card: { type: 'string', description: 'Card name or id. Defaults to "Other card".' },
      split: { type: 'string', enum: SPLIT_ENUM, description: 'Whose expense it is. Leave out to leave it for Jam to decide.' },
      paula_amount: { type: 'number', description: 'Only for split=custom.' }, jam_amount: { type: 'number', description: 'Only for split=custom.' },
      category: catProp, note: { type: 'string' }, week: weekProp,
    } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'update_transaction', title: 'Change a transaction', description: 'Change the split, category, note, card, date, description or amount of one transaction (use ids from get_week or search_transactions).',
    inputSchema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' }, split: { type: 'string', enum: SPLIT_ENUM }, paula_amount: { type: 'number' }, jam_amount: { type: 'number' },
      note: { type: 'string' }, card: { type: 'string' }, date: { type: 'string' }, description: { type: 'string' }, amount: { type: 'number' }, category: catProp,
    } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  { name: 'delete_transaction', title: 'Delete a transaction', description: 'Remove one transaction from its week. Prefer split="skip" when something is real but not part of the budget.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  {
    name: 'import_transactions', title: 'Import a statement', description: 'Add a card statement to a week: pass the CSV text or a list of {date, description, amount}. One import = one card. Card payments and charges already in the ledger are skipped; likely duplicates (same amount within 3 days, or repeated lines) are reported and skipped unless add_possible_duplicates is true. Splits and categories are guessed from how each merchant was handled before; guessed splits are marked for review.',
    inputSchema: { type: 'object', required: ['card'], properties: {
      card: { type: 'string', description: 'Card name or id the statement belongs to.' },
      csv: { type: 'string', description: 'Statement as CSV text (with or without a header row).' },
      transactions: { type: 'array', items: { type: 'object', required: ['date', 'description', 'amount'], properties: { date: { type: 'string' }, description: { type: 'string' }, amount: { type: 'number' } } } },
      from: { type: 'string', description: 'Only include dates on or after this (YYYY-MM-DD).' }, until: { type: 'string', description: 'Only include dates on or before this (YYYY-MM-DD).' },
      week: weekProp, add_possible_duplicates: { type: 'boolean', default: false }, file_name: { type: 'string', description: 'Shown in the app’s import list.' },
    } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  { name: 'create_week', title: 'Start a new week', description: 'Start a new weekly budget. Name defaults to today’s date (e.g. "Oct 9"); ratio is Paula’s % of shared costs and defaults to the usual ratio.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, ratio: { type: 'number', minimum: 0, maximum: 100 } } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'update_week', title: 'Change a week', description: 'Rename a week, change its salary ratio, or mark the transfer as paid / not paid.', inputSchema: { type: 'object', required: ['week'], properties: { week: weekProp, name: { type: 'string' }, ratio: { type: 'number', minimum: 0, maximum: 100 }, paid: { type: 'boolean' }, paid_on: { type: 'string', description: 'YYYY-MM-DD, defaults to today when paid=true.' } } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'settlement_summary', title: 'Settlement summary', description: 'The message Jam sends Paula: totals, each person’s share and who pays whom, as ready-to-send text plus the numbers.', inputSchema: { type: 'object', properties: { week: weekProp } }, annotations: { readOnlyHint: true, openWorldHint: false } },
  {
    name: 'year_overview', title: 'Year overview', description: 'Income, spending, budget and savings for the year or one month. For a month: each category’s budget, what was spent and what’s left (grouped needs / wants / savings / debt), the income entries, and each person’s income minus their share. For the year: one line per month plus category totals.',
    inputSchema: { type: 'object', properties: { month: { type: 'string', description: 'Leave out for the whole year. Otherwise 1–12, "Sep", "September" or "2026-09".' }, year: { type: 'integer', description: 'Defaults to this year.' } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'set_budget', title: 'Set a budget', description: 'Set (or clear, with amount null) one category’s monthly budget. Pass through_month to apply the same amount to every month up to it, e.g. October to December.',
    inputSchema: { type: 'object', required: ['category'], properties: { category: catProp, amount: { type: ['number', 'null'], description: 'Monthly budget in dollars; null removes it.' }, month: monthProp, through_month: { type: 'string', description: 'Last month to set, same formats as month.' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'add_income', title: 'Record income', description: 'Add a paycheque or other income to its month (by date). who: paula, jam or other.',
    inputSchema: { type: 'object', required: ['date', 'amount', 'source'], properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, amount: { type: 'number' }, source: { type: 'string', description: 'Where it came from, e.g. "Valard" or "Suncoast".' }, who: { type: 'string', enum: ['paula', 'jam', 'other'] }, note: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'remove_income', title: 'Remove income', description: 'Remove one income entry (ids come from year_overview with a month).',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  { name: 'sync_google_sheet', title: 'Sync the Google Sheet', description: 'Rewrite the Transactions, Weeks, Months, Budget and Income tabs of the linked Google Sheet now (it also syncs by itself every few minutes after changes).', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: 'sync_notion', title: 'Sync a week to Notion', description: 'Send a week and its transactions to the Budget Weeks / Budget Ledger databases in Notion. Only changes are sent.', inputSchema: { type: 'object', properties: { week: weekProp } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
];

/* ---------- helpers ---------- */
const cardOf = (settings: Settings, ref?: string | null) => {
  if (!ref) return null;
  const r = String(ref).trim().toLowerCase();
  return settings.cards.find(c => c.id.toLowerCase() === r) || settings.cards.find(c => c.name.toLowerCase() === r) || settings.cards.find(c => c.name.toLowerCase().includes(r)) || null;
};
const cardList = (s: Settings) => s.cards.map(c => `"${c.name}" (${c.id})`).join(', ');
const needWeek = async (env: Env, ref?: string) => {
  const w = await findWeek(env, ref);
  if (!w) throw new HttpError(404, ref ? `No week matches "${ref}". Use ledger_overview to see the weeks.` : 'There are no weeks yet. Use create_week first.');
  return w;
};
const isDate = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
function txOut(r: Row, settings: Settings, ratio: number, weekName?: string) {
  const [pp, jp] = parts(r, ratio);
  return {
    id: r.id, ...(weekName ? { week: weekName } : {}), date: r.date, description: r.desc, amount: r2(r.amt),
    category: r.cat || undefined, card: r.card ? settings.cards.find(c => c.id === r.card)?.name || r.card : undefined, split: modeLabel(r.mode, settings.names),
    paula: r2(r.p), jam: r2(r.j), shared: r2(r.s), paula_pays: pp, jam_pays: jp, note: r.note || undefined,
    needs_review: r.sug ? 'split guessed from past weeks' : undefined, source: r.src === 'manual' ? 'added by hand' : r.src === 'ai' ? 'added by AI' : r.src === 'sheet' ? '2026 workbook' : 'bank file',
  };
}
function weekSummary(w: WeekMeta, rows: Row[], settings: Settings) {
  const t = calc(rows, w.ratioP, settings.cards);
  const n = settings.names;
  return {
    id: w.id, name: w.name, kind: w.kind === 'month' ? 'month from the 2026 workbook' : 'week', dates: t.min ? `${t.min} to ${t.max}` : null, items: t.count, salary_ratio: `${w.ratioP}/${100 - w.ratioP}`,
    total_spent: t.total, paula_only: t.p, jam_only: t.j, shared: t.s, paula_share: t.pShare, jam_share: t.jShare,
    transfer: w.kind === 'month' ? 'none (month record)' : t.settle >= 0 ? `${n.p} pays ${n.j}` : `${n.j} pays ${n.p}`, transfer_amount: r2(Math.abs(t.settle)),
    paid_on: w.paid || null, not_split_yet: t.un, guessed_splits_to_review: t.sug,
  };
}
function summaryText(w: WeekMeta, rows: Row[], settings: Settings) {
  const t = calc(rows, w.ratioP, settings.cards), n = settings.names, rp = w.ratioP;
  const lines = [
    `Budget split · ${w.name}${t.min ? ` (${dShort(t.min)} – ${dShort(t.max)}, ${t.max!.slice(0, 4)})` : ''}`,
    `Total spent: ${money(t.total)} (${t.count} items)`, '',
    `${n.p} only: ${money(t.p)}`, `${n.j} only: ${money(t.j)}`,
    `Shared: ${money(t.s)} → ${n.p} ${rp}% ${money(t.s * rp / 100)} · ${n.j} ${100 - rp}% ${money(t.s * (100 - rp) / 100)}`, '',
    `${n.p}'s share: ${money(t.pShare)}`, `${n.j}'s share: ${money(t.jShare)}`,
    w.kind === 'month' ? 'No transfer is worked out for workbook months.' : `${t.settle >= 0 ? `${n.p} pays ${n.j}` : `${n.j} pays ${n.p}`}: ${money(Math.abs(t.settle))}`,
  ];
  if (t.un) lines.push('', `(${t.un} item${t.un === 1 ? '' : 's'} not split yet)`);
  return lines.join('\n');
}
function applySplit(row: Row, args: any, settings: Settings) {
  if (args.split == null) return;
  const mode = modeFrom(args.split, settings);
  if (!mode) throw new HttpError(400, `Unknown split "${args.split}". Use one of: ${SPLIT_ENUM.join(', ')}.`);
  if (mode === 'C') {
    const p = Number(args.paula_amount) || 0, j = Number(args.jam_amount) || 0;
    if (Math.abs(p + j) > Math.abs(row.amt) + 0.005) throw new HttpError(400, `paula_amount + jam_amount (${r2(p + j)}) is more than the amount (${r2(row.amt)}).`);
    applyMode(row, 'C', { p, j });
  } else applyMode(row, mode);
}

function applyCategory(row: Row, args: any, settings: Settings) {
  if (args.category == null) return;
  if (String(args.category).trim() === '') { row.cat = ''; return; }
  const c = catOf(settings, args.category);
  if (!c) throw new HttpError(400, `Unknown category "${args.category}". Categories: ${settings.categories.map(x => x.name).join(', ')}.`);
  row.cat = c;
}
function monthOf(arg: unknown, fallbackYear: number): { year: number; mm: string } {
  const s = String(arg ?? '').trim().toLowerCase();
  let m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m && +m[2] >= 1 && +m[2] <= 12) return { year: +m[1], mm: String(+m[2]).padStart(2, '0') };
  m = s.match(/^(\d{1,2})$/);
  if (m && +m[1] >= 1 && +m[1] <= 12) return { year: fallbackYear, mm: String(+m[1]).padStart(2, '0') };
  const i = MONTH_LONG.findIndex(x => s && (x.toLowerCase() === s || x.toLowerCase().slice(0, 3) === s.slice(0, 3)) && /^[a-z]+$/.test(s));
  if (i >= 0) return { year: fallbackYear, mm: String(i + 1).padStart(2, '0') };
  throw new HttpError(400, `Couldn’t read the month "${arg}". Use 1–12, "Sep" or "2026-09".`);
}
async function yearData(env: Env, settings: Settings, year: number) {
  const [doc, rows, weeks] = await Promise.all([getYear(env, year), getAllRows(env), listWeeks(env)]);
  const d = doc || normalizeYear(null, year);
  const ratio = new Map(weeks.map(w => [w.id, w.ratioP]));
  return { doc: d, agg: yearAgg(rows.map(r => ({ row: r, ratioP: ratio.get(r.weekId) ?? settings.ratioP })), d, settings) };
}

/* ---------- tool implementations ---------- */
export async function callTool(env: Env, name: string, args: any): Promise<unknown> {
  args = args || {};
  const settings = await getSettings(env);
  switch (name) {
    case 'ledger_overview': {
      const weeks = await listWeeks(env);
      const sheets = await sheetsState(env);
      return {
        people: settings.names, default_salary_ratio: `${settings.ratioP}/${100 - settings.ratioP} (${settings.names.p}/${settings.names.j})`,
        cards: settings.cards.map(c => ({ id: c.id, name: c.name, bill_paid_by: c.payer === 'p' ? settings.names.p : settings.names.j })),
        categories: Object.fromEntries(GROUPS.map(([g]) => [g, settings.categories.filter(c => c.group === g).map(c => c.name)])),
        weeks: weeks.map(w => ({ id: w.id, name: w.name, kind: w.kind === 'month' ? 'month record' : 'week', dates: w.minDate ? `${w.minDate} to ${w.maxDate}` : null, items: w.count, total_spent: w.total, transfer_amount: r2(Math.abs(w.settle)), transfer: w.kind === 'month' ? 'none (month record)' : w.settle >= 0 ? `${settings.names.p} pays ${settings.names.j}` : `${settings.names.j} pays ${settings.names.p}`, paid_on: w.paid || null })),
        latest_week: weeks[0]?.id || null,
        google_sheet: sheets.url || null,
      };
    }
    case 'get_week': {
      const w = await needWeek(env, args.week);
      const rows = await getRows(env, w.id);
      return { week: weekSummary(w, rows, settings), transactions: rows.map(r => txOut(r, settings, w.ratioP)) };
    }
    case 'search_transactions': {
      const weeks = await listWeeks(env);
      const wk = new Map(weeks.map(w => [w.id, w]));
      let rows = await getAllRows(env);
      if (args.week) { const w = await needWeek(env, args.week); rows = rows.filter(r => r.weekId === w.id); }
      if (args.text) { const q = String(args.text).toLowerCase(); rows = rows.filter(r => r.desc.toLowerCase().includes(q) || (r.note || '').toLowerCase().includes(q)); }
      if (isDate(args.from)) rows = rows.filter(r => r.date >= args.from);
      if (isDate(args.to)) rows = rows.filter(r => r.date <= args.to);
      if (args.card) { const c = cardOf(settings, args.card); if (!c) throw new HttpError(400, `Unknown card. Cards: ${cardList(settings)}.`); rows = rows.filter(r => r.card === c.id); }
      if (args.split) { const want = /^not/i.test(args.split) ? null : modeFrom(args.split, settings); rows = rows.filter(r => (r.mode || null) === want); }
      if (args.category) {
        if (/^(none|uncategori[sz]ed|no category)$/i.test(String(args.category))) rows = rows.filter(r => !r.cat);
        else { const c = catOf(settings, args.category); if (!c) throw new HttpError(400, `Unknown category "${args.category}".`); rows = rows.filter(r => r.cat === c); }
      }
      if (typeof args.min_amount === 'number') rows = rows.filter(r => r.amt >= args.min_amount);
      if (typeof args.max_amount === 'number') rows = rows.filter(r => r.amt <= args.max_amount);
      const limit = Math.min(500, Math.max(1, Number(args.limit) || 100));
      const total = r2(rows.reduce((a, r) => a + (r.mode === 'X' ? 0 : r.amt), 0));
      return { matched: rows.length, total_amount: total, shown: Math.min(limit, rows.length), transactions: rows.slice(0, limit).map(r => txOut(r, settings, wk.get(r.weekId)?.ratioP ?? settings.ratioP, wk.get(r.weekId)?.name)) };
    }
    case 'add_transaction': {
      if (!isDate(args.date)) throw new HttpError(400, 'date must be YYYY-MM-DD.');
      if (!args.description) throw new HttpError(400, 'description is required.');
      const amt = Number(args.amount); if (!isFinite(amt) || amt === 0) throw new HttpError(400, 'amount must be a non-zero number.');
      let w = await findWeek(env, args.week);
      if (!w) w = await createWeek(env, settings);
      const card = args.card ? cardOf(settings, args.card) : (cardOf(settings, 'other') || settings.cards[0]);
      if (!card) throw new HttpError(400, `Unknown card. Cards: ${cardList(settings)}.`);
      const row: Row = { id: rid(), date: args.date, desc: String(args.description).slice(0, 300), amt: r2(amt), card: card.id, mode: null, p: 0, j: 0, s: 0, note: String(args.note || ''), src: 'ai', sug: false, imp: null, dupOk: false, cat: '' };
      applySplit(row, args, settings);
      if (args.category != null) applyCategory(row, args, settings);
      else row.cat = suggestCat(catStats(await getAllRows(env)), row.desc);
      await patchRows(env, w.id, [row], []);
      return { added: txOut(row, settings, w.ratioP, w.name) };
    }
    case 'update_transaction': {
      const found = await getRow(env, String(args.id || ''));
      if (!found) throw new HttpError(404, `No transaction with id "${args.id}".`);
      const { weekId, ...row } = found;
      const w = (await findWeek(env, weekId))!;
      if (args.description != null) row.desc = String(args.description).slice(0, 300);
      if (args.date != null) { if (!isDate(args.date)) throw new HttpError(400, 'date must be YYYY-MM-DD.'); row.date = args.date; }
      if (args.card != null) { const c = cardOf(settings, args.card); if (!c) throw new HttpError(400, `Unknown card. Cards: ${cardList(settings)}.`); row.card = c.id; }
      if (args.note != null) row.note = String(args.note).slice(0, 500);
      if (args.amount != null) {
        const a = Number(args.amount); if (!isFinite(a) || a === 0) throw new HttpError(400, 'amount must be a non-zero number.');
        row.amt = r2(a);
        if (row.mode && row.mode !== 'C' && args.split == null) applyMode(row, row.mode);
      }
      applySplit(row, args, settings);
      applyCategory(row, args, settings);
      await patchRows(env, weekId, [row], []);
      return { updated: txOut(row, settings, w.ratioP, w.name) };
    }
    case 'delete_transaction': {
      const found = await getRow(env, String(args.id || ''));
      if (!found) throw new HttpError(404, `No transaction with id "${args.id}".`);
      await patchRows(env, found.weekId, [], [found.id]);
      return { deleted: { id: found.id, description: found.desc, amount: found.amt, date: found.date } };
    }
    case 'import_transactions': {
      const card = cardOf(settings, args.card);
      if (!card) throw new HttpError(400, `Unknown card "${args.card}". Cards: ${cardList(settings)}.`);
      let lines: ParsedLine[] = [];
      if (typeof args.csv === 'string' && args.csv.trim()) {
        const parsed = parseStatement(args.csv);
        if (!parsed.rows.length) throw new HttpError(400, parsed.error || 'No transactions found in the CSV.');
        lines = parsed.rows;
      } else if (Array.isArray(args.transactions)) {
        const parsed = parseGrid([['Date', 'Description', 'Amount'], ...args.transactions.map((t: any) => [t.date, t.description, t.amount])]);
        lines = parsed.rows;
      }
      if (!lines.length) throw new HttpError(400, 'Pass csv text or a transactions list.');
      let w = await findWeek(env, args.week);
      if (!w) w = await createWeek(env, settings);
      const all = await getAllRows(env);
      const weeks = await listWeeks(env);
      const wname = new Map(weeks.map(x => [x.id, x.name]));
      const stats = merchantStats(all), cstats = catStats(all);
      const items = classifyImport(lines, card.id, all, isDate(args.from) ? args.from : null, isDate(args.until) ? args.until : null);
      const impId = 'i' + rid('').slice(0, 9);
      const add: Row[] = [], flagged: unknown[] = [];
      const keepDupes = !!args.add_possible_duplicates;
      for (const x of items) {
        if (x.status !== 'new') continue;
        if ((x.near || x.repeated) && !keepDupes) {
          flagged.push({ date: x.date, description: x.desc, amount: x.amt, why: x.near ? `same amount as "${x.near.desc}" ${x.near.card ? `on ${settings.cards.find(c => c.id === x.near!.card)?.name || x.near.card}` : 'in the 2026 workbook'}, ${x.near.date} (${wname.get((x.near as any).weekId) || 'another week'})` : 'this exact line appears more than once in the statement' });
          continue;
        }
        const row: Row = { id: rid(), date: x.date, desc: x.desc, amt: x.amt, card: card.id, mode: null, p: 0, j: 0, s: 0, note: '', src: 'csv', sug: false, imp: impId, dupOk: !!(x.near || x.repeated), cat: suggestCat(cstats, x.desc) };
        const s = suggest(stats, x.desc);
        if (s) { applyMode(row, s); row.sug = true; }
        add.push(row);
      }
      if (add.length) {
        await patchRows(env, w.id, add, []);
        const fresh = (await findWeek(env, w.id))!;
        const dates = add.map(r => r.date).sort();
        await putWeek(env, w.id, { ...fresh, imports: [...((fresh.imports as any[]) || []), { id: impId, file: String(args.file_name || 'Imported by AI'), card: card.id, from: args.from || dates[0], to: args.until || dates[dates.length - 1], n: add.length, at: new Date().toISOString() }] });
      }
      const count = (s: string) => items.filter(x => x.status === s).length;
      return {
        week: w.name, card: card.name, added: add.length, guessed_splits: add.filter(r => r.sug).length, categorized: add.filter(r => r.cat).length,
        skipped: { card_payments: count('payment'), already_in_ledger: count('duplicate'), before_from: count('before_range'), after_until: count('after_range'), possible_duplicates: flagged.length },
        possible_duplicates: flagged,
        added_transactions: add.map(r => txOut(r, settings, w!.ratioP)),
        next_step: flagged.length ? 'Ask before adding the possible duplicates; call again with add_possible_duplicates=true and only those lines if they are real.' : undefined,
      };
    }
    case 'create_week': {
      const w = await createWeek(env, settings, args.name, args.ratio);
      return { created: { id: w.id, name: w.name, salary_ratio: `${w.ratioP}/${100 - w.ratioP}` } };
    }
    case 'update_week': {
      const w = await needWeek(env, args.week);
      const body: any = { ...w };
      if (args.name) body.name = String(args.name);
      if (args.ratio != null) body.ratioP = Number(args.ratio);
      if (args.paid === true) body.paid = isDate(args.paid_on) ? args.paid_on : todayISO(env.TZ);
      if (args.paid === false) body.paid = null;
      const out = (await putWeek(env, w.id, body))!;
      return { week: weekSummary(out, await getRows(env, w.id), settings) };
    }
    case 'settlement_summary': {
      const w = await needWeek(env, args.week);
      const rows = await getRows(env, w.id);
      return { text: summaryText(w, rows, settings), numbers: weekSummary(w, rows, settings) };
    }
    case 'year_overview': {
      const year = Number(args.year) || new Date().getFullYear();
      const { doc, agg } = await yearData(env, settings, year);
      const n = settings.names;
      if (args.month == null || args.month === '') {
        const months = MONTH_KEYS.filter(mm => agg[mm]).map(mm => { const m = agg[mm]; return { month: `${MONTH_LONG[+mm - 1]} ${year}`, income: m.income, spent: r2(m.spent), left_to_spend: r2(m.income - m.spent), budget: m.budget, into_savings: m.saved, paula_share: r2(m.p), jam_share: r2(m.j), not_split: m.unAmt, items: m.n }; });
        const cats: Record<string, number> = {};
        Object.values(agg).forEach(m => { Object.entries(m.cats).forEach(([c, v]) => { cats[c || 'No category'] = r2((cats[c || 'No category'] || 0) + v); }); Object.entries(m.savedCats).forEach(([c, v]) => { cats[c] = r2((cats[c] || 0) + v); }); });
        const sum = (k: 'income' | 'spent' | 'saved' | 'p' | 'j' | 'unAmt') => r2(Object.values(agg).reduce((a, m) => a + m[k], 0));
        const snaps = doc.snapshots.slice().sort((a, b) => a.date.localeCompare(b.date));
        return {
          year, totals: { income: sum('income'), spent: sum('spent'), left_to_spend: r2(sum('income') - sum('spent')), into_savings: sum('saved'), [`${n.p.toLowerCase()}_share`]: sum('p'), [`${n.j.toLowerCase()}_share`]: sum('j'), not_split: sum('unAmt') },
          months, spending_by_category: Object.fromEntries(Object.entries(cats).sort((a, b) => b[1] - a[1])),
          latest_savings_balances: snaps.length ? snaps[snaps.length - 1] : null,
        };
      }
      const { mm } = monthOf(args.month, year);
      const m = agg[mm];
      const md = doc.months[mm];
      const lines = monthBudgetLines(mm, m, doc, settings);
      const groups = Object.fromEntries([...GROUPS.map(g => g[0]), ''].map(g => {
        const ls = lines.filter(l => l.group === g); if (!ls.length) return null;
        const b = r2(ls.reduce((a, l) => a + (l.budget || 0), 0)), sp = r2(ls.reduce((a, l) => a + l.spent, 0));
        return [g || 'other', { budget: b, spent: sp, left: r2(b - sp), share_of_income_target: md?.pct?.[g as 'needs'] ?? null, categories: ls.map(l => ({ category: l.category, budget: l.budget, spent: l.spent, left: l.left })) }];
      }).filter(Boolean) as [string, unknown][]);
      return {
        month: `${MONTH_LONG[+mm - 1]} ${year}`, income: m?.income || 0, spent: r2(m?.spent || 0), left_to_spend: r2((m?.income || 0) - (m?.spent || 0)), into_savings: m?.saved || 0,
        people: { [n.p]: { income: m?.incP || 0, share: r2(m?.p || 0), left: r2((m?.incP || 0) - (m?.p || 0)) }, [n.j]: { income: m?.incJ || 0, share: r2(m?.j || 0), left: r2((m?.incJ || 0) - (m?.j || 0)) } },
        not_split: m?.unAmt || 0, budget_note: md?.budgetFrom || undefined, groups,
        income_entries: (md?.income || []).map(i => ({ id: i.id, date: i.date, source: i.source, who: i.who === 'p' ? n.p : i.who === 'j' ? n.j : 'other', amount: i.amt, note: i.note || undefined })),
      };
    }
    case 'set_budget': {
      const cat = catOf(settings, args.category);
      if (!cat) throw new HttpError(400, `Unknown category "${args.category}". Categories: ${settings.categories.map(x => x.name).join(', ')}.`);
      const now = new Date();
      const from = args.month != null && args.month !== '' ? monthOf(args.month, now.getFullYear()) : { year: now.getFullYear(), mm: String(now.getMonth() + 1).padStart(2, '0') };
      const to = args.through_month ? monthOf(args.through_month, from.year) : from;
      if (to.year !== from.year || to.mm < from.mm) throw new HttpError(400, 'through_month must be later in the same year.');
      const amount = args.amount === null || args.amount === undefined ? null : Number(args.amount);
      if (amount !== null && !isFinite(amount)) throw new HttpError(400, 'amount must be a number, or null to remove the budget.');
      const doc = (await getYear(env, from.year)) || normalizeYear(null, from.year);
      const changed: string[] = [];
      for (const mm of MONTH_KEYS.filter(k => k >= from.mm && k <= to.mm)) {
        const md = doc.months[mm] || (doc.months[mm] = { budget: {}, income: [], pct: {}, saved: {} });
        if (amount === null) delete md.budget[cat]; else md.budget[cat] = r2(amount);
        delete md.budgetFrom; changed.push(MONTH_LONG[+mm - 1]);
      }
      await saveYear(env, from.year, doc);
      return { category: cat, group: catGroup(settings, cat), amount: amount === null ? null : r2(amount), months: changed, year: from.year };
    }
    case 'add_income': {
      if (!isDate(args.date)) throw new HttpError(400, 'date must be YYYY-MM-DD.');
      const amt = Number(args.amount); if (!isFinite(amt) || amt === 0) throw new HttpError(400, 'amount must be a non-zero number.');
      if (!String(args.source || '').trim()) throw new HttpError(400, 'source is required, e.g. "Valard".');
      const year = +args.date.slice(0, 4), mm = args.date.slice(5, 7);
      const doc = (await getYear(env, year)) || normalizeYear(null, year);
      const md = doc.months[mm] || (doc.months[mm] = { budget: {}, income: [], pct: {}, saved: {} });
      const who = modeFrom(args.who, settings);
      const entry = { id: rid('i'), date: args.date, source: String(args.source).trim().slice(0, 80), who: (who === 'P' ? 'p' : who === 'J' ? 'j' : '') as 'p' | 'j' | '', amt: r2(amt), note: String(args.note || '').slice(0, 300) };
      md.income.push(entry);
      await saveYear(env, year, doc);
      return { added: { ...entry, who: entry.who === 'p' ? settings.names.p : entry.who === 'j' ? settings.names.j : 'other' }, month: `${MONTH_LONG[+mm - 1]} ${year}`, month_income: r2(md.income.reduce((a, i) => a + i.amt, 0)) };
    }
    case 'remove_income': {
      const id = String(args.id || '');
      for (const year of [new Date().getFullYear(), new Date().getFullYear() - 1, new Date().getFullYear() + 1]) {
        const doc = await getYear(env, year); if (!doc) continue;
        for (const [mm, md] of Object.entries(doc.months)) {
          const i = md.income.findIndex(x => x.id === id); if (i < 0) continue;
          const [gone] = md.income.splice(i, 1);
          await saveYear(env, year, doc);
          return { removed: gone, month: `${MONTH_LONG[+mm - 1]} ${year}` };
        }
      }
      throw new HttpError(404, `No income entry with id "${id}". Use year_overview with a month to see the ids.`);
    }
    case 'sync_google_sheet': return await pushSheets(env);
    case 'sync_notion': {
      const w = await needWeek(env, args.week);
      const sum = { added: 0, updated: 0, removed: 0 };
      let last: any = null;
      for (let i = 0; i < 3; i++) {
        last = await notionSyncWeek(env, w.id, 15);
        sum.added += last.added; sum.updated += last.updated; sum.removed += last.removed;
        if (last.done) break;
      }
      return { week: w.name, done: last.done, remaining: last.remaining, ...sum, note: last.done ? 'Notion is up to date for this week.' : 'Partly synced; call sync_notion again to finish.' };
    }
    default: throw new RpcError(-32602, `Unknown tool: ${name}`);
  }
}

async function createWeek(env: Env, settings: Settings, name?: string, ratio?: number) {
  const weeks = await listWeeks(env);
  const id = newWeekId(weeks);
  const t = todayISO(env.TZ);
  const [, m, d] = t.split('-');
  let nm = name ? String(name) : `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1]} ${+d}`;
  if (!name) { const base = nm; let n = 2; while (weeks.some(w => w.name === nm)) nm = `${base} (${n++})`; }
  return (await putWeek(env, id, { name: nm, ratioP: ratio ?? weeks[0]?.ratioP ?? settings.ratioP, created: new Date().toISOString(), paid: null, imports: [] }))!;
}

/* ---------- JSON-RPC plumbing ---------- */
class RpcError extends Error { constructor(public code: number, message: string) { super(message); } }

async function handleMessage(env: Env, msg: any, client: { name: string }) {
  const id = msg?.id;
  const isNotification = id === undefined || id === null;
  try {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') throw new RpcError(-32600, 'Invalid request');
    let result: unknown;
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        result = {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'jam-paula-ledger', title: 'Jam & Paula Ledger', version: '1.0.0' },
          instructions: INSTRUCTIONS,
        };
        break;
      }
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: TOOLS }; break;
      case 'resources/list': result = { resources: [] }; break;
      case 'prompts/list': result = { prompts: [] }; break;
      case 'tools/call': {
        const name = msg.params?.name;
        if (!TOOLS.some(t => t.name === name)) throw new RpcError(-32602, `Unknown tool: ${name}`);
        try {
          const out = await callTool(env, name, msg.params?.arguments);
          const text = typeof out === 'object' && out && 'text' in (out as any) && Object.keys(out as any).length <= 2
            ? `${(out as any).text}\n\n${JSON.stringify((out as any).numbers ?? {}, null, 1)}`
            : JSON.stringify(out, null, 1);
          result = { content: [{ type: 'text', text }], structuredContent: out, isError: false };
        } catch (e: any) {
          if (e instanceof RpcError) throw e;
          const message = e instanceof HttpError ? e.message : 'The ledger hit an error running that tool.';
          if (!(e instanceof HttpError)) console.error('mcp tool error', name, e);
          result = { content: [{ type: 'text', text: message }], isError: true };
        }
        break;
      }
      default:
        if (msg.method.startsWith('notifications/')) return null;
        throw new RpcError(-32601, `Method not found: ${msg.method}`);
    }
    return isNotification ? null : { jsonrpc: '2.0', id, result };
  } catch (e: any) {
    if (isNotification) return null;
    const code = e instanceof RpcError ? e.code : -32603;
    return { jsonrpc: '2.0', id, error: { code, message: e?.message || 'Internal error' } };
  }
}

export async function handleMcp(req: Request, env: Env): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const pathKey = url.pathname.match(/^\/mcp\/([A-Za-z0-9_-]{16,})$/)?.[1];
  const token = bearer || url.searchParams.get('key') || pathKey;
  if (!token) return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'This ledger needs a connection token. Create one in the app: Settings → AI connections.' } }, 401);
  const hash = await sha256(token);
  const row = await env.DB.prepare('SELECT id, name, last_used FROM api_tokens WHERE token_hash = ?').bind(hash).first<{ id: string; name: string; last_used: string | null }>();
  if (!row) return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'That connection token isn’t valid any more. Create a new one in Settings → AI connections.' } }, 401);
  if (!row.last_used || Date.now() - Date.parse(row.last_used) > 10 * 60 * 1000) {
    await env.DB.prepare('UPDATE api_tokens SET last_used = ? WHERE id = ?').bind(new Date().toISOString(), row.id).run();
  }
  if (req.method === 'GET') return new Response('This MCP server answers POST requests only (no event stream).', { status: 405, headers: { ...CORS, Allow: 'POST' } });
  if (req.method === 'DELETE') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { ...CORS, Allow: 'POST' } });
  let body: any;
  try { body = await req.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
  const client = { name: row.name };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(m => handleMessage(env, m, client)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
  }
  const out = await handleMessage(env, body, client);
  return out ? json(out) : new Response(null, { status: 202, headers: CORS });
}

export { TOOLS };
