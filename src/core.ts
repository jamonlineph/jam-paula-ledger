// Ledger rules shared by the REST API and the MCP tools.
// These mirror the browser app (public/index.html) so a split, a duplicate
// check or a total comes out the same no matter who makes the change.

export type Mode = 'P' | 'J' | 'S' | 'H' | 'C' | 'X' | null;

export interface Row {
  id: string;
  date: string;        // YYYY-MM-DD
  desc: string;
  amt: number;
  card: string;
  mode: Mode;
  p: number;
  j: number;
  s: number;
  note: string;
  src: string;         // 'csv' | 'manual' | 'ai' | 'sheet' (2026 workbook)
  sug: boolean;        // split guessed from history, not yet confirmed
  imp?: string | null; // import batch id
  dupOk?: boolean;
  cat?: string;        // budget category, e.g. "Grocery"
}

export type Group = 'needs' | 'wants' | 'savings' | 'debt';
export interface Category { name: string; group: Group }
export const GROUPS: [Group, string][] = [['needs', 'Needs'], ['wants', 'Wants'], ['savings', 'Savings'], ['debt', 'Debt']];
export const DEFAULT_CATS: Category[] = ([
  ['needs', ['Rent', 'Utilities', 'Grocery', 'Transportation', 'Car Loan', 'Gas', 'Mobile Plan', 'Life Insurance', 'Death Insurance', 'Pet Expense', 'Car Insurance', 'Credit Card Bill']],
  ['wants', ['Eat Out', 'Shopping', 'Miscellaneous', 'Gifts', 'Subscription', 'Miscellaneous - Jerome', 'Miscellaneous - Paula', 'Pickleball']],
  ['savings', ['Savings', 'RRSP', 'TFSA', 'FHSA', 'Pet Savings']],
  ['debt', ['Debt 1', 'Debt 2']],
] as [Group, string[]][]).flatMap(([group, names]) => names.map(name => ({ name, group })));

export interface Card { id: string; name: string; payer: 'p' | 'j' }

export interface Settings {
  names: { p: string; j: string };
  ratioP: number;
  importCard: string;
  hiddenQuick: string[];
  fileCards: Record<string, string>;
  cards: Card[];
  categories: Category[];
  notion: null | { pageUrl?: string; weeksDs: string; ledgerDs: string; weeksUrl?: string; ledgerUrl?: string };
}

export interface WeekMeta {
  id: string;
  name: string;
  created: string;
  ratioP: number;
  paid: string | null;
  count: number;
  total: number;
  settle: number;
  minDate: string | null;
  maxDate: string | null;
  imports?: unknown[];
  notion?: NotionMap | null;
  [k: string]: unknown;
}

export interface NotionMap { week?: string; wsig?: string; at?: string; rows: Record<string, [string, string]> }

export const DEFAULT_SETTINGS: Settings = {
  names: { p: 'Paula', j: 'Jam' },
  ratioP: 56,
  importCard: 'main',
  hiddenQuick: [],
  fileCards: {},
  cards: [
    { id: 'main', name: 'Main credit card', payer: 'j' },
    { id: 'other', name: 'Other card', payer: 'j' },
    { id: 'cash', name: 'Cash / e-transfer', payer: 'j' },
  ],
  categories: DEFAULT_CATS,
  notion: null,
};

