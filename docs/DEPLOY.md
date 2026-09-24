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

## 3. The frontend is deployed

It is live on Cloudflare Workers (static assets served from `web/`):

| Who | URL |
|---|---|
| Competitors | https://crosswordpuzzle.yb747cwjr8.workers.dev/ |
| Administrator | https://crosswordpuzzle.yb747cwjr8.workers.dev/admin/ |

Pushing to the connected branch redeploys automatically.

`web/_headers` sets a Content Security Policy permitting connections only to
the Supabase project. Cloudflare Workers static assets honour `_headers`, the
same as Pages.

### A caveat worth planning around

`*.workers.dev` subdomains are sometimes blocked by corporate web filters,
because the domain is shared by every free Worker and is therefore abused.
If any of your 150 competitors are on the office network or VPN, test from a
company-managed device before the day. If it is blocked, attach a custom
domain in the Worker's **Settings → Domains & Routes** — the app needs no
change for that, because the CSP constrains where the page connects *to*, not
where it is served *from*.

---

## Running the competition

1. Open the admin URL and sign in.
2. **Create competition** — name it and set the duration in minutes.
3. Set the **Competition title**. This is what competitors see as the heading
   on the join screen, the waiting room and the results screen, and as the
   browser tab title. You can change it at any time, including mid-event.
4. The first time, it asks **how many clues** you want and builds that many
   rows. Add or remove rows afterwards with **Add Row** and **Delete Row**, or
   the **×** at the end of each row. Deleting always asks first and names the
   row it is about to remove.
5. Enter your clues and answers. Answers must be a single word, letters only,
   3–15 characters, all different. The form names the row if one is wrong, and
   your draft is kept in the browser as you type.
6. **Generate.** Check the preview. **Try another layout** reshuffles it.
   - Anything under "Could not fit into the grid" was left out: swap that
     answer for one sharing more letters with the rest, or accept the loss.
   - A warning appears if a clue contains one of the puzzle's own answers,
     which hands it out for free. Reword unless it was deliberate.
7. **Use Grid** makes that grid the competition's puzzle. It then greys out to
   "Grid in use" so you cannot save the same grid twice; press **Generate**
   again to enable it for a different layout.
8. **Open Game.** Competitors can now enter their details and will sit in the
   waiting room.
9. **Start Game** when you are ready. One clock starts for everyone. Anyone
   arriving late joins immediately and simply has less time left.
10. Watch **Live results**. The first three finishers are highlighted.
    **End Game** stops it early if you need to.
11. **Export CSV** for the record, and check the employee IDs against HR.

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
- [ ] Competition title set.
- [ ] Clues entered, grid generated and used, nothing unplaced, no giveaway warnings.
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
