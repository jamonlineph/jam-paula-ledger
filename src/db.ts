import { applyYearOps, calc, normalizeSettings, normalizeYear, type Row, type Settings, type WeekMeta, type YearDoc } from './core';

export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  ASSETS: Fetcher;
  SHEET_URL?: string;          // link shown in the app
  SHEETS_WEBHOOK_URL?: string; // Apps Script web app URL (secret)
  SHEETS_TOKEN?: string;       // shared secret with the Apps Script (secret)
  NOTION_TOKEN?: string;       // Notion internal integration token (secret, optional)
  NOTION_API_BASE?: string;    // tests only
  ANTHROPIC_API_KEY?: string;  // Ask AI on the website (secret, optional)
  ANTHROPIC_MODEL?: string;    // defaults to claude-sonnet-5-5
  ANTHROPIC_EFFORT?: string;   // low | medium (default) | high | xhigh | max
  ANTHROPIC_API_BASE?: string; // tests only
  TZ?: string;
}

const now = () => new Date().toISOString();

/* ---------- small JSON documents ---------- */
export async function getDoc<T = any>(env: Env, key: string, fallback: T): Promise<T> {
  const row = await env.DB.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first<{ value: string }>();
  if (!row) return fallback;
  try { return JSON.parse(row.value) as T; } catch { return fallback; }
}
export async function putDoc(env: Env, key: string, value: unknown) {
  await env.DB.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, JSON.stringify(value), now()).run();
}
export async function getSettings(env: Env): Promise<Settings> { return normalizeSettings(await getDoc(env, 'settings', null)); }
export async function saveSettings(env: Env, s: unknown) { const n = normalizeSettings(s); await putDoc(env, 'settings', n); await markSheetsDirty(env); return n; }

export async function getYear(env: Env, year: number): Promise<YearDoc | null> {
  const raw = await getDoc<any>(env, `year:${year}`, null);
  return raw ? normalizeYear(raw, year) : null;
}
export async function saveYear(env: Env, year: number, body: unknown) {
  if (JSON.stringify(body ?? {}).length > 400_000) throw new HttpError(413, 'That year is too big to save.');
  const doc = normalizeYear(body, year);
  await putDoc(env, `year:${year}`, doc);
  await markSheetsDirty(env);
  return doc;
}
/** Apply changes to the latest saved copy of a year (see applyYearOps). */
export async function patchYear(env: Env, year: number, ops: unknown) {
  if (!Array.isArray(ops) || ops.length > 500) throw new HttpError(400, 'Send a list of up to 500 changes.');
  const doc = (await getYear(env, year)) || normalizeYear(null, year);
  if (!ops.length) return doc;
  return saveYear(env, year, applyYearOps(doc, ops));
}
/** Every saved year document, oldest first. */
export async function listYears(env: Env): Promise<YearDoc[]> {
  const { results } = await env.DB.prepare("SELECT key, value FROM kv WHERE key LIKE 'year:%' ORDER BY key").all<{ key: string; value: string }>();
  const out: YearDoc[] = [];
  for (const r of results) {
    const y = Number(r.key.slice(5)); if (!isFinite(y)) continue;
    try { out.push(normalizeYear(JSON.parse(r.value), y)); } catch { /* skip a broken document */ }
  }
  return out;
}

export async function markSheetsDirty(env: Env) {
  const st = await getDoc<any>(env, 'sheets_state', {});
  if (!st.dirty) await putDoc(env, 'sheets_state', { ...st, dirty: true, dirtySince: now() });
}

/* ---------- rows ---------- */
interface TxnRow { id: string; week_id: string; date: string; description: string; amount: number; card: string; mode: string | null; p: number; j: number; s: number; note: string; src: string; sug: number; imp: string | null; dup_ok: number; cat: string | null }
export const toRow = (t: TxnRow): Row => ({ id: t.id, date: t.date, desc: t.description, amt: t.amount, card: t.card, mode: (t.mode || null) as Row['mode'], p: t.p, j: t.j, s: t.s, note: t.note || '', src: t.src, sug: !!t.sug, imp: t.imp, dupOk: !!t.dup_ok, cat: t.cat || '' });

