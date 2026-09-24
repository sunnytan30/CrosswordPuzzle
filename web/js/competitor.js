/**
 * Competitor app: join, wait, solve, finish.
 *
 * Everything that decides the outcome — whether a word is right, what time it
 * is, when the event ends — is decided by the server. This file is a view over
 * that, plus enough local state to keep a phone responsive between calls.
 */

import { competitor, ApiError } from './api.js';
import { POLL_WAITING_MS, POLL_PLAYING_MS, AUTOSAVE_MS } from './config.js';

const TOKEN_KEY = 'crossword.token';
const ZOOM_KEY = 'crossword.cell';
const SENTINEL = '  '; // see onInput(): lets us detect backspace on Android

const $ = (id) => document.getElementById(id);

const state = {
  token: null,
  status: null,
  clockOffsetMs: 0,      // serverNow - deviceNow
  endsAt: null,
  solvedCount: 0,
  totalEntries: 0,
  finishedAt: null,
  startedAt: null,
  displayName: '',
  puzzle: null,          // { width, height, cells, entries }
  letters: new Map(),    // "r,c" -> letter typed by this competitor
  solved: new Set(),     // entry ids confirmed correct by the server
  currentEntryId: null,
  cursor: 0,             // index within the current entry
  lastTried: new Map(),  // entry id -> last guess sent, so we never resend it
  cooldownUntil: new Map(),
  cellSize: Number(safeRead(ZOOM_KEY)) || 0,
  dirty: false,
  checking: false,
  eventName: '',
};

let pollTimer = null;
let saveTimer = null;
let clockTimer = null;

// ------------------------------------------------------------- utilities --

