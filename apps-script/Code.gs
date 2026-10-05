/**
 * Jam & Paula Ledger → Google Sheet receiver.
 *
 * Paste this into the sheet: Extensions → Apps Script, replace everything, Save.
 * 1. Change LEDGER_TOKEN below to a long random string (the same value goes into
 *    the app as the SHEETS_TOKEN secret).
 * 2. Deploy → New deployment → type "Web app" → Execute as: Me →
 *    Who has access: Anyone → Deploy → copy the Web app URL (ends in /exec).
 *    That URL goes into the app as the SHEETS_WEBHOOK_URL secret.
 * The app then posts the full ledger here and this script rewrites the
 * Transactions, Weeks, Months, Budget and Income tabs. Your own tabs are never touched.
 */
const LEDGER_TOKEN = 'CHANGE-ME-to-a-long-random-string';

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'Body was not JSON.' }); }
  if (!LEDGER_TOKEN || LEDGER_TOKEN.indexOf('CHANGE-ME') === 0) return out_({ ok: false, error: 'Set LEDGER_TOKEN in the Apps Script first.' });
  if (body.token !== LEDGER_TOKEN) return out_({ ok: false, error: 'The token doesn’t match LEDGER_TOKEN in the Apps Script.' });
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    writeTab_(ss, 'Transactions', body.transactions, { money: [6, 12, 13, 14, 15, 16], date: [4] });
    writeTab_(ss, 'Weeks', body.weeks, { money: [7, 8, 9, 10, 12, 13, 15], date: [4, 5, 16] });
    if (body.months) writeTab_(ss, 'Months', body.months, { money: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] });
    if (body.budget) writeTab_(ss, 'Budget', body.budget, { money: [4, 5, 6] });
    if (body.income) writeTab_(ss, 'Income', body.income, { money: [5], date: [1] });
    return out_({ ok: true, transactions: body.transactions.rows.length, weeks: body.weeks.rows.length, at: new Date().toISOString() });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return out_({ ok: true, message: 'Jam & Paula Ledger receiver is running. The app sends data with POST.' });
}

function writeTab_(ss, name, table, fmt) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  const width = table.header.length;
  sh.getRange(1, 1, 1, width).setValues([table.header]).setFontWeight('bold').setBackground('#10130e').setFontColor('#f1f4ec');
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, width).clearContent();
  if (table.rows.length) {
    sh.getRange(2, 1, table.rows.length, width).setValues(table.rows);
    (fmt.money || []).forEach(c => sh.getRange(2, c, table.rows.length, 1).setNumberFormat('$#,##0.00'));
    (fmt.date || []).forEach(c => sh.getRange(2, c, table.rows.length, 1).setNumberFormat('yyyy-mm-dd'));
  }
  sh.setFrozenRows(1);
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