export async function getRows(env: Env, weekId: string): Promise<Row[]> {
  const { results } = await env.DB.prepare('SELECT * FROM txns WHERE week_id = ? ORDER BY date DESC, rowid ASC').bind(weekId).all<TxnRow>();
  return results.map(toRow);
}
export async function getAllRows(env: Env): Promise<(Row & { weekId: string })[]> {
  const { results } = await env.DB.prepare('SELECT * FROM txns ORDER BY date DESC, rowid ASC').all<TxnRow>();
  return results.map(t => ({ ...toRow(t), weekId: t.week_id }));
}
/** Rows of several weeks in one query (the app's year view, history and search load every week). */
export async function getRowsOf(env: Env, weekIds: string[]): Promise<Record<string, Row[]>> {
  const ids = [...new Set(weekIds)].filter(id => /^[A-Za-z0-9_-]{1,40}$/.test(id)).slice(0, 90);
  const out: Record<string, Row[]> = Object.fromEntries(ids.map(id => [id, []]));
  if (!ids.length) return out;
  const { results } = await env.DB.prepare(`SELECT * FROM txns WHERE week_id IN (${ids.map(() => '?').join(',')}) ORDER BY date DESC, rowid ASC`).bind(...ids).all<TxnRow>();
  for (const t of results) out[t.week_id].push(toRow(t));
  return out;
}
export async function getRow(env: Env, id: string) {
  const t = await env.DB.prepare('SELECT * FROM txns WHERE id = ?').bind(id).first<TxnRow>();
  return t ? { ...toRow(t), weekId: t.week_id } : null;
}

function cleanRow(r: any): Row {
  const num = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;
  const mode = ['P', 'J', 'S', 'H', 'C', 'X'].includes(r.mode) ? r.mode : null;
  if (!r || typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(r.id)) throw new HttpError(400, 'Each transaction needs a short id.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.date))) throw new HttpError(400, `Transaction ${r.id} has a bad date.`);
  return {
    id: r.id, date: r.date, desc: String(r.desc ?? '').slice(0, 300), amt: num(r.amt), card: typeof r.card === 'string' ? r.card.slice(0, 60) : 'main',
    mode, p: num(r.p), j: num(r.j), s: num(r.s), note: String(r.note ?? '').slice(0, 500), src: ['csv', 'manual', 'ai', 'sheet'].includes(r.src) ? r.src : 'csv',
    sug: !!r.sug, imp: r.imp ? String(r.imp).slice(0, 40) : null, dupOk: !!r.dupOk, cat: String(r.cat ?? '').slice(0, 60),
  };
}
const upsertSql = `INSERT INTO txns (id, week_id, date, description, amount, card, mode, p, j, s, note, src, sug, imp, dup_ok, updated_at, cat)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
  ON CONFLICT(id) DO UPDATE SET week_id = excluded.week_id, date = excluded.date, description = excluded.description, amount = excluded.amount,
    card = excluded.card, mode = excluded.mode, p = excluded.p, j = excluded.j, s = excluded.s, note = excluded.note, src = excluded.src,
    sug = excluded.sug, imp = excluded.imp, dup_ok = excluded.dup_ok, updated_at = excluded.updated_at, cat = excluded.cat`;

/** Apply row changes to one week, then refresh its totals. */
export async function patchRows(env: Env, weekId: string, upsert: unknown[] = [], del: unknown[] = []) {
  const week = await getWeek(env, weekId);
  if (!week) throw new HttpError(404, 'That week doesn’t exist.');
  const ts = now();
  const stmts: D1PreparedStatement[] = [];
  const up = (upsert || []).map(cleanRow);
  for (const r of up) {
    stmts.push(env.DB.prepare(upsertSql).bind(r.id, weekId, r.date, r.desc, r.amt, r.card, r.mode, r.p, r.j, r.s, r.note, r.src, r.sug ? 1 : 0, r.imp ?? null, r.dupOk ? 1 : 0, ts, r.cat || ''));
  }
  const ids = (del || []).filter((x): x is string => typeof x === 'string');
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    stmts.push(env.DB.prepare(`DELETE FROM txns WHERE week_id = ? AND id IN (${chunk.map(() => '?').join(',')})`).bind(weekId, ...chunk));
  }
  if (!stmts.length) return { upserted: 0, deleted: 0 };
  await env.DB.batch(stmts);
  await recomputeWeek(env, weekId);
  await markSheetsDirty(env);
  return { upserted: up.length, deleted: ids.length };
}

