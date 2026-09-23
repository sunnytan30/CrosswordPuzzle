/**
 * Browser-driven tests for the competitor app.
 *
 * These run the real HTML, CSS and JavaScript in Chromium against the local
 * dev server, at a phone viewport. They check the things unit tests cannot:
 * that the grid renders, that typing works the way a phone keyboard drives it,
 * that solved words lock, and that the answer key never reaches the client.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

/**
 * This environment ships Chromium at a fixed path that may not match the
 * version Playwright would download. Prefer the pre-installed binary.
 */
const BUNDLED_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const launchOptions = existsSync(BUNDLED_CHROMIUM)
  ? { executablePath: BUNDLED_CHROMIUM }
  : {};

const PORT = 8899;
const BASE = `http://localhost:${PORT}`;
const PHONE = { width: 390, height: 844 };  // iPhone 14 class

let server;
let browser;

async function waitForServer(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('dev server did not start');
}

before(async () => {
  server = spawn('node', ['dev/server.mjs', '--port', String(PORT)], { stdio: 'ignore' });
  await waitForServer();
  browser = await chromium.launch(launchOptions);
});

after(async () => {
  await browser?.close();
  server?.kill();
});

/** Reset the server to a fresh event, optionally already started. */
async function reseed({ start = false } = {}) {
  const res = await fetch(`${BASE}/__dev/seed?start=${start ? 1 : 0}`);
  assert.ok(res.ok, 'seed failed');
  return res.json();
}

async function answers() {
  return (await fetch(`${BASE}/__dev/answers`)).json();
}

async function newPage() {
  const context = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.__errors = errors;
  return page;
}

async function join(page, employeeId = '12345678', name = 'Test Competitor') {
  await page.goto(BASE);
  await page.waitForSelector('#view-join:not(.hidden)');
  await page.fill('#employee-id', employeeId);
  await page.fill('#display-name', name);
  await page.click('#join-submit');
}

// --------------------------------------------------------------------------

test('a competitor who joins before the start sees the waiting room', async () => {
  await reseed({ start: false });
  const page = await newPage();

  await join(page);
  await page.waitForSelector('#view-waiting:not(.hidden)', { timeout: 5000 });

  assert.match(await page.textContent('#waiting-name'), /Test Competitor/);
  assert.match(await page.textContent('#view-waiting'), /administrator/i);
  assert.deepEqual(page.__errors, []);
  await page.context().close();
});

test('the waiting room moves into the puzzle when the administrator starts', async () => {
  await reseed({ start: false });
  const page = await newPage();

  await join(page);
  await page.waitForSelector('#view-waiting:not(.hidden)');

  await fetch(`${BASE}/__dev/start`);
  await page.waitForSelector('#view-play:not(.hidden)', { timeout: 15000 });

  const cells = await page.locator('#grid .cell:not(.blank)').count();
  assert.ok(cells > 40, `expected a populated grid, got ${cells} cells`);
  assert.deepEqual(page.__errors, []);
  await page.context().close();
});

test('the page never receives the answer key', async () => {
  await reseed({ start: true });
  const page = await newPage();

  const payloads = [];
  page.on('response', async (res) => {
    if (res.url().includes('/rest/v1/rpc/')) {
      payloads.push(await res.text().catch(() => ''));
    }
  });

  await join(page);
  await page.waitForSelector('#view-play:not(.hidden)');

  const key = await answers();

  // Structural check first: no response may carry an `answer` field at any
  // depth. This is the guarantee, and it cannot be fooled by casing.
  const seenKeys = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) { seenKeys.add(k); walk(v); }
    }
  };
  for (const body of payloads) {
    try { walk(JSON.parse(body)); } catch { /* non-JSON bodies carry no fields */ }
  }
  assert.ok(!seenKeys.has('answer'), `a response carried an "answer" field`);

  // Then a textual check, case-insensitively, after removing legitimate clue
  // text — a clue may contain its own answer ("Protective measure against
  // loss"), and that is the author's choice, not a leak by the server.
  let blob = payloads.join('\n');
  const clues = await page.evaluate(() =>
    window.__crossword.state.puzzle.entries.map((e) => e.clue));
  for (const clue of clues) blob = blob.split(JSON.stringify(clue)).join('""');

  for (const { answer } of key) {
    assert.ok(
      !new RegExp(answer, 'i').test(blob),
      `answer ${answer} appeared in a response outside of clue text`,
    );
  }
  await page.context().close();
});

