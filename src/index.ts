import { Hono } from 'hono';
import { currentUser, endOtherSessions, endSession, hashPassword, noteFailedAttempt, randomToken, requireUser, sha256, startSession, tooManyAttempts, verifyPassword, type AppEnv } from './auth';
import { deleteWeek, getAllRows, getRows, getRowsOf, getSettings, getWeek, getYear, HttpError, listWeeks, listYears, moveRefs, patchRows, patchYear, putWeek, recomputeAll, saveSettings, saveYear, versions, type Env } from './db';
import { normalizeSettings, todayISO } from './core';
import { handleMcp } from './mcp';
import { askAI } from './ai';
import { cronSheets, notionSyncWeek, pushSheets, sheetsState } from './sync';

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: 'Something went wrong on the server. Try again in a moment.' }, 500);
});

app.get('/healthz', c => c.text('ok'));

/* ---------- MCP (token auth, not cookies) ---------- */
app.all('/mcp', c => handleMcp(c.req.raw, c.env));
app.all('/mcp/:key', c => handleMcp(c.req.raw, c.env));

/* ---------- sign in ---------- */
app.post('/api/login', async c => {
  const { username, password } = await c.req.json<{ username?: string; password?: string }>().catch(() => ({} as any));
  if (!username || !password) return c.json({ error: 'Enter your username and password.' }, 400);
  const ip = c.req.header('cf-connecting-ip') || 'local';
  const rlKey = `${String(username).toLowerCase()}|${ip}`;
  if (await tooManyAttempts(c.env, rlKey)) return c.json({ error: 'Too many tries. Wait 15 minutes and try again.' }, 429);
  const u = await c.env.DB.prepare('SELECT id, username, display_name, pw_hash FROM users WHERE username = ?').bind(String(username).trim()).first<{ id: string; username: string; display_name: string; pw_hash: string }>();
  if (!u || !(await verifyPassword(password, u.pw_hash))) {
    await noteFailedAttempt(c.env, rlKey);
    return c.json({ error: 'That username and password don’t match.' }, 401);
  }
  await startSession(c, { id: u.id, username: u.username, name: u.display_name });
  return c.json({ ok: true });
});
app.post('/api/logout', async c => { await endSession(c); return c.json({ ok: true }); });
app.get('/api/me', async c => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'Sign in to continue.' }, 401);
  const origin = new URL(c.req.url).origin;
  return c.json({
    user, mcpEndpoint: `${origin}/mcp`,
    sheets: await sheetsState(c.env),
    notion: { configured: !!c.env.NOTION_TOKEN },
    ai: { configured: !!c.env.ANTHROPIC_API_KEY },
  });
});

/* everything below needs a signed-in person */
app.use('/api/*', requireUser);

app.post('/api/password', async c => {
  const { current, next } = await c.req.json<{ current?: string; next?: string }>();
  if (!next || next.length < 10) return c.json({ error: 'Use at least 10 characters for the new password.' }, 400);
  const u = await c.env.DB.prepare('SELECT pw_hash FROM users WHERE id = ?').bind(c.get('user').id).first<{ pw_hash: string }>();
  if (!u || !(await verifyPassword(current || '', u.pw_hash))) return c.json({ error: 'Your current password isn’t right.' }, 400);
  await c.env.DB.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').bind(await hashPassword(next), c.get('user').id).run();
  const signedOut = await endOtherSessions(c, c.get('user').id); // an old password must not keep other devices signed in
  return c.json({ ok: true, signedOut });
});
app.post('/api/sessions/end-others', async c => c.json({ ok: true, signedOut: await endOtherSessions(c, c.get('user').id) }));

/* ---------- what changed: one cheap request the app polls instead of reloading everything ---------- */
app.get('/api/version', async c => {
  const v = await versions(c.env);
  return c.json({ ...v, sheets: { configured: !!(c.env.SHEETS_WEBHOOK_URL && c.env.SHEETS_TOKEN), url: c.env.SHEET_URL || null, ...v.sheets } });
});

/* ---------- backup: everything in one JSON file (no passwords or AI tokens) ---------- */
app.get('/api/export', async c => {
  const [settings, weeks, transactions, years] = await Promise.all([getSettings(c.env), listWeeks(c.env), getAllRows(c.env), listYears(c.env)]);
  const body = { app: 'jam-paula-ledger', kind: 'backup', version: 1, exportedAt: new Date().toISOString(), settings, weeks, transactions, years };
  return new Response(JSON.stringify(body, null, 1), { headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'content-disposition': `attachment; filename="ledger-backup-${todayISO(c.env.TZ)}.json"`,
  } });
});

