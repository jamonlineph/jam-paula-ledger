#!/usr/bin/env node
// npm test: the money rules live twice, in src/core.ts (server, MCP, Ask AI) and in the
// <script> of public/index.html (the page also runs on its own inside Claude). This runs both
// copies on the same inputs and fails when they disagree: statement parsing, splits, totals,
// merchant memory, duplicate checks, Notion records, year changes and the year's numbers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const root = new URL('..', import.meta.url);

// src/core.ts as JavaScript
const src = fs.readFileSync(new URL('src/core.ts', root), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-parity-')), 'core.mjs');
fs.writeFileSync(tmp, js);
const core = await import(tmp);

// the page's helpers and money rules (the blocks between the ===== markers)
const html = fs.readFileSync(new URL('public/index.html', root), 'utf8');
const block = (start, end) => {
  const a = html.indexOf(start), b = html.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`public/index.html is missing the "${start}" … "${end}" markers.`);
  return html.slice(a, b);
};
const names = ['applyMode', 'calc', 'mkey', 'merchantStats', 'suggest', 'catStats', 'suggestCat', 'baseKey', 'daysApart', 'parseCSV', 'dateOrder', 'parseDate', 'parseAmount', 'isPayment', 'parseGrid', 'parseStatement', 'classifyImport', 'NotionRec', 'applyYearOps', 'blankYear', 'aggYear'];
const page = new Function(`'use strict';\n${block('/* ===== helpers', '/* ===== end helpers')}\n${block('/* ===== money rules', '/* ===== end money rules')}\nreturn {${names.join(', ')}};`)();

let passed = 0, failed = 0;
const plain = v => JSON.parse(JSON.stringify(v, (k, x) => (x instanceof Map ? Object.fromEntries(x) : x instanceof Set ? [...x] : x)));
function same(name, a, b) {
  try { assert.deepStrictEqual(plain(a), plain(b)); passed++; }
  catch (e) { failed++; console.log(`✗ ${name}\n  page: ${JSON.stringify(plain(a)).slice(0, 400)}\n  core: ${JSON.stringify(plain(b)).slice(0, 400)}`); }
}
const clone = v => JSON.parse(JSON.stringify(v));