test('typing a correct word locks it, a wrong one does not', async () => {
  await reseed({ start: true });
  const page = await newPage();
  await join(page);
  await page.waitForSelector('#view-play:not(.hidden)');

  const key = await answers();
  const target = key[0];

  // Select the entry from the clue list, then type it as a keyboard would.
  await page.click(`.clue-list li[data-id="${target.id}"]`);
  await page.keyboard.type(target.answer);

  await page.waitForFunction(
    (id) => window.__crossword.state.solved.has(id),
    target.id,
    { timeout: 5000 },
  );

  assert.match(await page.textContent('#progress'), /^1 \/ 20$/);
  assert.ok(await page.locator('#grid .cell.solved').count() >= target.answer.length);

  // A wrong answer on a different entry must not count.
  const other = key.find((e) => e.id !== target.id && e.answer !== target.answer);
  await page.click(`.clue-list li[data-id="${other.id}"]`);
  await page.keyboard.type('Z'.repeat(other.answer.length));
  await page.waitForTimeout(600);

  const solved = await page.evaluate(() => window.__crossword.state.solved.size);
  assert.equal(solved, 1, 'a wrong guess should not be accepted');
  assert.deepEqual(page.__errors, []);
  await page.context().close();
});

test('solving every clue shows the finish screen with an elapsed time', async () => {
  await reseed({ start: true });
  const page = await newPage();
  await join(page);
  await page.waitForSelector('#view-play:not(.hidden)');

  const key = await answers();
  for (const entry of key) {
    await page.click(`.clue-list li[data-id="${entry.id}"]`);
    await page.keyboard.type(entry.answer);
    await page.waitForFunction(
      (id) => window.__crossword.state.solved.has(id), entry.id, { timeout: 8000 });
  }

  await page.waitForSelector('#view-done:not(.hidden)', { timeout: 8000 });
  assert.match(await page.textContent('#done-title'), /All done/i);
  assert.match(await page.textContent('#done-time'), /\d/);
  assert.deepEqual(page.__errors, []);
  await page.context().close();
});

test('progress survives a reload', async () => {
  await reseed({ start: true });
  const page = await newPage();
  await join(page);
  await page.waitForSelector('#view-play:not(.hidden)');

  const key = await answers();
  await page.click(`.clue-list li[data-id="${key[0].id}"]`);
  await page.keyboard.type(key[0].answer);
  await page.waitForFunction((id) => window.__crossword.state.solved.has(id), key[0].id);

  await page.reload();
  await page.waitForSelector('#view-play:not(.hidden)', { timeout: 8000 });

  assert.match(await page.textContent('#progress'), /^1 \/ 20$/);
  assert.deepEqual(page.__errors, []);
  await page.context().close();
});

test('the grid fits a phone screen without horizontal page scroll', async () => {
  await reseed({ start: true });
  const page = await newPage();
  await join(page);
  await page.waitForSelector('#view-play:not(.hidden)');

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `page scrolls horizontally by ${overflow}px`);

  // The grid itself may scroll inside its own container; that is intended.
  const box = await page.locator('#grid').boundingBox();
  assert.ok(box.width > 0 && box.height > 0);
  assert.deepEqual(page.__errors, []);
  await page.context().close();
});

test('a second device on the same employee ID is refused', async () => {
  await reseed({ start: true });
  const first = await newPage();
  await join(first, '11112222', 'First Device');
  await first.waitForSelector('#view-play:not(.hidden)');

  const second = await newPage();
  await join(second, '11112222', 'Second Device');
  await second.waitForSelector('#join-error:not(.hidden)', { timeout: 5000 });
  assert.match(await second.textContent('#join-error'), /another device/i);

  await first.context().close();
  await second.context().close();
});

test('an 8-digit employee ID is enforced in the browser too', async () => {
  await reseed({ start: false });
  const page = await newPage();
  await page.goto(BASE);
  await page.waitForSelector('#view-join:not(.hidden)');

  // The field is maxlength=8, so the browser truncates first and the input
  // handler then strips whatever letters survived.
  await page.fill('#employee-id', 'ab12cd34ef');
  assert.equal(await page.inputValue('#employee-id'), '1234', 'letters should be stripped');

  await page.fill('#display-name', 'Someone');
  await page.click('#join-submit');
  await page.waitForSelector('#join-error:not(.hidden)');
  assert.match(await page.textContent('#join-error'), /8 digits/);
  await page.context().close();
});