function safeRead(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeWrite(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}
function safeRemove(key) {
  try { localStorage.removeItem(key); } catch { /* private mode */ }
}

const key = (r, c) => `${r},${c}`;

function serverNow() {
  return Date.now() + state.clockOffsetMs;
}

function formatClock(ms) {
  if (ms == null) return '--:--';
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

/**
 * Apply the competition's title wherever competitors see it: the join
 * heading, the waiting room, the results screen and the browser tab.
 */
function applyEventName(name) {
  const title = (name ?? '').trim() || 'Crossword Competition';
  state.eventName = title;
  document.title = title;
  $('join-title').textContent = title;
  $('waiting-event-name').textContent = title;
  $('done-event-name').textContent = title;
}

function show(viewId) {
  for (const section of document.querySelectorAll('body > section')) {
    section.classList.toggle('hidden', section.id !== viewId);
  }
}

function showError(elementId, message) {
  const el = $(elementId);
  el.textContent = message;
  el.classList.remove('hidden');
}

function clearError(elementId) {
  $(elementId).classList.add('hidden');
}

function fatal(message) {
  stopTimers();
  $('fatal-message').textContent = message;
  show('view-error');
}

function stopTimers() {
  clearTimeout(pollTimer);
  clearInterval(saveTimer);
  clearInterval(clockTimer);
  pollTimer = saveTimer = clockTimer = null;
}

// ------------------------------------------------------------------ join --

$('join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError('join-error');

  const employeeId = $('employee-id').value.trim();
  const displayName = $('display-name').value.trim();

  if (!/^\d{8}$/.test(employeeId)) {
    showError('join-error', 'Your employee ID must be exactly 8 digits.');
    return;
  }
  if (displayName.length < 2) {
    showError('join-error', 'Please enter your name.');
    return;
  }

  const button = $('join-submit');
  button.disabled = true;
  button.textContent = 'Joining…';

  try {
    const result = await competitor.join(employeeId, displayName);
    state.token = result.token;
    state.displayName = result.display_name;
    safeWrite(TOKEN_KEY, result.token);
    await resume();
  } catch (error) {
    showError('join-error', error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Enter the competition';
  }
});

// Digits only, so a stray letter cannot silently fail validation later.
$('employee-id').addEventListener('input', (event) => {
  event.target.value = event.target.value.replace(/\D/g, '').slice(0, 8);
});

// ------------------------------------------------------------ event state --

async function refreshState() {
  const info = await competitor.state(state.token);

  // Derive the clock offset from the server's own timestamp, so a device with
  // the wrong time still sees the right countdown.
  state.clockOffsetMs = new Date(info.server_time).getTime() - Date.now();
  state.status = info.status;
  state.endsAt = info.ends_at ? new Date(info.ends_at).getTime() : null;
  state.startedAt = info.started_at ? new Date(info.started_at).getTime() : null;
  state.solvedCount = info.solved_count;
  state.totalEntries = info.total_entries;
  state.finishedAt = info.finished_at ? new Date(info.finished_at).getTime() : null;
  state.displayName = info.display_name;

  applyEventName(info.event_name);
  return info;
}

async function resume() {
  const info = await refreshState();

  if (state.finishedAt) return showDone('finished');
  if (info.status === 'ended') return showDone('ended');
  if (info.status === 'running') return startPlaying();
  return startWaiting();
}

// -------------------------------------------------------------- waiting ---

function startWaiting() {
  show('view-waiting');
  $('waiting-name').textContent = state.displayName;
  $('waiting-status').textContent = 'Waiting for the administrator to start…';

  stopTimers();
  const tick = async () => {
    try {
      const info = await refreshState();
      if (info.status === 'running') return startPlaying();
      if (info.status === 'ended') return showDone('ended');
      $('waiting-status').textContent =
        `Waiting for the administrator to start… (checked ${new Date().toLocaleTimeString('en-GB')})`;
    } catch (error) {
      if (error instanceof ApiError && error.isSessionExpired) return sessionExpired();
      $('waiting-status').textContent = 'Reconnecting…';
    }
    pollTimer = setTimeout(tick, POLL_WAITING_MS);
  };
  pollTimer = setTimeout(tick, POLL_WAITING_MS);
}

function sessionExpired() {
  stopTimers();
  safeRemove(TOKEN_KEY);
  state.token = null;
  show('view-join');
  showError('join-error', 'Your session has expired. Please join again.');
}

// -------------------------------------------------------------- playing ---

async function startPlaying() {
  stopTimers();

  if (!state.puzzle) {
    const puzzle = await competitor.puzzle(state.token);
    state.puzzle = puzzle;
    state.solved = new Set(puzzle.solved_entry_ids || []);

    // Restore whatever this competitor had typed before a reload or a dropped
    // connection, so nobody loses work to a locked screen.
    for (const [k, letter] of Object.entries(puzzle.grid_state || {})) {
      if (typeof letter === 'string' && /^[A-Z]$/.test(letter)) state.letters.set(k, letter);
    }
  }

  show('view-play');
  chooseInitialCellSize();
  renderGrid();
  renderClues();
  if (!state.currentEntryId && state.puzzle.entries.length) {
    selectEntry(firstUnsolvedEntry()?.id ?? state.puzzle.entries[0].id, 0);
  }
  updateProgress();
  startClock();

  pollTimer = setTimeout(pollWhilePlaying, POLL_PLAYING_MS);
  saveTimer = setInterval(saveProgress, AUTOSAVE_MS);
}

async function pollWhilePlaying() {
  try {
    const info = await refreshState();
    if (state.finishedAt) return showDone('finished');
    if (info.status === 'ended') return showDone('ended');
    updateProgress();
  } catch (error) {
    if (error instanceof ApiError && error.isSessionExpired) return sessionExpired();
    // A blip mid-event is not worth interrupting anyone for; try again.
  }
  pollTimer = setTimeout(pollWhilePlaying, POLL_PLAYING_MS);
}

function startClock() {
  const tick = () => {
    if (state.endsAt == null) return;
    const remaining = state.endsAt - serverNow();
    const el = $('clock');
    el.textContent = formatClock(remaining);
    el.classList.toggle('low', remaining <= 60000);
    if (remaining <= 0) {
      stopTimers();
      showDone('ended');
    }
  };
  tick();
  clockTimer = setInterval(tick, 500);
}

// ----------------------------------------------------------------- grid ---

function entriesAt(r, c) {
  return state.puzzle.entries.filter((e) => {
    if (e.direction === 'across') return e.row === r && c >= e.col && c < e.col + e.length;
    return e.col === c && r >= e.row && r < e.row + e.length;
  });
}

function cellsOf(entry) {
  const out = [];
  for (let i = 0; i < entry.length; i++) {
    out.push(entry.direction === 'across'
      ? { r: entry.row, c: entry.col + i }
      : { r: entry.row + i, c: entry.col });
  }
  return out;
}

function entryById(id) {
  return state.puzzle.entries.find((e) => e.id === id) ?? null;
}

function firstUnsolvedEntry() {
  return state.puzzle.entries.find((e) => !state.solved.has(e.id)) ?? null;
}

/** A cell is locked once any entry running through it has been confirmed. */
function isLocked(r, c) {
  return entriesAt(r, c).some((e) => state.solved.has(e.id));
}

function chooseInitialCellSize() {
  if (state.cellSize) return;
  const available = Math.min(window.innerWidth - 24, 820);
  const fit = Math.floor(available / state.puzzle.width);
  state.cellSize = Math.max(22, Math.min(44, fit));
}

function renderGrid() {
  const { width, height, cells } = state.puzzle;
  const grid = $('grid');
  const filled = new Map(cells.map((cell) => [key(cell.row, cell.col), cell]));

  grid.style.gridTemplateColumns = `repeat(${width}, var(--cell))`;
  grid.style.setProperty('--cell', `${state.cellSize}px`);
  grid.innerHTML = '';

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const div = document.createElement('div');
      const cell = filled.get(key(r, c));
      if (!cell) {
        div.className = 'cell blank';
      } else {
        div.className = 'cell';
        div.dataset.r = String(r);
        div.dataset.c = String(c);
        if (cell.number) {
          const n = document.createElement('span');
          n.className = 'num';
          n.textContent = String(cell.number);
          div.appendChild(n);
        }
        const letter = document.createElement('span');
        letter.className = 'letter';
        letter.textContent = state.letters.get(key(r, c)) ?? '';
        div.appendChild(letter);
      }
      grid.appendChild(div);
    }
  }
  paintSelection();
}