/* ---------- statements ---------- */
const statements = {
  'header, month first': 'Date,Description,Amount\n10/01/2026,COSTCO WHOLESALE #123,184.22\n10/02/2026,"SHELL, C12345",72.10\n10/03/2026,PAYMENT - THANK YOU,-500.00\n10/04/2026,AMAZON.CA REFUND,-12.99',
  'header, day first': 'Date,Description,Amount\n03/10/2026,LONDON DRUGS #12,24.15\n13/10/2026,PETSMART #331,41.99\n05/10/2026,SAFEWAY #8842,63.70',
  'no header, debit and credit': '10/01/2026,COSTCO WHOLESALE,184.22,,1234.56\n10/02/2026,PAYROLL DEPOSIT,,3200.00,4434.56\n10/03/2026,TIM HORTONS,8.45,,4426.11',
  'semicolons and quotes': 'Datum;Beschreibung;Betrag\n2026-10-01;"SUPERSTORE ""1520""";96.31\n2026-10-02;NETFLIX.COM;20.99',
  'month names': 'Date,Description,Amount\n"Oct 3, 2026",WINNERS #221,48.00\n03-Oct-2026,PIZZA 73,38.40\n4 Oct 2026,ESSO,61.00',
  'charges as negatives': 'Transaction Date,Description,Amount\n2026-10-01,COSTCO,-184.22\n2026-10-02,SHELL,-72.10\n2026-10-03,PAYMENT RECEIVED,500.00\n2026-10-04,REFUND STORE,5.00',
  'dates with dashes and dots': 'date,payee,amount\n13-10-2026,A,1\n01.10.2026,B,2\n2026/10/05,C,3',
  'empty': '',
  'no amount column': 'Date,Description\n2026-10-01,COSTCO',
};
for (const [name, text] of Object.entries(statements)) same(`parseStatement: ${name}`, page.parseStatement(text), core.parseStatement(text));
same('parseGrid: spreadsheet grid', page.parseGrid([['Posted', 'Merchant', 'Debit', 'Credit'], ['2026-10-01', 'COSTCO', '184.22', ''], ['2026-10-02', 'REFUND', '', '9.99']]), core.parseGrid([['Posted', 'Merchant', 'Debit', 'Credit'], ['2026-10-01', 'COSTCO', '184.22', ''], ['2026-10-02', 'REFUND', '', '9.99']]));
const dates = ['10/03/2026', '03/10/2026', '13/10/2026', '10/13/2026', '3/4/26', '2026-10-03', '2026/10/3', '03-Oct-2026', 'Oct 3, 2026', '3 Oct', '31/02/2026', 'garbage', '', null];
for (const order of [null, 'mdy', 'dmy']) same(`parseDate (${order})`, dates.map(d => page.parseDate(d, order)), dates.map(d => core.parseDate(d, order)));
same('dateOrder', [['13/10/2026'], ['10/13/2026'], ['01/02/2026'], ['13/10/2026', '10/14/2026', '14/10/2026']].map(page.dateOrder), [['13/10/2026'], ['10/13/2026'], ['01/02/2026'], ['13/10/2026', '10/14/2026', '14/10/2026']].map(core.dateOrder));
const amounts = ['184.22', '$1,234.56', '(45.00)', '-12.5', '12.50-', '$ -3.00', 'CAD 7', '', 'abc', 0];
same('parseAmount', amounts.map(page.parseAmount), amounts.map(core.parseAmount));
const descs = ['PAYMENT - THANK YOU', 'PAIEMENT MERCI', 'AUTOPAY', 'COSTCO', 'PAYMENT', 'ONLINE PAYMENT FROM CHQ'];
same('isPayment', descs.map(page.isPayment), descs.map(core.isPayment));

/* ---------- splits and totals ---------- */
const base = { id: 'r1', date: '2026-10-01', desc: 'X', card: 'main', note: '', src: 'csv', sug: true, cat: '' };
for (const amt of [100, 33.33, -45.5, 0.01, 1234.567]) {
  for (const mode of ['P', 'J', 'S', 'H', 'X', null]) same(`applyMode ${mode} ${amt}`, page.applyMode({ ...base, amt }, mode), core.applyMode({ ...base, amt }, mode));
  for (const custom of [{ p: 10, j: 5 }, { p: amt, j: 0 }, { p: 0, j: amt }, { p: 0, j: 0 }, { p: amt / 2, j: amt / 2 }]) same(`applyMode C ${amt} ${JSON.stringify(custom)}`, page.applyMode({ ...base, amt }, 'C', custom), core.applyMode({ ...base, amt }, 'C', custom));
}
const cards = [{ id: 'main', name: 'Main', payer: 'j' }, { id: 'pc', name: 'Paula card', payer: 'p' }, { id: 'cash', name: 'Cash', payer: 'j' }];
let n = 0;
const R = (date, desc, amt, mode, card = 'main', cat = '', extra = {}) => core.applyMode({ id: 'r' + (++n), date, desc, amt, card, mode: null, p: 0, j: 0, s: 0, note: '', src: 'csv', sug: false, cat, ...extra }, mode, extra.custom);
const rows = [
  R('2026-10-01', 'COSTCO WHOLESALE #123', 184.22, 'S', 'main', 'Grocery'), R('2026-10-01', 'TIM HORTONS #4411', 8.45, null, 'main'),
  R('2026-10-02', 'SHELL C12345', 72.10, 'J', 'main', 'Gas'), R('2026-10-03', 'NETFLIX.COM', 20.99, 'H', 'pc', 'Subscription'),
  R('2026-10-03', 'SEPHORA', 64.20, 'P', 'pc', 'Shopping'), R('2026-10-04', 'DINNER OUT', 100, 'C', 'cash', 'Eat Out', { custom: { p: 30, j: 30 } }),
  R('2026-10-04', 'TRANSFER', 500, 'X', 'main'), R('2026-10-05', 'COSTCO WHOLESALE #998', -12.99, 'S', 'main', 'Grocery'),
  R('2026-09-02', 'RENT', 1850, 'S', '', 'Rent'), R('2026-10-05', 'COSTCO WHOLESALE #77', 99.5, 'S', 'main', 'Grocery', { sug: true }),
];
rows[rows.length - 1].sug = true;
for (const ratio of [56, 60, 0, 100]) same(`calc ratio ${ratio}`, page.calc(rows, ratio, cards), core.calc(rows, ratio, cards));
same('calc with an unknown card', page.calc([R('2026-10-01', 'A', 10, 'S', 'gone')], 56, cards), core.calc([R('2026-10-01', 'A', 10, 'S', 'gone')], 56, cards));