/* ---------- weeks ---------- */
interface WeekRow { id: string; name: string; created: string; ratio_p: number; paid: string | null; meta: string; count: number; total: number; settle: number; min_date: string | null; max_date: string | null; updated_at: string }
const toWeek = (w: WeekRow): WeekMeta => {
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(w.meta || '{}'); } catch { /* keep empty */ }
  return { ...meta, id: w.id, name: w.name, created: w.created, ratioP: w.ratio_p, paid: w.paid, count: w.count, total: w.total, settle: w.settle, minDate: w.min_date, maxDate: w.max_date, updatedAt: w.updated_at } as WeekMeta;
};
export async function listWeeks(env: Env): Promise<WeekMeta[]> {
  const { results } = await env.DB.prepare('SELECT * FROM weeks ORDER BY created DESC').all<WeekRow>();
  return results.map(toWeek);
}
export async function getWeek(env: Env, id: string) {
  const w = await env.DB.prepare('SELECT * FROM weeks WHERE id = ?').bind(id).first<WeekRow>();
  return w ? toWeek(w) : null;
}
/** Resolve "latest", an id, or a week name. */
export async function findWeek(env: Env, ref?: string | null) {
  const weeks = await listWeeks(env);
  if (!weeks.length) return null;
  if (!ref || /^latest$/i.test(ref)) return weeks[0];
  const r = String(ref).trim().toLowerCase();
  return weeks.find(w => w.id.toLowerCase() === r) || weeks.find(w => w.name.toLowerCase() === r) || weeks.find(w => w.name.toLowerCase().includes(r)) || null;
}

const SERVER_FIELDS = new Set(['id', 'name', 'created', 'ratioP', 'paid', 'count', 'total', 'settle', 'minDate', 'maxDate', 'updatedAt', 'notion', 'importsAdd', 'importsRemove']);
/** Create or update a week from the app. Totals and the Notion map are owned by the server.
    Fields left out of the body keep their saved value, so the app sends only what it changed.
    importsAdd / importsRemove change the imported-files list without resending (and overwriting) it. */
export async function putWeek(env: Env, id: string, body: any, opts: { keepNotion?: boolean } = { keepNotion: true }) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new HttpError(400, 'Bad week id.');
  const existing = await getWeek(env, id);
  const meta: Record<string, unknown> = {};
  if (existing) for (const [k, v] of Object.entries(existing)) if (!SERVER_FIELDS.has(k)) meta[k] = v;
  for (const [k, v] of Object.entries(body || {})) if (!SERVER_FIELDS.has(k)) meta[k] = v;
  if (Array.isArray(body?.importsAdd) || Array.isArray(body?.importsRemove)) {
    const list = (Array.isArray(meta.imports) ? meta.imports : []) as { id?: unknown }[];
    const gone = new Set((body.importsRemove || []).map(String));
    const add = (body.importsAdd || []).filter((x: any) => x && typeof x.id === 'string' && !list.some(l => l?.id === x.id));
    meta.imports = list.filter(l => !gone.has(String(l?.id))).concat(add);
  }
  meta.notion = opts.keepNotion ? (existing?.notion ?? null) : (body?.notion ?? null);
  const name = String(body?.name ?? existing?.name ?? 'Untitled week').slice(0, 80) || 'Untitled week';
  const settings = await getSettings(env);
  let ratio = Number(body?.ratioP ?? existing?.ratioP ?? settings.ratioP);
  if (!isFinite(ratio)) ratio = settings.ratioP;
  ratio = Math.min(100, Math.max(0, Math.round(ratio)));
  const paid = body && 'paid' in body ? (body.paid ? String(body.paid).slice(0, 10) : null) : (existing?.paid ?? null);
  const created = existing?.created || (typeof body?.created === 'string' ? body.created : now());
  await env.DB.prepare(`INSERT INTO weeks (id, name, created, ratio_p, paid, meta, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, ratio_p = excluded.ratio_p, paid = excluded.paid, meta = excluded.meta, updated_at = excluded.updated_at`)
    .bind(id, name, created, ratio, paid, JSON.stringify(meta), now()).run();
  await recomputeWeek(env, id);
  await markSheetsDirty(env);
  return getWeek(env, id);
}
export async function setWeekNotion(env: Env, id: string, notion: unknown) {
  const w = await env.DB.prepare('SELECT meta FROM weeks WHERE id = ?').bind(id).first<{ meta: string }>();
  if (!w) return;
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(w.meta || '{}'); } catch { /* ignore */ }
  meta.notion = notion;
  await env.DB.prepare('UPDATE weeks SET meta = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(meta), now(), id).run();
}
/** Settings: move every transaction off a removed card, and off a renamed or removed category
    (an empty target clears the category). Budgets and savings in every year follow a category. */
