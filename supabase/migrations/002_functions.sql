-- Crossword competition: the only public surface.
--
-- Tables live in `app`, which PostgREST does not expose. These SECURITY
-- DEFINER functions in `public` are therefore the entire API. Every one sets
-- an empty search_path and fully qualifies its names, so a caller cannot
-- shadow a function or table to change what runs.

-- ------------------------------------------------------------- helpers ----

create or replace function app.effective_status(p_status text, p_ends_at timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  -- An event whose duration has elapsed is ended, whether or not an
  -- administrator has pressed Stop. The clock is authoritative, not the flag.
  select case
           when p_status = 'running'
                and p_ends_at is not null
                and now() >= p_ends_at then 'ended'
           else p_status
         end;
$$;

create or replace function app.hash_token(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

create or replace function app.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.admins a where a.user_id = (select auth.uid())
  );
$$;

create or replace function app.require_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app.is_admin() then
    raise exception 'Administrator access required.' using errcode = '28000';
  end if;
end;
$$;

create or replace function app.participant_for_token(p_token text)
returns app.participants
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_participant app.participants;
begin
  if p_token is null or char_length(p_token) <> 64 then
    raise exception 'Your session has expired. Please join again.' using errcode = '28000';
  end if;

  select * into v_participant
    from app.participants
   where token_hash = app.hash_token(p_token);

  if not found then
    raise exception 'Your session has expired. Please join again.' using errcode = '28000';
  end if;

  return v_participant;
end;
$$;

create or replace function app.entry_count(p_event_id uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer
    from app.puzzle_entries e
    join app.puzzles p on p.id = e.puzzle_id
   where p.event_id = p_event_id;
$$;

-- --------------------------------------------------------- competitors ----

create or replace function public.join_event(
  p_employee_id  text,
  p_display_name text
)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event          app.events;
  v_name           text;
  v_existing       app.participants;
  v_token          text;
  v_participant_id uuid;
begin
  v_name := trim(regexp_replace(coalesce(p_display_name, ''), '\s+', ' ', 'g'));

  if p_employee_id is null or p_employee_id !~ '^[0-9]{8}$' then
    raise exception 'Your employee ID must be exactly 8 digits.';
  end if;

  if char_length(v_name) < 2 or char_length(v_name) > 60 then
    raise exception 'Please enter your name (2 to 60 characters).';
  end if;

  select * into v_event
    from app.events
   where status in ('open', 'running')
   limit 1;

  if not found then
    raise exception 'No competition is open at the moment. Please wait for the administrator.';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  select * into v_existing
    from app.participants
   where event_id = v_event.id
     and employee_id = p_employee_id;

  if found then
    -- One active session per employee ID. An administrator can release an ID
    -- so a competitor can move to a different device.
    if v_existing.released_at is null then
      raise exception
        'Employee ID % is already in this competition on another device. Ask the administrator to release it.',
        p_employee_id;
    end if;

    update app.participants
       set token_hash   = app.hash_token(v_token),
           display_name = v_name,
           released_at  = null,
           last_seen_at = now()
     where id = v_existing.id;

    v_participant_id := v_existing.id;
  else
    begin
      insert into app.participants (event_id, employee_id, display_name, token_hash)
      values (v_event.id, p_employee_id, v_name, app.hash_token(v_token))
      returning id into v_participant_id;
    exception when unique_violation then
      -- Two devices raced for the same ID; the other one won.
      raise exception
        'Employee ID % is already in this competition on another device. Ask the administrator to release it.',
        p_employee_id;
    end;
  end if;

  return json_build_object(
    'token',          v_token,
    'participant_id', v_participant_id,
    'display_name',   v_name,
    'event', json_build_object(
      'id',     v_event.id,
      'name',   v_event.name,
      'status', app.effective_status(v_event.status, v_event.ends_at)
    )
  );
end;
$$;

create or replace function public.get_event_state(p_token text)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_p     app.participants;
  v_event app.events;
begin
  v_p := app.participant_for_token(p_token);

  select * into v_event from app.events where id = v_p.event_id;

  update app.participants set last_seen_at = now() where id = v_p.id;

  return json_build_object(
    'status',           app.effective_status(v_event.status, v_event.ends_at),
    'event_name',       v_event.name,
    -- The client uses server_time to derive its clock offset once, then
    -- counts down locally and re-syncs periodically. Ranking never depends
    -- on the device clock.
    'server_time',      now(),
    'started_at',       v_event.started_at,
    'ends_at',          v_event.ends_at,
    'duration_seconds', v_event.duration_seconds,
    'display_name',     v_p.display_name,
    'solved_count',     v_p.solved_count,
    'total_entries',    app.entry_count(v_event.id),
    'finished_at',      v_p.finished_at
  );
end;
$$;

create or replace function public.get_puzzle(p_token text)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_p      app.participants;
  v_event  app.events;
  v_status text;
  v_puzzle app.puzzles;
  v_result json;
begin
  v_p := app.participant_for_token(p_token);

  select * into v_event from app.events where id = v_p.event_id;
  v_status := app.effective_status(v_event.status, v_event.ends_at);

  if v_status not in ('running', 'ended') then
    raise exception 'The competition has not started yet.';
  end if;

  select * into v_puzzle from app.puzzles where event_id = v_event.id;
  if not found then
    raise exception 'No puzzle has been set for this competition.';
  end if;

  update app.participants set last_seen_at = now() where id = v_p.id;

  -- Note the deliberate absence of `answer`. The grid geometry, clue text and
  -- entry lengths go to the browser; the letters never do.
  select json_build_object(
    'width',  v_puzzle.width,
    'height', v_puzzle.height,
    'cells',  v_puzzle.cells,
    'entries', coalesce((
      select json_agg(
               json_build_object(
                 'id',        e.id,
                 'number',    e.number,
                 'direction', e.direction,
                 'row',       e.row_index,
                 'col',       e.col_index,
                 'length',    e.length,
                 'clue',      e.clue
               )
               order by e.number, e.direction
             )
        from app.puzzle_entries e
       where e.puzzle_id = v_puzzle.id
    ), '[]'::json),
    'solved_entry_ids', coalesce((
      select json_agg(s.entry_id)
        from app.solved_entries s
       where s.participant_id = v_p.id
    ), '[]'::json),
    'grid_state', coalesce(
      (select pr.grid_state from app.progress pr where pr.participant_id = v_p.id),
      '{}'::jsonb
    )
  ) into v_result;

  return v_result;
end;
$$;

create or replace function public.check_answer(
  p_token    text,
  p_entry_id uuid,
  p_guess    text
)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_p        app.participants;
  v_event    app.events;
  v_entry    app.puzzle_entries;
  v_last     timestamptz;
  v_attempts integer;
  v_correct  boolean;
  v_solved   integer;
  v_total    integer;
  v_finished timestamptz;
  v_guess    text;
begin
  v_p := app.participant_for_token(p_token);
  select * into v_event from app.events where id = v_p.event_id;

  -- Rejecting submissions outside the window is what makes the hard stop real.
  if app.effective_status(v_event.status, v_event.ends_at) <> 'running' then
    raise exception 'The competition is not running.';
  end if;

  select e.* into v_entry
    from app.puzzle_entries e
    join app.puzzles p on p.id = e.puzzle_id
   where e.id = p_entry_id
     and p.event_id = v_event.id;

  if not found then
    raise exception 'Unknown clue.';
  end if;

  if exists (
    select 1 from app.solved_entries s
     where s.participant_id = v_p.id and s.entry_id = p_entry_id
  ) then
    return json_build_object(
      'correct', true, 'already_solved', true,
      'solved_count', v_p.solved_count,
      'total_entries', app.entry_count(v_event.id),
      'finished', v_p.finished_at is not null
    );
  end if;

  -- Per-entry cooldown: blunts brute-forcing one word without penalising an
  -- honest competitor, who rarely retries the same clue twice in 3 seconds.
  select max(attempted_at) into v_last
    from app.guess_attempts
   where participant_id = v_p.id and entry_id = p_entry_id;

  if v_last is not null and v_last > now() - interval '3 seconds' then
    return json_build_object(
      'correct', false,
      'cooldown', true,
      'retry_after_ms',
        ceil(extract(epoch from (v_last + interval '3 seconds' - now())) * 1000)::integer
    );
  end if;

  select count(*) into v_attempts
    from app.guess_attempts where participant_id = v_p.id;

  if v_attempts >= 2000 then
    raise exception 'Too many attempts recorded for this session.';
  end if;

  -- Normalise the way a phone keyboard behaves: letters only, case-insensitive.
  v_guess  := upper(regexp_replace(coalesce(p_guess, ''), '[^A-Za-z]', '', 'g'));
  v_correct := v_guess = v_entry.answer;

  insert into app.guess_attempts (participant_id, entry_id, correct)
  values (v_p.id, p_entry_id, v_correct);

  if not v_correct then
    update app.participants
       set wrong_guesses = wrong_guesses + 1,
           last_seen_at  = now()
     where id = v_p.id;

    -- A bare false. No per-letter feedback, so a wrong guess leaks nothing.
    return json_build_object(
      'correct', false,
      'solved_count', v_p.solved_count,
      'total_entries', app.entry_count(v_event.id)
    );
  end if;

  insert into app.solved_entries (participant_id, entry_id)
  values (v_p.id, p_entry_id)
  on conflict do nothing;

  select count(*)::integer into v_solved
    from app.solved_entries where participant_id = v_p.id;

  v_total := app.entry_count(v_event.id);

  update app.participants
     set solved_count  = v_solved,
         last_seen_at  = now(),
         finished_at   = case
                           when v_solved >= v_total and finished_at is null
                             then now()
                           else finished_at
                         end
   where id = v_p.id
   returning finished_at into v_finished;

  return json_build_object(
    'correct', true,
    'solved_count', v_solved,
    'total_entries', v_total,
    'finished', v_finished is not null,
    'finished_at', v_finished
  );
end;
$$;

create or replace function public.save_progress(p_token text, p_grid_state jsonb)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_p app.participants;
begin
  v_p := app.participant_for_token(p_token);

  if p_grid_state is null or jsonb_typeof(p_grid_state) <> 'object' then
    raise exception 'Invalid progress payload.';
  end if;

  if pg_column_size(p_grid_state) > 20000 then
    raise exception 'Progress payload too large.';
  end if;

  insert into app.progress (participant_id, grid_state)
  values (v_p.id, p_grid_state)
  on conflict (participant_id)
  do update set grid_state = excluded.grid_state, updated_at = now();

  update app.participants set last_seen_at = now() where id = v_p.id;

  return json_build_object('ok', true);
end;
$$;
