// Quick end-to-end check against a running server (default: npm run dev on :8787).
//   LEDGER_PASSWORD=… npm run smoke            (user "jam" by default)
//   LEDGER_URL=https://… LEDGER_USER=paula LEDGER_PASSWORD=… npm run smoke
// It only reads, except for one MCP connection token it creates and then revokes.
const base = (process.env.LEDGER_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const user = process.env.LEDGER_USER || 'jam';
const password = process.env.LEDGER_PASSWORD;
if (!password) { console.error('Set LEDGER_PASSWORD (and LEDGER_USER if not "jam").'); process.exit(2); }

let cookie = '', failed = 0;
const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-ledger': '1', cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
};
const check = (name, ok, detail = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' · ' + detail : ''}`); if (!ok) failed++; };

const health = await fetch(base + '/healthz').then(r => r.text()).catch(() => '');
check('server answers /healthz', health === 'ok');
const login = await call('POST', '/api/login', { username: user, password });
check('sign in', login.status === 200, `HTTP ${login.status}`);
if (login.status !== 200) process.exit(1);
const me = await call('GET', '/api/me');
check('who am I', !!me.data?.user, `${me.data?.user?.name} · sheet ${me.data?.sheets?.configured ? 'on' : 'off'} · notion ${me.data?.notion?.configured ? 'on' : 'off'} · ask AI ${me.data?.ai?.configured ? 'on' : 'off'}`);
const settings = await call('GET', '/api/settings');
check('settings', Array.isArray(settings.data?.cards) && Array.isArray(settings.data?.categories), `${settings.data?.cards?.length} cards · ${settings.data?.categories?.length} categories`);
const weeks = await call('GET', '/api/weeks');
check('weeks', Array.isArray(weeks.data), `${weeks.data?.length} weeks and months`);
if (weeks.data?.length) {
  const w = weeks.data[0];
  const rows = await call('GET', `/api/weeks/${encodeURIComponent(w.id)}/rows`);
  const total = Math.round(rows.data.items.filter(r => r.mode !== 'X').reduce((a, r) => a + r.amt, 0) * 100) / 100;
  check(`rows of ${w.name}`, Math.abs(total - w.total) < 0.011, `${rows.data.items.length} rows, total ${total} vs stored ${w.total}`);
}
const year = new Date().getFullYear();
const y = await call('GET', `/api/years/${year}`);
check(`year ${year}`, y.status === 200, y.data?.doc ? `${Object.keys(y.data.doc.months).length} months with data` : 'no year document yet');

const tok = await call('POST', '/api/tokens', { name: 'smoke test' });
check('create MCP token', !!tok.data?.token);
if (tok.data?.token) {
  const rpc = async (method, params) => (await fetch(tok.data.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok.data.token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  check('MCP initialize', !!init.result?.serverInfo, init.result?.protocolVersion);
  const tools = await rpc('tools/list', {});
  check('MCP tools', (tools.result?.tools?.length || 0) >= 16, `${tools.result?.tools?.length} tools`);
  const ov = await rpc('tools/call', { name: 'year_overview', arguments: {} });
  check('MCP year_overview', !ov.result?.isError, JSON.stringify(ov.result?.structuredContent?.totals || {}));
  await call('DELETE', `/api/tokens/${tok.data.id}`);
}
await call('POST', '/api/logout');
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
