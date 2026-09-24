/**
 * Administrator console: build the puzzle, run the event, read the results.
 *
 * The grid is generated here in the browser using the same generator module
 * the tests exercise, previewed, and only then saved to the database. Nothing
 * about the outcome is decided here — the server owns the clock, the answer
 * checking and the ranking.
 */

import { admin, signIn, ApiError } from './api.js';
import { generatePuzzle, normaliseAnswer } from './generator.js';

const TOKEN_KEY = 'crossword.admin.token';
const DRAFT_KEY = 'crossword.admin.draft';
const TARGET_CLUES = 20;
const BOARD_POLL_MS = 4000;

const $ = (id) => document.getElementById(id);

const state = {
  token: null,
  event: null,
  puzzle: null,   // generator output awaiting save
  seed: 1,
  rows: [],       // [{ clue, answer }]
  boardTimer: null,
  board: [],
  // Which row the administrator last typed in, so "Delete Row" acts on the
  // row they are looking at rather than always the last one.
  focusedRow: null,
  // True once the current preview has been saved, so "Use Grid" can grey out
  // until a fresh grid is generated.
  puzzleSaved: false,
};

// ----------------------------------------------------------------- helpers --

function safeRead(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeWrite(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
function safeRemove(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }

function show(id) {
  for (const s of document.querySelectorAll('body > section')) {
    s.classList.toggle('hidden', s.id !== id);
  }
}

function setError(id, message) {
  const el = $(id);
  if (!message) { el.classList.add('hidden'); return; }
  el.textContent = message;
  el.classList.remove('hidden');
}

function note(message) {
  const el = $('console-note');
  if (!message) { el.classList.add('hidden'); return; }
  el.textContent = message;
  el.classList.remove('hidden');
}

async function guard(fn, errorElement = 'console-error') {
  setError(errorElement, '');
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiError && error.isSessionExpired) return signOut('Your session expired. Please sign in again.');
    setError(errorElement, error.message);
    return null;
  }
}

function formatSeconds(value) {
  if (value == null) return '—';
  const total = Number(value);
  const m = Math.floor(total / 60);
  const s = (total % 60).toFixed(1);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// -------------------------------------------------------------- sign in ----

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  setError('login-error', '');
  const button = $('login-submit');
  button.disabled = true;

  try {
    const session = await signIn($('email').value.trim(), $('password').value);
    state.token = session.access_token;
    safeWrite(TOKEN_KEY, state.token);

    const who = await admin.whoami(state.token);
    if (!who?.is_admin) {
      safeRemove(TOKEN_KEY);
      state.token = null;
      setError('login-error',
        'That account is signed in but is not an administrator. Add its user id to app.admins.');
      return;
    }
    await enterConsole();
  } catch (error) {
    setError('login-error', error.message);
  } finally {
    button.disabled = false;
  }
});

function signOut(message) {
  clearInterval(state.boardTimer);
  state.boardTimer = null;
  state.token = null;
  safeRemove(TOKEN_KEY);
  show('view-login');
  if (message) setError('login-error', message);
}

$('sign-out').addEventListener('click', () => signOut());

// -------------------------------------------------------------- console ----

async function enterConsole() {
  show('view-console');
  loadDraft();
  renderClueSection();
  await refreshEvent();
  startBoardPolling();
}

async function refreshEvent() {
  const events = await guard(() => admin.events(state.token));
  if (!events) return;

  // The database permits only one open or running competition, so work with
  // the most recent one that is not finished, else the newest overall.
  state.event = events.find((e) => e.status !== 'ended') ?? events[0] ?? null;
  renderEvent();
  await refreshBoard();
}

