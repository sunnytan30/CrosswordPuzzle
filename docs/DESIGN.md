# Crossword Competition — Design

A single-event crossword race for ~150 simultaneous competitors on any phone or
desktop browser, hosted entirely on free tiers.

## 1. Decisions

| Area | Decision |
|---|---|
| Scoring | Live per-word check. A word locks green the moment it is correct. Finish time is when the 20th word locks. |
| Wrong answers | No penalty, unlimited retries, with a short per-word cooldown to blunt brute-forcing. |
| Identity | Employee ID (8 digits) + self-entered name. No roster; verified against HR records after the event from the admin export. |
| Session | One active session per employee ID. A second device on the same ID is refused; the admin can release it. |
| Start | Administrator presses Start. One shared event clock for everyone. |
| Late joiners | Admitted automatically, no admin approval. Their clock is the shared clock, so they simply have less time left. |
| End | Fixed duration set by the admin before Start. Grid locks for everyone when it expires. |
| Answers | Single words, A–Z only, 3–15 letters, all unique. |
| Competitor view | Countdown and "X of 20 solved". No leaderboard. |
| Admin view | Live ranking, progress, and CSV export. |
| Hosting | Cloudflare Pages (static frontend) + Supabase (Postgres, all game logic in RPC functions). |

## 2. Why this stack

Vercel's free Hobby plan is restricted to personal, non-commercial use — Vercel
defines commercial usage as *"any Deployment that is used for the purpose of
financial gain of anyone involved in any part of the production of the project,
including a paid employee or consultant writing the code."* A staff competition
built by employees sits inside that definition, so Vercel is avoided.

Cloudflare Pages serves the static frontend with no request metering and no
non-commercial clause. Supabase Free carries the database and the game logic.
Supabase Realtime is deliberately **not** used for competitors — the Free plan
includes 200 concurrent peak connections, which leaves almost no headroom at
150 players. Competitors poll instead; Realtime stays available for the single
admin screen if we want it later.

Supabase Free projects pause after a week of inactivity. Waking the project is
on the pre-event checklist.

## 3. Architecture

```
  Competitor phone                 Admin laptop
  (/index.html)                    (/admin/index.html)
        │                                │
        │  HTTPS, static assets          │
        ├────────── Cloudflare Pages ────┤
        │                                │
        │  PostgREST RPC calls           │  RPC + Supabase Auth
        └────────────► Supabase Postgres ◄┘
                       ├ tables (RLS: deny-all to anon)
                       └ SECURITY DEFINER functions = the only way in
```

There is no application server. Every rule — who may join, whether the event
has started, whether a guess is correct, what time it is — is a Postgres
function. That is what makes the result defensible: the browser is never
trusted with anything.

## 4. Security model

The prize makes this worth getting right. A competitor with DevTools open must
gain nothing.

1. **The answer key never leaves the database.** `puzzle_entries.answer` is
   readable only by `SECURITY DEFINER` functions. The anon role has no `SELECT`
   on the table at all. The browser receives grid geometry, clue text, entry
   numbers and lengths — never letters.
2. **Answers are checked server-side.** `check_answer(token, entry_id, guess)`
   compares inside Postgres and returns a bare `correct: true/false`. No
   per-letter feedback, so a wrong guess reveals nothing about which letters
   were right.
3. **Times are server times.** `started_at`, `ends_at` and `finished_at` are all
   `now()` inside the database. A competitor's device clock, timezone and
   latency cannot move their rank. The client countdown is cosmetic and re-syncs
   against the server every 30 seconds.
4. **Submissions outside the window are rejected.** `check_answer` verifies the
   event is `running` and `now() < ends_at` before doing anything.
5. **Rate limiting.** Per entry, one guess every 3 seconds; per participant, a
   cap on total guesses. Attempts are logged so the admin can see anyone
   hammering a single word.
6. **Opaque session tokens.** Joining issues a random token stored in
   `localStorage`. Every call carries it. Knowing someone's employee ID is not
   enough to act as them mid-event.
7. **Separate admin URL and real authentication.** `/admin` uses Supabase Auth
   email + password, not an obscure path. Admin RPCs check the caller's role.

Residual risk, stated plainly: with no roster, someone can enter a colleague's
employee ID at the door. The one-session-per-ID rule and the ID + name export
make it detectable afterwards, not preventable at the time. If you later get a
roster CSV, adding it is a small change.

## 5. Data model

