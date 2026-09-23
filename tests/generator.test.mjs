import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePuzzle, normaliseAnswer } from '../web/js/generator.js';

/** Rebuild the letter grid from the generator's output. */
function toGrid(puzzle) {
  const grid = Array.from({ length: puzzle.height }, () => Array(puzzle.width).fill(null));
  for (const e of puzzle.entries) {
    for (let i = 0; i < e.answer.length; i++) {
      const r = e.row + (e.direction === 'down' ? i : 0);
      const c = e.col + (e.direction === 'across' ? i : 0);
      const existing = grid[r][c];
      assert.ok(
        existing === null || existing === e.answer[i],
        `conflicting letters at ${r},${c}: ${existing} vs ${e.answer[i]} (${e.answer})`,
      );
      grid[r][c] = e.answer[i];
    }
  }
  return grid;
}

/**
 * A grid is valid only if every maximal run of two or more letters, in both
 * directions, is itself one of the puzzle's entries. This is the check that
 * catches accidental adjacency — the classic generator bug.
 */
function assertNoStrayWords(puzzle) {
  const grid = toGrid(puzzle);
  const declared = new Set(
    puzzle.entries.map((e) => `${e.direction}:${e.row}:${e.col}:${e.answer}`),
  );

  for (let r = 0; r < puzzle.height; r++) {
    let c = 0;
    while (c < puzzle.width) {
      if (grid[r][c] === null) { c++; continue; }
      let end = c;
      while (end + 1 < puzzle.width && grid[r][end + 1] !== null) end++;
      if (end > c) {
        const word = grid[r].slice(c, end + 1).join('');
        assert.ok(declared.has(`across:${r}:${c}:${word}`), `stray across word "${word}" at ${r},${c}`);
      }
      c = end + 1;
    }
  }

  for (let c = 0; c < puzzle.width; c++) {
    let r = 0;
    while (r < puzzle.height) {
      if (grid[r][c] === null) { r++; continue; }
      let end = r;
      while (end + 1 < puzzle.height && grid[end + 1][c] !== null) end++;
      if (end > r) {
        let word = '';
        for (let i = r; i <= end; i++) word += grid[i][c];
        assert.ok(declared.has(`down:${r}:${c}:${word}`), `stray down word "${word}" at ${r},${c}`);
      }
      r = end + 1;
    }
  }
}

function assertNumberingIsStandard(puzzle) {
  const grid = toGrid(puzzle);
  const at = (r, c) => (r >= 0 && r < puzzle.height && c >= 0 && c < puzzle.width ? grid[r][c] : null);
  let expected = 1;
  const byCell = new Map();
  for (let r = 0; r < puzzle.height; r++) {
    for (let c = 0; c < puzzle.width; c++) {
      if (at(r, c) === null) continue;
      const startsAcross = at(r, c - 1) === null && at(r, c + 1) !== null;
      const startsDown = at(r - 1, c) === null && at(r + 1, c) !== null;
      if (startsAcross || startsDown) byCell.set(`${r},${c}`, expected++);
    }
  }
  for (const e of puzzle.entries) {
    assert.equal(e.number, byCell.get(`${e.row},${e.col}`), `wrong number for ${e.answer}`);
  }
}

const SAMPLE_20 = [
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

test('normaliseAnswer accepts a clean single word', () => {
  assert.deepEqual(normaliseAnswer(' risk '), { answer: 'RISK', error: null });
});

test('normaliseAnswer rejects spaces, digits and short answers', () => {
  assert.match(normaliseAnswer('data privacy').error, /single word/);
  assert.match(normaliseAnswer('ISO27001').error, /letters A-Z/);
  assert.match(normaliseAnswer('AT').error, /at least 3/);
  assert.match(normaliseAnswer('').error, /required/);
});

test('generates a legal grid from a realistic set of 20 answers', () => {
  const puzzle = generatePuzzle(SAMPLE_20, { seed: 42 });
  assertNoStrayWords(puzzle);
  assertNumberingIsStandard(puzzle);
  assert.equal(puzzle.entries.length + puzzle.unplaced.length, 20);
  assert.ok(puzzle.entries.length >= 18, `only placed ${puzzle.entries.length}/20`);
  assert.ok(puzzle.width <= 30 && puzzle.height <= 30, `grid too large: ${puzzle.width}x${puzzle.height}`);
});

test('is deterministic for a given seed', () => {
  const a = generatePuzzle(SAMPLE_20, { seed: 7 });
  const b = generatePuzzle(SAMPLE_20, { seed: 7 });
  assert.deepEqual(a.entries, b.entries);
});

test('different seeds give the admin a different grid to choose from', () => {
  const a = generatePuzzle(SAMPLE_20, { seed: 1 });
  const b = generatePuzzle(SAMPLE_20, { seed: 2 });
  assert.notDeepEqual(a.entries, b.entries);
});

test('reports answers it could not interlock rather than dropping them silently', () => {
  // No shared letters at all, so only one can ever be placed.
  const puzzle = generatePuzzle(
    [{ clue: 'a', answer: 'ABC' }, { clue: 'b', answer: 'XYZ' }],
    { seed: 3 },
  );
  assert.equal(puzzle.entries.length, 1);
  assert.equal(puzzle.unplaced.length, 1);
  assertNoStrayWords(puzzle);
});

test('rejects duplicate answers', () => {
  assert.throws(
    () => generatePuzzle([{ clue: 'a', answer: 'RISK' }, { clue: 'b', answer: 'risk' }]),
    /Duplicate answer/,
  );
});

test('stays legal across many random answer sets', () => {
  const pool = SAMPLE_20.map((e) => e.answer);
  for (let seed = 1; seed <= 40; seed++) {
    const picked = pool.filter((_, i) => (i + seed) % 3 !== 0).slice(0, 12);
    assert.ok(picked.length >= 8, 'test fixture should supply a real answer set');
    const puzzle = generatePuzzle(picked.map((a) => ({ clue: a.toLowerCase(), answer: a })), { seed });
    assertNoStrayWords(puzzle);
    assertNumberingIsStandard(puzzle);
  }
});
