# Crossword Competition

An online crossword race for around 150 simultaneous competitors, playable in
any mobile or desktop browser, hosted on free tiers.

- Competitors enter an 8-digit employee ID and their name, then wait in a
  holding screen until the administrator starts the event.
- One shared clock for everyone. Each answer is checked on the server as it is
  completed and locks green when correct. The first three to finish win.
- Administrators use a separate URL to enter 20 clues and answers, generate and
  preview the grid, run the event, and watch a live leaderboard.

**[Deployment and run-day guide](docs/DEPLOY.md)** · **[Design and security
model](docs/DESIGN.md)** · **[Database](supabase/README.md)**

## Status

- [x] Crossword grid generator
- [x] Database schema, security boundary and game logic
- [x] Competitor web app
- [x] Administrator console
- [x] Test suites: generator, database, browser, load
- [ ] Deployed to Cloudflare Pages *(needs your account — see the deploy guide)*
- [ ] Administrator account created *(see the deploy guide)*
- [ ] Rehearsal with real devices

## How the outcome is kept honest

The prize makes this worth stating plainly.

- **The answer key never leaves the database.** Tables live in a schema
  PostgREST does not expose, so they have no REST endpoint. `get_puzzle` sends
  grid geometry, clue text and entry lengths — never a letter of the key.
- **Answers are checked in Postgres**, and a wrong guess returns a bare
  `false`. No per-letter feedback, so guessing reveals nothing.
- **Times are server times.** Start, end and finish are all stamped with the
  database's `now()`. A device's clock, timezone or latency cannot change a
  rank. The on-screen countdown is derived from the server's time and is
  cosmetic.
- **The hard stop is enforced server-side.** Submissions at or after the end
  time are refused, not merely hidden.
- **Sessions are opaque tokens**, stored hashed. Knowing a colleague's employee
  ID is not enough to play as them once they have joined.

One residual risk, stated honestly: with no employee roster to check against,
someone could enter a colleague's ID at the door. One-session-per-ID and the
ID-plus-name CSV export make that detectable afterwards rather than impossible
at the time. If a roster becomes available, adding it is a small change.

## Layout

```
web/                  The two apps. No build step, no dependencies.
  index.html          Competitor
  admin/index.html    Administrator
  js/generator.js     Crossword generator (also runs in Node)
  js/api.js           RPC client
  _headers            Cloudflare Pages security headers
supabase/migrations/  Database schema, functions, grants and tests
dev/server.mjs        Local server mirroring the Supabase API in memory
tests/                Generator unit tests and browser tests
scripts/loadtest.mjs  Simulates a full field against a live instance
docs/                 Design and deployment
```

## Development

Requires Node 22 or later.

```sh
npm install     # Playwright, for the browser tests only
npm run dev     # http://localhost:8787 — no Supabase needed
npm test        # generator unit tests plus 15 browser tests
```

The dev server serves both apps and implements the same RPC surface in memory,
seeded with a sample puzzle. Sign in to `/admin/` with `admin@example.com` /
`crossword`.

The database is the authority. If the dev server and the database ever
disagree, the database is right — `supabase/migrations/` is the source of
truth, and `select * from test.run_all();` checks it.