function renderEvent() {
  const summary = $('event-summary');
  const createForm = $('create-form');

  if (!state.event) {
    summary.innerHTML = '<p class="muted">No competition yet. Create one to begin.</p>';
    createForm.classList.remove('hidden');
  } else {
    const e = state.event;
    summary.innerHTML = '';

    const title = document.createElement('p');
    title.innerHTML = `<strong></strong> <span class="pill"></span>`;
    title.querySelector('strong').textContent = e.name;
    const pill = title.querySelector('.pill');
    pill.textContent = e.status;
    pill.classList.add(e.status);
    summary.appendChild(title);

    const detail = document.createElement('p');
    detail.className = 'small muted';
    detail.textContent =
      `${Math.round(e.duration_seconds / 60)} minute limit · ${e.entry_count} clues · `
      + `${e.participant_count} competitor${e.participant_count === 1 ? '' : 's'}`
      + (e.ends_at ? ` · ends ${new Date(e.ends_at).toLocaleTimeString('en-GB')}` : '');
    summary.appendChild(detail);

    createForm.classList.toggle('hidden', e.status !== 'ended');
  }

  // The title editor only makes sense once a competition exists.
  $('title-editor').classList.toggle('hidden', !state.event);
  if (state.event && document.activeElement !== $('event-title')) {
    $('event-title').value = state.event.name;
  }

  const status = state.event?.status;
  $('open-event').disabled = status !== 'draft';
  $('start-event').disabled = status !== 'open';
  $('end-event').disabled = !(status === 'open' || status === 'running');
  // Greyed out once this grid is the competition's puzzle; Generate brings
  // it back, so there is no way to save the same grid twice by accident.
  $('save-puzzle').disabled = status !== 'draft' || state.puzzleSaved;
  $('save-puzzle').textContent = state.puzzleSaved ? 'Grid in use' : 'Use Grid';
  // Say why it is greyed out, since there are two different reasons.
  $('save-puzzle').title = state.puzzleSaved
    ? 'This grid is already the competition\u2019s puzzle. Press Generate for a different one.'
    : status !== 'draft'
      ? 'The puzzle can only be changed while the competition is a draft.'
      : 'Make this grid the competition\u2019s puzzle.';
  $('reset-event').disabled = !state.event;

  $('run-state').textContent = !state.event
    ? 'Create a competition first.'
    : {
        draft: 'Draft. Save a grid, then open it so competitors can join the waiting room.',
        open: 'Open. Competitors can join and are waiting. Press Start when you are ready.',
        running: 'Running. The clock is going.',
        ended: 'Ended. Results below are final.',
      }[status] ?? '';
}

$('save-title').addEventListener('click', async () => {
  if (!state.event) return;
  const title = $('event-title').value.trim();
  const result = await guard(() => admin.setTitle(state.token, state.event.id, title));
  if (result) {
    note(`Competitors will now see "${result.name}".`);
    await refreshEvent();
  }
});

$('create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const minutes = Number($('event-minutes').value);
  const result = await guard(() =>
    admin.create(state.token, $('event-name').value.trim(), Math.round(minutes * 60)));
  if (result) {
    note('Competition created. Now enter your clues and generate a grid.');
    await refreshEvent();
  }
});

// -------------------------------------------------------- clues and grid ----

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
];

function loadDraft() {
  const saved = safeRead(DRAFT_KEY);
  if (saved) {
    try {
      const rows = JSON.parse(saved);
      if (Array.isArray(rows) && rows.length) { state.rows = rows; return; }
    } catch { /* fall through */ }
  }
  // No draft yet: ask how many clues rather than guessing.
  state.rows = [];
}

/** Show either the "how many clues?" setup or the table, never both. */
function renderClueSection() {
  const empty = state.rows.length === 0;
  $('row-setup').classList.toggle('hidden', !empty);
  $('clue-editor').classList.toggle('hidden', empty);
  if (!empty) renderRows();
}

function saveDraft() {
  safeWrite(DRAFT_KEY, JSON.stringify(state.rows));
}