| Table | Purpose |
|---|---|
| `events` | One row per competition: name, status (`draft`/`open`/`running`/`ended`), `duration_seconds`, `started_at`, `ends_at`. |
| `puzzles` | Generated grid for an event: width, height, cell list. |
| `puzzle_entries` | Per entry: number, direction, row, col, length, clue, **answer**. |
| `participants` | Employee ID, display name, session token, `joined_at`, `finished_at`, `solved_count`. |
| `solved_entries` | One row per (participant, entry) solved, with server timestamp. |
| `progress` | Autosaved partial grid per participant, so a dropped connection does not lose work. |
| `guess_attempts` | Attempt log for rate limiting and cheat review. |

Ranking is `finished_at ASC` among participants who solved all entries; the top
three are simply the first three rows.

## 6. Public API (Postgres RPC)

Competitor (anon role):
- `join_event(employee_id, display_name)` → session token, event status
- `get_event_state(token)` → status, server time, `ends_at`, own solved count
- `get_puzzle(token)` → grid geometry + clues, **no answers**
- `check_answer(token, entry_id, guess)` → `{ correct, solved_count, finished }`
- `save_progress(token, grid_state)` → ok

Admin (authenticated role):
- `create_event`, `set_puzzle`, `start_event(duration_seconds)`, `end_event`
- `admin_leaderboard(event_id)`, `release_participant(participant_id)`

## 7. Grid generation

`web/js/generator.js` is a dependency-free freeform ("criss-cross") generator
that runs identically in the admin's browser and in the Node test suite.

- Longest answer is laid first; each subsequent answer is placed at its
  best-scoring intersection, favouring more crossings and a tighter box.
- Repeated passes, then 200 seeded restarts; the best grid wins.
- Rules enforced: no two entries in the same direction overlap, no letter sits
  immediately before or after an entry, and an empty square being filled must
  not touch letters on its perpendicular sides. The test suite re-derives every
  maximal letter run in both directions and asserts each one is a declared
  entry — this is what catches accidental adjacency.
- Output is deterministic per seed, so the admin can press "Regenerate" to see a
  different layout and keep the one they like.
- Anything that cannot be interlocked is returned in `unplaced` and shown to the
  admin. It is never silently dropped.

On a realistic 20-word set the generator placed all 20 in a 15×19 grid with 20
crossings.

## 8. Mobile

- Grid is an SVG/CSS grid in a pinch-zoomable, scrollable container. At 15
  columns on a 360 px screen a cell is ~22 px, which is legible but tight, so
  the grid also supports zoom and auto-scrolls the active cell into view.
- Tapping a square selects its entry; the clue for the current entry is pinned
  above the on-screen keyboard, so the competitor never scrolls to read it.
- A single hidden input drives the device keyboard; typing advances along the
  entry, backspace reverses.
- Across/Down toggle on tapping an intersection square.
- Solved entries lock, turn green and become read-only.
- Works on iOS Safari, Android Chrome, and desktop browsers. No app install.

## 9. Free-tier sizing for 150 competitors

Estimated calls per competitor over a 30-minute event: 1 join, 1 puzzle fetch,
~180 state polls (5 s while waiting, 15 s while playing), ~40 answer checks,
~120 progress autosaves — roughly 340 calls.

At 150 competitors that is ~51,000 database calls and ~150 MB of egress,
peaking around 28 requests/second. Supabase Free allows 5 GB egress per month
and does not cap request counts, so this fits with a wide margin. Static asset
traffic on Cloudflare Pages is unmetered.

## 10. Build plan (2–4 weeks)

1. Grid generator + test suite — **done**
2. Supabase schema, RLS and RPC functions, with SQL tests for the security rules
3. Competitor flow: join → waiting room → grid → finished
4. Admin console: clue entry, generate/preview/regenerate, start, live board, export
5. Mobile polish and cross-browser pass (iOS Safari, Android Chrome)
6. Load test simulating 150 concurrent players against the real deployment
7. Dry run with real colleagues

## 11. Pre-event checklist

- [ ] Wake the Supabase project (Free projects pause after a week idle)
- [ ] Clue and answer set entered, grid generated and approved, `unplaced` empty
- [ ] Event duration set
- [ ] Admin password rotated; admin logged in on a second device as backup
- [ ] Dry run completed with at least 10 real devices
- [ ] Competitor URL and QR code distributed
- [ ] Decide how long employee IDs are retained after the event, and who deletes them

## 12. Open items

- Data retention period for employee IDs and names (PDPA).
- Branding: logo, colours, event name on the waiting screen.
- Tie-break if two people finish in the same second (proposal: fewer total
  wrong guesses, then earlier join time).
- Whether a roster CSV becomes available before the event.
