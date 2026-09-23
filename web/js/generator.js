/**
 * Freeform ("criss-cross") crossword generator.
 *
 * Pure, dependency-free ES module. Runs unchanged in the browser (admin
 * console preview) and in Node (unit tests, CLI preview), so what the admin
 * sees in the preview is exactly what the tests exercise.
 *
 * The generator is deliberately best-effort: an arbitrary set of 20 answers
 * is not guaranteed to interlock into a single connected grid, so it returns
 * whichever entries it could place plus an explicit `unplaced` list for the
 * admin to act on.
 */

export const MIN_ANSWER_LENGTH = 3;
export const MAX_ANSWER_LENGTH = 15;

/** Deterministic PRNG (mulberry32) so a given seed always yields one grid. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, rng) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Normalise a raw admin-entered answer to grid form: uppercase A-Z only.
 * Returns { answer, error }. `error` is a message fit to show in the form.
 */
export function normaliseAnswer(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { answer: '', error: 'Answer is required.' };
  const upper = trimmed.toUpperCase();
  if (/\s/.test(upper)) {
    return { answer: '', error: 'Answers must be a single word with no spaces.' };
  }
  if (!/^[A-Z]+$/.test(upper)) {
    return { answer: '', error: 'Answers may only contain the letters A-Z.' };
  }
  if (upper.length < MIN_ANSWER_LENGTH) {
    return { answer: '', error: `Answers must be at least ${MIN_ANSWER_LENGTH} letters.` };
  }
  if (upper.length > MAX_ANSWER_LENGTH) {
    return { answer: '', error: `Answers must be at most ${MAX_ANSWER_LENGTH} letters.` };
  }
  return { answer: upper, error: null };
}

const key = (r, c) => `${r},${c}`;

class Board {
  constructor() {
    this.cells = new Map();   // "r,c" -> letter
    this.across = new Set();  // "r,c" cells already covered by an across entry
    this.down = new Set();    // "r,c" cells already covered by a down entry
    this.placements = [];     // { answer, clue, row, col, dir }
  }

  letterAt(r, c) {
    return this.cells.get(key(r, c)) ?? null;
  }

  /**
   * Can `answer` sit at (row, col) running `dir` without breaking crossword
   * rules? Returns the number of intersections, or -1 if the placement is
   * illegal.
   */
  fit(answer, row, col, dir) {
    const dr = dir === 'down' ? 1 : 0;
    const dc = dir === 'across' ? 1 : 0;
    const sameDir = dir === 'across' ? this.across : this.down;

    // The squares immediately before and after the entry must be empty,
    // otherwise we would silently extend an existing entry.
    if (this.letterAt(row - dr, col - dc) !== null) return -1;
    if (this.letterAt(row + dr * answer.length, col + dc * answer.length) !== null) return -1;

    let intersections = 0;
    for (let i = 0; i < answer.length; i++) {
      const r = row + dr * i;
      const c = col + dc * i;
      const existing = this.letterAt(r, c);

      // Never lay an entry along squares already used in the same direction.
      if (sameDir.has(key(r, c))) return -1;

      if (existing === null) {
        // An empty square must not touch letters on its perpendicular sides,
        // or we would create an unintended two-letter entry.
        if (this.letterAt(r - dc, c - dr) !== null) return -1;
        if (this.letterAt(r + dc, c + dr) !== null) return -1;
      } else if (existing !== answer[i]) {
        return -1;
      } else {
        intersections++;
      }
    }
    return intersections;
  }

  place(entry, row, col, dir) {
    const dr = dir === 'down' ? 1 : 0;
    const dc = dir === 'across' ? 1 : 0;
    const sameDir = dir === 'across' ? this.across : this.down;
    for (let i = 0; i < entry.answer.length; i++) {
      const r = row + dr * i;
      const c = col + dc * i;
      this.cells.set(key(r, c), entry.answer[i]);
      sameDir.add(key(r, c));
    }
    this.placements.push({ ...entry, row, col, dir });
  }