export const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const pad = (n: number) => String(n).padStart(2, '0');
export const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dShort = (s: string | null) => { if (!s) return ''; const [, m, d] = s.split('-'); return `${MON[+m - 1]} ${+d}`; };
export const money = (n: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(r2(n));
export const rid = (prefix = 'r') => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
export const todayISO = (tz = 'America/Edmonton') => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
/** This year in the household's time zone (the Worker's clock is UTC). */
export const thisYear = (tz?: string) => +todayISO(tz).slice(0, 4);
export function addDays(s: string, n: number) { const [y, m, d] = s.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }
export function daysApart(a: string, b: string) {
  const [y1, m1, d1] = a.split('-').map(Number), [y2, m2, d2] = b.split('-').map(Number);
  return Math.round(Math.abs(Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 864e5);
}

export function normalizeSettings(s: any): Settings {
  const d: Settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (!s || typeof s !== 'object') return d;
  return {
    names: { p: s.names?.p || d.names.p, j: s.names?.j || d.names.j },
    ratioP: typeof s.ratioP === 'number' ? s.ratioP : d.ratioP,
    importCard: s.importCard || d.importCard,
    hiddenQuick: Array.isArray(s.hiddenQuick) ? s.hiddenQuick.filter((x: unknown) => typeof x === 'string') : [],
    fileCards: s.fileCards && typeof s.fileCards === 'object' ? s.fileCards : {},
    cards: Array.isArray(s.cards) && s.cards.length ? s.cards.map((c: any) => ({ id: String(c.id), name: String(c.name || 'Card'), payer: c.payer === 'p' ? 'p' : 'j' })) : d.cards,
    categories: Array.isArray(s.categories) && s.categories.length
      ? s.categories.filter((c: any) => c && String(c.name || '').trim()).slice(0, 200).map((c: any) => ({ name: String(c.name).trim().slice(0, 60), group: GROUPS.some(g => g[0] === c.group) ? c.group : 'wants' }))
      : d.categories,
    notion: s.notion && typeof s.notion === 'object' ? s.notion : null,
  };
}
export const catGroup = (settings: Settings, name?: string | null) => settings.categories.find(c => c.name === name)?.group || '';
/** Match a category by name, ignoring case; partial names work when they're unambiguous. */
export function catOf(settings: Settings, ref: unknown): string | null {
  const r = String(ref ?? '').trim().toLowerCase(); if (!r) return null;
  const exact = settings.categories.find(c => c.name.toLowerCase() === r); if (exact) return exact.name;
  const part = settings.categories.filter(c => c.name.toLowerCase().includes(r));
  return part.length === 1 ? part[0].name : null;
}

export const MODE_WORDS: Record<string, Exclude<Mode, null>> = {
  p: 'P', paula: 'P', hers: 'P', j: 'J', jam: 'J', his: 'J', s: 'S', shared: 'S', ratio: 'S', household: 'S',
  h: 'H', half: 'H', '50/50': 'H', even: 'H', split: 'H', c: 'C', custom: 'C', x: 'X', skip: 'X', exclude: 'X', none: 'X',
};
export function modeFrom(word: unknown, settings?: Settings): Mode {
  if (word == null || word === '') return null;
  const w = String(word).trim().toLowerCase();
  if (settings) {
    if (w === settings.names.p.toLowerCase()) return 'P';
    if (w === settings.names.j.toLowerCase()) return 'J';
  }
  return MODE_WORDS[w] ?? null;
}
export const modeLabel = (mode: Mode, names: Settings['names']) =>
  mode ? ({ P: names.p, J: names.j, S: 'Shared', H: '50/50', C: 'Custom', X: 'Skip' } as const)[mode] : 'Not split';

export function applyMode(row: Row, mode: Mode, custom?: { p: number; j: number }) {
  const a = r2(row.amt);
  row.mode = mode; row.sug = false;
  if (mode === 'P') { row.p = a; row.j = 0; row.s = 0; }
  else if (mode === 'J') { row.p = 0; row.j = a; row.s = 0; }
  else if (mode === 'S') { row.p = 0; row.j = 0; row.s = a; }
  else if (mode === 'H') { row.p = r2(a / 2); row.j = r2(a - row.p); row.s = 0; }
  else if (mode === 'C') { row.p = r2(custom?.p); row.j = r2(custom?.j); row.s = r2(a - row.p - row.j); }
  else { row.p = 0; row.j = 0; row.s = 0; }
  if (mode === 'C') {
    if (!row.j && !row.s) row.mode = 'P';
    else if (!row.p && !row.s) row.mode = 'J';
    else if (!row.p && !row.j) row.mode = 'S';
    else if (!row.s && Math.abs(row.p - row.j) < 0.011) row.mode = 'H';
  }
  return row;
}

export function calc(rows: Row[], ratioP: number, cards: Card[]) {
  const r = ratioP / 100;
  const payer = (id: string) => cards.find(c => c.id === id)?.payer || 'j';
  const t = { total: 0, p: 0, j: 0, s: 0, n: 0, count: 0, un: 0, unAmt: 0, sug: 0, skip: 0, pShare: 0, jShare: 0, settle: 0, min: null as string | null, max: null as string | null, byCard: {} as Record<string, { amt: number; n: number }>, byCat: {} as Record<string, { amt: number; n: number }> };
  for (const x of rows) {
    if (!t.min || x.date < t.min) t.min = x.date;
    if (!t.max || x.date > t.max) t.max = x.date;
    if (x.mode === 'X') { t.skip++; continue; }
    t.count++;
    if (x.card) { const bc = t.byCard[x.card] || (t.byCard[x.card] = { amt: 0, n: 0 }); bc.amt += x.amt; bc.n++; }
    const bk = t.byCat[x.cat || ''] || (t.byCat[x.cat || ''] = { amt: 0, n: 0 }); bk.amt += x.amt; bk.n++;
    t.total += x.amt;
    if (!x.mode) { t.un++; t.unAmt += x.amt; continue; }
    if (x.sug) t.sug++;
    t.n++; t.p += x.p; t.j += x.j; t.s += x.s;
    if (!x.card) continue; // workbook months have no card, so no transfer
    if (payer(x.card) === 'j') t.settle += x.p + x.s * r;
    else t.settle -= x.j + x.s * (1 - r);
  }
  t.pShare = t.p + t.s * r; t.jShare = t.j + t.s * (1 - r);
  for (const k of ['total', 'p', 'j', 's', 'unAmt', 'pShare', 'jShare', 'settle'] as const) (t as any)[k] = r2((t as any)[k]);
  for (const v of Object.values(t.byCard)) v.amt = r2(v.amt);
  for (const v of Object.values(t.byCat)) v.amt = r2(v.amt);
  return t;
}

/** What each person ends up paying for one row. */
export function parts(r: Row, ratioP: number): [number, number] {
  if (!r.mode || r.mode === 'X') return [0, 0];
  const pp = r2(r.p + r.s * ratioP / 100);
  return [pp, r2(r.p + r.j + r.s - pp)];
}

/* merchant memory: learned from every week's choices */
export function mkey(desc: string) {
  let s = String(desc || '').toUpperCase();
  s = s.replace(/\*(?=[A-Z0-9]*\d)[A-Z0-9]{5,}/g, ' ');
  s = s.replace(/\b(?=[A-Z]*\d)(?=\d*[A-Z])[A-Z0-9]{5,}\b/g, ' ');
  s = s.replace(/#\s*\d+/g, ' ').replace(/\b\d{2,}\b/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}
export function merchantStats(rows: Row[]) {
  const m = new Map<string, Record<string, number>>();
  for (const r of rows) {
    if (!r.mode || r.sug) continue;
    const k = mkey(r.desc); if (!k) continue;
    const o = m.get(k) || {}; o[r.mode] = (o[r.mode] || 0) + 1; m.set(k, o);
  }
  return m;
}
export function suggest(stats: Map<string, Record<string, number>>, desc: string): Mode {
  const o = stats.get(mkey(desc)); if (!o) return null;
  let tot = 0, best: string | null = null, bn = 0;
  for (const [k, v] of Object.entries(o)) { tot += v; if (v > bn) { bn = v; best = k; } }
  if (!best || best === 'C' || bn / tot < 0.6) return null;
  return best as Mode;
}
export function catStats(rows: Row[]) {
  const m = new Map<string, Record<string, number>>();
  for (const r of rows) {
    if (!r.cat) continue;
    const k = mkey(r.desc); if (!k) continue;
    const o = m.get(k) || {}; o[r.cat] = (o[r.cat] || 0) + 1; m.set(k, o);
  }
  return m;
}
export function suggestCat(stats: Map<string, Record<string, number>>, desc: string): string {
  const o = stats.get(mkey(desc)); if (!o) return '';
  let tot = 0, best = '', bn = 0;
  for (const [k, v] of Object.entries(o)) { tot += v; if (v > bn) { bn = v; best = k; } }
  return bn / tot >= 0.6 ? best : '';
}
export const baseKey = (date: string, desc: string, amt: number) => `${date}|${String(desc).toUpperCase().replace(/\s+/g, ' ').trim()}|${r2(amt).toFixed(2)}`;

/* statement parsing (CSV text or a grid from a spreadsheet) */
export function parseCSV(text: string): string[][] {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].map(d => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = []; let row: string[] = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim() !== ''));
}
export type DateOrder = 'mdy' | 'dmy' | null;
/** Day-first or month-first, decided once per file: any 25/10/2026 makes the whole file day-first. */
export function dateOrder(values: unknown[]): DateOrder {
  let mdy = 0, dmy = 0;
  for (const v of values) {
    const m = String(v ?? '').trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/); if (!m) continue;
    if (+m[1] > 12 && +m[2] <= 12) dmy++; else if (+m[2] > 12 && +m[1] <= 12) mdy++;
  }
  return dmy > mdy ? 'dmy' : mdy ? 'mdy' : null;
}
export function parseDate(raw: unknown, order: DateOrder = null): string | null {
  const s = String(raw ?? '').trim(); let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/))) {
    let y = +m[3]; if (y < 100) y += 2000; let a = +m[1], b = +m[2];
    if (order === 'dmy' || (!order && a > 12 && b <= 12)) [a, b] = [b, a];
    if (a < 1 || a > 12 || b < 1 || b > 31) return null;
    return iso(y, a, b);
  }
  if ((m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*\.?[- ,]*(\d{2,4})?$/))) {
    const mi = MON.findIndex(x => x.toLowerCase() === m![2].toLowerCase()); if (mi < 0) return null;
    let y = m[3] ? +m[3] : new Date().getFullYear(); if (y < 100) y += 2000; return iso(y, mi + 1, +m[1]);
  }
  if ((m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/))) {
    const mi = MON.findIndex(x => x.toLowerCase() === m![1].toLowerCase()); if (mi < 0) return null;
    return iso(+m[3], mi + 1, +m[2]);
  }
  return null;
}
export function parseAmount(raw: unknown): number | null {
  let s = String(raw ?? '').trim(); if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s) || /^\$?\s*-/.test(s);
  s = s.replace(/[^0-9.]/g, ''); if (!s || !/\d/.test(s)) return null;
  const n = parseFloat(s); if (isNaN(n)) return null;
  return neg ? -n : n;
}
export const isPayment = (d: string) => /PAYMENT\s*-?\s*THANK\s*YOU|PAYMENT\s+RECEIVED|THANK YOU FOR YOUR PAYMENT|PAIEMENT|AUTOPAY|AUTO PAY|ONLINE PAYMENT|PAYMENT FROM|^PAYMENT$/i.test(d);