function renderRows() {
  const tbody = $('clue-rows');
  tbody.innerHTML = '';

  state.rows.forEach((row, index) => {
    const tr = document.createElement('tr');

    const num = document.createElement('td');
    num.textContent = String(index + 1);
    tr.appendChild(num);

    const clueCell = document.createElement('td');
    const clueInput = document.createElement('input');
    clueInput.type = 'text';
    clueInput.maxLength = 300;
    clueInput.value = row.clue;
    clueInput.placeholder = 'Clue';
    clueInput.addEventListener('input', () => { row.clue = clueInput.value; saveDraft(); });
    clueCell.appendChild(clueInput);
    tr.appendChild(clueCell);

    const answerCell = document.createElement('td');
    const answerInput = document.createElement('input');
    answerInput.type = 'text';
    answerInput.maxLength = 15;
    answerInput.value = row.answer;
    answerInput.placeholder = 'ANSWER';
    answerInput.style.textTransform = 'uppercase';
    answerInput.addEventListener('input', () => {
      row.answer = answerInput.value.toUpperCase();
      answerInput.value = row.answer;
      saveDraft();
    });
    answerCell.appendChild(answerInput);
    tr.appendChild(answerCell);

    const deleteCell = document.createElement('td');
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'secondary';
    deleteButton.textContent = '\u00D7';
    deleteButton.title = `Delete row ${index + 1}`;
    deleteButton.setAttribute('aria-label', `Delete row ${index + 1}`);
    deleteButton.style.minHeight = '34px';
    deleteButton.style.padding = '2px 10px';
    deleteButton.addEventListener('click', () => deleteRow(index));
    deleteCell.appendChild(deleteButton);
    tr.appendChild(deleteCell);

    // Remember where the administrator is working, so the toolbar's
    // "Delete Row" removes the row they are actually looking at.
    for (const input of [clueInput, answerInput]) {
      input.addEventListener('focus', () => {
        state.focusedRow = index;
        highlightFocusedRow();
      });
    }

    tbody.appendChild(tr);
  });
  highlightFocusedRow();
}

function highlightFocusedRow() {
  const rows = $('clue-rows').querySelectorAll('tr');
  rows.forEach((tr, i) => tr.classList.toggle('row-focused', i === state.focusedRow));
}

/** Delete one row, always confirming and always naming what is being lost. */
function deleteRow(index) {
  const row = state.rows[index];
  if (!row) return;

  const described = row.clue.trim() || row.answer.trim()
    ? `\n\n  ${row.clue.trim() || '(no clue)'} \u2014 ${row.answer.trim() || '(no answer)'}`
    : ' (it is empty)';

  if (!confirm(`Delete row ${index + 1}?${described}`)) return;

  state.rows.splice(index, 1);
  if (state.focusedRow != null) {
    if (state.focusedRow === index) state.focusedRow = null;
    else if (state.focusedRow > index) state.focusedRow -= 1;
  }
  saveDraft();
  renderClueSection();
}

$('add-row').addEventListener('click', () => {
  state.rows.push({ clue: '', answer: '' });
  state.focusedRow = state.rows.length - 1;
  saveDraft();
  renderClueSection();
  // Put the cursor straight into the row that was just added.
  $('clue-rows').querySelector('tr:last-child input')?.focus();
});

$('delete-row').addEventListener('click', () => {
  if (!state.rows.length) return;
  // The row they were last typing in, or the last row if they have not
  // touched one yet.
  const index = state.focusedRow ?? state.rows.length - 1;
  deleteRow(Math.min(index, state.rows.length - 1));
});

function loadSample() {
  state.rows = SAMPLE.map(([clue, answer]) => ({ clue, answer }));
  state.focusedRow = null;
  saveDraft();
  renderClueSection();
  note('Sample clues loaded. Replace them with your own before the event.');
}

$('load-sample').addEventListener('click', loadSample);
$('setup-sample').addEventListener('click', loadSample);

$('create-rows').addEventListener('click', () => {
  const count = Number($('row-count').value);
  if (!Number.isInteger(count) || count < 1 || count > 60) {
    setError('console-error', 'Enter a number of clues between 1 and 60.');
    return;
  }
  setError('console-error', '');
  state.rows = Array.from({ length: count }, () => ({ clue: '', answer: '' }));
  state.focusedRow = 0;
  saveDraft();
  renderClueSection();
  $('clue-rows').querySelector('input')?.focus();
});

/** Validate the admin's input and say exactly which row is wrong. */
function collectEntries() {
  const filled = state.rows
    .map((row, index) => ({ ...row, index }))
    .filter((row) => row.clue.trim() || row.answer.trim());

  if (!filled.length) throw new Error('Enter at least one clue and answer.');

  const seen = new Map();
  return filled.map((row) => {
    if (!row.clue.trim()) throw new Error(`Row ${row.index + 1}: the clue is empty.`);
    const { answer, error } = normaliseAnswer(row.answer);
    if (error) throw new Error(`Row ${row.index + 1}: ${error}`);
    if (seen.has(answer)) {
      throw new Error(`Row ${row.index + 1}: "${answer}" is already used in row ${seen.get(answer) + 1}.`);
    }
    seen.set(answer, row.index);
    return { clue: row.clue.trim(), answer };
  });
}

