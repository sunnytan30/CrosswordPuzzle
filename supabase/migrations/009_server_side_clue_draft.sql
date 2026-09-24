-- Clue drafts were kept in the administrator's browser only, so work in
-- progress did not follow them to another device. The draft now lives with
-- the competition.
--
-- It holds answers, so it sits in the app schema like everything else and is
-- reachable only through the admin functions below.
alter table app.events add column if not exists clue_draft jsonb;
alter table app.events add column if not exists clue_draft_updated_at timestamptz;

comment on column app.events.clue_draft is
  'Work in progress from the clue editor: [{clue, answer}, ...]. Contains answers.';

create or replace function public.admin_save_draft(p_event_id uuid, p_rows jsonb)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform app.require_admin();

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Invalid draft payload.';
  end if;

  -- A 60-row draft is a few kilobytes; this is a sanity bound, not a limit
  -- anyone will meet.
  if pg_column_size(p_rows) > 200000 then
    raise exception 'Draft too large.';
  end if;

  update app.events
     set clue_draft = p_rows,
         clue_draft_updated_at = now()
   where id = p_event_id;

  if not found then
    raise exception 'Unknown competition.';
  end if;

  return json_build_object('ok', true, 'rows', jsonb_array_length(p_rows), 'saved_at', now());
end;
$$;

create or replace function public.admin_get_draft(p_event_id uuid)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_event app.events;
  v_rows  jsonb;
begin
  perform app.require_admin();

  select * into v_event from app.events where id = p_event_id;
  if not found then
    raise exception 'Unknown competition.';
  end if;

  if v_event.clue_draft is not null and jsonb_array_length(v_event.clue_draft) > 0 then
    return json_build_object(
      'rows', v_event.clue_draft,
      'source', 'draft',
      'saved_at', v_event.clue_draft_updated_at
    );
  end if;

  -- No draft, but the competition may already have a saved puzzle. Loading
  -- its clues back means an administrator on a new device sees the clues that
  -- are actually in play rather than an empty table.
  select jsonb_agg(jsonb_build_object('clue', e.clue, 'answer', e.answer)
                   order by e.number, e.direction)
    into v_rows
    from app.puzzle_entries e
    join app.puzzles p on p.id = e.puzzle_id
   where p.event_id = p_event_id;

  if v_rows is not null then
    return json_build_object('rows', v_rows, 'source', 'puzzle', 'saved_at', null);
  end if;

  return json_build_object('rows', '[]'::jsonb, 'source', 'none', 'saved_at', null);
end;
$$;

revoke execute on function public.admin_save_draft(uuid, jsonb) from public, anon;
revoke execute on function public.admin_get_draft(uuid)         from public, anon;

grant execute on function public.admin_save_draft(uuid, jsonb) to authenticated;
grant execute on function public.admin_get_draft(uuid)         to authenticated;