function headerMap(h: string[]) {
  const find = (re: RegExp, not?: RegExp) => h.findIndex(x => re.test(x) && !(not && not.test(x)));
  const m = {
    date: find(/date/),
    desc: find(/desc|merchant|payee|name|details|memo|narrative|transaction$/, /date|amount/),
    amt: find(/amount|amt/, /debit|credit/),
    debit: find(/debit|withdraw|charge|purchase|money out|paid out/),
    credit: find(/credit|deposit|refund|money in|paid in/, /card/),
    flip: false,
  };
  if (m.amt >= 0 && m.debit >= 0) m.amt = -1;
  return m;
}
function guessMap(grid: string[][]) {
  const width = Math.max(...grid.map(r => r.length));
  const cols: { c: number; filled: number; dates: number; nums: number; empty: number }[] = [];
  for (let c = 0; c < width; c++) {
    let filled = 0, dates = 0, nums = 0;
    for (const r of grid) {
      const v = String(r[c] ?? '').trim(); if (!v) continue; filled++;
      if (parseDate(v)) dates++; else if (parseAmount(v) !== null && /^[\s$(+-]*[\d,]+(\.\d+)?[\s)$-]*$/.test(v)) nums++;
    }
    cols.push({ c, filled, dates, nums, empty: grid.length - filled });
  }
  const date = cols.find(x => x.filled && x.dates / x.filled > 0.6)?.c ?? -1;
  const desc = cols.find(x => x.c !== date && x.filled && (x.filled - x.nums - x.dates) / x.filled > 0.6)?.c ?? -1;
  const numeric = cols.filter(x => x.c !== date && x.c !== desc && x.filled && x.nums / x.filled > 0.9);
  const m = { date, desc, amt: -1, debit: -1, credit: -1, flip: false };
  if (numeric.length >= 3) { m.debit = numeric[0].c; m.credit = numeric[1].c; }
  else if (numeric.length === 2) {
    if (numeric[0].empty && numeric[1].empty) { m.debit = numeric[0].c; m.credit = numeric[1].c; }
    else m.amt = numeric[0].c;
  } else if (numeric.length === 1) m.amt = numeric[0].c;
  return m;
}
export interface ParsedLine { date: string; desc: string; amt: number; kind: 'charge' | 'refund' | 'payment' }
export function parseGrid(gridIn: unknown[][]): { rows: ParsedLine[]; error?: string } {
  const grid = (gridIn || []).map(r => r.map(c => String(c ?? ''))).filter(r => r.some(x => x.trim() !== ''));
  if (!grid.length) return { rows: [], error: 'The file is empty.' };
  let start = 0, map;
  const head = grid[0].map(x => String(x).trim().toLowerCase());
  if (!grid[0].some(c => parseDate(c)) && head.some(c => /[a-z]/.test(c))) {
    map = headerMap(head); start = 1;
    if (map.date < 0 || map.desc < 0 || (map.amt < 0 && map.debit < 0)) map = guessMap(grid.slice(1));
  } else map = guessMap(grid);
  if (map.date < 0 || map.desc < 0 || (map.amt < 0 && map.debit < 0)) return { rows: [], error: 'Couldn’t find date, description and amount columns.' };
  const order = dateOrder(grid.slice(start).map(r => r[map.date]));
  const out: ParsedLine[] = [];
  for (const line of grid.slice(start)) {
    const date = parseDate(line[map.date], order); if (!date) continue;
    const desc = String(line[map.desc] ?? '').replace(/\s+/g, ' ').trim(); if (!desc) continue;
    let amt: number;
    if (map.amt >= 0) { const a = parseAmount(line[map.amt]); if (a === null) continue; amt = a; }
    else {
      const d = parseAmount(line[map.debit]), c = map.credit >= 0 ? parseAmount(line[map.credit]) : null;
      if (d === null && c === null) continue;
      amt = Math.abs(d || 0) - Math.abs(c || 0);
    }
    out.push({ date, desc, amt: r2(amt), kind: 'charge' });
  }
  if (map.amt >= 0) {
    const negs = out.filter(r => r.amt < 0 && !isPayment(r.desc)).length;
    if (negs > out.length / 2) out.forEach(r => { r.amt = -r.amt; });
  }
  out.forEach(r => { r.kind = isPayment(r.desc) ? 'payment' : r.amt < 0 ? 'refund' : 'charge'; });
  return { rows: out };
}
export const parseStatement = (text: string) => parseGrid(parseCSV(text));

