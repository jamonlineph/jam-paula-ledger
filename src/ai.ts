// "Ask AI" on the website: questions about the budget, answered by Claude through
// the Anthropic API (official SDK) with the same read-only tools the MCP server offers.
// The answer streams to the browser as newline-delimited JSON, one event per line:
//   {"t":"status","text":…}   what it is looking up
//   {"t":"delta","text":…}    the next piece of the answer
//   {"t":"clear"}             drop the text so far (a lead-in before a lookup)
//   {"t":"done","model":…,"note"?,"refused"?}
//   {"t":"error","message":…} stopped; whatever arrived before it stays on screen
// Needs the ANTHROPIC_API_KEY secret. ANTHROPIC_MODEL picks the model, ANTHROPIC_EFFORT the effort.

import Anthropic from '@anthropic-ai/sdk';
import { GROUPS, MON, MONTH_KEYS, MONTH_LONG, normalizeYear, r2, todayISO, yearAgg, type Settings, type WeekMeta } from './core';
import { getAllRows, getSettings, HttpError, listWeeks, listYears, type Env } from './db';
import { callTool, TOOLS } from './mcp';

const READ_TOOLS = ['ledger_overview', 'get_week', 'search_transactions', 'year_overview', 'settlement_summary'];
const MAX_ROUNDS = 6;
const PER_HOUR = 40;
const STATUS: Record<string, string> = {
  ledger_overview: 'Reading the ledger…', get_week: 'Opening the week…', search_transactions: 'Looking through transactions…',
  year_overview: 'Checking the budget…', settlement_summary: 'Working out the transfer…',
};
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
// Models that take each optional request feature (anything else gets the plain request).
const FALLBACK_MODELS = /^claude-(sonnet-5-5|opus-5-5|opus-5|fable-5-1)$/;           // server-side fallbacks: "default"
const SYSTEM_NOTE_MODELS = /^claude-(sonnet-5-5|opus-5-5|opus-5|opus-4-8|fable-5|fable-5-1|mythos-5|mythos-5-1)$/; // role "system" messages
const EFFORT_MODELS = /^claude-(sonnet-5-5|sonnet-5|sonnet-4-6|opus-5-5|opus-5|opus-4-[5-8]|fable-5|fable-5-1|mythos-5|mythos-5-1)$/;

const f = (n: number) => r2(n).toFixed(2);

async function context(env: Env) {
  const [settings, weeks, rows, docs] = await Promise.all([getSettings(env), listWeeks(env), getAllRows(env), listYears(env)]);
  const today = todayISO(env.TZ), year = +today.slice(0, 4);
  const docOf = new Map(docs.map(d => [d.year, d]));
  const ratio = new Map(weeks.map(w => [w.id, w.ratioP]));
  const withRatio = rows.map(r => ({ row: r, ratioP: ratio.get(r.weekId) ?? settings.ratioP }));
  const n = settings.names;
  const L: string[] = [];
  L.push(`Today is ${today}. Amounts are Canadian dollars.`);
  L.push(`People: ${n.p} and ${n.j}. Shared costs are split by salary ratio, default ${settings.ratioP}/${100 - settings.ratioP} (${n.p}/${n.j}); each week or month can have its own ratio.`);
  L.push(`Splits: "${n.p}" = hers alone, "${n.j}" = his alone, "Shared" = split by the salary ratio, "50/50" = half each, "Custom" = typed amounts (the rest shared), "Skip" = left out, "Not split" = not decided yet. A person's share = their own items + their ratio % of shared items. For weeks, the transfer = ${n.p}'s share of everything on cards whose bill ${n.j} pays, minus ${n.j}'s share of cards ${n.p} pays.`);
  L.push(`Cards: ${settings.cards.map(c => `${c.name} (${c.payer === 'p' ? n.p : n.j} pays the bill)`).join('; ')}.`);
  L.push(`Categories: ${GROUPS.map(([g, l]) => `${l}: ${settings.categories.filter(c => c.group === g).map(c => c.name).join(', ')}`).join(' | ')}. "Miscellaneous - Jerome" is ${n.j}'s personal spending.`);
  L.push('January to September 2026 came from their 2026 Income & Expense workbook as month records: no card, no transfer; January to March 2026 aren\'t split.');
  L.push('', 'Weeks and months, newest first (name | kind | dates | items | total | transfer | paid):');
  for (const w of weeks.slice(0, 60)) {
    const rec = w.kind === 'month';
    L.push(`${w.name} | ${rec ? 'workbook month' : 'week'} | ${w.minDate || ''}–${w.maxDate || ''} | ${w.count} | ${f(w.total)} | ${rec ? 'none' : `${w.settle >= 0 ? `${n.p} pays ${n.j}` : `${n.j} pays ${n.p}`} ${f(Math.abs(w.settle))}`} | ${w.paid ? 'paid ' + w.paid : rec ? '' : 'not paid'}`);
  }
  for (const y of [year - 1, year]) { // last year too, so January still sees December
    const agg = yearAgg(withRatio, docOf.get(y) || normalizeYear(null, y), settings);
    const mms = MONTH_KEYS.filter(mm => agg[mm]); if (!mms.length) continue;
    L.push('', `${y} by month (month | income | ${n.p} income | ${n.j} income | spent | left | budget | into savings | ${n.p}'s share | ${n.j}'s share | not split):`);
    for (const mm of mms) { const m = agg[mm]; L.push(`${MON[+mm - 1]} ${y} | ${f(m.income)} | ${f(m.incP)} | ${f(m.incJ)} | ${f(m.spent)} | ${f(m.income - m.spent)} | ${f(m.budget)} | ${f(m.saved)} | ${f(m.p)} | ${f(m.j)} | ${f(m.unAmt)}`); }
  }
  return { settings, weeks, text: L.join('\n') };
}

