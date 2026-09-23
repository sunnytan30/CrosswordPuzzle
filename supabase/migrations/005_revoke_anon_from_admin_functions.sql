-- Supabase's default privileges grant anon and authenticated EXECUTE on every
-- new function in `public` explicitly, so `revoke ... from public` in 004 did
-- not remove it. Revoke from the named roles as well.
--
-- require_admin() inside each function already rejected anonymous callers;
-- this closes the outer lock so an unauthenticated browser cannot even reach
-- the admin endpoints.

revoke execute on function public.admin_whoami()                    from anon;
revoke execute on function public.admin_list_events()               from anon;
revoke execute on function public.admin_create_event(text, integer) from anon;
revoke execute on function public.admin_set_puzzle(uuid, jsonb)     from anon;
revoke execute on function public.admin_open_event(uuid)            from anon;
revoke execute on function public.admin_start_event(uuid)           from anon;
revoke execute on function public.admin_end_event(uuid)             from anon;
revoke execute on function public.admin_leaderboard(uuid)           from anon;
revoke execute on function public.admin_release_participant(uuid)   from anon;
revoke execute on function public.admin_reset_event(uuid, text)     from anon;

-- The internal helpers are not part of the API at all. anon and authenticated
-- have no USAGE on the app schema, but revoke explicitly so a later schema
-- grant cannot silently expose them.
revoke execute on function app.effective_status(text, timestamptz) from anon, authenticated;
revoke execute on function app.hash_token(text)                    from anon, authenticated;
revoke execute on function app.is_admin()                          from anon, authenticated;
revoke execute on function app.require_admin()                     from anon, authenticated;
revoke execute on function app.participant_for_token(text)         from anon, authenticated;
revoke execute on function app.entry_count(uuid)                   from anon, authenticated;