/** Duplicate check used by imports: same rules as the import dialog. */
export function classifyImport(lines: ParsedLine[], card: string, hist: Row[], from?: string | null, until?: string | null) {
  const counts = new Map<string, number>();
  hist.filter(r => r.card === card).forEach(r => { const k = baseKey(r.date, r.desc, r.amt); counts.set(k, (counts.get(k) || 0) + 1); });
  const byAmt = new Map<string, Row[]>();
  hist.forEach(r => { if (r.mode === 'X') return; const k = r2(r.amt).toFixed(2); if (!byAmt.has(k)) byAmt.set(k, []); byAmt.get(k)!.push(r); });
  const seen = new Map<string, number>();
  return lines.map((r, i) => {
    const k = baseKey(r.date, r.desc, r.amt); const n = seen.get(k) || 0; seen.set(k, n + 1);
    const c = counts.get(k) || 0, dup = n < c;
    const status = r.kind === 'payment' ? 'payment' : dup ? 'duplicate' : (from && r.date < from) ? 'before_range' : (until && r.date > until) ? 'after_range' : 'new';
    let near: Row | null = null;
    if (status === 'new') {
      near = (byAmt.get(r2(r.amt).toFixed(2)) || [])
        .filter(h => !(h.card === card && baseKey(h.date, h.desc, h.amt) === k) && daysApart(h.date, r.date) <= 3)
        .sort((a, b) => daysApart(a.date, r.date) - daysApart(b.date, r.date))[0] || null;
    }
    return { ...r, i, key: k, status, near, repeated: status === 'new' && n > c };
  });
}