function rules(names: Settings['names']) {
  return `You are the budget helper inside ${names.p} and ${names.j}'s household ledger website. Answer their question from the ledger data below and your lookup tools (use them for specific transactions, merchants, categories, a month's budget, another year, or a week's details; their totals are exact, so prefer them to adding up yourself).
Be brief and concrete: lead with the answer and the number, then at most a few lines or a small table. Money as $1,234.56. Use their names.
Only use this data; if something isn't in it, say so. No investment or tax advice; you can point out patterns, overspending against budget and simple ways to cut back.
A note from the app may say what they have open; "this week" or "this month" means that unless they say otherwise.
You can only read. If they ask you to change something, tell them where to do it on the website (split buttons and category box on each row, Add item, Import statement, the budget boxes in the year overview, Update for savings balances).`;
}

/** What the page has open, as a sentence for the model. */
function viewNote(ctx: any, weeks: WeekMeta[]) {
  if (!ctx || typeof ctx !== 'object') return '';
  if (ctx.view === 'year') {
    const y = Number(ctx.year);
    if (!/^\d{4}$/.test(String(ctx.year))) return '';
    const mm = /^\d{2}$/.test(String(ctx.month)) && +ctx.month >= 1 && +ctx.month <= 12 ? String(ctx.month) : null;
    return `The app is showing the year overview for ${mm ? `${MONTH_LONG[+mm - 1]} ` : ''}${y}.`;
  }
  const w = typeof ctx.period === 'string' ? weeks.find(x => x.id === ctx.period) : null;
  if (!w) return '';
  return `The app has ${w.kind === 'month' ? 'the workbook month' : 'the week'} "${w.name}" open (id ${w.id}${w.minDate ? `, ${w.minDate} to ${w.maxDate}` : ''}).`;
}

/** After a mid-answer fallback, the declined model's reasoning and tool calls before the switch are not sent back. */
function echo(content: Anthropic.Beta.BetaContentBlock[]) {
  const types = content.map(b => (b as { type: string }).type);
  const cut = types.lastIndexOf('fallback');
  if (cut < 0) return content;
  return content.filter((_, i) => i > cut || !['thinking', 'redacted_thinking', 'tool_use'].includes(types[i]));
}

function errText(e: unknown) {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return 'The Anthropic API key was refused. Check ANTHROPIC_API_KEY.';
  if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError) return 'The AI is busy right now. Try again in a minute.';
  if (e instanceof Anthropic.APIConnectionError) return 'Couldn’t reach the AI. Try again in a moment.';
  if (e instanceof Anthropic.APIError) return `The AI couldn’t answer: ${e.message}`;
  if (e instanceof HttpError) return e.message;
  return 'Something went wrong while answering. Try again.';
}

type Send = (event: Record<string, unknown>) => void;