  bounds() {
    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    for (const k of this.cells.keys()) {
      const [r, c] = k.split(',').map(Number);
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
    if (this.cells.size === 0) return { minR: 0, maxR: -1, minC: 0, maxC: -1 };
    return { minR, maxR, minC, maxC };
  }
}

function buildOnce(entries, rng) {
  const board = new Board();
  const remaining = entries.slice();

  // Seed the grid with the longest answer, laid across the middle.
  remaining.sort((a, b) => b.answer.length - a.answer.length);
  const first = remaining.shift();
  board.place(first, 0, 0, 'across');

  const unplaced = [];
  let pending = shuffled(remaining, rng);

  // Repeat passes: a word that does not fit now may fit once its neighbours
  // have been laid down, so keep going until a full pass places nothing.
  let progress = true;
  while (progress && pending.length) {
    progress = false;
    const stillPending = [];

    for (const entry of pending) {
      let best = null;

      for (const placed of board.placements) {
        const dir = placed.dir === 'across' ? 'down' : 'across';
        for (let i = 0; i < placed.answer.length; i++) {
          const anchorR = placed.row + (placed.dir === 'down' ? i : 0);
          const anchorC = placed.col + (placed.dir === 'across' ? i : 0);
          const letter = placed.answer[i];

          for (let j = 0; j < entry.answer.length; j++) {
            if (entry.answer[j] !== letter) continue;
            const row = dir === 'down' ? anchorR - j : anchorR;
            const col = dir === 'across' ? anchorC - j : anchorC;
            const intersections = board.fit(entry.answer, row, col, dir);
            if (intersections < 1) continue;

            // Prefer more intersections, then the tightest bounding box.
            const b = board.bounds();
            const endR = dir === 'down' ? row + entry.answer.length - 1 : row;
            const endC = dir === 'across' ? col + entry.answer.length - 1 : col;
            const width = Math.max(b.maxC, endC) - Math.min(b.minC, col) + 1;
            const height = Math.max(b.maxR, endR) - Math.min(b.minR, row) + 1;
            const score = intersections * 1000
              - (width * height)
              - Math.abs(width - height) * 5
              + rng();

            if (!best || score > best.score) best = { score, row, col, dir };
          }
        }
      }

      if (best) {
        board.place(entry, best.row, best.col, best.dir);
        progress = true;
      } else {
        stillPending.push(entry);
      }
    }
    pending = stillPending;
  }

  unplaced.push(...pending);
  return { board, unplaced };
}

/**
 * Walk the finished grid and assign standard crossword numbers.
 * A square is numbered when it begins an across entry, a down entry, or both.
 */
function numberGrid(board, width, height, offsetR, offsetC) {
  const at = (r, c) => board.letterAt(r + offsetR, c + offsetC);
  const numbers = new Map(); // "r,c" -> number
  let next = 1;

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (at(r, c) === null) continue;
      const startsAcross = at(r, c - 1) === null && at(r, c + 1) !== null;
      const startsDown = at(r - 1, c) === null && at(r + 1, c) !== null;
      if (startsAcross || startsDown) numbers.set(key(r, c), next++);
    }
  }
  return numbers;
}

/**
 * Generate a puzzle from admin-entered clue/answer pairs.
 *
 * @param {Array<{clue: string, answer: string}>} rawEntries
 * @param {{seed?: number, attempts?: number}} [options]
 * @returns {{
 *   width: number, height: number,
 *   cells: Array<{row: number, col: number}>,
 *   entries: Array<{number: number, clue: string, answer: string, row: number, col: number, direction: 'across'|'down', length: number}>,
 *   unplaced: Array<{clue: string, answer: string}>,
 *   intersections: number
 * }}
 */
export function generatePuzzle(rawEntries, options = {}) {
  const attempts = options.attempts ?? 200;
  const baseSeed = options.seed ?? 1;

  const entries = rawEntries.map((e, i) => {
    const { answer, error } = normaliseAnswer(e.answer);
    if (error) throw new Error(`Answer ${i + 1} ("${e.answer}"): ${error}`);
    return { clue: String(e.clue ?? '').trim(), answer, index: i };
  });

  if (entries.length === 0) throw new Error('At least one clue and answer is required.');

  // De-duplicate: two identical answers cannot both be numbered entries.
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.answer)) throw new Error(`Duplicate answer "${e.answer}" — every answer must be unique.`);
    seen.add(e.answer);
  }

  let best = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const rng = makeRng(baseSeed + attempt * 7919);
    const { board, unplaced } = buildOnce(entries, rng);
    const b = board.bounds();
    const width = b.maxC - b.minC + 1;
    const height = b.maxR - b.minR + 1;
    const area = width * height;
    const candidate = { board, unplaced, b, width, height, area };

    if (!best) { best = candidate; continue; }
    if (unplaced.length < best.unplaced.length) { best = candidate; continue; }
    if (unplaced.length === best.unplaced.length && area < best.area) best = candidate;
  }

  const { board, b, width, height } = best;
  const numbers = numberGrid(board, width, height, b.minR, b.minC);

  const outEntries = board.placements.map((p) => {
    const row = p.row - b.minR;
    const col = p.col - b.minC;
    return {
      number: numbers.get(key(row, col)),
      clue: p.clue,
      answer: p.answer,
      row,
      col,
      direction: p.dir,
      length: p.answer.length,
    };
  }).sort((a, x) => (a.number - x.number) || (a.direction === 'across' ? -1 : 1));

  const cells = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (board.letterAt(r + b.minR, c + b.minC) !== null) {
        cells.push({ row: r, col: c, number: numbers.get(key(r, c)) ?? null });
      }
    }
  }

  let intersections = 0;
  for (const cell of cells) {
    const r = cell.row + b.minR;
    const c = cell.col + b.minC;
    if (board.across.has(key(r, c)) && board.down.has(key(r, c))) intersections++;
  }

  return {
    width,
    height,
    cells,
    entries: outEntries,
    unplaced: best.unplaced.map(({ clue, answer }) => ({ clue, answer })),
    intersections,
  };
}
