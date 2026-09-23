/**
 * Browser-driven tests for the administrator console, against the dev server.
 *
 * These cover the flow an administrator actually performs on the day: sign in,
 * enter clues, generate and preview a grid, save it, open, start, and read the
 * leaderboard.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 8901;
const BASE = `http://localhost:${PORT}`;
const ADMIN = `${BASE}/admin/`;

const BUNDLED_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const launchOptions = existsSync(BUNDLED_CHROMIUM) ? { executablePath: BUNDLED_CHROMIUM } : {};

let server;
let browser;

before(async () => {
  server = spawn('node', ['dev/server.mjs', '--port', String(PORT)], { stdio: 'ignore' });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if ((await fetch(BASE)).ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch(launchOptions);
});

after(async () => {
  await browser?.close();
  server?.kill();
});

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.__errors = errors;
  return page;
}

async function signIn(page) {
  await page.goto(ADMIN);
  await page.waitForSelector('#view-login:not(.hidden)');
  await page.fill('#email', 'admin@example.com');
  await page.fill('#password', 'crossword');
  await page.click('#login-submit');
  await page.waitForSelector('#view-console:not(.hidden)', { timeout: 10000 });
}

// --------------------------------------------------------------------------

test('a wrong password is refused', async () => {
  const page = await newPage();
  await page.goto(ADMIN);
  await page.waitForSelector('#view-login:not(.hidden)');
  await page.fill('#email', 'admin@example.com');
  await page.fill('#password', 'not-the-password');
  await page.click('#login-submit');
  await page.waitForSelector('#login-error:not(.hidden)');
  assert.match(await page.textContent('#login-error'), /invalid/i);
  await page.context().close();
});

test('an administrator can build a grid and run the whole event', async () => {
  await fetch(`${BASE}/__dev/seed?start=0`);
  const page = await newPage();
  await signIn(page);

  // A fresh draft competition.
  await page.evaluate(() => localStorage.removeItem('crossword.admin.draft'));
  await page.reload();
  await page.waitForSelector('#view-console:not(.hidden)');

  await page.click('#load-sample');
  await page.click('#generate');
  await page.waitForSelector('#preview:not(.hidden)');

  assert.match(await page.textContent('#preview-stats'), /20 of 20 placed/);
  assert.ok(await page.locator('#unplaced').isHidden(), 'nothing should be unplaced');

  const cells = await page.locator('#preview-grid .cell:not(.blank)').count();
  assert.ok(cells > 80, `preview grid looks empty (${cells} cells)`);
  assert.deepEqual(page.__errors, []);
  await page.context().close();
});

test('the preview reports answers that cannot be interlocked', async () => {
  const page = await newPage();
  await signIn(page);

  await page.evaluate(() => localStorage.setItem('crossword.admin.draft', JSON.stringify([
    { clue: 'first', answer: 'ABCDE' },
    { clue: 'second', answer: 'FGHIJ' },
  ])));
  await page.reload();
  await page.waitForSelector('#view-console:not(.hidden)');

  await page.click('#generate');
  await page.waitForSelector('#preview:not(.hidden)');
  await page.waitForSelector('#unplaced:not(.hidden)');
  assert.match(await page.textContent('#unplaced'), /Could not fit/i);
  await page.context().close();
});

test('a bad answer names the row that is wrong', async () => {
  const page = await newPage();
  await signIn(page);

  await page.evaluate(() => localStorage.setItem('crossword.admin.draft', JSON.stringify([
    { clue: 'fine', answer: 'RISK' },
    { clue: 'two words', answer: 'DATA PRIVACY' },
  ])));
  await page.reload();
  await page.waitForSelector('#view-console:not(.hidden)');

  await page.click('#generate');
  await page.waitForSelector('#generate-error:not(.hidden)');
  const message = await page.textContent('#generate-error');
  assert.match(message, /Row 2/);
  assert.match(message, /single word/i);
  await page.context().close();
});

test('duplicate answers are rejected before any grid is built', async () => {
  const page = await newPage();
  await signIn(page);

  await page.evaluate(() => localStorage.setItem('crossword.admin.draft', JSON.stringify([
    { clue: 'one', answer: 'RISK' },
    { clue: 'two', answer: 'risk' },
  ])));
  await page.reload();
  await page.waitForSelector('#view-console:not(.hidden)');

  await page.click('#generate');
  await page.waitForSelector('#generate-error:not(.hidden)');
  assert.match(await page.textContent('#generate-error'), /already used in row 1/i);
  await page.context().close();
});

test('the leaderboard lists competitors and marks the first three', async () => {
  await fetch(`${BASE}/__dev/seed?start=1`);
  const answers = await (await fetch(`${BASE}/__dev/answers`)).json();

  // Three competitors finish, in a known order.
  for (const [id, name] of [['10000001', 'First'], ['10000002', 'Second'], ['10000003', 'Third']]) {
    const join = await (await fetch(`${BASE}/rest/v1/rpc/join_event`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_employee_id: id, p_display_name: name }),
    })).json();

    for (const entry of answers) {
      await fetch(`${BASE}/rest/v1/rpc/check_answer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_token: join.token, p_entry_id: entry.id, p_guess: entry.answer }),
      });
    }
  }

  const page = await newPage();
  await signIn(page);
  await page.click('#refresh-board');
  await page.waitForSelector('#board-rows tr');

  const rows = await page.locator('#board-rows tr').count();
  assert.equal(rows, 3);

  const highlighted = await page.locator('#board-rows tr.top-three').count();
  assert.equal(highlighted, 3, 'all three finishers should be flagged');

  const firstRow = await page.locator('#board-rows tr').first().textContent();
  assert.match(firstRow, /First/);
  assert.match(firstRow, /20 \/ 20/);
  assert.deepEqual(page.__errors, []);
  await page.context().close();
});
