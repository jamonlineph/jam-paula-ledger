import { calc, catGroup, modeLabel, MONTH_KEYS, MONTH_LONG, monthBudgetLines, normalizeYear, NotionRec, parts, r2, yearAgg, type Row, type WeekMeta } from './core';
import { getAllRows, getDoc, getRows, getSettings, getWeek, getYear, listWeeks, putDoc, setWeekNotion, type Env, HttpError } from './db';

const SOURCE: Record<string, string> = { manual: 'Added by hand', ai: 'Added by AI', sheet: '2026 workbook', csv: 'Bank file' };
/* ===================== Google Sheets =====================
   The sheet runs a tiny Apps Script web app (apps-script/Code.gs). We POST the
   whole ledger to it and it rewrites the Transactions and Weeks tabs. */
export const TX_HEADER = ['Ledger ID', 'Week', 'Week ID', 'Date', 'Description', 'Amount', 'Category', 'Group', 'Card', 'Bill paid by', 'Split', 'Paula', 'Jam', 'Shared', "Paula's part", "Jam's part", 'Note', 'Source', 'Imported from', 'Last synced'];
export const WEEK_HEADER = ['Week ID', 'Week', 'Kind', 'From', 'To', 'Items', 'Total spent', 'Paula only', 'Jam only', 'Shared', 'Salary ratio', "Paula's share", "Jam's share", 'Transfer', 'Transfer amount', 'Paid on', 'Not split yet', 'Last synced'];
export const MONTH_HEADER = ['Month', 'Income', 'Paula income', 'Jam income', 'Other income', 'Spent', 'Left to spend', 'Budget', 'Into savings', "Paula's share", "Jam's share", 'Not split'];
export const BUDGET_HEADER = ['Month', 'Category', 'Group', 'Budget', 'Spent', 'Left'];
export const INCOME_HEADER = ['Date', 'Month', 'Source', 'Who', 'Amount', 'Note'];

export async function sheetsState(env: Env) {
  const st = await getDoc<any>(env, 'sheets_state', {});
  return { configured: !!(env.SHEETS_WEBHOOK_URL && env.SHEETS_TOKEN), url: env.SHEET_URL || null, ...st };
}

export async function buildSheetPayload(env: Env) {
  const settings = await getSettings(env);
  const weeks = await listWeeks(env);
  const rows = await getAllRows(env);
  const syncedAt = new Date().toISOString();
  const cardName = (id: string) => settings.cards.find(c => c.id === id)?.name || 'Unknown card';
  const payerName = (id: string) => (settings.cards.find(c => c.id === id)?.payer === 'p' ? settings.names.p : settings.names.j);
  const byWeek = new Map<string, (Row & { weekId: string })[]>();
  rows.forEach(r => { if (!byWeek.has(r.weekId)) byWeek.set(r.weekId, []); byWeek.get(r.weekId)!.push(r); });
  const txRows: unknown[][] = [];
  const weekRows: unknown[][] = [];
  for (const w of weeks) {
    const list = byWeek.get(w.id) || [];
    const files = new Map<string, string>(((w.imports as any[]) || []).map(im => [im.id, im.file]));
    for (const r of list) {
      const [pp, jp] = parts(r, w.ratioP);
      txRows.push([r.id, w.name, w.id, r.date, r.desc, r2(r.amt), r.cat || '', catGroup(settings, r.cat), r.card ? cardName(r.card) : '', r.card ? payerName(r.card) : '', modeLabel(r.mode, settings.names),
        r2(r.p), r2(r.j), r2(r.s), pp, jp, r.note || '', SOURCE[r.src] || 'Bank file',
        r.imp ? (files.get(r.imp) || '') : '', syncedAt]);
    }
    const t = calc(list, w.ratioP, settings.cards);
    const rec = w.kind === 'month';
    weekRows.push([w.id, w.name, rec ? 'Month (workbook)' : 'Week', t.min || '', t.max || '', t.count, t.total, t.p, t.j, t.s, `${w.ratioP}/${100 - w.ratioP}`, t.pShare, t.jShare,
      rec ? 'No transfer (month record)' : t.settle >= 0 ? `${settings.names.p} pays ${settings.names.j}` : `${settings.names.j} pays ${settings.names.p}`, r2(Math.abs(t.settle)), w.paid || '', t.un, syncedAt]);
  }
  // the year: one line per month, budget lines and income
  const year = new Date().getFullYear();
  const doc = (await getYear(env, year)) || normalizeYear(null, year);
  const ratio = new Map(weeks.map(w => [w.id, w.ratioP]));
  const agg = yearAgg(rows.map(r => ({ row: r, ratioP: ratio.get(r.weekId) ?? settings.ratioP })), doc, settings);
  const monthRows: unknown[][] = [], budgetRows: unknown[][] = [], incomeRows: unknown[][] = [];
  for (const mm of MONTH_KEYS) {
    const m = agg[mm]; if (!m) continue;
    const label = `${MONTH_LONG[+mm - 1]} ${year}`;
    monthRows.push([label, m.income, m.incP, m.incJ, m.incO, r2(m.spent), r2(m.income - m.spent), m.budget, m.saved, r2(m.p), r2(m.j), m.unAmt]);
    for (const l of monthBudgetLines(mm, m, doc, settings)) budgetRows.push([label, l.category, l.group, l.budget, l.spent, l.left]);
    for (const i of (doc.months[mm]?.income || []).slice().sort((a, b) => a.date.localeCompare(b.date))) incomeRows.push([i.date, label, i.source, i.who === 'p' ? settings.names.p : i.who === 'j' ? settings.names.j : '', i.amt, i.note || '']);
  }
  return {
    transactions: { header: TX_HEADER, rows: txRows }, weeks: { header: WEEK_HEADER, rows: weekRows },
    months: { header: MONTH_HEADER, rows: monthRows }, budget: { header: BUDGET_HEADER, rows: budgetRows }, income: { header: INCOME_HEADER, rows: incomeRows },
    syncedAt,
  };
}

