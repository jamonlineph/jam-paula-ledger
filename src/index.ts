import { Hono } from 'hono';
import { currentUser, endSession, hashPassword, noteFailedAttempt, randomToken, requireUser, sha256, startSession, tooManyAttempts, verifyPassword, type AppEnv } from './auth';
import { deleteWeek, getRows, getSettings, getWeek, getYear, HttpError, listWeeks, patchRows, putWeek, recomputeAll, saveSettings, saveYear, type Env } from './db';
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
  return c.json({ ok: true });
});

/* ---------- settings ---------- */
app.get('/api/settings', async c => c.json(await getSettings(c.env)));
app.put('/api/settings', async c => {
  const before = await getSettings(c.env);
  const body = await c.req.json();
  const saved = await saveSettings(c.env, { ...body, notion: body?.notion ?? before.notion });
  if (JSON.stringify(before.cards) !== JSON.stringify(saved.cards)) await recomputeAll(c.env); // card payer changes move the transfer
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
app.patch('/api/weeks/:id/rows', async c => {
  const body = await c.req.json<{ upsert?: unknown[]; delete?: unknown[] }>();
  return c.json(await patchRows(c.env, c.req.param('id'), body.upsert || [], body.delete || []));
});

/* ---------- the year: income, budgets, savings balances ---------- */
const yearParam = (v: string) => { const y = Number(v); if (!/^\d{4}$/.test(v) || y < 2000 || y > 2100) throw new HttpError(400, 'Bad year.'); return y; };
app.get('/api/years/:year', async c => c.json({ doc: await getYear(c.env, yearParam(c.req.param('year'))) }));
app.put('/api/years/:year', async c => c.json({ doc: await saveYear(c.env, yearParam(c.req.param('year')), await c.req.json()) }));

/* ---------- Ask AI ---------- */
app.post('/api/ask', async c => c.json(await askAI(c.env, c.get('user'), await c.req.json().catch(() => ({})))));

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