export async function moveRefs(env: Env, cardMoves: Record<string, string>, catMoves: Record<string, string>) {
  const ts = now(), stmts: D1PreparedStatement[] = [];
  for (const [from, to] of Object.entries(cardMoves)) {
    stmts.push(env.DB.prepare('UPDATE weeks SET updated_at = ? WHERE id IN (SELECT DISTINCT week_id FROM txns WHERE card = ?)').bind(ts, from));
    stmts.push(env.DB.prepare('UPDATE txns SET card = ?, updated_at = ? WHERE card = ?').bind(to, ts, from));
  }
  for (const [from, to] of Object.entries(catMoves)) {
    stmts.push(env.DB.prepare('UPDATE weeks SET updated_at = ? WHERE id IN (SELECT DISTINCT week_id FROM txns WHERE cat = ?)').bind(ts, from));
    stmts.push(env.DB.prepare('UPDATE txns SET cat = ?, updated_at = ? WHERE cat = ?').bind(to, ts, from));
  }
  if (stmts.length) await env.DB.batch(stmts);
  const ops = Object.entries(catMoves).map(([from, to]) => ({ op: 'renameCat', from, to }));
  if (ops.length) {
    for (const doc of await listYears(env)) {
      const before = JSON.stringify(doc);
      applyYearOps(doc, ops);
      if (JSON.stringify(doc) !== before) await putDoc(env, `year:${doc.year}`, doc);
    }
  }
  if (stmts.length || ops.length) await markSheetsDirty(env);
}
/** What changed when: the app polls this instead of reloading everything every 20 seconds. */
export async function versions(env: Env) {
  const [kv, weeks] = await Promise.all([
    env.DB.prepare("SELECT key, updated_at, CASE WHEN key = 'sheets_state' THEN value END AS value FROM kv WHERE key IN ('settings', 'sheets_state') OR key LIKE 'year:%'").all<{ key: string; updated_at: string; value: string | null }>(),
    env.DB.prepare('SELECT id, updated_at FROM weeks').all<{ id: string; updated_at: string }>(),
  ]);
  const out = { settings: '', years: {} as Record<string, string>, weeks: {} as Record<string, string>, sheets: {} as Record<string, unknown> };
  for (const r of kv.results) {
    if (r.key === 'settings') out.settings = r.updated_at;
    else if (r.key === 'sheets_state') { try { out.sheets = JSON.parse(r.value || '{}'); } catch { /* keep empty */ } }
    else out.years[r.key.slice(5)] = r.updated_at;
  }
  for (const w of weeks.results) out.weeks[w.id] = w.updated_at;
  return out;
}
export async function deleteWeek(env: Env, id: string) {
  await env.DB.batch([env.DB.prepare('DELETE FROM txns WHERE week_id = ?').bind(id), env.DB.prepare('DELETE FROM weeks WHERE id = ?').bind(id)]);
  await markSheetsDirty(env);
}
/** Refresh one week's stored totals. updated_at moves too, which tells open apps to reload its rows. */
export async function recomputeWeek(env: Env, id: string) {
  const w = await env.DB.prepare('SELECT ratio_p FROM weeks WHERE id = ?').bind(id).first<{ ratio_p: number }>();
  if (!w) return;
  const settings = await getSettings(env);
  const rows = await getRows(env, id);
  const t = calc(rows, w.ratio_p, settings.cards);
  await env.DB.prepare('UPDATE weeks SET count = ?, total = ?, settle = ?, min_date = ?, max_date = ?, updated_at = ? WHERE id = ?')
    .bind(t.count, t.total, t.settle, t.min, t.max, now(), id).run();
}
/** Refresh every week after a change that can move totals (a card's payer, moved cards).
    Three reads and one batch, whatever the number of weeks: D1 allows 50 queries per request on the free plan. */
export async function recomputeAll(env: Env) {
  const [weeks, settings, rows] = await Promise.all([listWeeks(env), getSettings(env), getAllRows(env)]);
  const byWeek = new Map<string, Row[]>();
  for (const r of rows) { const list = byWeek.get(r.weekId); if (list) list.push(r); else byWeek.set(r.weekId, [r]); }
  const ts = now(), stmts: D1PreparedStatement[] = [];
  for (const w of weeks) {
    const t = calc(byWeek.get(w.id) || [], w.ratioP, settings.cards);
    if (t.count === w.count && t.total === w.total && t.settle === w.settle && t.min === w.minDate && t.max === w.maxDate) continue;
    stmts.push(env.DB.prepare('UPDATE weeks SET count = ?, total = ?, settle = ?, min_date = ?, max_date = ?, updated_at = ? WHERE id = ?')
      .bind(t.count, t.total, t.settle, t.min, t.max, ts, w.id));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}
export function newWeekId(existing: { id: string }[], date = new Date()) {
  const base = 'p' + date.toISOString().slice(0, 10).replace(/-/g, '');
  let id = base, n = 2;
  while (existing.some(w => w.id === id)) id = `${base}-${n++}`;
  return id;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
