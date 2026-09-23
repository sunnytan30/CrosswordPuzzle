-- Crossword competition: private schema and tables.
--
-- Every table lives in the `app` schema, which is deliberately NOT one of the
-- schemas PostgREST exposes. There is therefore no REST endpoint for any table
-- in this file, whatever the grants say. The only way in is the SECURITY
-- DEFINER functions in `public` (see 002_functions.sql).

create schema if not exists app;

revoke all on schema app from public;
revoke all on schema app from anon, authenticated;

-- ---------------------------------------------------------------- events ---

create table app.events (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (char_length(trim(name)) between 1 and 120),
  status           text not null default 'draft'
                     check (status in ('draft', 'open', 'running', 'ended')),
  duration_seconds integer not null default 1800
                     check (duration_seconds between 60 and 14400),
  started_at       timestamptz,
  ends_at          timestamptz,
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  -- true for exactly one event at a time, NULL otherwise. The unique index
  -- below then makes "two events open at once" impossible rather than merely
  -- discouraged.
  active_marker    boolean generated always as
                     (case when status in ('open', 'running') then true end) stored
);

create unique index events_single_active on app.events (active_marker);

comment on column app.events.ends_at is
  'Server-side hard stop. check_answer refuses anything at or after this time.';

-- --------------------------------------------------------------- puzzles ---

create table app.puzzles (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null unique references app.events (id) on delete cascade,
  width      smallint not null check (width between 1 and 60),
  height     smallint not null check (height between 1 and 60),
  -- [{ "row": 0, "col": 3, "number": 1 | null }, ...]
  cells      jsonb not null,
  seed       integer not null,
  created_at timestamptz not null default now()
);

create table app.puzzle_entries (
  id         uuid primary key default gen_random_uuid(),
  puzzle_id  uuid not null references app.puzzles (id) on delete cascade,
  number     smallint not null check (number > 0),
  direction  text not null check (direction in ('across', 'down')),
  row_index  smallint not null check (row_index >= 0),
  col_index  smallint not null check (col_index >= 0),
  length     smallint not null check (length between 3 and 15),
  clue       text not null check (char_length(trim(clue)) between 1 and 300),
  answer     text not null check (answer ~ '^[A-Z]{3,15}$'),
  constraint puzzle_entries_unique_slot unique (puzzle_id, number, direction),
  constraint puzzle_entries_length_matches_answer check (length = char_length(answer))
);

create index puzzle_entries_by_puzzle on app.puzzle_entries (puzzle_id);

comment on column app.puzzle_entries.answer is
  'Never leaves the database. Only check_answer reads it, and it returns a bare boolean.';

-- ---------------------------------------------------------- participants ---

create table app.participants (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references app.events (id) on delete cascade,
  employee_id   text not null check (employee_id ~ '^[0-9]{8}$'),
  display_name  text not null check (char_length(trim(display_name)) between 1 and 60),
  -- SHA-256 of the session token. The raw token exists only in the
  -- competitor's browser, so a database leak does not let anyone play as them.
  token_hash    text not null,
  joined_at     timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  solved_count  smallint not null default 0 check (solved_count >= 0),
  wrong_guesses integer not null default 0 check (wrong_guesses >= 0),
  finished_at   timestamptz,
  released_at   timestamptz,
  constraint participants_one_per_event unique (event_id, employee_id)
);

create index participants_ranking
  on app.participants (event_id, finished_at)
  where finished_at is not null;

comment on column app.participants.released_at is
  'Set by an administrator to let an employee ID re-join from a different device.';

-- ---------------------------------------------------- play state and logs ---

create table app.solved_entries (
  participant_id uuid not null references app.participants (id) on delete cascade,
  entry_id       uuid not null references app.puzzle_entries (id) on delete cascade,
  solved_at      timestamptz not null default now(),
  primary key (participant_id, entry_id)
);

create table app.progress (
  participant_id uuid primary key references app.participants (id) on delete cascade,
  grid_state     jsonb not null,
  updated_at     timestamptz not null default now()
);

create table app.guess_attempts (
  id             bigint generated always as identity primary key,
  participant_id uuid not null references app.participants (id) on delete cascade,
  entry_id       uuid not null references app.puzzle_entries (id) on delete cascade,
  correct        boolean not null,
  attempted_at   timestamptz not null default now()
);

create index guess_attempts_cooldown
  on app.guess_attempts (participant_id, entry_id, attempted_at desc);

-- ---------------------------------------------------------------- admins ---

create table app.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text,
  created_at timestamptz not null default now()
);

-- Belt and braces: row-level security on every table, with no policies at all.
-- The table owner is exempt, so the SECURITY DEFINER functions still work,
-- while any other role is denied even if a future change accidentally exposes
-- the schema. Deliberately NOT `force row level security` — that would apply
-- RLS to the owner too and lock the functions out of their own tables.
alter table app.events          enable row level security;
alter table app.puzzles         enable row level security;
alter table app.puzzle_entries  enable row level security;
alter table app.participants    enable row level security;
alter table app.solved_entries  enable row level security;
alter table app.progress        enable row level security;
alter table app.guess_attempts  enable row level security;
alter table app.admins          enable row level security;
