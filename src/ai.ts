// "Ask AI" on the website: questions about the budget, answered by Claude
// through the Anthropic API with the same read-only tools the MCP server offers.
// Needs the ANTHROPIC_API_KEY secret; ANTHROPIC_MODEL picks the model.

import { GROUPS, MONTH_KEYS, MON, normalizeYear, r2, todayISO, yearAgg } from './core';
import { getAllRows, getSettings, getYear, HttpError, listWeeks, type Env } from './db';
import { callTool, TOOLS } from './mcp';

const READ_TOOLS = ['ledger_overview', 'get_week', 'search_transactions', 'year_overview', 'settlement_summary'];
const MAX_ROUNDS = 6;
const PER_HOUR = 40;

const f = (n: number) => r2(n).toFixed(2);

async function context(env: Env) {
  const [settings, weeks, rows] = await Promise.all([getSettings(env), listWeeks(env), getAllRows(env)]);
  const year = new Date().getFullYear();
  const doc = (await getYear(env, year)) || normalizeYear(null, year);
  const ratio = new Map(weeks.map(w => [w.id, w.ratioP]));
  const agg = yearAgg(rows.map(r => ({ row: r, ratioP: ratio.get(r.weekId) ?? settings.ratioP })), doc, settings);
  const n = settings.names;
  const L: string[] = [];
  L.push(`Today is ${todayISO(env.TZ)}. Amounts are Canadian dollars.`);
  L.push(`People: ${n.p} and ${n.j}. Shared costs are split by salary ratio, default ${settings.ratioP}/${100 - settings.ratioP} (${n.p}/${n.j}); each week or month can have its own ratio.`);
  L.push(`Splits: "${n.p}" = hers alone, "${n.j}" = his alone, "Shared" = split by the salary ratio, "50/50" = half each, "Custom" = typed amounts (the rest shared), "Skip" = left out, "Not split" = not decided yet. A person's share = their own items + their ratio % of shared items. For weeks, the transfer = ${n.p}'s share of everything on cards whose bill ${n.j} pays, minus ${n.j}'s share of cards ${n.p} pays.`);
  L.push(`Cards: ${settings.cards.map(c => `${c.name} (${c.payer === 'p' ? n.p : n.j} pays the bill)`).join('; ')}.`);
  L.push(`Categories: ${GROUPS.map(([g, l]) => `${l}: ${settings.categories.filter(c => c.group === g).map(c => c.name).join(', ')}`).join(' | ')}. "Miscellaneous - Jerome" is ${n.j}'s personal spending.`);
  L.push(`January to September ${year} came from their 2026 Income & Expense workbook as month records: no card, no transfer; January to March aren't split.`);
  L.push('', 'Weeks and months, newest first (name | kind | dates | items | total | transfer | paid):');
  for (const w of weeks.slice(0, 60)) {
    const rec = w.kind === 'month';
    L.push(`${w.name} | ${rec ? 'workbook month' : 'week'} | ${w.minDate || ''}–${w.maxDate || ''} | ${w.count} | ${f(w.total)} | ${rec ? 'none' : `${w.settle >= 0 ? `${n.p} pays ${n.j}` : `${n.j} pays ${n.p}`} ${f(Math.abs(w.settle))}`} | ${w.paid ? 'paid ' + w.paid : rec ? '' : 'not paid'}`);
  }
  L.push('', `${year} by month (month | income | ${n.p} income | ${n.j} income | spent | left | budget | into savings | ${n.p}'s share | ${n.j}'s share | not split):`);
  for (const mm of MONTH_KEYS) { const m = agg[mm]; if (m) L.push(`${MON[+mm - 1]} | ${f(m.income)} | ${f(m.incP)} | ${f(m.incJ)} | ${f(m.spent)} | ${f(m.income - m.spent)} | ${f(m.budget)} | ${f(m.saved)} | ${f(m.p)} | ${f(m.j)} | ${f(m.unAmt)}`); }
  return { settings, text: L.join('\n') };
}

function rules(names: { p: string; j: string }) {
  return `You are the budget helper inside ${names.p} and ${names.j}'s household ledger website. Answer their question from the ledger data below and your lookup tools (use them for specific transactions, merchants, categories, a month's budget or a week's details; their totals are exact, so prefer them to adding up yourself).
Be brief and concrete: lead with the answer and the number, then at most a few lines or a small table. Money as $1,234.56. Use their names.
Only use this data; if something isn't in it, say so. No investment or tax advice; you can point out patterns, overspending against budget and simple ways to cut back.
You can only read. If they ask you to change something, tell them where to do it on the website (split buttons and category box on each row, Add item, Import statement, the budget boxes in the year overview, Update for savings balances).`;
}

type Msg = { role: 'user' | 'assistant'; content: unknown };

export async function askAI(env: Env, user: { id: string }, body: any) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(400, 'Ask AI isn’t turned on for this website yet. Add an Anthropic API key (README, step 8).');
  const hour = new Date().toISOString().slice(0, 13);
  const rlKey = `ask:${user.id}:${hour}`;
  const used = Number(await env.SESSIONS.get(rlKey)) || 0;
  if (used >= PER_HOUR) throw new HttpError(429, `That’s ${PER_HOUR} questions this hour. Try again a little later.`);
  await env.SESSIONS.put(rlKey, String(used + 1), { expirationTtl: 3700 });

  const incoming: Msg[] = (Array.isArray(body?.messages) ? body.messages : [])
    .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-12).map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
  while (incoming.length && incoming[0].role !== 'user') incoming.shift();
  if (!incoming.length || incoming[incoming.length - 1].role !== 'user') throw new HttpError(400, 'Ask a question first.');

  const { settings, text } = await context(env);
  const system = rules(settings.names) + '\n\n--- Ledger data ---\n' + text;
  const tools = TOOLS.filter(t => READ_TOOLS.includes(t.name)).map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const base = env.ANTHROPIC_API_BASE || 'https://api.anthropic.com';
  const model = env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
  const msgs: Msg[] = [...incoming];
  const said: string[] = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const last = round === MAX_ROUNDS - 1;
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1600, system, messages: msgs, tools, ...(last ? { tool_choice: { type: 'none' } } : {}) }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const why = j?.error?.message || res.statusText;
      if (res.status === 401 || res.status === 403) throw new HttpError(502, `The Anthropic API key was refused (${why}). Check ANTHROPIC_API_KEY.`);
      if (res.status === 429 || res.status === 529) throw new HttpError(503, 'The AI is busy right now. Try again in a minute.');
      throw new HttpError(502, `The AI couldn’t answer: ${why}`);
    }
    const content: any[] = Array.isArray(j.content) ? j.content : [];
    const words = content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (words) said.push(words);
    if (j.stop_reason !== 'tool_use') break;
    msgs.push({ role: 'assistant', content });
    const results = await Promise.all(content.filter(b => b.type === 'tool_use').map(async b => {
      if (!READ_TOOLS.includes(b.name)) return { type: 'tool_result', tool_use_id: b.id, content: 'Error: that tool isn’t available here.', is_error: true };
      try { return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(await callTool(env, b.name, b.input || {})).slice(0, 30000) }; }
      catch (e: any) { return { type: 'tool_result', tool_use_id: b.id, content: `Error: ${e?.message || 'the lookup failed'}`, is_error: true }; }
    }));
    msgs.push({ role: 'user', content: results });
  }
  const answer = said.length ? said[said.length - 1] : '';
  if (!answer) throw new HttpError(502, 'No answer came back. Try asking it a different way.');
  return { text: answer, model };
}