/* Notion record: property builders (same as the browser's) */
export const NotionRec = (() => {
  const f2 = (n: number) => { const v = r2(n); return (v === 0 ? 0 : v).toFixed(2); };
  const split = (mode: Mode, names: Settings['names']) => modeLabel(mode, names);
  const SOURCES: Record<string, string> = { manual: 'Added by hand', ai: 'Added by AI', sheet: '2026 workbook', csv: 'Bank file' };
  interface Ctx { rp: number; names: Settings['names']; cardName: (id: string) => string; now: string; weekId?: string }
  function rowProps(r: Row, ctx: Ctx) {
    const [pp, jp] = parts(r, ctx.rp);
    const props: Record<string, unknown> = {
      'Description': r.desc, 'date:Date:start': r.date, 'date:Date:is_datetime': 0,
      'Amount': r2(r.amt), 'Split': split(r.mode, ctx.names),
      'Paula': r2(r.p), 'Jam': r2(r.j), 'Shared': r2(r.s), "Paula's part": pp, "Jam's part": jp,
      'Note': r.note || '', 'Source': SOURCES[r.src] || 'Bank file',
      'Removed from app': '__NO__', 'Ledger ID': r.id,
    };
    if (r.card) props['Card'] = ctx.cardName(r.card);
    if (r.cat) props['Category'] = r.cat;
    if (ctx.weekId) props['Week'] = [ctx.weekId];
    return props;
  }
  function rowSig(r: Row, ctx: Ctx) {
    const [pp, jp] = parts(r, ctx.rp);
    return [r.desc, r.date, f2(r.amt), r.card ? ctx.cardName(r.card) : '', split(r.mode, ctx.names), f2(r.p), f2(r.j), f2(r.s), f2(pp), f2(jp), r.note || '', r.src === 'manual' ? 'm' : r.src === 'ai' ? 'a' : r.src === 'sheet' ? 'w' : 'b', r.cat || ''].join('|');
  }
  function weekProps(p: WeekMeta, t: ReturnType<typeof calc>, ctx: Ctx, forCreate: boolean) {
    const props: Record<string, unknown> = {
      'Week': p.name,
      'date:Dates:start': t.min || null, 'date:Dates:end': t.max && t.max !== t.min ? t.max : null, 'date:Dates:is_datetime': 0,
      'Total spent': t.total, 'Paula only': t.p, 'Jam only': t.j, 'Shared': t.s,
      'Salary ratio': `${ctx.rp}/${100 - ctx.rp}`, "Paula's share": t.pShare, "Jam's share": t.jShare,
      'Transfer': p.kind === 'month' ? 'No transfer (month record)' : t.settle >= 0 ? `${ctx.names.p} pays ${ctx.names.j}` : `${ctx.names.j} pays ${ctx.names.p}`,
      'Transfer amount': r2(Math.abs(t.settle)),
      'Paid': p.paid ? '__YES__' : '__NO__', 'date:Paid on:start': p.paid || null,
      'Items': t.count, 'Not split yet': t.un, 'Ledger ID': p.id,
      'date:Last synced:start': ctx.now, 'date:Last synced:is_datetime': 1,
    };
    if (forCreate) Object.keys(props).forEach(k => { if (props[k] === null) delete props[k]; });
    return props;
  }
  function weekSig(p: WeekMeta, t: ReturnType<typeof calc>, ctx: Ctx) {
    const o = weekProps(p, t, { ...ctx, now: '' }, false);
    delete o['date:Last synced:start'];
    return JSON.stringify(o);
  }
  return { rowProps, rowSig, weekProps, weekSig };
})();