/* ---------- settings ---------- */
app.get('/api/settings', async c => c.json(await getSettings(c.env)));
/** {from: to} pairs from the settings dialog: short strings only. */
const movesOf = (v: unknown) => {
  const out: Record<string, string> = {};
  if (v && typeof v === 'object') for (const [from, to] of Object.entries(v).slice(0, 60)) if (from && typeof to === 'string' && from.length <= 60 && to.length <= 60) out[from] = to;
  return out;
};
app.put('/api/settings', async c => {
  const before = await getSettings(c.env);
  const body = await c.req.json<any>();
  const next = normalizeSettings({ ...body, notion: body?.notion ?? before.notion });
  // transactions on a removed card, or in a renamed or removed category, move to the one picked in Settings
  const cardMoves = movesOf(body?.cardMoves), catMoves = movesOf(body?.catMoves);
  for (const [from, to] of Object.entries(cardMoves)) if (from === to || !next.cards.some(x => x.id === to)) delete cardMoves[from];
  for (const [from, to] of Object.entries(catMoves)) if (from === to || (to !== '' && !next.categories.some(x => x.name === to))) delete catMoves[from];
  for (const [file, card] of Object.entries(next.fileCards)) if (cardMoves[card]) next.fileCards[file] = cardMoves[card];
  if (cardMoves[next.importCard]) next.importCard = cardMoves[next.importCard];
  const saved = await saveSettings(c.env, next);
  await moveRefs(c.env, cardMoves, catMoves);
  // who pays a card moves the transfer, and so do moved cards
  if (Object.keys(cardMoves).length || JSON.stringify(before.cards) !== JSON.stringify(saved.cards)) await recomputeAll(c.env);
  return c.json(saved);
});

/* ---------- weeks and transactions ---------- */
app.get('/api/weeks', async c => c.json(await listWeeks(c.env)));
app.put('/api/weeks/:id', async c => c.json(await putWeek(c.env, c.req.param('id'), await c.req.json())));
app.delete('/api/weeks/:id', async c => { await deleteWeek(c.env, c.req.param('id')); return c.json({ ok: true }); });
app.get('/api/weeks/:id/rows', async c => {
  if (!(await getWeek(c.env, c.req.param('id')))) return c.json({ items: [] });
  return c.json({ items: await getRows(c.env, c.req.param('id')) });
});
app.get('/api/rows', async c => c.json({ weeks: await getRowsOf(c.env, String(c.req.query('weeks') || '').split(',')) }));
app.patch('/api/weeks/:id/rows', async c => {
  const body = await c.req.json<{ upsert?: unknown[]; delete?: unknown[] }>();
  return c.json(await patchRows(c.env, c.req.param('id'), body.upsert || [], body.delete || []));
});

/* ---------- the year: income, budgets, savings balances ---------- */
const yearParam = (v: string) => { const y = Number(v); if (!/^\d{4}$/.test(v) || y < 2000 || y > 2100) throw new HttpError(400, 'Bad year.'); return y; };
app.get('/api/years/:year', async c => c.json({ doc: await getYear(c.env, yearParam(c.req.param('year'))) }));
app.put('/api/years/:year', async c => c.json({ doc: await saveYear(c.env, yearParam(c.req.param('year')), await c.req.json()) }));
/* changes as small operations, applied to the latest saved copy (see applyYearOps in core.ts) */
app.patch('/api/years/:year', async c => {
  const body = await c.req.json<{ ops?: unknown }>().catch(() => ({} as { ops?: unknown }));
  return c.json({ doc: await patchYear(c.env, yearParam(c.req.param('year')), body.ops) });
});

/* ---------- Ask AI ---------- */
app.post('/api/ask', async c => askAI(c.env, c.get('user'), await c.req.json().catch(() => ({})), c.executionCtx));

/* ---------- Google Sheets + Notion ---------- */
app.get('/api/sheets', async c => c.json(await sheetsState(c.env)));
app.post('/api/sheets/sync', async c => c.json(await pushSheets(c.env)));
app.post('/api/weeks/:id/notion', async c => c.json(await notionSyncWeek(c.env, c.req.param('id'), 40)));

/* ---------- AI connections (MCP tokens) ---------- */
app.get('/api/tokens', async c => {
  const { results } = await c.env.DB.prepare('SELECT id, name, hint, created_by, created_at, last_used FROM api_tokens ORDER BY created_at DESC').all();
  return c.json(results);
});
app.post('/api/tokens', async c => {
  const { name } = await c.req.json<{ name?: string }>();
  const label = String(name || '').trim().slice(0, 60);
  if (!label) return c.json({ error: 'Give the connection a name, like "ChatGPT".' }, 400);
  const token = 'jpl_' + randomToken(24);
  const id = 't' + crypto.randomUUID().slice(0, 8);
  await c.env.DB.prepare('INSERT INTO api_tokens (id, name, token_hash, hint, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, label, await sha256(token), token.slice(-4), c.get('user').name, new Date().toISOString()).run();
  const origin = new URL(c.req.url).origin;
  return c.json({ id, name: label, token, endpoint: `${origin}/mcp`, urlWithKey: `${origin}/mcp?key=${token}` });
});
app.delete('/api/tokens/:id', async c => {
  await c.env.DB.prepare('DELETE FROM api_tokens WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

app.all('/api/*', c => c.json({ error: 'Not found.' }, 404));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(cronSheets(env));
  },
} satisfies ExportedHandler<Env>;
