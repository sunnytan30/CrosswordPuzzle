-- Crossword competition: administrator functions.
--
-- These are granted to `authenticated`, but every one calls app.require_admin()
-- first, so merely holding a Supabase account is not enough. Email signups
-- should also be disabled in the dashboard so no one can self-register.

create or replace function public.admin_whoami()
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select json_build_object(
    'is_admin', app.is_admin(),
    'user_id',  (select auth.uid())
  );
$$;

create or replace function public.admin_list_events()
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_admin();

  return coalesce((
    select json_agg(
             json_build_object(
               'id',               e.id,
               'name',             e.name,
               'status',           app.effective_status(e.status, e.ends_at),
               'raw_status',       e.status,
               'duration_seconds', e.duration_seconds,
               'started_at',       e.started_at,
               'ends_at',          e.ends_at,
               'created_at',       e.created_at,
               'entry_count',      app.entry_count(e.id),
               'participant_count',
                 (select count(*) from app.participants p where p.event_id = e.id)
             )
             order by e.created_at desc
           )
      from app.events e
  ), '[]'::json);
end;
$$;

create or replace function public.admin_create_event(
  p_name             text,
  p_duration_seconds integer
)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform app.require_admin();

  if p_name is null or char_length(trim(p_name)) = 0 then
    raise exception 'Please give the competition a name.';
  end if;

  if p_duration_seconds is null or p_duration_seconds not between 60 and 14400 then
    raise exception 'Duration must be between 1 minute and 4 hours.';
  end if;

  insert into app.events (name, duration_seconds, created_by)
  values (trim(p_name), p_duration_seconds, (select auth.uid()))
  returning id into v_id;

  return json_build_object('id', v_id);
end;
$$;

create or replace function public.admin_set_puzzle(p_event_id uuid, p_puzzle jsonb)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event     app.events;
  v_puzzle_id uuid;
  v_count     integer;
begin
  perform app.require_admin();

  select * into v_event from app.events where id = p_event_id;
  if not found then
    raise exception 'Unknown competition.';
  end if;

  -- Replacing the grid mid-event would invalidate everyone's progress.
  if v_event.status <> 'draft' then
    raise exception 'The puzzle can only be set while the competition is still a draft.';
  end if;

  if jsonb_typeof(p_puzzle -> 'entries') <> 'array'
     or jsonb_array_length(p_puzzle -> 'entries') = 0 then
    raise exception 'The puzzle must contain at least one entry.';
  end if;

  delete from app.puzzles where event_id = p_event_id;

  insert into app.puzzles (event_id, width, height, cells, seed)
  values (
    p_event_id,
    (p_puzzle ->> 'width')::smallint,
    (p_puzzle ->> 'height')::smallint,
    coalesce(p_puzzle -> 'cells', '[]'::jsonb),
    coalesce((p_puzzle ->> 'seed')::integer, 0)
  )
  returning id into v_puzzle_id;

  insert into app.puzzle_entries
    (puzzle_id, number, direction, row_index, col_index, length, clue, answer)
  select
    v_puzzle_id,
    (e ->> 'number')::smallint,
    e ->> 'direction',
    (e ->> 'row')::smallint,
    (e ->> 'col')::smallint,
    (e ->> 'length')::smallint,
    e ->> 'clue',
    upper(e ->> 'answer')
  from jsonb_array_elements(p_puzzle -> 'entries') as e;

  select count(*)::integer into v_count
    from app.puzzle_entries where puzzle_id = v_puzzle_id;

  return json_build_object('puzzle_id', v_puzzle_id, 'entry_count', v_count);
end;
$$;