/* ===================== the year: income, budgets, savings =====================
   One JSON document per year ('year:2026'), same shape as the browser app keeps. */
export interface IncomeEntry { id: string; date: string; source: string; who: 'p' | 'j' | ''; amt: number; note?: string }
export interface MonthData { budget: Record<string, number>; income: IncomeEntry[]; pct: Partial<Record<Group, number>>; saved: Record<string, number>; budgetFrom?: string }
export interface Snapshot { id: string; date: string; note?: string; accounts: { name: string; amt: number }[] }
export interface YearDoc { year: number; months: Record<string, MonthData>; snapshots: Snapshot[]; plan?: unknown; source?: unknown }
export const MONTH_KEYS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
export const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function normalizeYear(raw: any, year: number): YearDoc {
  const doc: YearDoc = { year, months: {}, snapshots: [] };
  if (!raw || typeof raw !== 'object') return doc;
  const num = (v: unknown) => { const n = Number(v); return isFinite(n) ? r2(n) : null; };
  for (const mm of MONTH_KEYS) {
    const m = raw.months?.[mm]; if (!m || typeof m !== 'object') continue;
    const out: MonthData = { budget: {}, income: [], pct: {}, saved: {} };
    for (const [k, v] of Object.entries(m.budget || {})) { const n = num(v); if (n !== null && k.trim()) out.budget[k.trim().slice(0, 60)] = n; }
    for (const [k, v] of Object.entries(m.saved || {})) { const n = num(v); if (n !== null && k.trim()) out.saved[k.trim().slice(0, 60)] = n; }
    for (const g of GROUPS.map(x => x[0])) { const n = num(m.pct?.[g]); if (n !== null) out.pct[g] = Math.max(0, Math.min(100, n)); }
    for (const i of Array.isArray(m.income) ? m.income.slice(0, 200) : []) {
      const amt = num(i?.amt); if (amt === null || !/^\d{4}-\d{2}-\d{2}$/.test(String(i?.date))) continue;
      out.income.push({ id: String(i.id || rid('i')).slice(0, 40), date: i.date, source: String(i.source || 'Income').slice(0, 80), who: i.who === 'p' || i.who === 'j' ? i.who : '', amt, note: String(i.note || '').slice(0, 300) });
    }
    if (typeof m.budgetFrom === 'string') out.budgetFrom = m.budgetFrom.slice(0, 80);
    doc.months[mm] = out;
  }
  for (const sn of Array.isArray(raw.snapshots) ? raw.snapshots.slice(0, 100) : []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sn?.date))) continue;
    doc.snapshots.push({ id: String(sn.id || 's' + sn.date.replace(/-/g, '')).slice(0, 40), date: sn.date, note: String(sn.note || '').slice(0, 200),
      accounts: (Array.isArray(sn.accounts) ? sn.accounts : []).slice(0, 30).filter((a: any) => a && String(a.name || '').trim()).map((a: any) => ({ name: String(a.name).trim().slice(0, 60), amt: num(a.amt) ?? 0 })) });
  }
  if (raw.plan && typeof raw.plan === 'object') doc.plan = raw.plan;
  if (raw.source && typeof raw.source === 'object') doc.source = raw.source;
  return doc;
}

