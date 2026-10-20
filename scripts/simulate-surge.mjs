/**
 * Surge rehearsal: a large field all signing up in a narrow window, then
 * playing in mixed ways for a fixed period.
 *
 * Where simulate-event.mjs models a well-behaved field, this models the
 * awkward one — everybody hitting "Enter the competition" at once, then a
 * spread of racers, steady solvers, strugglers, idlers and people whose phone
 * drops and reconnects.
 *
 *   node scripts/simulate-surge.mjs --base <url> --key <key> \
 *     --answers answers.json --players 300 --signup-window 10 --play 300
 *
 * Run against a rehearsal event, never a live one.
 */

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const BASE = arg('base', 'http://localhost:8787');
const KEY = arg('key', null);
const PLAYERS = Number(arg('players', 300));
const SIGNUP_WINDOW = Number(arg('signup-window', 10));  // seconds for everyone to join
const PLAY_SECONDS = Number(arg('play', 300));
const COOLDOWN_MS = 3200;

const { readFile } = await import('node:fs/promises');
const ANSWERS = JSON.parse(await readFile(arg('answers', 'answers.json'), 'utf8'));

const headers = { 'Content-Type': 'application/json' };
if (KEY) { headers.apikey = KEY; headers.Authorization = `Bearer ${KEY}`; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const M = {
  calls: 0, latencies: [], perCall: new Map(), errors: new Map(),
  joinLatencies: [], joined: 0, started: 0, finished: 0,
  wrong: 0, cooldowns: 0, finishTimes: [], solvedCounts: [],
  byProfile: new Map(),
};
const err = (k) => M.errors.set(k, (M.errors.get(k) ?? 0) + 1);

async function rpc(fn, body) {
  const t = performance.now();
  try {
    const res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const text = await res.text();
    const ms = performance.now() - t;
    M.latencies.push(ms); M.calls++;
    if (!M.perCall.has(fn)) M.perCall.set(fn, []);
    M.perCall.get(fn).push(ms);
    if (fn === 'join_event') M.joinLatencies.push(ms);
    if (!res.ok) { err(`${fn} ${res.status}: ${text.slice(0, 110)}`); return null; }
    return text ? JSON.parse(text) : null;
  } catch (e) {
    M.latencies.push(performance.now() - t); M.calls++;
    err(`${fn} threw: ${e.message}`);
    return null;
  }
}

/**
 * How a given competitor behaves. Real fields are not uniform: a few race,
 * most plod, some flounder, a few barely engage, and some drop and come back.
 */
function pickProfile() {
  const r = Math.random();
  if (r < 0.15) return { name: 'racer',        think: [1.5, 4],  mistakes: 0.10, solveAll: true,  reconnect: false };
  if (r < 0.55) return { name: 'steady',       think: [6, 14],   mistakes: 0.25, solveAll: true,  reconnect: false };
  if (r < 0.80) return { name: 'struggler',    think: [10, 22],  mistakes: 0.60, solveAll: false, reconnect: false };
  if (r < 0.90) return { name: 'idler',        think: [25, 60],  mistakes: 0.20, solveAll: false, reconnect: false };
  return             { name: 'reconnector',    think: [7, 16],   mistakes: 0.25, solveAll: true,  reconnect: true  };
}

async function competitor(index, deadline) {
  const profile = pickProfile();
  M.byProfile.set(profile.name, (M.byProfile.get(profile.name) ?? 0) + 1);

  // Everyone signs up inside the surge window.
  await sleep(rand(0, SIGNUP_WINDOW * 1000));
  const join = await rpc('join_event', {
    p_employee_id: String(70000000 + index),
    p_display_name: `Surge ${index} (${profile.name})`,
  });
  if (!join?.token) return;
  const token = join.token;
  M.joined++;

  // Wait for the administrator to start.
  while (Date.now() < deadline) {
    const state = await rpc('get_event_state', { p_token: token });
    if (state?.status === 'running') break;
    if (state?.status === 'ended') return;
    await sleep(2000 * rand(0.8, 1.2));
  }
  M.started++;
  const began = performance.now();

  let puzzle = await rpc('get_puzzle', { p_token: token });
  let entries = puzzle?.entries ?? [];
  if (!entries.length) { err('get_puzzle returned no entries'); return; }

  const byClue = new Map(ANSWERS.map((a) => [a.clue, a.answer]));
  const grid = {};
  let solved = 0;
  let reconnected = false;

  for (const entry of entries) {
    if (Date.now() >= deadline) break;

    // A dropped connection partway through: the app refetches state, the
    // grid and the solved list, exactly as a reload does.
    if (profile.reconnect && !reconnected && solved >= 2) {
      reconnected = true;
      await rpc('get_event_state', { p_token: token });
      const again = await rpc('get_puzzle', { p_token: token });
      if (!again?.entries?.length) err('reconnect lost the puzzle');
      else if ((again.solved_entry_ids ?? []).length !== solved) {
        err(`reconnect lost progress: server says ${(again.solved_entry_ids ?? []).length}, expected ${solved}`);
      }
    }

    await sleep(rand(profile.think[0], profile.think[1]) * 1000);
    if (Date.now() >= deadline) break;

    // Idlers and strugglers stop early rather than finishing.
    if (!profile.solveAll && Math.random() < 0.35) break;

    const answer = byClue.get(entry.clue);
    if (!answer) { err(`no answer for "${entry.clue}"`); continue; }

    if (Math.random() < profile.mistakes) {
      const wrong = answer.slice(0, -1) + (answer.at(-1) === 'Z' ? 'Y' : 'Z');
      const r = await rpc('check_answer', { p_token: token, p_entry_id: entry.id, p_guess: wrong });
      if (r?.cooldown) M.cooldowns++; else if (r?.correct === false) M.wrong++;
      await sleep(COOLDOWN_MS);
    }

    let r = await rpc('check_answer', { p_token: token, p_entry_id: entry.id, p_guess: answer });
    if (r?.cooldown) {
      M.cooldowns++;
      await sleep((r.retry_after_ms ?? 3000) + 200);
      r = await rpc('check_answer', { p_token: token, p_entry_id: entry.id, p_guess: answer });
    }
    if (r?.correct !== true) {
      err(`correct answer rejected for "${entry.clue}": ${JSON.stringify(r)}`);
      continue;
    }
    solved++;

    grid[`${solved},${index % 11}`] = answer[0];
    await rpc('save_progress', { p_token: token, p_grid_state: grid });

    if (r.finished) {
      M.finished++;
      M.finishTimes.push((performance.now() - began) / 1000);
      break;
    }
  }
  M.solvedCounts.push(solved);
}

const pct = (s, p) => s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0;
const stat = (label, v, unit = 'ms') => {
  if (!v.length) return `${label.padEnd(22)} (none)`;
  const s = v.slice().sort((a, b) => a - b);
  const f = (n) => unit === 's' ? n.toFixed(1) : n.toFixed(0);
  return `${label.padEnd(22)} n=${String(s.length).padStart(5)}  p50=${f(pct(s, 0.5))}  p95=${f(pct(s, 0.95))}  max=${f(s.at(-1))} ${unit}`;
};

log(`Surge: ${PLAYERS} competitors signing up within ${SIGNUP_WINDOW}s, then ${PLAY_SECONDS}s of play`);
const t0 = performance.now();
const deadline = Date.now() + (SIGNUP_WINDOW + 30 + PLAY_SECONDS) * 1000;
await Promise.all(Array.from({ length: PLAYERS }, (_, i) => competitor(i, deadline)));
const wall = (performance.now() - t0) / 1000;

console.log('\n' + '='.repeat(74));
console.log(`joined ${M.joined}/${PLAYERS} · reached the puzzle ${M.started} · finished all clues ${M.finished}`);
console.log(`wall ${wall.toFixed(0)}s · ${M.calls} calls · ${(M.calls / wall).toFixed(1)} req/s`);
console.log(`wrong guesses ${M.wrong} · cooldowns hit ${M.cooldowns}`);
console.log(`behaviour mix: ${[...M.byProfile].map(([k, v]) => `${k} ${v}`).join(' · ')}`);
console.log('');
console.log(stat('signup burst', M.joinLatencies));
console.log(stat('all calls', M.latencies));
for (const [fn, v] of [...M.perCall].sort()) console.log(stat('  ' + fn, v));
console.log('');
console.log(stat('finish times', M.finishTimes, 's'));
const sc = M.solvedCounts.slice().sort((a, b) => a - b);
console.log(`clues solved per person   min=${sc[0] ?? 0}  p50=${pct(sc, 0.5)}  max=${sc.at(-1) ?? 0}`);

if (M.errors.size) {
  console.log('\nerrors:');
  for (const [m, c] of [...M.errors].sort((a, b) => b[1] - a[1])) console.log(`  ${c} x ${m}`);
  process.exitCode = 1;
} else {
  console.log('\nno errors');
}
