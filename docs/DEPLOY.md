# Deployment

The database already exists. What remains is creating your administrator
account and putting the frontend on Cloudflare Pages.

| | |
|---|---|
| Supabase project | `crossword-competition` |
| Project ref | `wtmzothubshasogrcbob` |
| Region | ap-southeast-1 (Singapore) |
| API URL | `https://wtmzothubshasogrcbob.supabase.co` |

The publishable key is already in `web/js/config.js`. It is meant to be public:
it grants only the `anon` role, which can call five functions and read no table.

---

## 1. Create the administrator account

In the Supabase dashboard, **check the project selector at the top left says
`crossword-competition`** — not `bike-maintenance-tracker`. This is the easiest
thing to get wrong, and creating the user in the other project looks like it
worked.

Then **Authentication → Users → Add user**:

- Enter your email and a strong password.
- Tick **Auto Confirm User**, otherwise you will be stuck waiting for a
  confirmation email.

Confirm the user landed in the right project. In **SQL Editor**:

```sql
select id, email from auth.users;
```

If that returns nothing, the user went to a different project. Switch projects
and create it again.

Now grant it administrator rights. This deliberately fails loudly rather than
quietly doing nothing if the email does not match:

```sql
do $$
declare
  v_email text := 'you@example.com';   -- <<< change this
  v_id    uuid;
begin
  select id into v_id from auth.users where lower(email) = lower(v_email);
  if v_id is null then
    raise exception
      'No user with email %. Create it under Authentication -> Users in THIS project first.', v_email;
  end if;
  insert into app.admins (user_id, email) values (v_id, v_email)
  on conflict (user_id) do nothing;
end $$;

-- Must return exactly one row. If it is empty, you are not an administrator yet.
select a.user_id, a.email from app.admins a;
```

## 2. Close the door behind you

**Authentication → Sign In / Providers → Email**: turn **Allow new users to
sign up** off.

This matters. The admin functions are granted to the `authenticated` role and
gated on membership of `app.admins`, so a stranger's account could not run your
competition. But with signups open, anyone could create an account against your
project, and there is no reason to allow that.

## 3. Deploy the frontend to Cloudflare Pages

1. Push this repository to GitHub.
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git**, and pick the repository.
3. Build settings:
   - Framework preset: **None**
   - Build command: *leave empty* — there is no build step
   - Build output directory: **`web`**
4. **Save and Deploy.** You get a URL like
   `https://crossword-competition.pages.dev`.

Every push to the branch redeploys automatically.

### After the first deploy

`web/_headers` sets a Content Security Policy that only permits connections to
the Supabase project. If you later move to a custom domain, nothing needs to
change there — the policy constrains where the page may *connect to*, not where
it is served from.

## 4. The two URLs

| Who | URL |
|---|---|
| Competitors | `https://<your-site>.pages.dev/` |
| Administrator | `https://<your-site>.pages.dev/admin/` |

Give competitors the first one, ideally as a QR code on a slide. The admin URL
is a separate page behind an email and password, not merely an obscure path.

---

## Running the competition

1. Open the admin URL and sign in.
2. **Create competition** — name it and set the duration in minutes.
3. Enter your 20 clues and answers. Answers must be a single word, letters
   only, 3–15 characters, all different. The form names the row if one is
   wrong, and your draft is kept in the browser as you type.
4. **Generate grid.** Check the preview. **Try another layout** reshuffles it.
   If anything appears under "Could not fit into the grid", swap that answer
   for one sharing more letters with the rest, or accept that it will be left
   out.
5. **Save this grid to the competition.**
6. **Open for joining.** Competitors can now enter their details and will sit
   in the waiting room.
7. **Start** when you are ready. One clock starts for everyone. Anyone arriving
   late joins immediately and simply has less time left.
8. Watch **Live results**. The first three finishers are highlighted.
9. **Export CSV** for the record, and check the employee IDs against HR.

### If something goes wrong on the day

| Problem | What to do |
|---|---|
| "Already in this competition on another device" | Find them in Live results and press **Release**. They can then join from the new device, keeping their progress. |
| Someone's phone died | Same: release them, then they re-join and their solved clues and typed letters come back. |
| You need to stop early | **End now.** Nobody can submit after that. |
| You want to rehearse first | Run the whole thing, then **Reset competition** to clear every competitor and return to draft. |

---

## Before the event

- [ ] **Wake the Supabase project.** Free projects pause after a week of
      inactivity. Open the dashboard a day before and confirm it says Active,
      then again on the morning.
- [ ] Clues entered, grid generated and saved, nothing unplaced.
- [ ] Duration set.
- [ ] Signups disabled, admin password stored in your password manager.
- [ ] A second device signed in to the admin console as a backup.
- [ ] Rehearsal done with at least ten real phones, then **Reset competition**.
- [ ] Competitor URL and QR code ready to distribute.
- [ ] Decide how long you keep employee IDs and names, and who deletes them.

## Testing before you trust it

```sh
npm install
npm test                 # generator unit tests plus 15 browser tests
npm run dev              # local dev server, no Supabase needed
```

Database tests run inside Postgres:

```sql
select * from test.run_all();   -- 18 checks; do not run during a live event
```

A load test drives a full field through the real endpoints:

```sh
node scripts/loadtest.mjs --base https://wtmzothubshasogrcbob.supabase.co \
  --key sb_publishable_ber-gmJFDSAxj0BNf5fntg_-bYC_obp \
  --players 150 --seconds 60
```

Run that against a rehearsal event, never a live one — it creates 150
competitors with employee IDs from 90000000 up. Afterwards, **Reset
competition**.

## Deleting the data afterwards

```sql
-- Removes every competitor, their progress and their attempt log.
delete from app.participants where event_id = '<event id>';
```

Or delete the whole Supabase project, which also frees your second free-tier
project slot.
