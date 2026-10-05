#!/usr/bin/env node
// One-time Cloudflare setup: creates the D1 database and KV namespace and
// writes their ids into wrangler.jsonc. Run after `npx wrangler login`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const run = args => execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
let cfg = fs.readFileSync('wrangler.jsonc', 'utf8');

if (cfg.includes('REPLACE_WITH_D1_DATABASE_ID')) {
  console.log('Creating D1 database "ledger"…');
  const out = run(['d1', 'create', 'ledger']);
  const id = out.match(/"database_id":\s*"([0-9a-f-]{36})"/)?.[1] || out.match(/database_id\s*=\s*"([0-9a-f-]{36})"/)?.[1];
  if (!id) { console.error(out); throw new Error('Could not read the new database id. Paste it into wrangler.jsonc by hand.'); }
  cfg = cfg.replace('REPLACE_WITH_D1_DATABASE_ID', id);
  fs.writeFileSync('wrangler.jsonc', cfg);
  console.log('  database_id', id);
}
if (cfg.includes('REPLACE_WITH_KV_NAMESPACE_ID')) {
  console.log('Creating KV namespace for sign-in sessions…');
  const out = run(['kv', 'namespace', 'create', 'SESSIONS']);
  const id = out.match(/"id":\s*"([0-9a-f]{32})"/)?.[1] || out.match(/id\s*=\s*"([0-9a-f]{32})"/)?.[1];
  if (!id) { console.error(out); throw new Error('Could not read the new KV id. Paste it into wrangler.jsonc by hand.'); }
  cfg = cfg.replace('REPLACE_WITH_KV_NAMESPACE_ID', id);
  fs.writeFileSync('wrangler.jsonc', cfg);
  console.log('  kv id', id);
}
console.log('Applying database migrations…');
execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'ledger', '--remote'], { stdio: 'inherit' });
console.log('\nDone. Next: npm run user:add -- jam "Jam"  and  npm run user:add -- paula "Paula", then npm run deploy');
