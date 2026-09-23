# Database

The migrations in `migrations/` are the source of truth. Applying them in
order to an empty Supabase project reproduces the competition database.

## Shape

- **`app` schema** — every table. It is *not* in PostgREST's exposed schemas,
  so no table here has a REST endpoint. Row-level security is enabled with no
  policies as a second layer; the table owner is exempt, which is what lets the
  SECURITY DEFINER functions through.
- **`public` schema** — the entire API, as SECURITY DEFINER functions. Each one
  pins `search_path = ''` and fully qualifies its names, so a caller cannot
  shadow a table or function to change what runs.
- **`test` schema** — the regression suite. Not exposed, not granted.

## The answer key

`app.puzzle_entries.answer` is read by exactly one function, `check_answer`,
which returns a bare boolean. `get_puzzle` deliberately omits it. There is no
code path that sends a letter of the answer key to a browser, and
`006_tests.sql` asserts this against the live payload.

## Grants

Postgres grants EXECUTE on new functions to `PUBLIC`, and Supabase's default
privileges additionally grant `anon` and `authenticated` explicitly. Both have
to be revoked — `004_grants.sql` does the first and `005_...sql` the second.
If you add a function, revoke from `anon` too, then re-run the linter.

## Running the tests

```sql
select * from test.run_all();
```

All 18 checks should pass. The fixture creates a *running* event and the
`events_single_active` index permits only one, so do not run this against a
live competition.

## Rebuilding from scratch

Apply `001` through `007` in order. Afterwards:

1. Create the administrator user in Authentication → Users.
2. Insert their `user_id` into `app.admins`.
3. Disable email signups in Authentication → Providers, so nobody can
   self-register and reach the admin endpoints.