/* ---------- merchant memory ---------- */
const keys = ['AMAZON.CA*AB12CD34E', 'COSTCO WHOLESALE #123', 'SQ *CAFE 12345', 'UBER* TRIP 4F3D2', 'PAYPAL *SPOTIFY 4029357733', 'STORE 0042 EDMONTON AB'];
same('mkey', keys.map(page.mkey), keys.map(core.mkey));
same('merchantStats', page.merchantStats(rows), core.merchantStats(rows));
same('catStats', page.catStats(rows), core.catStats(rows));
const ms = core.merchantStats(rows), cs = core.catStats(rows);
same('suggest', keys.concat(['COSTCO WHOLESALE #5', 'SHELL C99999']).map(d => page.suggest(page.merchantStats(rows), d)), keys.concat(['COSTCO WHOLESALE #5', 'SHELL C99999']).map(d => core.suggest(ms, d)));
same('suggestCat', ['COSTCO WHOLESALE #5', 'NETFLIX.COM', 'NOPE'].map(d => page.suggestCat(page.catStats(rows), d)), ['COSTCO WHOLESALE #5', 'NETFLIX.COM', 'NOPE'].map(d => core.suggestCat(cs, d)));
same('baseKey', page.baseKey('2026-10-01', ' costco  wholesale ', 184.2), core.baseKey('2026-10-01', ' costco  wholesale ', 184.2));

/* ---------- import duplicate checks ---------- */
const lines = core.parseStatement('Date,Description,Amount\n10/01/2026,COSTCO WHOLESALE #123,184.22\n10/01/2026,COSTCO WHOLESALE #123,184.22\n10/02/2026,SHELL C12345,72.10\n09/20/2026,OLD THING,5\n10/09/2026,LATE THING,6\n10/03/2026,PAYMENT - THANK YOU,-500\n10/04/2026,OTHER SHOP,20.99').rows;
for (const [from, until] of [[null, null], ['2026-09-25', '2026-10-05']]) {
  same(`classifyImport ${from || 'any'}–${until || 'any'}`, page.classifyImport(lines, 'main', rows, from, until), core.classifyImport(lines, 'main', rows, from, until));
}

/* ---------- Notion records ---------- */
const ctx = { rp: 56, names: { p: 'Paula', j: 'Jam' }, cardName: id => cards.find(c => c.id === id)?.name || 'Unknown card', now: '2026-10-05T12:00:00.000Z', weekId: 'notion-week-1' };
for (const r of rows) {
  same(`NotionRec.rowProps ${r.desc}`, page.NotionRec.rowProps(r, ctx), core.NotionRec.rowProps(r, ctx));
  same(`NotionRec.rowSig ${r.desc}`, page.NotionRec.rowSig(r, ctx), core.NotionRec.rowSig(r, ctx));
}
for (const meta of [{ id: 'p1', name: 'Oct 5', paid: null }, { id: 'p2', name: 'Sep 28', paid: '2026-10-01' }, { id: 'm1', name: 'September 2026', kind: 'month', paid: null }]) {
  const t = core.calc(rows, 56, cards);
  same(`NotionRec.weekProps ${meta.name}`, page.NotionRec.weekProps(meta, page.calc(rows, 56, cards), ctx, true), core.NotionRec.weekProps(meta, t, ctx, true));
  same(`NotionRec.weekSig ${meta.name}`, page.NotionRec.weekSig(meta, page.calc(rows, 56, cards), ctx), core.NotionRec.weekSig(meta, t, ctx));
}

