/**
 * Load test: simulates a full field of competitors against a running instance.
 *
 * It drives the real RPC endpoints the browsers use — join, poll, check, save —
 * at roughly the rate a real competitor generates, and reports latency
 * percentiles and any errors.
 *
 *   node scripts/loadtest.mjs --base http://localhost:8787 --players 150
 *   node scripts/loadtest.mjs --base https://<project>.supabase.co --key <anon key>
 *
 * Against Supabase, pass the publishable key with --key. Run it against a
 * draft or rehearsal event, never a live one: it creates 150 competitors.
 */

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const BASE = arg('base', 'http://localhost:8787');
const KEY = arg('key', null);
const PLAYERS = Number(arg('players', 150));
const SECONDS = Number(arg('seconds', 60));

const headers = { 'Content-Type': 'application/json' };
if (KEY) { headers.apikey = KEY; headers.Authorization = `Bearer ${KEY}`; }

const latencies = [];
const errors = new Map();
let calls = 0;

async function rpc(name, body) {
  const started = performance.now();
  try {
    const res = await fetch(`${BASE}/rest/v1/rpc/${name}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const text = await res.text();
    latencies.push(performance.now() - started);
    calls++;
    if (!res.ok) {
      const key = `${name} ${res.status}: ${text.slice(0, 120)}`;
      errors.set(key, (errors.get(key) ?? 0) + 1);
      return null;
    }
    return text ? JSON.parse(text) : null;
  } catch (error) {
    latencies.push(performance.now() - started);
    calls++;
    const key = `${name} threw: ${error.message}`;
    errors.set(key, (errors.get(key) ?? 0) + 1);
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.75 + Math.random() * 0.5);

/** One competitor's session, at roughly human pace. */
async function player(index, until) {
  const employeeId = String(90000000 + index);
  const join = await rpc('join_event', {
    p_employee_id: employeeId,
    p_display_name: `Load Test ${index}`,
  });
  if (!join?.token) return;

  const token = join.token;
  const puzzle = await rpc('get_puzzle', { p_token: token });
  const entries = puzzle?.entries ?? [];
  const grid = {};

  while (Date.now() < until) {
    await rpc('get_event_state', { p_token: token });
    await sleep(jitter(1500));

    // A wrong guess on a random clue: the most expensive call, so bias
    // towards it rather than flattering the numbers.
    if (entries.length) {
      const entry = entries[Math.floor(Math.random() * entries.length)];
      await rpc('check_answer', {
        p_token: token, p_entry_id: entry.id,
        p_guess: 'Z'.repeat(entry.length),
      });
    }
    await sleep(jitter(1500));

    grid[`${Math.floor(Math.random() * 20)},${Math.floor(Math.random() * 20)}`] = 'A';
    await rpc('save_progress', { p_token: token, p_grid_state: grid });
    await sleep(jitter(3000));
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

const started = Date.now();
const until = started + SECONDS * 1000;

console.log(`Load test: ${PLAYERS} competitors against ${BASE} for ${SECONDS}s`);
await Promise.all(
  Array.from({ length: PLAYERS }, (_, i) =>
    sleep(Math.random() * 3000).then(() => player(i, until))),
);

const elapsed = (Date.now() - started) / 1000;
const sorted = latencies.slice().sort((a, b) => a - b);

console.log('');
console.log(`calls        ${calls}`);
console.log(`throughput   ${(calls / elapsed).toFixed(1)} req/s`);
console.log(`latency p50  ${percentile(sorted, 0.50).toFixed(0)} ms`);
console.log(`latency p95  ${percentile(sorted, 0.95).toFixed(0)} ms`);
console.log(`latency p99  ${percentile(sorted, 0.99).toFixed(0)} ms`);
console.log(`slowest      ${(sorted.at(-1) ?? 0).toFixed(0)} ms`);

if (errors.size) {
  console.log('\nerrors:');
  for (const [message, count] of [...errors].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count} x ${message}`);
  }
  process.exitCode = 1;
} else {
  console.log('\nno errors');
}
