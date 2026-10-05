#!/usr/bin/env node
// Quick check that the MCP endpoint answers:  node scripts/mcp-check.mjs "https://<your-app>/mcp?key=jpl_..."
const url = process.argv[2];
if (!url) { console.error('Usage: node scripts/mcp-check.mjs "<link with key>"'); process.exit(1); }
const rpc = async (method, params, id = 1) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
};
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-check', version: '1' } });
console.log('✓ connected to', init.serverInfo.title, '(protocol', init.protocolVersion + ')');
const { tools } = await rpc('tools/list', {}, 2);
console.log('✓', tools.length, 'tools:', tools.map(t => t.name).join(', '));
const ov = await rpc('tools/call', { name: 'ledger_overview', arguments: {} }, 3);
console.log('✓ ledger_overview:', ov.structuredContent.weeks.length, 'weeks,', ov.structuredContent.cards.length, 'cards');
