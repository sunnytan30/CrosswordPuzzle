/**
 * Local development server.
 *
 * Serves web/ and implements the same RPC surface as the Supabase project, in
 * memory. It exists so the competitor and admin apps can be driven end to end
 * without touching the real database — useful for development, for the
 * browser tests, and for trying the UI offline.
 *
 * It mirrors the rules in supabase/migrations/, but the database remains the
 * authority. If the two ever disagree, the database is right.
 *
 *   node dev/server.mjs [--port 8787] [--seed]
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { generatePuzzle } from '../web/js/generator.js';

const ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 8787;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const SAMPLE = [
  ['Protective measure against loss', 'INSURANCE'],
  ['Keeping information private', 'CONFIDENTIAL'],
  ['A written set of rules', 'POLICY'],
  ['Chance of something going wrong', 'RISK'],
  ['Checked for accuracy', 'AUDIT'],
  ['Follows the rules', 'COMPLIANCE'],
  ['Person who buys a service', 'CUSTOMER'],
  ['Group working together', 'TEAM'],
  ['Money set aside for a purpose', 'BUDGET'],
  ['Formal meeting of shareholders', 'GENERAL'],
  ['Secure code for access', 'PASSWORD'],
  ['Unwanted electronic mail', 'SPAM'],
  ['Copy kept for safety', 'BACKUP'],
  ['To train or teach', 'COACH'],
  ['Yearly', 'ANNUAL'],
  ['Statement of money owed', 'INVOICE'],
  ['Opposite of profit', 'LOSS'],
  ['Person in charge', 'MANAGER'],
  ['A planned approach', 'STRATEGY'],
  ['Honest and open', 'TRANSPARENT'],
].map(([clue, answer]) => ({ clue, answer }));

// ------------------------------------------------------------ in-memory db --

const db = {
  event: null,           // { id, name, status, duration_seconds, started_at, ends_at }
  puzzle: null,          // generator output plus entry ids
  participants: new Map(), // id -> participant
  byToken: new Map(),      // token hash -> participant id
  byEmployee: new Map(),   // employee id -> participant id
  adminEmail: 'admin@example.com',
  adminPassword: 'crossword',
  adminToken: null,
};

const hash = (t) => createHash('sha256').update(t).digest('hex');
const uuid = () => randomBytes(16).toString('hex').replace(
  /^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

function effectiveStatus(event) {
  if (!event) return 'none';
  if (event.status === 'running' && event.ends_at && Date.now() >= event.ends_at) return 'ended';
  return event.status;
}

function entryCount() {
  return db.puzzle ? db.puzzle.entries.length : 0;
}

function setPuzzle(puzzle) {
  db.puzzle = {
    ...puzzle,
    entries: puzzle.entries.map((e) => ({ ...e, id: uuid() })),
  };
}

function seed({ start = false } = {}) {
  // A fresh event means a fresh field. Without this, a competitor from the
  // previous event still holds their employee ID and the next join is refused.
  db.participants.clear();
  db.byToken.clear();
  db.byEmployee.clear();

  const puzzle = generatePuzzle(SAMPLE, { seed: 42 });
  db.event = {
    id: uuid(),
    name: 'Dev Competition',
    status: 'open',
    duration_seconds: 1800,
    started_at: null,
    ends_at: null,
  };
  setPuzzle(puzzle);
  db.event.clue_draft = null;
  db.event.clue_draft_updated_at = null;
  if (start) {
    db.event.status = 'running';
    db.event.started_at = Date.now();
    db.event.ends_at = Date.now() + db.event.duration_seconds * 1000;
  }
  return db.event;
}

// ------------------------------------------------------------------- rpc ----

class RpcError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function participantFor(token) {
  const id = db.byToken.get(hash(token ?? ''));
  const p = id ? db.participants.get(id) : null;
  if (!p) throw new RpcError('Your session has expired. Please join again.', 403);
  return p;
}

function requireAdmin(auth) {
  if (!db.adminToken || auth !== `Bearer ${db.adminToken}`) {
    throw new RpcError('Administrator access required.', 403);
  }
}

const rpcs = {
  join_event({ p_employee_id, p_display_name }) {
    const name = String(p_display_name ?? '').trim().replace(/\s+/g, ' ');
    if (!/^\d{8}$/.test(String(p_employee_id ?? ''))) {
      throw new RpcError('Your employee ID must be exactly 8 digits.');
    }
    if (name.length < 2 || name.length > 60) {
      throw new RpcError('Please enter your name (2 to 60 characters).');
    }
    const status = effectiveStatus(db.event);
    if (status !== 'open' && status !== 'running') {
      throw new RpcError('No competition is open at the moment. Please wait for the administrator.');
    }

    const token = randomBytes(32).toString('hex');
    const existingId = db.byEmployee.get(p_employee_id);

    if (existingId) {
      const existing = db.participants.get(existingId);
      if (!existing.released_at) {
        throw new RpcError(
          `Employee ID ${p_employee_id} is already in this competition on another device. Ask the administrator to release it.`);
      }
      db.byToken.delete(existing.token_hash);
      existing.token_hash = hash(token);
      existing.display_name = name;
      existing.released_at = null;
      db.byToken.set(existing.token_hash, existing.id);
      return { token, participant_id: existing.id, display_name: name,
               event: { id: db.event.id, name: db.event.name, status } };
    }

    const p = {
      id: uuid(), employee_id: p_employee_id, display_name: name,
      token_hash: hash(token), joined_at: Date.now(), last_seen_at: Date.now(),
      solved: new Set(), wrong_guesses: 0, finished_at: null, released_at: null,
      grid_state: {}, attempts: new Map(),
    };
    db.participants.set(p.id, p);
    db.byToken.set(p.token_hash, p.id);
    db.byEmployee.set(p_employee_id, p.id);
    return { token, participant_id: p.id, display_name: name,
             event: { id: db.event.id, name: db.event.name, status } };
  },

  get_open_event() {
    const status = effectiveStatus(db.event);
    if (status !== 'open' && status !== 'running') {
      return { name: null, status: 'none' };
    }
    return { name: db.event.name, status };
  },

  get_event_state({ p_token }) {
    const p = participantFor(p_token);
    p.last_seen_at = Date.now();
    return {
      status: effectiveStatus(db.event),
      event_name: db.event?.name ?? '',
      server_time: new Date().toISOString(),
      started_at: db.event?.started_at ? new Date(db.event.started_at).toISOString() : null,
      ends_at: db.event?.ends_at ? new Date(db.event.ends_at).toISOString() : null,
      duration_seconds: db.event?.duration_seconds ?? 0,
      display_name: p.display_name,
      solved_count: p.solved.size,
      total_entries: entryCount(),
      finished_at: p.finished_at ? new Date(p.finished_at).toISOString() : null,
    };
  },

  get_puzzle({ p_token }) {
    const p = participantFor(p_token);
    const status = effectiveStatus(db.event);
    if (status !== 'running' && status !== 'ended') {
      throw new RpcError('The competition has not started yet.');
    }
    if (!db.puzzle) throw new RpcError('No puzzle has been set for this competition.');

    return {
      width: db.puzzle.width,
      height: db.puzzle.height,
      cells: db.puzzle.cells,
      // Note the omission of `answer`, exactly as get_puzzle does in Postgres.
      entries: db.puzzle.entries.map((e) => ({
        id: e.id, number: e.number, direction: e.direction,
        row: e.row, col: e.col, length: e.length, clue: e.clue,
      })),
      solved_entry_ids: [...p.solved],
      grid_state: p.grid_state,
    };
  },

  check_answer({ p_token, p_entry_id, p_guess }) {
    const p = participantFor(p_token);
    if (effectiveStatus(db.event) !== 'running') {
      throw new RpcError('The competition is not running.');
    }
    const entry = db.puzzle.entries.find((e) => e.id === p_entry_id);
    if (!entry) throw new RpcError('Unknown clue.');

    if (p.solved.has(entry.id)) {
      return { correct: true, already_solved: true, solved_count: p.solved.size,
               total_entries: entryCount(), finished: p.finished_at != null };
    }

    const last = p.attempts.get(entry.id) ?? 0;
    if (Date.now() - last < 3000) {
      return { correct: false, cooldown: true, retry_after_ms: 3000 - (Date.now() - last) };
    }
    p.attempts.set(entry.id, Date.now());

    const guess = String(p_guess ?? '').toUpperCase().replace(/[^A-Z]/g, '');
    if (guess !== entry.answer) {
      p.wrong_guesses++;
      return { correct: false, solved_count: p.solved.size, total_entries: entryCount() };
    }

    p.solved.add(entry.id);
    if (p.solved.size >= entryCount() && !p.finished_at) p.finished_at = Date.now();
    return {
      correct: true, solved_count: p.solved.size, total_entries: entryCount(),
      finished: p.finished_at != null,
      finished_at: p.finished_at ? new Date(p.finished_at).toISOString() : null,
    };
  },

  save_progress({ p_token, p_grid_state }) {
    const p = participantFor(p_token);
    if (!p_grid_state || typeof p_grid_state !== 'object') throw new RpcError('Invalid progress payload.');
    p.grid_state = p_grid_state;
    return { ok: true };
  },

  admin_whoami(_body, auth) {
    return { is_admin: db.adminToken != null && auth === `Bearer ${db.adminToken}`, user_id: 'dev-admin' };
  },

  admin_list_events(_body, auth) {
    requireAdmin(auth);
    if (!db.event) return [];
    return [{
      id: db.event.id, name: db.event.name, status: effectiveStatus(db.event),
      raw_status: db.event.status, duration_seconds: db.event.duration_seconds,
      started_at: db.event.started_at ? new Date(db.event.started_at).toISOString() : null,
      ends_at: db.event.ends_at ? new Date(db.event.ends_at).toISOString() : null,
      created_at: new Date().toISOString(),
      entry_count: entryCount(), participant_count: db.participants.size,
    }];
  },

  admin_create_event({ p_name, p_duration_seconds }, auth) {
    requireAdmin(auth);
    db.event = { id: uuid(), name: p_name, status: 'draft',
                 duration_seconds: p_duration_seconds, started_at: null, ends_at: null };
    db.puzzle = null;
    return { id: db.event.id };
  },

  admin_set_puzzle({ p_puzzle }, auth) {
    requireAdmin(auth);
    if (db.event.status !== 'draft') {
      throw new RpcError('The puzzle can only be set while the competition is still a draft.');
    }
    setPuzzle(p_puzzle);
    return { puzzle_id: uuid(), entry_count: entryCount() };
  },

  admin_save_draft({ p_rows }, auth) {
    requireAdmin(auth);
    if (!Array.isArray(p_rows)) throw new RpcError('Invalid draft payload.');
    db.event.clue_draft = p_rows;
    db.event.clue_draft_updated_at = new Date().toISOString();
    return { ok: true, rows: p_rows.length, saved_at: db.event.clue_draft_updated_at };
  },

  admin_get_draft(_body, auth) {
    requireAdmin(auth);
    if (db.event?.clue_draft?.length) {
      return { rows: db.event.clue_draft, source: 'draft',
               saved_at: db.event.clue_draft_updated_at };
    }
    if (db.puzzle?.entries?.length) {
      return {
        rows: db.puzzle.entries.map((e) => ({ clue: e.clue, answer: e.answer })),
        source: 'puzzle', saved_at: null,
      };
    }
    return { rows: [], source: 'none', saved_at: null };
  },

  admin_set_event_title({ p_title }, auth) {
    requireAdmin(auth);
    const title = String(p_title ?? '').trim().replace(/\s+/g, ' ');
    if (title.length < 1 || title.length > 120) {
      throw new RpcError('The title must be between 1 and 120 characters.');
    }
    db.event.name = title;
    return { name: title };
  },

  admin_open_event(_body, auth) {
    requireAdmin(auth);
    if (db.event.status !== 'draft') throw new RpcError('Only a draft competition can be opened.');
    if (!entryCount()) throw new RpcError('Set the puzzle before opening the competition.');
    db.event.status = 'open';
    return { status: 'open' };
  },

  admin_start_event(_body, auth) {
    requireAdmin(auth);
    if (db.event.status !== 'open') {
      throw new RpcError('Open the competition for joining before starting it.');
    }
    db.event.status = 'running';
    db.event.started_at = Date.now();
    db.event.ends_at = Date.now() + db.event.duration_seconds * 1000;
    return { status: 'running',
             started_at: new Date(db.event.started_at).toISOString(),
             ends_at: new Date(db.event.ends_at).toISOString() };
  },

  admin_end_event(_body, auth) {
    requireAdmin(auth);
    db.event.status = 'ended';
    db.event.ends_at = Date.now();
    return { status: 'ended' };
  },

  admin_leaderboard(_body, auth) {
    requireAdmin(auth);
    const rows = [...db.participants.values()].sort((a, b) => {
      const af = a.finished_at == null, bf = b.finished_at == null;
      if (af !== bf) return af ? 1 : -1;
      if (a.finished_at !== b.finished_at) return (a.finished_at ?? 0) - (b.finished_at ?? 0);
      if (a.solved.size !== b.solved.size) return b.solved.size - a.solved.size;
      if (a.wrong_guesses !== b.wrong_guesses) return a.wrong_guesses - b.wrong_guesses;
      return a.joined_at - b.joined_at;
    });
    return rows.map((p, i) => ({
      rank: i + 1, id: p.id, employee_id: p.employee_id, display_name: p.display_name,
      solved_count: p.solved.size, total_entries: entryCount(),
      wrong_guesses: p.wrong_guesses,
      joined_at: new Date(p.joined_at).toISOString(),
      finished_at: p.finished_at ? new Date(p.finished_at).toISOString() : null,
      last_seen_at: new Date(p.last_seen_at).toISOString(),
      released: p.released_at != null,
      finish_seconds: p.finished_at && db.event.started_at
        ? Math.round((p.finished_at - db.event.started_at) / 100) / 10 : null,
    }));
  },

  admin_release_participant({ p_participant_id }, auth) {
    requireAdmin(auth);
    const p = db.participants.get(p_participant_id);
    if (!p) throw new RpcError('Unknown competitor.');
    p.released_at = Date.now();
    return { ok: true };
  },

  admin_reset_event({ p_confirm }, auth) {
    requireAdmin(auth);
    if (p_confirm !== 'RESET') throw new RpcError('Reset requires explicit confirmation.');
    const removed = db.participants.size;
    db.participants.clear(); db.byToken.clear(); db.byEmployee.clear();
    db.event.status = 'draft';
    db.event.started_at = null;
    db.event.ends_at = null;
    return { ok: true, participants_removed: removed };
  },
};

// ---------------------------------------------------------------- server ----

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'apikey, authorization, content-type',
  });
  // Buffers are file contents and must go out as bytes; anything else that is
  // not already a string is a JSON response body.
  if (typeof body === 'string' || Buffer.isBuffer(body)) res.end(body);
  else res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') return send(res, 204, '');

  // Test-only hooks, so the browser tests can drive event state directly.
  if (url.pathname === '/__dev/seed') {
    const event = seed({ start: url.searchParams.get('start') === '1' });
    return send(res, 200, { ok: true, event: { ...event, entries: entryCount() } });
  }
  if (url.pathname === '/__dev/blank') {
    // A draft competition with no puzzle and no clue draft: what an
    // administrator sees the very first time.
    db.participants.clear(); db.byToken.clear(); db.byEmployee.clear();
    db.event = { id: uuid(), name: 'Blank Competition', status: 'draft',
                 duration_seconds: 1800, started_at: null, ends_at: null,
                 clue_draft: null, clue_draft_updated_at: null };
    db.puzzle = null;
    return send(res, 200, { ok: true, event: db.event });
  }
  if (url.pathname === '/__dev/draft') {
    const rows = await readBody(req);
    db.event.clue_draft = rows;
    db.event.clue_draft_updated_at = new Date().toISOString();
    return send(res, 200, { ok: true, rows: rows.length });
  }
  if (url.pathname === '/__dev/answers') {
    return send(res, 200, db.puzzle.entries.map((e) => ({ id: e.id, answer: e.answer })));
  }
  if (url.pathname === '/__dev/start') {
    db.event.status = 'running';
    db.event.started_at = Date.now();
    db.event.ends_at = Date.now() + (Number(url.searchParams.get('seconds')) || 1800) * 1000;
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/auth/v1/token') {
    const body = await readBody(req);
    if (body.email !== db.adminEmail || body.password !== db.adminPassword) {
      return send(res, 400, { error_description: 'Invalid login credentials' });
    }
    db.adminToken = randomBytes(24).toString('hex');
    return send(res, 200, {
      access_token: db.adminToken, refresh_token: 'dev', token_type: 'bearer',
      expires_in: 3600, user: { id: 'dev-admin', email: db.adminEmail },
    });
  }

  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const name = url.pathname.slice('/rest/v1/rpc/'.length);
    const fn = rpcs[name];
    if (!fn) return send(res, 404, { message: `Unknown function ${name}` });
    try {
      const body = await readBody(req);
      return send(res, 200, fn(body, req.headers.authorization));
    } catch (error) {
      if (error instanceof RpcError) return send(res, error.status, { message: error.message });
      return send(res, 500, { message: error.message });
    }
  }

  // Static files.
  let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  if (pathname.endsWith('/')) pathname += 'index.html';
  const filePath = join(ROOT, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  try {
    const data = await readFile(filePath);
    return send(res, 200, data, TYPES[extname(filePath)] ?? 'application/octet-stream');
  } catch {
    return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
});

if (args.includes('--seed')) seed({ start: args.includes('--start') });

server.listen(PORT, () => {
  console.log(`Crossword dev server on http://localhost:${PORT}`);
  console.log(`  competitor  http://localhost:${PORT}/`);
  console.log(`  admin       http://localhost:${PORT}/admin/  (${db.adminEmail} / ${db.adminPassword})`);
});
