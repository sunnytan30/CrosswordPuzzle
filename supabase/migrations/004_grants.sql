-- Crossword competition: execute grants.
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default, so every
-- function is revoked first and then granted back to exactly the roles that
-- need it. The admin functions still check app.require_admin() themselves —
-- these grants are the outer of two locks, not the only one.

-- Internal helpers are unreachable anyway (anon and authenticated have no
-- USAGE on the app schema), but revoke them too so a future schema grant
-- cannot quietly open a door.
revoke execute on function app.effective_status(text, timestamptz) from public;
revoke execute on function app.hash_token(text)                    from public;
revoke execute on function app.is_admin()                          from public;
revoke execute on function app.require_admin()                     from public;
revoke execute on function app.participant_for_token(text)         from public;
revoke execute on function app.entry_count(uuid)                   from public;

-- Competitors. These are the only functions an unauthenticated browser may
-- call, and none of them can read or infer an answer.
revoke execute on function public.join_event(text, text)             from public;
revoke execute on function public.get_event_state(text)              from public;
revoke execute on function public.get_puzzle(text)                   from public;
revoke execute on function public.check_answer(text, uuid, text)     from public;
revoke execute on function public.save_progress(text, jsonb)         from public;

grant execute on function public.join_event(text, text)              to anon, authenticated;
grant execute on function public.get_event_state(text)               to anon, authenticated;
grant execute on function public.get_puzzle(text)                    to anon, authenticated;
grant execute on function public.check_answer(text, uuid, text)      to anon, authenticated;
grant execute on function public.save_progress(text, jsonb)          to anon, authenticated;

-- Administrators. Granted to signed-in users only, then gated again on
-- membership of app.admins inside each function.
revoke execute on function public.admin_whoami()                          from public;
revoke execute on function public.admin_list_events()                     from public;
revoke execute on function public.admin_create_event(text, integer)       from public;
revoke execute on function public.admin_set_puzzle(uuid, jsonb)           from public;
revoke execute on function public.admin_open_event(uuid)                  from public;
revoke execute on function public.admin_start_event(uuid)                 from public;
revoke execute on function public.admin_end_event(uuid)                   from public;
revoke execute on function public.admin_leaderboard(uuid)                 from public;
revoke execute on function public.admin_release_participant(uuid)         from public;
revoke execute on function public.admin_reset_event(uuid, text)           from public;

grant execute on function public.admin_whoami()                           to authenticated;
grant execute on function public.admin_list_events()                      to authenticated;
grant execute on function public.admin_create_event(text, integer)        to authenticated;
grant execute on function public.admin_set_puzzle(uuid, jsonb)            to authenticated;
grant execute on function public.admin_open_event(uuid)                   to authenticated;
grant execute on function public.admin_start_event(uuid)                  to authenticated;
grant execute on function public.admin_end_event(uuid)                    to authenticated;
grant execute on function public.admin_leaderboard(uuid)                  to authenticated;
grant execute on function public.admin_release_participant(uuid)          to authenticated;
grant execute on function public.admin_reset_event(uuid, text)            to authenticated;
