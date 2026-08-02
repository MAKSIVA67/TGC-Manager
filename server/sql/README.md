# Database migrations

Card training, chemistry and the cup all need new columns and a new table.
Until the migration below is run, those three features quietly switch
themselves off — the app keeps working exactly as it did before, nothing
breaks, you just won't see them.

## How to run migration 002

1. Go to **https://supabase.com/dashboard** and sign in.
2. Click your **TCG Manager** project.
3. In the left sidebar, click the **SQL Editor** icon (it looks like a database
   symbol with `SQL` on it, roughly halfway down the list).
4. Click the green **+ New query** button at the top.
5. Open the file `server/sql/002_training_chemistry_cup.sql` from this repo,
   select everything in it (**Ctrl+A**) and copy it (**Ctrl+C**).
6. Click into the big empty editor box on the Supabase page and paste
   (**Ctrl+V**).
7. Click the green **Run** button at the bottom right (or press **Ctrl+Enter**).
8. You should see **Success. No rows returned** at the bottom. That is what
   success looks like here — this migration changes the database's shape, it
   doesn't return data.

The file is safe to run more than once. If you're unsure whether it worked,
just run it again — every statement checks whether it has already been applied.

### Checking it worked

Paste this into the same editor and press Run:

```sql
select level, shards from public.user_cards limit 1;
select league, region from public.cards limit 5;
select count(*) from public.cup_runs;
```

If all three return without an error, you're done. (The third will say `0` —
the table exists but nobody has entered the cup yet.)

### If something goes wrong

An error mentioning `relation "public.cards" does not exist` means you're on
the wrong Supabase project — check the project name at the top left.

Any other error: copy the full red message and send it over. Nothing is
half-applied in a way that breaks the app — the features stay hidden until the
migration completes cleanly.

## After running it

Chemistry needs each card to have a league and a region. The migration gives
every card a starting value (`Free Agents` / `World`, and `Legends` / `World`
for Icons and GOATs), so chemistry works immediately but links are weak.

To make it meaningful, set real values per card in the **Admin** tab. Cards
sharing a league link fully; cards sharing a region link at half strength.
Sensible leagues: `Premier League`, `La Liga`, `Serie A`, `Bundesliga`,
`Ligue 1`, `Legends`. Sensible regions: `Europe`, `South America`, `Africa`,
`Asia`, `North America`, `World`.

---

# Migration 003 — security fix (run this one)

**What it fixes:** right now any player can open the browser's developer
console and type one line to make themselves an admin of the game, or to
unban themselves after being banned. This closes that.

**Why it happened:** Supabase's default setup lets a signed-in user update
every column of their own profile row. That's correct for their gems and their
team name — but `is_admin` and `banned` sit on that same row, and the database
had no way to tell those apart. Migration 003 removes write access to just
those two columns and moves the admin panel's ban/promote buttons behind
functions that re-check your admin status inside the database, where a player
can't fake it.

**Do you have to run it?** The app works either way — the Ban and Make Admin
buttons fall back to the old behaviour if 003 hasn't been run. But the hole
stays open until you do. Worth doing soon.

## How to run migration 003

1. Go to **https://supabase.com/dashboard** and sign in.
2. Click your **TCG Manager** project.
3. In the left sidebar, click the **SQL Editor** icon (database symbol with
   `SQL` on it, roughly halfway down the list).
4. Click the green **+ New query** button at the top.
5. Open `server/sql/003_lock_down_admin_columns.sql` from this repo, select
   everything (**Ctrl+A**) and copy it (**Ctrl+C**).
6. Click into the big empty editor box on the Supabase page and paste
   (**Ctrl+V**).
7. Click the green **Run** button at the bottom right (or **Ctrl+Enter**).
8. You should see **Success. No rows returned**.

Safe to run more than once.

### Checking it worked

Paste this into the same editor and press Run:

```sql
select grantee, privilege_type, column_name
from information_schema.column_privileges
where table_schema='public' and table_name='profiles'
  and grantee in ('authenticated','anon') and privilege_type='UPDATE'
order by column_name;
```

Before the migration this returned 46 rows including `banned` and `is_admin`.
Afterwards there should be **no `is_admin` row, no `banned` row, and no `anon`
rows at all**. Everything else (gems, wins, team name...) should still be
listed — the app needs those.

Then check the admin panel still works: open the **Admin** tab, pick a player,
and confirm the **Ban Player** button still does what it says.

### If something goes wrong

If the Ban or Make Admin buttons stop working after running this, the most
likely cause is that your own account isn't flagged as an admin in the
database. Check with:

```sql
select display_name, is_admin from public.profiles where is_admin = true;
```

If that returns nothing, no one is an admin. Fix it by running this once (it
writes directly, bypassing the new rules, which is fine from the SQL editor):

```sql
update public.profiles set is_admin = true
where id = (select id from auth.users where email = 'your@email.here');
```

Replace `your@email.here` with the email you sign into the game with.

Any other error: copy the full red message and send it over.

## Still open after 003

003 stops players becoming admins. It does **not** stop a determined player
editing their own gems or card levels — the whole economy is still calculated
in the browser and trusted by the database. Closing that properly means moving
pack opening, training and match rewards into database functions, which is a
bigger job. It only affects that player's own account, so it's a much smaller
problem than someone gaining admin over everyone else.