create or replace function public.admin_open_event(p_event_id uuid)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event app.events;
begin
  perform app.require_admin();

  select * into v_event from app.events where id = p_event_id;
  if not found then raise exception 'Unknown competition.'; end if;

  if v_event.status <> 'draft' then
    raise exception 'Only a draft competition can be opened.';
  end if;

  if app.entry_count(p_event_id) = 0 then
    raise exception 'Set the puzzle before opening the competition.';
  end if;

  -- The unique index on active_marker turns "another event is already open"
  -- into a constraint violation rather than a silent second event.
  begin
    update app.events set status = 'open' where id = p_event_id;
  exception when unique_violation then
    raise exception 'Another competition is already open or running. End it first.';
  end;

  return json_build_object('status', 'open');
end;
$$;

create or replace function public.admin_start_event(p_event_id uuid)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event app.events;
  v_now   timestamptz;
begin
  perform app.require_admin();

  select * into v_event from app.events where id = p_event_id;
  if not found then raise exception 'Unknown competition.'; end if;

  if v_event.status <> 'open' then
    raise exception 'Open the competition for joining before starting it.';
  end if;

  -- One shared clock for everyone, stamped by the database. Late joiners get
  -- this same ends_at, so they simply have less time remaining.
  v_now := now();

  update app.events
     set status     = 'running',
         started_at = v_now,
         ends_at    = v_now + make_interval(secs => v_event.duration_seconds)
   where id = p_event_id;

  return json_build_object(
    'status',     'running',
    'started_at', v_now,
    'ends_at',    v_now + make_interval(secs => v_event.duration_seconds)
  );
end;
$$;

create or replace function public.admin_end_event(p_event_id uuid)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform app.require_admin();

  update app.events
     set status  = 'ended',
         ends_at = least(coalesce(ends_at, now()), now())
   where id = p_event_id
     and status in ('open', 'running');

  if not found then
    raise exception 'That competition is not open or running.';
  end if;

  return json_build_object('status', 'ended');
end;
$$;

create or replace function public.admin_leaderboard(p_event_id uuid)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_total integer;
begin
  perform app.require_admin();

  v_total := app.entry_count(p_event_id);

  return coalesce((
    select json_agg(row_to_json(r) order by r.rank)
      from (
        select
          row_number() over (
            order by
              (p.finished_at is null),   -- finishers first
              p.finished_at asc,          -- then fastest
              p.solved_count desc,        -- then most solved
              p.wrong_guesses asc,        -- tie-break: fewer wrong guesses
              p.joined_at asc             -- then whoever joined earlier
          ) as rank,
          p.id,
          p.employee_id,
          p.display_name,
          p.solved_count,
          v_total as total_entries,
          p.wrong_guesses,
          p.joined_at,
          p.finished_at,
          p.last_seen_at,
          p.released_at is not null as released,
          case
            when p.finished_at is not null
              then round(extract(epoch from (p.finished_at - e.started_at))::numeric, 1)
          end as finish_seconds
        from app.participants p
        join app.events e on e.id = p.event_id
       where p.event_id = p_event_id
      ) r
  ), '[]'::json);
end;
$$;

create or replace function public.admin_release_participant(p_participant_id uuid)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform app.require_admin();

  -- Releases the employee ID so the competitor can re-join from another
  -- device. Their solved entries and progress are kept.
  update app.participants
     set released_at = now()
   where id = p_participant_id;

  if not found then
    raise exception 'Unknown competitor.';
  end if;

  return json_build_object('ok', true);
end;
$$;

create or replace function public.admin_reset_event(p_event_id uuid, p_confirm text)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  perform app.require_admin();

  -- Destructive, so it takes an explicit confirmation string. Intended for
  -- clearing a dry run before the real event.
  if p_confirm is distinct from 'RESET' then
    raise exception 'Reset requires explicit confirmation.';
  end if;

  delete from app.participants where event_id = p_event_id;
  get diagnostics v_deleted = row_count;

  update app.events
     set status     = 'draft',
         started_at = null,
         ends_at    = null
   where id = p_event_id;

  return json_build_object('ok', true, 'participants_removed', v_deleted);
end;
$$;