/* ---------- year changes ---------- */
const doc = core.normalizeYear({
  months: {
    '09': { budget: { Grocery: 800, 'Eat Out': 300 }, income: [{ id: 'i1', date: '2026-09-15', source: 'Valard', who: 'j', amt: 3200 }], pct: { needs: 50 }, saved: { TFSA: 200 } },
    '10': { budget: { Grocery: 800 }, income: [], pct: {}, saved: {}, budgetFrom: 'Copied from September' },
  },
  snapshots: [{ id: 's1', date: '2026-05-29', accounts: [{ name: 'Savings', amt: 8200 }] }],
}, 2026);
const opLists = {
  budgets: [{ op: 'budget', mm: '10', cat: 'Eat Out', v: 350.456 }, { op: 'budget', mm: '09', cat: 'Grocery', v: null }, { op: 'budget', mm: '13', cat: 'X', v: 1 }, { op: 'budget', mm: '11', cat: '', v: 1 }],
  shares: [{ op: 'pct', mm: '10', g: 'needs', v: 55.55 }, { op: 'pct', mm: '10', g: 'wants', v: 150 }, { op: 'pct', mm: '10', g: 'nope', v: 10 }, { op: 'pct', mm: '09', g: 'needs', v: null }],
  copy: ['10', '11', '12'].map(mm => ({ op: 'month', mm, budget: { Grocery: 800, Gas: '250' }, pct: { needs: 50, bad: 3 }, budgetFrom: 'Copied from September' })),
  income: [{ op: 'incomeAdd', entry: { id: 'i2', date: '2026-10-01', source: 'Suncoast', who: 'p', amt: 2600 } }, { op: 'incomeAdd', entry: { id: 'i2', date: '2026-10-01', source: 'dup', who: 'p', amt: 1 } }, { op: 'incomeAdd', entry: { id: 'i3', date: '2027-01-01', source: 'wrong year', amt: 1 } }, { op: 'incomeDel', id: 'i1' }],
  snapshots: [{ op: 'snap', snap: { id: 's2', date: '2026-09-30', accounts: [{ name: 'Savings', amt: 9050 }] } }, { op: 'snap', snap: { id: 's1b', date: '2026-05-29', accounts: [] } }],
  renames: [{ op: 'renameCat', from: 'Eat Out', to: 'Restaurants' }, { op: 'renameCat', from: 'TFSA', to: '' }, { op: 'renameCat', from: 'Grocery', to: 'Restaurants' }],
  junk: [null, 5, { op: 'nope' }, { op: 'budgetFrom', mm: '10', v: '' }],
};
for (const [name, ops] of Object.entries(opLists)) same(`applyYearOps: ${name}`, page.applyYearOps(clone(doc), clone(ops)), core.applyYearOps(clone(doc), clone(ops)));
same('applyYearOps on a blank year', page.applyYearOps(page.blankYear('2027'), clone(opLists.copy)), core.applyYearOps(core.normalizeYear(null, 2027), clone(opLists.copy)));

/* ---------- the year's numbers ---------- */
const settings = core.normalizeSettings({ categories: [...core.DEFAULT_CATS, { name: 'Restaurants', group: 'wants' }] });
const period = { id: 'p1', ratioP: 60 };
const pageYear = page.aggYear(rows.map(r => [r, period]), clone(doc), settings.categories, 56);
const coreYear = core.yearAgg(rows.map(r => ({ row: r, ratioP: 60 })), clone(doc), settings);
for (const m of Object.values(pageYear)) delete m.periods; // the page also keeps which weeks fed each month
same('yearAgg', pageYear, coreYear);

console.log(failed ? `\n${failed} of ${passed + failed} checks failed: public/index.html and src/core.ts disagree.` : `✓ ${passed} checks: public/index.html and src/core.ts agree.`);
process.exit(failed ? 1 : 0);
