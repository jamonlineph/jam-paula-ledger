// Writes dist/ledger-artifact.html: the page body of public/index.html, which is
// what gets published as the Claude version of the app (it runs on window.claude
// instead of this server). The <head> tags for the website (manifest, icons) are left out.
import fs from 'node:fs';
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const start = html.indexOf('<body>'), end = html.lastIndexOf('</body>');
if (start < 0 || end < 0) { console.error('public/index.html has no <body>…</body>.'); process.exit(1); }
const body = html.slice(start + '<body>'.length, end).trim() + '\n';
fs.mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../dist/ledger-artifact.html', import.meta.url), body);
console.log(`dist/ledger-artifact.html · ${(body.length / 1024).toFixed(0)} KB`);
