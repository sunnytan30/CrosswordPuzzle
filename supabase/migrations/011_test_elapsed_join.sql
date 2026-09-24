-- Regression test for 010: a competition whose clock has run out must not be
-- joinable, even while its stored status still reads 'running'.
--
-- Kept separate from test.run_all() so it can be run on its own. Like
-- run_all, it needs the single active-event slot, so do not run it while a
-- competition is open or running.
create or replace function test.elapsed_event_checks()
returns table(check_name text, passed boolean, detail text)
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_pz       uuid;
begin
  delete from app.events where name = 'TEST elapsed';

  insert into app.events (name, duration_seconds, status)
  values ('TEST elapsed', 600, 'draft') returning id into v_event_id;

  insert into app.puzzles (event_id, width, height, cells, seed)
  values (v_event_id, 4, 4, '[]'::jsonb, 1) returning id into v_pz;

  insert into app.puzzle_entries (puzzle_id, number, direction, row_index, col_index, length, clue, answer)
  values (v_pz, 1, 'across', 0, 0, 4, 'Chance of going wrong', 'RISK');

  -- A competition that started and whose clock has already run out, with
  -- nobody having pressed End: stored status still says running.
  update app.events set status = 'open' where id = v_event_id;
  update app.events
     set status = 'running',
         started_at = now() - interval '20 minutes',
         ends_at    = now() - interval '10 minutes'
   where id = v_event_id;

  return query select 'stored status still reads running',
    (select status from app.events where id = v_event_id) = 'running', null::text;

  return query select 'effective status reads ended',
    (select app.effective_status(status, ends_at) from app.events where id = v_event_id) = 'ended',
    null::text;

  begin
    set local role anon;
    perform public.join_event('77778888', 'Late Arrival');
    reset role;
    return query select 'an elapsed competition cannot be joined', false, 'the join was accepted';
  exception when others then
    return query select 'an elapsed competition cannot be joined', true, sqlerrm;
  end;

  begin
    set local role anon;
    return query select 'the public title lookup reports nothing open',
      (public.get_open_event() ->> 'status') = 'none', null::text;
    reset role;
  end;

  delete from app.events where id = v_event_id;
end;
$$;

revoke all on function test.elapsed_event_checks() from public, anon, authenticated;
