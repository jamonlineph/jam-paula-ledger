#!/usr/bin/env node
// Create (or reset) a login.  Usage:
//   npm run user:add -- <username> "<Display name>" [--local]
// You'll be asked for the password; it is hashed here (PBKDF2-SHA256, 100k)
// and only the hash is stored in D1.
import { webcrypto as crypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import readline from 'node:readline';

const args = process.argv.slice(2);
const local = args.includes('--local');
const [username, display] = args.filter(a => !a.startsWith('--'));
if (!username) {
  console.error('Usage: npm run user:add -- <username> "<Display name>" [--local]');
  process.exit(1);
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise(res => {
    rl._writeToOutput = s => { if (s.includes(q)) rl.output.write(s); else rl.output.write('*'); };
    rl.question(q, a => { rl.close(); process.stdout.write('\n'); res(a); });
  });
}
const password = process.env.LEDGER_PASSWORD || await ask(`Password for ${username}: `);
if (!password || password.length < 10) { console.error('Use at least 10 characters.'); process.exit(1); }

const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
const b64 = b => Buffer.from(b).toString('base64');
const hash = `pbkdf2$100000$${b64(salt)}$${b64(bits)}`;
const id = 'u' + crypto.randomUUID().slice(0, 8);
const esc = s => String(s).replace(/'/g, "''");
const sql = `INSERT INTO users (id, username, display_name, pw_hash, created_at) VALUES ('${id}', '${esc(username)}', '${esc(display || username)}', '${hash}', '${new Date().toISOString()}') ON CONFLICT(username) DO UPDATE SET pw_hash = excluded.pw_hash, display_name = excluded.display_name;`;
execFileSync('npx', ['wrangler', 'd1', 'execute', 'ledger', local ? '--local' : '--remote', '--command', sql], { stdio: 'inherit' });
console.log(`\n✓ ${username} can now sign in${local ? ' (local dev database)' : ''}.`);