function paintSelection() {
  const entry = entryById(state.currentEntryId);
  const inEntry = new Set(entry ? cellsOf(entry).map((p) => key(p.r, p.c)) : []);
  const cursorCell = entry ? cellsOf(entry)[state.cursor] : null;

  for (const div of $('grid').querySelectorAll('.cell:not(.blank)')) {
    const r = Number(div.dataset.r);
    const c = Number(div.dataset.c);
    const k = key(r, c);
    div.classList.toggle('in-entry', inEntry.has(k));
    div.classList.toggle('cursor', !!cursorCell && cursorCell.r === r && cursorCell.c === c);
    div.classList.toggle('solved', isLocked(r, c));
    div.querySelector('.letter').textContent = state.letters.get(k) ?? '';
  }

  $('clue-label').textContent = entry
    ? `${entry.number} ${entry.direction === 'across' ? 'Across' : 'Down'} (${entry.length})`
    : '—';
  $('clue-text').textContent = entry ? entry.clue : 'Tap a square to begin.';

  for (const li of document.querySelectorAll('.clue-list li')) {
    li.classList.toggle('is-current', li.dataset.id === state.currentEntryId);
    li.classList.toggle('is-solved', state.solved.has(li.dataset.id));
  }
}

function renderClues() {
  for (const direction of ['across', 'down']) {
    const ul = $(direction === 'across' ? 'clues-across' : 'clues-down');
    ul.innerHTML = '';
    for (const entry of state.puzzle.entries.filter((e) => e.direction === direction)) {
      const li = document.createElement('li');
      li.dataset.id = entry.id;
      li.innerHTML = `<span class="n"></span><span class="t"></span>`;
      li.querySelector('.n').textContent = String(entry.number);
      li.querySelector('.t').textContent = entry.clue;
      li.addEventListener('click', () => {
        selectEntry(entry.id, 0);
        focusKeyboard();
        scrollCursorIntoView();
      });
      ul.appendChild(li);
    }
  }
}

function selectEntry(entryId, cursor = 0) {
  state.currentEntryId = entryId;
  const entry = entryById(entryId);
  state.cursor = entry ? Math.min(Math.max(cursor, 0), entry.length - 1) : 0;
  paintSelection();
}

$('grid').addEventListener('click', (event) => {
  const div = event.target.closest('.cell:not(.blank)');
  if (!div) return;

  const r = Number(div.dataset.r);
  const c = Number(div.dataset.c);
  const here = entriesAt(r, c).filter((e) => !state.solved.has(e.id));
  const candidates = here.length ? here : entriesAt(r, c);
  if (!candidates.length) return;

  // Tapping the square you are already on flips across/down, the way every
  // crossword app behaves.
  const current = entryById(state.currentEntryId);
  let chosen = candidates[0];
  if (current && candidates.some((e) => e.id === current.id) && candidates.length > 1) {
    chosen = candidates.find((e) => e.id !== current.id) ?? chosen;
  }

  const index = cellsOf(chosen).findIndex((p) => p.r === r && p.c === c);
  selectEntry(chosen.id, Math.max(0, index));
  focusKeyboard();
});