export async function pushSheets(env: Env) {
  if (!env.SHEETS_WEBHOOK_URL || !env.SHEETS_TOKEN) throw new HttpError(400, 'Google Sheets isn’t connected yet. Set SHEETS_WEBHOOK_URL and SHEETS_TOKEN (see README).');
  const before = await getDoc<any>(env, 'sheets_state', {});
  const payload = await buildSheetPayload(env);
  let res: Response, body: any = null;
  try {
    res = await fetch(env.SHEETS_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: env.SHEETS_TOKEN, ...payload }), redirect: 'follow' });
    const text = await res.text();
    try { body = JSON.parse(text); } catch { body = { ok: false, error: `The sheet answered with something other than JSON (HTTP ${res.status}). Check the Apps Script deployment URL and that it runs as you with access for "Anyone".` }; }
  } catch (e: any) {
    body = { ok: false, error: `Couldn’t reach the sheet: ${e?.message || e}` };
  }
  if (!body?.ok) {
    await putDoc(env, 'sheets_state', { ...before, dirty: true, lastAttempt: payload.syncedAt, error: body?.error || 'The sheet refused the update.' });
    throw new HttpError(502, body?.error || 'The sheet refused the update.');
  }
  const st = { dirty: false, lastSync: payload.syncedAt, transactions: payload.transactions.rows.length, weeks: payload.weeks.rows.length, error: null };
  await putDoc(env, 'sheets_state', st);
  return st;
}

/** Cron: push when something changed since the last sync. */
export async function cronSheets(env: Env) {
  if (!env.SHEETS_WEBHOOK_URL || !env.SHEETS_TOKEN) return;
  const st = await getDoc<any>(env, 'sheets_state', {});
  if (!st.dirty) return;
  try { await pushSheets(env); } catch (e) { console.warn('sheets sync failed', e); }
}

/* ===================== Notion =====================
   Same records as the Claude version's sync: one page per week in Budget Weeks,
   one per transaction in Budget Ledger. Needs NOTION_TOKEN (an internal
   integration connected to the "Jam & Paula Budget" page). Each call does at
   most `budget` Notion requests so it stays inside Workers' subrequest limit;
   the app calls again until `done` is true. */
const LEDGER_TYPES: Record<string, string> = { 'Category': 'select', 'Description': 'title', 'Date': 'date', 'Amount': 'number', 'Card': 'select', 'Split': 'select', 'Paula': 'number', 'Jam': 'number', 'Shared': 'number', "Paula's part": 'number', "Jam's part": 'number', 'Note': 'rich_text', 'Source': 'select', 'Week': 'relation', 'Removed from app': 'checkbox', 'Ledger ID': 'rich_text' };
const WEEK_TYPES: Record<string, string> = { 'Week': 'title', 'Dates': 'date', 'Total spent': 'number', 'Paula only': 'number', 'Jam only': 'number', 'Shared': 'number', 'Salary ratio': 'rich_text', "Paula's share": 'number', "Jam's share": 'number', 'Transfer': 'select', 'Transfer amount': 'number', 'Paid': 'checkbox', 'Paid on': 'date', 'Items': 'number', 'Not split yet': 'number', 'Ledger ID': 'rich_text', 'Last synced': 'date' };