/* Changes to a year are sent as small operations and applied to the latest saved
   copy, so two people (or an AI) changing different things never undo each other.
   Same function in the browser (applyYearOps in public/index.html). */
export type YearOp =
  | { op: 'budget'; mm: string; cat: string; v: number | null }
  | { op: 'pct'; mm: string; g: Group; v: number | null }
  | { op: 'budgetFrom'; mm: string; v: string | null }
  | { op: 'month'; mm: string; budget: Record<string, number>; pct: Partial<Record<Group, number>>; budgetFrom?: string | null }
  | { op: 'incomeAdd'; entry: IncomeEntry }
  | { op: 'incomeDel'; id: string }
  | { op: 'snap'; snap: Snapshot }
  | { op: 'renameCat'; from: string; to: string };
export function applyYearOps(doc: YearDoc, ops: unknown): YearDoc {
  doc.months = doc.months || {}; doc.snapshots = doc.snapshots || [];
  const month = (mm: string) => {
    const m = doc.months[mm] || (doc.months[mm] = { budget: {}, income: [], pct: {}, saved: {} });
    m.budget = m.budget || {}; m.income = m.income || []; m.pct = m.pct || {}; m.saved = m.saved || {};
    return m;
  };
  const num = (v: unknown) => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : r2(v));
  for (const o of (Array.isArray(ops) ? ops : []) as any[]) {
    if (!o || typeof o !== 'object') continue;
    const mmOk = MONTH_KEYS.includes(o.mm);
    if (o.op === 'budget' && mmOk && typeof o.cat === 'string' && o.cat) {
      const m = month(o.mm), v = num(o.v);
      if (v === null) delete m.budget[o.cat]; else m.budget[o.cat] = v;
      delete m.budgetFrom;
    } else if (o.op === 'pct' && mmOk && GROUPS.some(g => g[0] === o.g)) {
      const m = month(o.mm), v = num(o.v);
      if (v === null) delete m.pct[o.g as Group]; else m.pct[o.g as Group] = Math.max(0, Math.min(100, Math.round(v * 10) / 10));
    } else if (o.op === 'budgetFrom' && mmOk) {
      const m = month(o.mm);
      if (o.v) m.budgetFrom = String(o.v).slice(0, 80); else delete m.budgetFrom;
    } else if (o.op === 'month' && mmOk) {
      const m = month(o.mm);
      m.budget = {}; m.pct = {};
      for (const [k, v] of Object.entries(o.budget || {})) { const n = num(v); if (n !== null && k) m.budget[k] = n; }
      for (const [g, v] of Object.entries(o.pct || {})) { const n = num(v); if (n !== null && GROUPS.some(x => x[0] === g)) m.pct[g as Group] = n; }
      if (o.budgetFrom) m.budgetFrom = String(o.budgetFrom).slice(0, 80); else delete m.budgetFrom;
    } else if (o.op === 'incomeAdd' && o.entry && typeof o.entry === 'object') {
      const e = o.entry, mm = String(e.date || '').slice(5, 7), amt = num(e.amt);
      if (!String(e.date || '').startsWith(doc.year + '-') || !MONTH_KEYS.includes(mm) || amt === null || !e.id) continue;
      if (Object.values(doc.months).some(m => (m.income || []).some(i => i.id === e.id))) continue; // already there (a retried save)
      month(mm).income.push({ id: String(e.id), date: e.date, source: String(e.source || 'Income'), who: e.who === 'p' || e.who === 'j' ? e.who : '', amt, note: String(e.note || '') });
    } else if (o.op === 'incomeDel' && o.id) {
      for (const m of Object.values(doc.months)) m.income = (m.income || []).filter(i => i.id !== o.id);
    } else if (o.op === 'snap' && o.snap && /^\d{4}-\d{2}-\d{2}$/.test(String(o.snap.date))) {
      doc.snapshots = doc.snapshots.filter(s => s.date !== o.snap.date).concat([o.snap]);
    } else if (o.op === 'renameCat' && typeof o.from === 'string' && o.from && o.from !== o.to) {
      for (const m of Object.values(doc.months)) {
        for (const key of ['budget', 'saved'] as const) {
          const map = m[key]; if (!map || !(o.from in map)) continue;
          const v = map[o.from]; delete map[o.from];
          if (o.to) map[o.to] = r2((map[o.to] || 0) + v); // merging into an existing category adds the amounts
        }
      }
    }
  }
  return doc;
}

