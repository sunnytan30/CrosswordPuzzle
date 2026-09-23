-- Regression tests for the game logic and the security boundary.
--
-- Run with:  select * from test.run_all();
-- The `test` schema is not exposed and not granted to anon or authenticated.
--
-- Note: the fixture creates a running event, and the events_single_active
-- index permits only one. Do not run this against a live competition.

create schema if not exists test;
revoke all on schema test from public;
revoke all on schema test from anon, authenticated;

create or replace function test.run_all()
returns table(check_name text, passed boolean, detail text)
language plpgsql
volatile
as $$
declare
  v_event_id uuid;
  v_pz       uuid;
  v_token    text;
  v_res      json;
  v_txt      text;
  v_e1 uuid; v_e2 uuid; v_e3 uuid;
  v_fin timestamptz;
begin
  ------------------------------------------------------------------ fixture
  delete from app.events where name = 'TEST competition';

  insert into app.events (name, duration_seconds, status)
  values ('TEST competition', 600, 'draft') returning id into v_event_id;

  insert into app.puzzles (event_id, width, height, cells, seed)
  values (v_event_id, 6, 6, '[]'::jsonb, 1) returning id into v_pz;

  insert into app.puzzle_entries (puzzle_id, number, direction, row_index, col_index, length, clue, answer)
  values (v_pz, 1, 'across', 0, 0, 4, 'Chance of something going wrong', 'RISK') returning id into v_e1;
  insert into app.puzzle_entries (puzzle_id, number, direction, row_index, col_index, length, clue, answer)
  values (v_pz, 1, 'down', 0, 0, 5, 'Checked for accuracy', 'AUDIT') returning id into v_e2;
  insert into app.puzzle_entries (puzzle_id, number, direction, row_index, col_index, length, clue, answer)
  values (v_pz, 2, 'down', 0, 3, 4, 'Group working together', 'TEAM') returning id into v_e3;

  update app.events set status = 'open' where id = v_event_id;
  update app.events set status = 'running', started_at = now(),
                        ends_at = now() + interval '10 minutes'
   where id = v_event_id;

  -------------------------------------------------- anon cannot reach tables
  begin
    set local role anon;
    perform 1 from app.puzzle_entries limit 1;
    reset role;
    return query select 'anon cannot read app.puzzle_entries', false, 'SELECT unexpectedly succeeded';
  exception when insufficient_privilege or undefined_table then
    return query select 'anon cannot read app.puzzle_entries', true, null::text;
  end;

  begin
    set local role anon;
    perform 1 from app.participants limit 1;
    reset role;
    return query select 'anon cannot read app.participants', false, 'SELECT unexpectedly succeeded';
  exception when insufficient_privilege or undefined_table then
    return query select 'anon cannot read app.participants', true, null::text;
  end;

  ------------------------------------------- anon cannot reach admin API
  begin
    set local role anon;
    perform public.admin_list_events();
    reset role;
    return query select 'anon cannot call admin_list_events', false, 'call unexpectedly succeeded';
  exception when insufficient_privilege then
    return query select 'anon cannot call admin_list_events', true, 'EXECUTE denied'::text;
  when others then
    return query select 'anon cannot call admin_list_events', true, sqlerrm;
  end;

  ------------------------------------------------------------------- joining
  begin
    set local role anon;
    v_res := public.join_event('12345678', 'Test Competitor');
    reset role;
    v_token := v_res ->> 'token';
    return query select 'join_event issues a 64-char token',
                        char_length(coalesce(v_token, '')) = 64,
                        'length ' || char_length(coalesce(v_token, ''));
  end;

  begin
    set local role anon;
    perform public.join_event('1234567', 'Short Id');
    reset role;
    return query select 'join_event rejects a 7-digit employee ID', false, 'accepted';
  exception when others then
    return query select 'join_event rejects a 7-digit employee ID', true, null::text;
  end;

  begin
    set local role anon;
    perform public.join_event('12345678', 'Impostor');
    reset role;
    return query select 'second device on the same ID is refused', false, 'accepted';
  exception when others then
    return query select 'second device on the same ID is refused', true, null::text;
  end;

  ------------------------------------------------- the answer key stays put
  set local role anon;
  v_res := public.get_puzzle(v_token);
  reset role;
  v_txt := upper(v_res::text);

  return query select 'get_puzzle payload contains no answer text',
    (v_txt not like '%RISK%' and v_txt not like '%AUDIT%' and v_txt not like '%TEAM%'),
    left(v_txt, 200);

  return query select 'get_puzzle entries carry no answer field',
    not exists (
      select 1 from json_array_elements(v_res -> 'entries') e
       where e::jsonb ? 'answer'
    ), null::text;

  return query select 'get_puzzle returns all three clues',
    json_array_length(v_res -> 'entries') = 3,
    'got ' || json_array_length(v_res -> 'entries');

  ---------------------------------------------------------- checking answers
  set local role anon;
  v_res := public.check_answer(v_token, v_e1, 'WRONG');
  reset role;
  return query select 'a wrong guess returns correct=false',
    (v_res ->> 'correct') = 'false', v_res::text;

  return query select 'a wrong guess leaks no per-letter feedback',
    not (v_res::jsonb ?| array['answer', 'letters', 'correct_positions', 'hint']),
    v_res::text;

  set local role anon;
  v_res := public.check_answer(v_token, v_e1, 'WRONGAGAIN');
  reset role;
  return query select 'a second guess within 3s is cooled down',
    (v_res ->> 'cooldown') = 'true', v_res::text;

  -- Clear the cooldown the honest way: rewind the recorded attempt.
  update app.guess_attempts set attempted_at = now() - interval '10 seconds'
   where entry_id = v_e1;

  set local role anon;
  v_res := public.check_answer(v_token, v_e1, '  risk ');
  reset role;
  return query select 'a correct guess is accepted, case and space insensitive',
    (v_res ->> 'correct') = 'true', v_res::text;

  return query select 'solving one of three does not finish the puzzle',
    (v_res ->> 'finished') = 'false', v_res::text;

  --------------------------------------------------------------- finishing
  set local role anon;
  v_res := public.check_answer(v_token, v_e2, 'AUDIT');
  v_res := public.check_answer(v_token, v_e3, 'TEAM');
  reset role;

  return query select 'solving every entry finishes the puzzle',
    (v_res ->> 'finished') = 'true', v_res::text;

  select finished_at into v_fin from app.participants where employee_id = '12345678';
  return query select 'finish time is stamped by the server',
    v_fin is not null and v_fin <= now(), v_fin::text;

  ------------------------------------------------------- the hard stop bites
  update app.events set ends_at = now() - interval '1 second' where id = v_event_id;

  begin
    set local role anon;
    perform public.check_answer(v_token, v_e1, 'RISK');
    reset role;
    return query select 'submissions after ends_at are refused', false, 'accepted';
  exception when others then
    return query select 'submissions after ends_at are refused', true, null::text;
  end;

  return query select 'an elapsed event reports itself ended',
    app.effective_status('running', now() - interval '1 second') = 'ended', null::text;

  ------------------------------------------------------------------ cleanup
  delete from app.events where id = v_event_id;
end;
$$;
