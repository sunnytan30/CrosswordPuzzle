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

  // With no draft, the setup prompt appears instead of the table.
  await page.waitForSelector('#row-setup:not(.hidden)');
  await page.click('#setup-sample');
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

test('the preview warns when a clue gives away another answer', async () => {
  const page = await newPage();
  await signIn(page);

  // "Protective measure against loss" contains LOSS, which is the answer to a
  // different clue in the same puzzle.
  await page.evaluate(() => localStorage.setItem('crossword.admin.draft', JSON.stringify([
    { clue: 'Protective measure against loss', answer: 'INSURANCE' },
    { clue: 'Opposite of profit', answer: 'LOSS' },
    { clue: 'Checked for accuracy', answer: 'AUDIT' },
  ])));
  await page.reload();
  await page.waitForSelector('#view-console:not(.hidden)');

  await page.click('#generate');
  await page.waitForSelector('#preview:not(.hidden)');
  await page.waitForSelector('#clue-warnings:not(.hidden)');

  const text = await page.textContent('#clue-warnings');
  assert.match(text, /give an answer away/i);
  assert.match(text, /LOSS/);
  await page.context().close();
});

test('a clean clue set produces no giveaway warning', async () => {
  const page = await newPage();
  await signIn(page);

  await page.evaluate(() => localStorage.setItem('crossword.admin.draft', JSON.stringify([
    { clue: 'Chance of something going wrong', answer: 'RISK' },
    { clue: 'Checked for accuracy', answer: 'AUDIT' },
    { clue: 'Group working together', answer: 'TEAM' },
  ])));
  await page.reload();
  await page.waitForSelector('#view-console:not(.hidden)');

  await page.click('#generate');
  await page.waitForSelector('#preview:not(.hidden)');
  await page.waitForTimeout(300);
  assert.ok(await page.locator('#clue-warnings').isHidden(), 'no warning expected');
  await page.context().close();
});


// ---------------------------------------------------------------- new UI --

test('a first-time draft asks how many clues and builds that many rows', async () => {
  const page = await newPage();
  await signIn(page);
  await page.evaluate(() => localStorage.removeItem('crossword.admin.draft'));
  await page.reload();
  await page.waitForSelector('#view-console:not(.hidden)');

  await page.waitForSelector('#row-setup:not(.hidden)');
  assert.ok(await page.locator('#clue-editor').isHidden(), 'table should be hidden until rows exist');

  await page.fill('#row-count', '7');
  await page.click('#create-rows');

  await page.waitForSelector('#clue-editor:not(.hidden)');
  assert.equal(await page.locator('#clue-rows tr').count(), 7);
  assert.ok(await page.locator('#row-setup').isHidden());
  await page.context().close();
});

test('Add Row appends and Delete Row removes, after confirming', async () => {
  const page = await newPage();
  await signIn(page);
  await page.evaluate(() => localStorage.setItem('crossword.admin.draft', JSON.stringify([
    { clue: 'one', answer: 'RISK' },
    { clue: 'two', answer: 'TEAM' },
    { clue: 'three', answer: 'AUDIT' },
  ])));
  await page.reload();
  await page.waitForSelector('#clue-editor:not(.hidden)');

  await page.click('#add-row');
  assert.equal(await page.locator('#clue-rows tr').count(), 4);

  // A dismissed confirmation must leave the rows alone.
  page.once('dialog', d => d.dismiss());
  await page.click('#delete-row');
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#clue-rows tr').count(), 4, 'cancel should not delete');

  page.once('dialog', d => d.accept());
  await page.click('#delete-row');
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#clue-rows tr').count(), 3);
  await page.context().close();
});

test('Delete Row removes the row being edited, naming it in the prompt', async () => {
  const page = await newPage();
  await signIn(page);
  await page.evaluate(() => localStorage.setItem('crossword.admin.draft', JSON.stringify([
    { clue: 'first clue', answer: 'RISK' },
    { clue: 'second clue', answer: 'TEAM' },
    { clue: 'third clue', answer: 'AUDIT' },
  ])));
  await page.reload();
  await page.waitForSelector('#clue-editor:not(.hidden)');

  // Put the cursor in row 2, then delete.
  await page.locator('#clue-rows tr').nth(1).locator('input').first().click();

  let message = '';
  page.once('dialog', d => { message = d.message(); d.accept(); });
  await page.click('#delete-row');
  await page.waitForTimeout(200);

  assert.match(message, /row 2/i);
  assert.match(message, /second clue/);

  const clues = await page.locator('#clue-rows input').evaluateAll(
    els => els.filter((_, i) => i % 2 === 0).map(e => e.value));
  assert.deepEqual(clues, ['first clue', 'third clue']);
  await page.context().close();
});