function scrollCursorIntoView() {
  const cell = $('grid').querySelector('.cell.cursor');
  cell?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ---------------------------------------------------------------- input ---

const catcher = $('keyboard-catcher');

function focusKeyboard() {
  catcher.value = SENTINEL;
  catcher.focus({ preventScroll: true });
  try { catcher.setSelectionRange(SENTINEL.length, SENTINEL.length); } catch { /* ignore */ }
}

/**
 * Android keyboards report Backspace as keyCode 229 and fire no useful
 * keydown, so instead of reading keys we keep a sentinel in the input and
 * watch how its value changes: shorter means a deletion, longer means typing.
 */
catcher.addEventListener('input', () => {
  const value = catcher.value;
  if (value.length < SENTINEL.length) {
    backspace();
  } else {
    const typed = value.slice(SENTINEL.length).toUpperCase().replace(/[^A-Z]/g, '');
    for (const letter of typed) typeLetter(letter);
  }
  catcher.value = SENTINEL;
  try { catcher.setSelectionRange(SENTINEL.length, SENTINEL.length); } catch { /* ignore */ }
});

document.addEventListener('keydown', (event) => {
  if ($('view-play').classList.contains('hidden')) return;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { moveCursor(1); event.preventDefault(); }
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { moveCursor(-1); event.preventDefault(); }
  else if (event.key === 'Tab') { stepEntry(event.shiftKey ? -1 : 1); event.preventDefault(); }
  else if (event.key === 'Backspace' && document.activeElement !== catcher) { backspace(); event.preventDefault(); }
  else if (/^[a-zA-Z]$/.test(event.key) && document.activeElement !== catcher) {
    typeLetter(event.key.toUpperCase());
    event.preventDefault();
  }
});

function currentCells() {
  const entry = entryById(state.currentEntryId);
  return entry ? cellsOf(entry) : [];
}

/**
 * Place a typed letter, coping with squares already locked in by a crossing
 * word. Two habits have to work equally well: typing the whole answer
 * (including the letters already on the grid), and typing only the gaps.
 *
 * Landing on a locked square, a matching letter is treated as the competitor
 * typing over what is already there and simply moves on; anything else is
 * taken as the next missing letter and goes in the next free square.
 */
function typeLetter(letter) {
  const entry = entryById(state.currentEntryId);
  if (!entry || state.solved.has(entry.id)) return;

  const cells = cellsOf(entry);
  let index = state.cursor;
  if (index >= cells.length) return;

  if (isLocked(cells[index].r, cells[index].c)) {
    const existing = state.letters.get(key(cells[index].r, cells[index].c));
    if (existing === letter) {
      // They typed the letter that is already there: consume it and move on.
      state.cursor = Math.min(index + 1, cells.length - 1);
      paintSelection();
      scrollCursorIntoView();
      return;
    }
    // They are typing the gaps: find the next square they can actually fill.
    while (index < cells.length && isLocked(cells[index].r, cells[index].c)) index++;
    if (index >= cells.length) return;
  }

  state.letters.set(key(cells[index].r, cells[index].c), letter);
  state.dirty = true;
  state.cursor = Math.min(index + 1, cells.length - 1);

  paintSelection();
  scrollCursorIntoView();
  maybeCheckEntries();
}

function backspace() {
  const entry = entryById(state.currentEntryId);
  if (!entry || state.solved.has(entry.id)) return;

  const cells = cellsOf(entry);
  const here = cells[state.cursor];

  if (here && state.letters.has(key(here.r, here.c)) && !isLocked(here.r, here.c)) {
    state.letters.delete(key(here.r, here.c));
  } else {
    let prev = state.cursor - 1;
    while (prev >= 0 && isLocked(cells[prev].r, cells[prev].c)) prev--;
    if (prev >= 0) {
      state.cursor = prev;
      state.letters.delete(key(cells[prev].r, cells[prev].c));
    }
  }
  state.dirty = true;
  paintSelection();
  scrollCursorIntoView();
}

function moveCursor(delta) {
  const cells = currentCells();
  if (!cells.length) return;
  state.cursor = Math.min(Math.max(state.cursor + delta, 0), cells.length - 1);
  paintSelection();
  scrollCursorIntoView();
}

function stepEntry(delta) {
  const entries = state.puzzle.entries;
  const index = entries.findIndex((e) => e.id === state.currentEntryId);
  if (index < 0) return;
  for (let i = 1; i <= entries.length; i++) {
    const candidate = entries[(index + delta * i + entries.length * i) % entries.length];
    if (!state.solved.has(candidate.id)) {
      selectEntry(candidate.id, 0);
      scrollCursorIntoView();
      return;
    }
  }
}

$('prev-entry').addEventListener('click', () => { stepEntry(-1); focusKeyboard(); });
$('next-entry').addEventListener('click', () => { stepEntry(1); focusKeyboard(); });

$('zoom-in').addEventListener('click', () => setCellSize(state.cellSize + 4));
$('zoom-out').addEventListener('click', () => setCellSize(state.cellSize - 4));

function setCellSize(size) {
  state.cellSize = Math.max(18, Math.min(60, size));
  safeWrite(ZOOM_KEY, String(state.cellSize));
  $('grid').style.setProperty('--cell', `${state.cellSize}px`);
}

// -------------------------------------------------------- answer checking --

function guessFor(entry) {
  return cellsOf(entry).map((p) => state.letters.get(key(p.r, p.c)) ?? '').join('');
}

/**
 * Submit any entry that is now completely filled and has changed since we last
 * asked. Crossing letters mean typing one word can complete another, so every
 * entry is considered, not just the current one.
 */
async function maybeCheckEntries() {
  if (state.checking) return;
  state.checking = true;

  try {
    for (const entry of state.puzzle.entries) {
      if (state.solved.has(entry.id)) continue;

      const guess = guessFor(entry);
      if (guess.length !== entry.length) continue;
      if (state.lastTried.get(entry.id) === guess) continue;

      const until = state.cooldownUntil.get(entry.id) ?? 0;
      if (Date.now() < until) continue;

      state.lastTried.set(entry.id, guess);

      let result;
      try {
        result = await competitor.check(state.token, entry.id, guess);
      } catch (error) {
        if (error instanceof ApiError && error.isSessionExpired) return sessionExpired();
        // Let the competitor try again rather than silently swallowing it.
        state.lastTried.delete(entry.id);
        continue;
      }

      if (result.cooldown) {
        state.cooldownUntil.set(entry.id, Date.now() + (result.retry_after_ms ?? 3000));
        state.lastTried.delete(entry.id);
        continue;
      }

      if (result.correct) {
        state.solved.add(entry.id);
        state.solvedCount = result.solved_count ?? state.solvedCount + 1;
        state.totalEntries = result.total_entries ?? state.totalEntries;
        updateProgress();
        paintSelection();
        saveProgress();

        if (result.finished) {
          state.finishedAt = result.finished_at ? new Date(result.finished_at).getTime() : Date.now();
          return showDone('finished');
        }
        // Move on to something still unsolved.
        if (state.currentEntryId === entry.id) {
          const next = firstUnsolvedEntry();
          if (next) selectEntry(next.id, 0);
        }
      }
    }
  } finally {
    state.checking = false;
  }
}

function updateProgress() {
  $('progress').textContent = `${state.solvedCount} / ${state.totalEntries}`;
}

// ------------------------------------------------------------- autosave ---

async function saveProgress() {
  if (!state.dirty || !state.token) return;
  state.dirty = false;
  const payload = Object.fromEntries(state.letters);
  try {
    await competitor.save(state.token, payload);
  } catch (error) {
    if (error instanceof ApiError && error.isSessionExpired) return sessionExpired();
    state.dirty = true; // try again on the next tick
  }
}

// A backgrounded phone may never run another timer, so flush on the way out.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveProgress();
});