function buildPreview(newSeed = false) {
  setError('generate-error', '');
  let entries;
  try {
    entries = collectEntries();
  } catch (error) {
    setError('generate-error', error.message);
    return;
  }

  if (newSeed) state.seed = Math.floor(Math.random() * 1_000_000) + 1;

  // A freshly generated grid has not been used yet, so "Use Grid" comes back.
  state.puzzleSaved = false;

  try {
    state.puzzle = generatePuzzle(entries, { seed: state.seed });
  } catch (error) {
    setError('generate-error', error.message);
    return;
  }

  renderPreview();
  renderEvent();
}

function renderPreview() {
  const p = state.puzzle;
  $('preview').classList.remove('hidden');

  $('preview-stats').textContent =
    `${p.entries.length} of ${p.entries.length + p.unplaced.length} placed · `
    + `${p.width} × ${p.height} grid · ${p.intersections} crossings`;

  // A clue that contains one of the puzzle's own answers hands it out for
  // free. Easy to do by accident ("Protective measure against loss" gives away
  // LOSS), and invisible until someone notices mid-competition.
  const giveaways = [];
  for (const entry of p.entries) {
    for (const other of p.entries) {
      if (new RegExp(`\\b${other.answer}\\b`, 'i').test(entry.clue)) {
        giveaways.push(entry.number + ' ' + entry.direction
          + ' ("' + entry.clue + '") contains the answer to '
          + other.number + ' ' + other.direction + ': ' + other.answer);
      }
    }
  }

  const warnings = $('clue-warnings');
  if (giveaways.length) {
    warnings.textContent = 'These clues give an answer away — '
      + giveaways.join('; ') + '. The puzzle still works, but consider rewording.';
    warnings.classList.remove('hidden');
  } else {
    warnings.classList.add('hidden');
  }

  const unplaced = $('unplaced');
  if (p.unplaced.length) {
    unplaced.textContent =
      `Could not fit into the grid: ${p.unplaced.map((u) => u.answer).join(', ')}. `
      + 'Try another layout, or swap these answers for ones sharing more letters with the rest.';
    unplaced.classList.remove('hidden');
  } else {
    unplaced.classList.add('hidden');
  }

  const cellSize = Math.max(18, Math.min(34, Math.floor(760 / p.width)));
  const grid = $('preview-grid');
  grid.style.gridTemplateColumns = `repeat(${p.width}, var(--cell))`;
  grid.style.setProperty('--cell', `${cellSize}px`);
  grid.innerHTML = '';

  const letters = new Map();
  const numbers = new Map();
  for (const entry of p.entries) {
    for (let i = 0; i < entry.answer.length; i++) {
      const r = entry.row + (entry.direction === 'down' ? i : 0);
      const c = entry.col + (entry.direction === 'across' ? i : 0);
      letters.set(`${r},${c}`, entry.answer[i]);
    }
  }
  for (const cell of p.cells) if (cell.number) numbers.set(`${cell.row},${cell.col}`, cell.number);

  for (let r = 0; r < p.height; r++) {
    for (let c = 0; c < p.width; c++) {
      const div = document.createElement('div');
      const letter = letters.get(`${r},${c}`);
      if (!letter) {
        div.className = 'cell blank';
      } else {
        div.className = 'cell';
        const n = numbers.get(`${r},${c}`);
        if (n) {
          const span = document.createElement('span');
          span.className = 'num';
          span.textContent = String(n);
          div.appendChild(span);
        }
        const text = document.createElement('span');
        text.textContent = letter;
        div.appendChild(text);
      }
      grid.appendChild(div);
    }
  }
}

$('generate').addEventListener('click', () => buildPreview(false));
$('regenerate').addEventListener('click', () => buildPreview(true));

$('save-puzzle').addEventListener('click', async () => {
  if (!state.puzzle) return setError('generate-error', 'Generate a grid first.');
  if (!state.event) return setError('console-error', 'Create a competition first.');

  if (state.puzzle.unplaced.length
      && !confirm(`${state.puzzle.unplaced.length} answer(s) could not be placed and will not appear in the puzzle. Save anyway?`)) {
    return;
  }

  const payload = {
    width: state.puzzle.width,
    height: state.puzzle.height,
    seed: state.seed,
    cells: state.puzzle.cells,
    entries: state.puzzle.entries.map((e) => ({
      number: e.number, direction: e.direction, row: e.row, col: e.col,
      length: e.length, clue: e.clue, answer: e.answer,
    })),
  };

  const result = await guard(() => admin.setPuzzle(state.token, state.event.id, payload));
  if (result) {
    state.puzzleSaved = true;
    note(`This grid is now the competition's puzzle (${result.entry_count} clues). `
       + 'Press Generate again if you want to try a different one.');
    await refreshEvent();
  }
});