export interface MonthAgg { spent: number; n: number; cats: Record<string, number>; savedCats: Record<string, number>; p: number; j: number; un: number; unAmt: number; income: number; incP: number; incJ: number; incO: number; saved: number; budget: number }
const blankAgg = (): MonthAgg => ({ spent: 0, n: 0, cats: {}, savedCats: {}, p: 0, j: 0, un: 0, unAmt: 0, income: 0, incP: 0, incJ: 0, incO: 0, saved: 0, budget: 0 });
/** Same numbers as the app's year overview. Rows come with their week's salary ratio. */
export function yearAgg(rows: { row: Row; ratioP: number }[], doc: YearDoc, settings: Settings) {
  const months: Record<string, MonthAgg> = {};
  const M = (mm: string) => months[mm] || (months[mm] = blankAgg());
  const y = String(doc.year);
  for (const { row: r, ratioP } of rows) {
    if (!r.date.startsWith(y + '-') || r.mode === 'X') continue;
    const m = M(r.date.slice(5, 7)), c = r.cat || '';
    m.spent += r.amt; m.n++; m.cats[c] = (m.cats[c] || 0) + r.amt;
    if (!r.mode) { m.un++; m.unAmt += r.amt; continue; }
    m.p += r.p + r.s * ratioP / 100; m.j += r.j + r.s * (100 - ratioP) / 100;
  }
  for (const mm of MONTH_KEYS) {
    const md = doc.months[mm];
    const has = md && (md.income.length || Object.keys(md.budget).length || Object.keys(md.saved).length);
    if (!has && !months[mm]) continue;
    const m = M(mm);
    for (const i of md?.income || []) { m.income += i.amt; if (i.who === 'p') m.incP += i.amt; else if (i.who === 'j') m.incJ += i.amt; else m.incO += i.amt; }
    for (const [c, v] of Object.entries(m.cats)) if (catGroup(settings, c) === 'savings') m.saved += v;
    for (const [c, v] of Object.entries(md?.saved || {})) { m.saved += v; m.savedCats[c] = (m.savedCats[c] || 0) + v; }
    for (const v of Object.values(md?.budget || {})) m.budget += v;
  }
  for (const m of Object.values(months)) for (const k of ['spent', 'p', 'j', 'unAmt', 'income', 'incP', 'incJ', 'incO', 'saved', 'budget'] as const) m[k] = r2(m[k]);
  return months;
}
/** Budget against spending for one month, category by category. */
export function monthBudgetLines(mm: string, agg: MonthAgg | undefined, doc: YearDoc, settings: Settings) {
  const md = doc.months[mm] || { budget: {}, saved: {}, pct: {}, income: [] };
  const a = agg || blankAgg();
  interface Line { category: string; group: Group | ''; budget: number | null; spent: number; left: number | null }
  const lines: Line[] = settings.categories.map((c): Line => {
    const spent = r2((a.cats[c.name] || 0) + (c.group === 'savings' ? md.saved[c.name] || 0 : 0));
    const budget = md.budget[c.name];
    return { category: c.name, group: c.group, budget: budget ?? null, spent, left: budget == null ? null : r2(budget - spent) };
  }).filter(l => l.budget !== null || l.spent);
  for (const [c, v] of Object.entries(a.cats)) if (!settings.categories.some(x => x.name === c)) lines.push({ category: c || 'No category', group: '', budget: null, spent: r2(v), left: null });
  return lines;
}
