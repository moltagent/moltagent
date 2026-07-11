/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 Moltagent contributors
 *
 * calendar-date-grounding-harness.js — the gap-closer measurement instrument
 * for Calendar Arc PR-4 (#168).
 *
 * Question it answers: given a "schedule X tomorrow" turn, does the LOCAL-ONLY
 * tools seat (qwen3:8b) emit a `calendar_create_event` call whose `start` lands
 * on tomorrow's real date — or on its ~October-2023 training prior?
 *
 * Faithfulness: it drives the SAME artifacts production sends the model —
 *   • the real calendar tool schemas (ToolRegistry.getToolSubset('calendar')),
 *   • the same live-date injection production applies (injectLiveDate), and
 *   • the real transport (OllamaToolsProvider → Ollama /api/chat).
 * It does NOT stand up Nextcloud or Talk (a targeted harness, per S122 — avoids
 * the shared-NC-account outage). Tool handlers never run: the harness reads the
 * emitted tool-call arguments, it does not create events.
 *
 * Control vs variant is a single flag, so one committed harness measures both
 * rows of the PR table against identical seed turns:
 *   node test/manual/calendar-date-grounding-harness.js            # BASELINE (deployed reality: date header only)
 *   node test/manual/calendar-date-grounding-harness.js --inject   # VARIANT  (date also in the start schema)
 *
 * Env:
 *   OLLAMA_URL    Ollama endpoint (required; e.g. the box's OLLAMA_URL)
 *   OLLAMA_MODEL  model tag (default qwen3:8b)
 *   HARNESS_TZ    IANA zone for the date header + injection (default Europe/Berlin)
 *   TURN_TIMEOUT  per-turn ms (default 300000 — qwen3:8b runs ~200s/turn, #124)
 */

'use strict';

(async () => {
  const path = require('path');
  const { ToolRegistry } = require(path.join('..', '..', 'src', 'lib', 'agent', 'tool-registry'));
  const { OllamaToolsProvider } = require(path.join('..', '..', 'src', 'lib', 'agent', 'providers', 'ollama-tools'));
  const { injectLiveDate } = require(path.join('..', '..', 'src', 'lib', 'agent', 'calendar-date-grounding'));

  const GREEN = '\x1b[32m'; const RED = '\x1b[31m'; const YELLOW = '\x1b[33m'; const DIM = '\x1b[2m'; const RESET = '\x1b[0m';

  const INJECT = process.argv.includes('--inject');
  const ENDPOINT = process.env.OLLAMA_URL;
  const MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b';
  const TZ = process.env.HARNESS_TZ || 'Europe/Berlin';
  const TURN_TIMEOUT = Number(process.env.TURN_TIMEOUT) || 300000;

  if (!ENDPOINT) {
    console.error(`${RED}OLLAMA_URL is required (the local model endpoint). Aborting.${RESET}`);
    process.exit(2);
  }

  // Silence the registry's [BOOT] chatter; we only need the schemas.
  const silent = { info() {}, warn() {}, error(...a) { console.error(...a); }, debug() {} };

  // Real calendar schemas. A truthy stub client passes the registration gate;
  // handlers are never invoked here.
  const registry = new ToolRegistry({ calDAVClient: {}, logger: silent });
  let tools = registry.getToolSubset('calendar');
  if (!tools.length) {
    console.error(`${RED}No calendar tools registered — registration gate changed?${RESET}`);
    process.exit(2);
  }

  const now = new Date();
  if (INJECT) {
    tools = injectLiveDate(tools, now, TZ);
  }

  // Reproduce production's system-prompt date header verbatim (agent-loop.js
  // _buildSystemPrompt). This is the control held constant across both rows;
  // SOUL/cockpit/persona are omitted (not the variable under test).
  const dateStr = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: TZ,
  }).format(now);
  const timeStr = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ,
  }).format(now);
  const dateHeader = `Today is ${dateStr}. Current time: ${timeStr} (24h format, ${TZ}). Use this for all date-related queries.\n\n`;

  // Faithfulness knob. The minimal prompt makes the date header prominent; that
  // is NOT what production sends. With SOUL=1 the harness reproduces production's
  // real ordering (agent-loop.js _buildSystemPrompt: … + dateHeader + this.soul),
  // so the header is diluted by the full ~443-line SOUL exactly as it is live.
  // This is the variable that decides whether #168 reproduces.
  const fs = require('fs');
  let system;
  if (process.env.SOUL) {
    const soul = fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'SOUL.md'), 'utf8');
    system = dateHeader + soul;
  } else {
    system = dateHeader +
      'You are a scheduling assistant. When the user asks to schedule or book something, ' +
      'call calendar_create_event with an ISO 8601 start. Do not ask for a title.';
  }

  // Tomorrow's real date in the header's zone — the single expected answer.
  const iso = (d) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ }).format(d);
  const TOMORROW = iso(new Date(now.getTime() + 24 * 60 * 60 * 1000));

  // Six seed turns — 2 DE / 2 EN / 2 PT — all anchored on "tomorrow" so the
  // expected start-date is unambiguous. Same phrasing family as the gap-closer.
  const TURNS = [
    { lang: 'DE', text: 'Plane morgen um 15:00 ein Meeting für 90 Minuten.' },
    { lang: 'DE', text: 'Trag mir morgen um 09:30 einen Termin für 60 Minuten ein.' },
    { lang: 'EN', text: 'Schedule a meeting tomorrow at 14:00 for 45 minutes.' },
    { lang: 'EN', text: 'Book something tomorrow at 11:00 for one hour.' },
    { lang: 'PT', text: 'Agenda uma reunião amanhã às 16:00 por 30 minutos.' },
    { lang: 'PT', text: 'Marca amanhã às 10:00 um compromisso de 60 minutos.' },
  ];

  const provider = new OllamaToolsProvider({ endpoint: ENDPOINT, model: MODEL, toolTimeout: TURN_TIMEOUT, timeout: TURN_TIMEOUT }, silent);

  const promptMode = process.env.SOUL ? 'full-SOUL prompt' : 'minimal prompt';
  const mode = `${INJECT ? 'VARIANT (date-in-schema)' : 'BASELINE (date header only)'} · ${promptMode}`;
  console.log(`\n${YELLOW}Calendar date-grounding harness — ${mode}${RESET}`);
  console.log(`${DIM}model=${MODEL}  tz=${TZ}  today=${iso(now)}  tomorrow=${TOMORROW}  timeout=${TURN_TIMEOUT}ms${RESET}\n`);

  // Warm the model once (#124 cold-load >60s would otherwise blow turn 1).
  process.stdout.write(`${DIM}warming ${MODEL} …${RESET}`);
  try {
    await provider.chat({ system: 'ok', messages: [{ role: 'user', content: 'Reply with the word ready.' }], timeout: TURN_TIMEOUT });
    console.log(`${DIM} warm.${RESET}\n`);
  } catch (e) {
    console.log(`${YELLOW} warmup failed (${e.message}) — continuing.${RESET}\n`);
  }

  let grounded = 0;
  const rows = [];
  for (const turn of TURNS) {
    const started = Date.now();
    let emittedStart = null; let verdict; let note = '';
    try {
      const res = await provider.chat({ system, messages: [{ role: 'user', content: turn.text }], tools, timeout: TURN_TIMEOUT });
      const call = (res.toolCalls || []).find(c => c.name === 'calendar_create_event')
        || (res.toolCalls || [])[0];
      if (!call) {
        verdict = 'prose'; note = (res.content || '').slice(0, 60).replace(/\n/g, ' ');
      } else {
        const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : (call.arguments || {});
        emittedStart = args.start || null;
        const emittedDate = emittedStart ? String(emittedStart).slice(0, 10) : null;
        if (emittedDate === TOMORROW) { verdict = 'grounded'; grounded++; }
        else { verdict = 'wrong'; }
      }
    } catch (e) {
      verdict = 'error'; note = e.message.slice(0, 60);
    }
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    const mark = verdict === 'grounded' ? `${GREEN}✓ grounded${RESET}` : `${RED}✗ ${verdict}${RESET}`;
    console.log(`${mark}  [${turn.lang}] ${turn.text}`);
    console.log(`      emitted start: ${emittedStart || '—'}   expected: ${TOMORROW}   (${secs}s)${note ? `  ${DIM}${note}${RESET}` : ''}`);
    rows.push({ lang: turn.lang, text: turn.text, emittedStart, verdict, secs: Number(secs) });
  }

  console.log(`\n${grounded === TURNS.length ? GREEN : (grounded === 0 ? RED : YELLOW)}GROUNDED: ${grounded}/${TURNS.length}${RESET}  (${mode})`);
  // Machine-readable summary line for the PR table.
  console.log('HARNESS_RESULT ' + JSON.stringify({ mode: INJECT ? 'variant' : 'baseline', model: MODEL, tz: TZ, today: iso(now), tomorrow: TOMORROW, grounded, total: TURNS.length, rows }));
  process.exit(grounded === TURNS.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