export async function askAI(env: Env, user: { id: string }, body: any, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(400, 'Ask AI isn’t turned on for this website yet. Add an Anthropic API key (README, step 8).');
  const incoming: Anthropic.Beta.BetaMessageParam[] = (Array.isArray(body?.messages) ? body.messages : [])
    .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-12).map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
  while (incoming.length && incoming[0].role !== 'user') incoming.shift();
  if (!incoming.length || incoming[incoming.length - 1].role !== 'user') throw new HttpError(400, 'Ask a question first.');

  const hour = new Date().toISOString().slice(0, 13);
  const rlKey = `ask:${user.id}:${hour}`;
  const used = Number(await env.SESSIONS.get(rlKey)) || 0;
  if (used >= PER_HOUR) throw new HttpError(429, `That’s ${PER_HOUR} questions this hour. Try again a little later.`);
  await env.SESSIONS.put(rlKey, String(used + 1), { expirationTtl: 3700 });

  const { settings, weeks, text } = await context(env);
  const note = viewNote(body?.context, weeks);

  const ac = new AbortController(), enc = new TextEncoder();
  let out!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { out = c; }, cancel() { ac.abort(); } });
  const send: Send = event => {
    if (ac.signal.aborted) return;
    try { out.enqueue(enc.encode(JSON.stringify(event) + '\n')); } catch { ac.abort(); }
  };
  const work = answer(env, settings, text, note, incoming, send, ac.signal)
    .catch(e => {
      if (ac.signal.aborted) return;
      if (!(e instanceof Anthropic.APIError || e instanceof HttpError)) console.error('ask AI', e);
      send({ t: 'error', message: errText(e) });
    })
    .finally(() => { try { out.close(); } catch { /* the page went away */ } });
  ctx?.waitUntil(work);
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-content-type-options': 'nosniff' } });
}

async function answer(env: Env, settings: Settings, data: string, note: string, incoming: Anthropic.Beta.BetaMessageParam[], send: Send, signal: AbortSignal) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_API_BASE || undefined, maxRetries: 2 });
  const model = env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
  const effort = EFFORTS.find(e => e === env.ANTHROPIC_EFFORT) || 'medium';
  const tools: Anthropic.Beta.BetaTool[] = TOOLS.filter(t => READ_TOOLS.includes(t.name))
    .map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema, eager_input_streaming: true }));
  // Tools and the instructions never change and the ledger data changes only with the ledger:
  // one cache breakpoint after the data covers all of it, so the rounds of one question
  // (and the next question, while nothing changed) reuse it.
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: 'text', text: rules(settings.names) },
    { type: 'text', text: '--- Ledger data ---\n' + data, cache_control: { type: 'ephemeral' } },
  ];
  const msgs: Anthropic.Beta.BetaMessageParam[] = [...incoming];
  if (note) {
    // what the page has open goes after the question, never into the cached system prompt
    if (SYSTEM_NOTE_MODELS.test(model)) msgs.push({ role: 'system', content: note });
    else {
      const last = msgs[msgs.length - 1];
      msgs[msgs.length - 1] = { role: 'user', content: [{ type: 'text', text: String(last.content) }, { type: 'text', text: `(App note: ${note})` }] };
    }
  }
  let badJson = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const last = round === MAX_ROUNDS - 1;
    const s = client.beta.messages.stream({
      model, max_tokens: 16000, system, tools, messages: msgs,
      cache_control: { type: 'ephemeral' }, // the growing tool rounds of this question
      ...(last ? { tool_choice: { type: 'none' as const } } : {}),
      ...(EFFORT_MODELS.test(model) ? { output_config: { effort } } : {}),
      ...(FALLBACK_MODELS.test(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    }, { signal });
    s.on('text', delta => send({ t: 'delta', text: delta }));
    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await s.finalMessage();
      badJson = 0;
    } catch (e) {
      // only a tool input that wasn't valid JSON is asked again; API errors stop the answer
      if (e instanceof Anthropic.APIError || signal.aborted || badJson++ >= 2) throw e;
      send({ t: 'clear' }); round--; continue;
    }
    if (msg.stop_reason === 'refusal') { send({ t: 'clear' }); send({ t: 'done', model: msg.model, refused: true }); return; }
    const content = echo(msg.content);
    const uses = content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (msg.stop_reason !== 'tool_use' || !uses.length) {
      if (msg.stop_reason === 'max_tokens' && uses.length) throw new HttpError(502, 'The answer got too long. Ask for less at a time.');
      send({ t: 'done', model: msg.model, ...(msg.stop_reason === 'max_tokens' ? { note: 'The answer was cut short. Ask for less at a time.' } : {}) });
      return;
    }
    send({ t: 'clear' });
    msgs.push({ role: 'assistant', content: content as Anthropic.Beta.BetaContentBlockParam[] });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const b of uses) {
      send({ t: 'status', text: STATUS[b.name] || 'Looking it up…' });
      const input = b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? b.input : null;
      if (!READ_TOOLS.includes(b.name) || !input) {
        results.push({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: !input ? 'Error: the input was not a JSON object.' : 'Error: that tool isn’t available here.' });
        continue;
      }
      try { results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(await callTool(env, b.name, input)).slice(0, 30000) }); }
      catch (e: any) { results.push({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: `Error: ${e?.message || 'the lookup failed'}` }); }
    }
    msgs.push({ role: 'user', content: results });
  }
}
