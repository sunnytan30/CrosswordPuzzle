# Crossword Competition

An online crossword race for around 150 simultaneous competitors, playable in
any mobile or desktop browser, hosted on free tiers.

- Competitors enter an 8-digit employee ID and their name, then wait in a
  holding screen until the administrator starts the event.
- One shared clock. Each answer is checked on the server as it is completed and
  locks green when correct. The first three to complete all entries win.
- Administrators use a separate URL to enter 20 clue/answer pairs, generate and
  preview the grid, start and stop the event, and watch a live leaderboard.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full design, security model and
free-tier sizing.

## Status

Work in progress.

- [x] Crossword grid generator and test suite
- [ ] Database schema, row-level security and game logic
- [ ] Competitor web app
- [ ] Administrator console
- [ ] Load test and deployment

## Layout

```
web/js/generator.js   Freeform crossword generator (browser + Node)
tests/                Node test suite
docs/DESIGN.md        Design, security model, sizing, checklists
supabase/migrations/  Database schema and functions
```

## Development

Requires Node 22 or later. No dependencies.

```sh
npm test
```