// --------------------------------------------------------------- finish ---

function showDone(kind) {
  stopTimers();
  saveProgress();
  show('view-done');

  if (kind === 'finished') {
    const seconds = state.finishedAt && state.startedAt
      ? (state.finishedAt - state.startedAt) / 1000
      : null;
    $('done-title').textContent = 'All done';
    $('done-icon').textContent = '🎉';
    $('done-message').innerHTML =
      `<strong>${escapeHtml(state.displayName)}</strong>, you solved every clue.`;
    $('done-time').textContent = seconds != null ? formatDuration(seconds) : '';
  } else {
    $('done-title').textContent = "Time's up";
    $('done-icon').textContent = '⏱';
    $('done-message').textContent =
      `You solved ${state.solvedCount} of ${state.totalEntries} clues.`;
    $('done-time').textContent = '';
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ----------------------------------------------------------------- boot ---

$('fatal-retry').addEventListener('click', () => location.reload());

async function boot() {
  const saved = safeRead(TOKEN_KEY);
  if (!saved) {
    show('view-join');
    // Nobody has a session yet, so read the title from the public endpoint.
    // A failure here is cosmetic: the default heading stands.
    try {
      const open = await competitor.openEvent();
      if (open?.name) applyEventName(open.name);
    } catch { /* keep the default heading */ }
    return;
  }

  state.token = saved;
  try {
    await resume();
  } catch (error) {
    if (error instanceof ApiError && error.isSessionExpired) {
      safeRemove(TOKEN_KEY);
      state.token = null;
      show('view-join');
      return;
    }
    fatal(error.message);
  }
}

boot();

// Exposed for the browser-driven tests in tests/ui.test.mjs.
window.__crossword = { state, selectEntry, typeLetter, backspace };