export function toNotionApi(flat: Record<string, unknown>, types: Record<string, string>) {
  const out: Record<string, unknown> = {};
  const dates: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(flat)) {
    const m = k.match(/^date:(.+):(start|end|is_datetime)$/);
    if (m) { (dates[m[1]] ||= {})[m[2]] = v; continue; }
    const t = types[k]; if (!t) continue;
    if (t === 'title') out[k] = { title: [{ text: { content: String(v ?? '').slice(0, 2000) } }] };
    else if (t === 'rich_text') out[k] = { rich_text: v ? [{ text: { content: String(v).slice(0, 2000) } }] : [] };
    else if (t === 'number') out[k] = { number: v == null ? null : Number(v) };
    else if (t === 'select') out[k] = { select: v ? { name: String(v).replace(/,/g, ' ').slice(0, 100) } : null };
    else if (t === 'checkbox') out[k] = { checkbox: v === '__YES__' || v === true };
    else if (t === 'relation') out[k] = { relation: ((v as string[]) || []).map(id => ({ id })) };
  }
  for (const [name, d] of Object.entries(dates)) {
    if (!types[name]) continue;
    out[name] = { date: d.start ? { start: d.start, end: d.end || null } : null };
  }
  return out;
}

export async function notionSyncWeek(env: Env, weekId: string, budget = 40) {
  if (!env.NOTION_TOKEN) throw new HttpError(400, 'Notion isn’t connected on the server yet. Set NOTION_TOKEN (see README).');
  const settings = await getSettings(env);
  const cfg = settings.notion;
  if (!cfg?.weeksDs || !cfg?.ledgerDs) throw new HttpError(400, 'Notion databases aren’t set in Settings.');
  const week = await getWeek(env, weekId);
  if (!week) throw new HttpError(404, 'That week doesn’t exist.');
  const rows = await getRows(env, weekId);
  const t = calc(rows, week.ratioP, settings.cards);
  const ctx: any = { rp: week.ratioP, names: settings.names, cardName: (id: string) => settings.cards.find(c => c.id === id)?.name || 'Unknown card', now: new Date().toISOString() };
  const nm: { week?: string; wsig?: string; at?: string; rows: Record<string, [string, string]> } = JSON.parse(JSON.stringify(week.notion || { rows: {} }));
  nm.rows ||= {};
  const base = env.NOTION_API_BASE || 'https://api.notion.com';
  let ops = 0;
  const api = async (method: string, path: string, body: unknown) => {
    ops++;
    const res = await fetch(base + path, { method, headers: { 'Authorization': `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2025-09-03', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(res.status === 401 || res.status === 403 ? 400 : 502, `Notion: ${json?.message || res.statusText}`);
    return json;
  };
  const counts = { added: 0, updated: 0, removed: 0 };
  const wsig = NotionRec.weekSig(week as WeekMeta, t, ctx);
  try {
    if (!nm.week) {
      const page = await api('POST', '/v1/pages', { parent: { type: 'data_source_id', data_source_id: cfg.weeksDs }, properties: toNotionApi(NotionRec.weekProps(week as WeekMeta, t, ctx, true), WEEK_TYPES) });
      nm.week = page.id; nm.wsig = wsig;
    }
    ctx.weekId = nm.week;
    for (const r of rows) {
      if (ops >= budget) break;
      const m = nm.rows[r.id], sig = NotionRec.rowSig(r, ctx);
      if (!m) {
        const page = await api('POST', '/v1/pages', { parent: { type: 'data_source_id', data_source_id: cfg.ledgerDs }, properties: toNotionApi(NotionRec.rowProps(r, ctx), LEDGER_TYPES) });
        nm.rows[r.id] = [page.id, sig]; counts.added++;
      } else if (m[1] !== sig) {
        await api('PATCH', `/v1/pages/${m[0]}`, { properties: toNotionApi(NotionRec.rowProps(r, ctx), LEDGER_TYPES) });
        m[1] = sig; counts.updated++;
      }
    }
    const ids = new Set(rows.map(r => r.id));
    for (const id of Object.keys(nm.rows)) {
      if (ops >= budget) break;
      if (ids.has(id)) continue;
      await api('PATCH', `/v1/pages/${nm.rows[id][0]}`, { properties: { 'Removed from app': { checkbox: true } } });
      delete nm.rows[id]; counts.removed++;
    }
    const remaining = rows.filter(r => !nm.rows[r.id] || nm.rows[r.id][1] !== NotionRec.rowSig(r, ctx)).length + Object.keys(nm.rows).filter(id => !ids.has(id)).length;
    if (!remaining && ops < budget && (nm.wsig !== wsig || counts.added || counts.updated || counts.removed)) {
      await api('PATCH', `/v1/pages/${nm.week}`, { properties: toNotionApi(NotionRec.weekProps(week as WeekMeta, t, ctx, false), WEEK_TYPES) });
      nm.wsig = wsig;
    }
    const done = !remaining && nm.wsig === wsig;
    if (done) nm.at = ctx.now;
    return { done, remaining: remaining + (nm.wsig === wsig ? 0 : 1), ...counts };
  } finally {
    await setWeekNotion(env, weekId, nm);
  }
}