// ------------------------------------------------------------- run event ----

$('open-event').addEventListener('click', async () => {
  if (await guard(() => admin.open(state.token, state.event.id))) {
    note('Open. Competitors can now join and will wait for you to start.');
    await refreshEvent();
  }
});

$('start-event').addEventListener('click', async () => {
  if (!confirm('Start the competition now? The clock begins immediately for everyone.')) return;
  if (await guard(() => admin.start(state.token, state.event.id))) {
    note('Started.');
    await refreshEvent();
  }
});

$('end-event').addEventListener('click', async () => {
  if (!confirm('End the competition now? Nobody will be able to submit another answer.')) return;
  if (await guard(() => admin.end(state.token, state.event.id))) {
    note('Ended.');
    await refreshEvent();
  }
});

$('reset-event').addEventListener('click', async () => {
  if (!confirm('Remove every competitor and return this competition to draft? This cannot be undone.')) return;
  const result = await guard(() => admin.reset(state.token, state.event.id));
  if (result) {
    note(`Reset. ${result.participants_removed} competitor(s) removed.`);
    await refreshEvent();
  }
});

// ---------------------------------------------------------------- results ---

function startBoardPolling() {
  clearInterval(state.boardTimer);
  state.boardTimer = setInterval(() => {
    if (state.event && state.event.status !== 'draft') refreshBoard();
  }, BOARD_POLL_MS);
}

async function refreshBoard() {
  if (!state.event) return;
  const rows = await guard(() => admin.board(state.token, state.event.id));
  if (!rows) return;
  state.board = rows;

  const tbody = $('board-rows');
  tbody.innerHTML = '';

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'muted';
    td.textContent = 'No competitors yet.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const row of rows) {
    const tr = document.createElement('tr');
    if (row.finished_at && row.rank <= 3) tr.className = 'top-three';

    const cells = [
      row.rank,
      row.display_name,
      row.employee_id,
      `${row.solved_count} / ${row.total_entries}`,
      row.finished_at ? formatSeconds(row.finish_seconds) : '—',
      row.wrong_guesses,
    ];
    for (const value of cells) {
      const td = document.createElement('td');
      td.textContent = String(value);
      if (typeof value === 'number') td.className = 'num';
      tr.appendChild(td);
    }

    const action = document.createElement('td');
    const button = document.createElement('button');
    button.className = 'secondary';
    button.style.minHeight = '32px';
    button.style.padding = '4px 10px';
    button.textContent = row.released ? 'Released' : 'Release';
    button.disabled = row.released;
    button.title = 'Let this employee ID join again from a different device';
    button.addEventListener('click', async () => {
      if (await guard(() => admin.release(state.token, row.id))) refreshBoard();
    });
    action.appendChild(button);
    tr.appendChild(action);

    tbody.appendChild(tr);
  }
}

$('refresh-board').addEventListener('click', refreshBoard);

$('export-csv').addEventListener('click', () => {
  const header = ['Rank', 'Name', 'Employee ID', 'Solved', 'Total', 'Finish seconds',
                  'Wrong guesses', 'Joined at', 'Finished at'];
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = [header.map(escape).join(',')];

  for (const row of state.board) {
    lines.push([
      row.rank, row.display_name, row.employee_id, row.solved_count, row.total_entries,
      row.finish_seconds ?? '', row.wrong_guesses, row.joined_at, row.finished_at ?? '',
    ].map(escape).join(','));
  }

  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `crossword-results-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
});

// ------------------------------------------------------------------- boot ---

async function boot() {
  const saved = safeRead(TOKEN_KEY);
  if (!saved) return show('view-login');

  state.token = saved;
  try {
    const who = await admin.whoami(state.token);
    if (who?.is_admin) return enterConsole();
  } catch { /* fall through to the login form */ }
  signOut();
}

boot();
