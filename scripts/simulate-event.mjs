/**
 * Full-event rehearsal: simulates a real field of competitors end to end.
 *
 * Unlike loadtest.mjs, which hammers the endpoints to find a ceiling, this
 * models what people actually do — arrive early, sit in the waiting room,
 * start together, think between answers, mistype, wait out the cooldown and
 * finish at different times. It is the closest thing to a dress rehearsal
 * without 200 colleagues and 200 phones.
 *
 *   node scripts/simulate-event.mjs --base <url> --key <publishable key> \
 *     --answers answers.json --players 200 --min-finish 60 --max-finish 180
 *
 * The answers file is [{ "clue": "...", "answer": "..." }, ...]: the script
 * needs the key because the server, correctly, will never hand it over.
 *
 * Run against a rehearsal event, never a live one.
 */

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const BASE = arg('base', 'http://localhost:8787');
const KEY = arg('key', null);
const PLAYERS = Number(arg('players', 200));
const MIN_FINISH = Number(arg('min-finish', 60));
const MAX_FINISH = Number(arg('max-finish', 180));
const ARRIVAL_WINDOW = Number(arg('arrival-window', 45));   // seconds people trickle in over
const MISTAKE_RATE = Number(arg('mistake-rate', 0.25));      // share of entries typed wrong first
const WAIT_POLL_MS = 5000;
const PLAY_POLL_MS = 15000;
const AUTOSAVE_MS = 15000;
const COOLDOWN_MS = 3200;                                    // the server enforces 3s per entry

const { readFile } = await import('node:fs/promises');
const ANSWERS = JSON.parse(await readFile(arg('answers', 'answers.json'), 'utf8'));

const headers = { 'Content-Type': 'application/json' };
if (KEY) { headers.apikey = KEY; headers.Authorization = `Bearer ${KEY}`; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ------------------------------------------------------------- telemetry --

const metrics = {
  latencies: [],
  errors: new Map(),
  calls: 0,
  cooldownHits: 0,
  wrongGuesses: 0,
  joined: 0,
  started: 0,
  finished: 0,
  finishTimes: [],     // seconds from the client's own start signal
  perCall: new Map(),  // fn -> [ms]
};

function recordError(key) {
  metrics.errors.set(key, (metrics.errors.get(key) ?? 0) + 1);
}

async function rpc(fn, body) {
  const t = performance.now();
  try {
    const res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const text = await res.text();
    const ms = performance.now() - t;
    metrics.latencies.push(ms);
    metrics.calls++;
    if (!metrics.perCall.has(fn)) metrics.perCall.set(fn, []);
    metrics.perCall.get(fn).push(ms);

    if (!res.ok) {
      recordError(`${fn} ${res.status}: ${text.slice(0, 100)}`);
      return null;
    }
    return text ? JSON.parse(text) : null;
  } catch (error) {
    metrics.latencies.push(performance.now() - t);
    metrics.calls++;
    recordError(`${fn} threw: ${error.message}`);
    return null;
  }
}

// ---------------------------------------------------------- one competitor --

/**
 * Plan a competitor's run: which entries they fumble, and how long they pause
 * between answers so they finish near their target time.
 */
function planRun(entryCount, targetSeconds) {
  const mistakes = new Map();
  for (let i = 0; i < entryCount; i++) {
    const roll = Math.random();
    if (roll < MISTAKE_RATE * 0.2) mistakes.set(i, 2);        // typed it wrong twice
    else if (roll < MISTAKE_RATE) mistakes.set(i, 1);          // one wrong attempt
  }
  const retries = [...mistakes.values()].reduce((a, b) => a + b, 0);
  // Cooldown waits are dead time, so take them out of the thinking budget.
  const thinkBudget = Math.max(entryCount * 0.4, targetSeconds - retries * (COOLDOWN_MS / 1000));
  return { mistakes, thinkPerEntry: thinkBudget / entryCount };
}

async function competitor(index, phase) {
  const employeeId = String(60000000 + index);

  // 1. Arrive at some point during the arrival window.
  await sleep(rand(0, ARRIVAL_WINDOW * 1000));
  const join = await rpc('join_event', {
    p_employee_id: employeeId, p_display_name: `Sim Competitor ${index}`,
  });
  if (!join?.token) return;
  const token = join.token;
  metrics.joined++;

  // 2. Sit in the waiting room, polling exactly as the app does.
  let state = null;
  while (true) {
    state = await rpc('get_event_state', { p_token: token });
    if (state?.status === 'running') break;
    if (state?.status === 'ended') return;
    await sleep(WAIT_POLL_MS * rand(0.9, 1.1));
  }
  metrics.started++;
  const startedAt = performance.now();

  // 3. Fetch the grid, as every phone does the moment the clock starts.
  const puzzle = await rpc('get_puzzle', { p_token: token });
  const entries = puzzle?.entries ?? [];
  if (!entries.length) { recordError('get_puzzle returned no entries'); return; }

  const byClue = new Map(ANSWERS.map((a) => [a.clue, a.answer]));
  const target = rand(MIN_FINISH, MAX_FINISH);
  const { mistakes, thinkPerEntry } = planRun(entries.length, target);

  // Background chatter: state polls and progress autosaves while they play.
  let playing = true;
  const grid = {};
  const chatter = (async () => {
    while (playing) {
      await sleep(PLAY_POLL_MS * rand(0.9, 1.1));
      if (!playing) break;
      await rpc('get_event_state', { p_token: token });
      await sleep(AUTOSAVE_MS * rand(0.4, 0.6));
      if (!playing) break;
      grid[`${Math.floor(Math.random() * 19)},${Math.floor(Math.random() * 15)}`] = 'A';
      await rpc('save_progress', { p_token: token, p_grid_state: grid });
    }
  })();

  // 4. Work through the clues.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const answer = byClue.get(entry.clue);
    if (!answer) { recordError(`no answer mapped for clue "${entry.clue}"`); continue; }

    await sleep(thinkPerEntry * 1000 * rand(0.5, 1.5));

    // Fumble it the planned number of times first.
    for (let attempt = 0; attempt < (mistakes.get(i) ?? 0); attempt++) {
      const wrong = answer.slice(0, -1) + (answer.at(-1) === 'Z' ? 'Y' : 'Z');
      const result = await rpc('check_answer',
        { p_token: token, p_entry_id: entry.id, p_guess: wrong });
      if (result?.cooldown) metrics.cooldownHits++;
      else if (result?.correct === false) metrics.wrongGuesses++;
      // The app blocks a retry on the same clue for 3 seconds.
      await sleep(COOLDOWN_MS);
    }

    let result = await rpc('check_answer',
      { p_token: token, p_entry_id: entry.id, p_guess: answer });

    // If the cooldown caught us, wait it out and try once more, as the app does.
    if (result?.cooldown) {
      metrics.cooldownHits++;
      await sleep((result.retry_after_ms ?? 3000) + 200);
      result = await rpc('check_answer',
        { p_token: token, p_entry_id: entry.id, p_guess: answer });
    }

    if (result?.correct !== true) {
      recordError(`a correct answer was rejected for "${entry.clue}": ${JSON.stringify(result)}`);
    }
    if (result?.finished) {
      metrics.finished++;
      metrics.finishTimes.push((performance.now() - startedAt) / 1000);
      break;
    }
  }

  playing = false;
  await chatter;
}