test('the per-row delete button also confirms first', async () => {
  const page = await newPage();
  await signIn(page);
  await page.evaluate(() => localStorage.setItem('crossword.admin.draft', JSON.stringify([
    { clue: 'alpha', answer: 'RISK' },
    { clue: 'beta', answer: 'TEAM' },
  ])));
  await page.reload();
  await page.waitForSelector('#clue-editor:not(.hidden)');

  page.once('dialog', d => d.accept());
  await page.locator('#clue-rows tr').first().locator('button').click();
  await page.waitForTimeout(200);

  assert.equal(await page.locator('#clue-rows tr').count(), 1);
  await page.context().close();
});

test('the clue toolbar buttons are in order and all the same width', async () => {
  const page = await newPage();
  await signIn(page);
  await page.evaluate(() => localStorage.setItem('crossword.admin.draft', JSON.stringify([
    { clue: 'one', answer: 'RISK' },
  ])));
  await page.reload();
  await page.waitForSelector('#clue-editor:not(.hidden)');

  const labels = await page.locator('#clue-editor .btn-row button').allTextContents();
  assert.deepEqual(labels.map(t => t.trim()), ['Add Row', 'Delete Row', 'Generate', 'Load Sample']);

  const widths = [];
  for (const id of ['#add-row', '#delete-row', '#generate', '#load-sample']) {
    widths.push(Math.round((await page.locator(id).boundingBox()).width));
  }
  assert.equal(new Set(widths).size, 1, `widths differ: ${widths.join(', ')}`);
  await page.context().close();
});

test('the run buttons are renamed, coloured and equal width', async () => {
  const page = await newPage();
  await signIn(page);

  assert.equal((await page.textContent('#open-event')).trim(), 'Open Game');
  assert.equal((await page.textContent('#start-event')).trim(), 'Start Game');
  assert.equal((await page.textContent('#end-event')).trim(), 'End Game');

  const widths = [];
  for (const id of ['#open-event', '#start-event', '#end-event']) {
    widths.push(Math.round((await page.locator(id).boundingBox()).width));
  }
  assert.equal(new Set(widths).size, 1, `widths differ: ${widths.join(', ')}`);

  // Distinct colours: blue, green, red.
  const colours = [];
  for (const id of ['#open-event', '#start-event', '#end-event']) {
    colours.push(await page.locator(id).evaluate(el => getComputedStyle(el).backgroundColor));
  }
  assert.equal(new Set(colours).size, 3, `expected three distinct colours, got ${colours.join(' / ')}`);
  await page.context().close();
});

test('Use Grid greys out once used and returns when a new grid is generated', async () => {
  await fetch(`${BASE}/__dev/seed?start=0`);
  const page = await newPage();
  await signIn(page);

  // Put the competition back to draft so the puzzle can be set.
  page.once('dialog', d => d.accept());
  await page.click('#reset-event');
  await page.waitForTimeout(400);

  await page.evaluate(() => localStorage.removeItem('crossword.admin.draft'));
  await page.reload();
  await page.waitForSelector('#view-console:not(.hidden)');
  await page.click('#setup-sample');
  await page.waitForSelector('#clue-editor:not(.hidden)');

  await page.click('#generate');
  await page.waitForSelector('#preview:not(.hidden)');
  assert.equal(await page.locator('#save-puzzle').isDisabled(), false, 'should be usable before saving');
  assert.equal((await page.textContent('#save-puzzle')).trim(), 'Use Grid');

  await page.click('#save-puzzle');
  await page.waitForFunction(() => document.getElementById('save-puzzle').disabled, null, { timeout: 8000 });
  assert.equal((await page.textContent('#save-puzzle')).trim(), 'Grid in use');

  // Generating again offers it once more.
  await page.click('#regenerate');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#save-puzzle').isDisabled(), false, 'Generate should re-enable it');
  assert.equal((await page.textContent('#save-puzzle')).trim(), 'Use Grid');
  await page.context().close();
});

test('the administrator can set the title competitors see', async () => {
  await fetch(`${BASE}/__dev/seed?start=0`);
  const page = await newPage();
  await signIn(page);

  await page.waitForSelector('#title-editor:not(.hidden)');
  await page.fill('#event-title', 'Finance Team Quiz 2026');
  await page.click('#save-title');
  await page.waitForTimeout(600);

  const open = await (await fetch(`${BASE}/rest/v1/rpc/get_open_event`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })).json();
  assert.equal(open.name, 'Finance Team Quiz 2026');
  await page.context().close();
});