// ------------------------------------------------------------------ report --

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function summarise(label, values, unit = 'ms') {
  if (!values.length) return `${label.padEnd(20)} (none)`;
  const s = values.slice().sort((a, b) => a - b);
  const f = (n) => (unit === 's' ? n.toFixed(1) : n.toFixed(0));
  return `${label.padEnd(20)} n=${String(s.length).padStart(5)}  `
    + `min=${f(s[0])}  p50=${f(percentile(s, 0.5))}  p95=${f(percentile(s, 0.95))}  max=${f(s.at(-1))} ${unit}`;
}

// -------------------------------------------------------------------- run --

log(`Simulating ${PLAYERS} competitors against ${BASE}`);
log(`arrival window ${ARRIVAL_WINDOW}s · finish times ${MIN_FINISH}-${MAX_FINISH}s · `
  + `mistakes on ~${Math.round(MISTAKE_RATE * 100)}% of entries`);
log('competitors will join, then wait for the administrator to press Start');

const wallStart = performance.now();
await Promise.all(Array.from({ length: PLAYERS }, (_, i) => competitor(i)));
const wall = (performance.now() - wallStart) / 1000;

console.log('\n' + '='.repeat(72));
console.log(`joined ${metrics.joined}/${PLAYERS} · reached the puzzle ${metrics.started} · finished ${metrics.finished}`);
console.log(`wall clock ${wall.toFixed(0)}s · ${metrics.calls} calls · ${(metrics.calls / wall).toFixed(1)} req/s average`);
console.log(`wrong guesses ${metrics.wrongGuesses} · cooldowns hit ${metrics.cooldownHits}`);
console.log('');
console.log(summarise('all calls', metrics.latencies));
for (const [fn, values] of [...metrics.perCall].sort()) {
  console.log(summarise('  ' + fn, values));
}
console.log('');
console.log(summarise('finish times', metrics.finishTimes, 's'));

if (metrics.errors.size) {
  console.log('\nerrors:');
  for (const [message, count] of [...metrics.errors].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count} x ${message}`);
  }
  process.exitCode = 1;
} else {
  console.log('\nno errors');
}
