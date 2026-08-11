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

---

# Migration 004 — tighten the write rules

**Run 003 first.** 004 assumes it.

**What it fixes**, all confirmed by reading the app's own code:

- **Balances can't go negative.** A bug in the cup entry fee can drive your
  gems below zero and save it. This stops the database accepting that,
  whatever the browser does.
- **Trades can't offer negative gems.** Someone could otherwise send an
  "offer" that drains gems out of the person receiving it.
- **Only the person who RECEIVED a friend request can accept it.** Right now
  the sender can likely accept their own request and force a friendship —
  which is what unlocks chat, trading and seeing someone's cards.
- **Finished challenges and trades can't be rewritten.** A completed challenge
  could be flipped back to "declined", wiping the result for both players;
  a completed trade could be flipped to "cancelled" after the cards moved.
- **You can only create challenges and trades in your own name, and only
  record your own match results.**
- **Chat messages are capped at 500 characters** in the database, not just in
  the browser.

## How to run migration 004

Same steps as before:

1. **https://supabase.com/dashboard** → sign in → your **TCG Manager** project.
2. Left sidebar → **SQL Editor** → green **+ New query**.
3. Open `server/sql/004_tighten_write_rules.sql`, select all (**Ctrl+A**),
   copy (**Ctrl+C**).
4. Paste into the big box, click the green **Run** button.
5. Expect **Success. No rows returned**.

Safe to run more than once.

**Watch for the `NOTICE` lines.** This migration replaces some existing
security rules, and it prints the name of every rule it removed. If you see
any notices, **copy them and send them over** — they tell me what your old
rules were called, which is useful if anything needs adjusting later.

### Checking it worked

```sql
select tablename, policyname, cmd, qual as using_clause, with_check
from pg_policies
where schemaname='public'
  and tablename in ('friend_requests','challenges','trades','matches')
order by tablename, cmd;
```

Each row should read sensibly out loud — e.g. the `friend_requests` UPDATE row
should mention `addressee_id` and **not** `requester_id`.

### Then test the game

The things most likely to be affected, in order:

1. Send a friend request from one account and accept it from the other.
2. Challenge a friend and play the challenge out.
3. Send a trade offer and accept it.
4. Play a normal league match and check the result saves.

If any of those now fail, send me the error and I'll adjust — nothing here is
hard to reverse.

## Still open after 004

*(Since fixed — see migration 007 at the bottom of this file.)*

**The economy is still calculated in the browser and trusted by the database.**
A player can still give themselves cards, max out card training, or set their
own gem balance from the developer console. Fixing it means moving pack
opening, training and match rewards into the database itself — a paired
database + app change that has to ship together, because doing one without the
other stops the game working. That's the next meaningful piece of security
work, and it's bigger than these two migrations combined.

Deliberately **not** done: requiring people to be friends before they can
message or challenge each other. It would stop spam from strangers, but it
also means you could never challenge someone you just found in search — that's
a game design decision for you to make, not something to slip into a security
fix.

---

# Migration 005 — shards and training

**What it fixes:** two problems with duplicate-card shards.

- If saving your shards failed, the card still showed them on screen — and you
  could then spend those imaginary shards on a real, permanent card level. The
  same failure also handed your gems back, so the pack came out free.
- With the game open in two tabs, or a pack opening while a training upgrade
  was still saving, one of the two changes silently overwrote the other. Shards
  just vanished, and nothing said so.

**How:** the maths moves into the database. Adding shards is now "add 6 to
whatever is stored" rather than "set it to what my browser thinks", so two
changes can't overwrite each other. Training reads the level itself, works out
the price from that, and takes the shards, the level and the gems together in
one go — so you can't be charged for a level that didn't happen, or get one you
didn't pay for.

**Do you have to run it?** The app works either way — without it the browser
falls back to a safer method that refuses a conflicting write instead of
silently losing it. But the "spend shards you don't have" hole only fully
closes once this is run.

## How to run migration 005

1. **https://supabase.com/dashboard** → sign in → your **TCG Manager** project.
2. Left sidebar → **SQL Editor** → green **+ New query**.
3. Open `server/sql/005_atomic_shards_and_training.sql`, select all
   (**Ctrl+A**), copy (**Ctrl+C**).
4. Paste into the big box, click the green **Run** button.
5. Expect **Success. No rows returned**.

Safe to run more than once. Run 002 first (this needs the columns it adds).

### Checking it worked

```sql
select p.proname, p.prosecdef as security_definer
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('grant_card_shards','train_card');
```

Two rows, both saying `true`. Then in the game: open a pack containing a card
you already own and check the shard count went up by the amount the reveal
showed, then train a card and check the level went up by one and your gems down
by exactly the price quoted.

This one was tested by running it against a real Postgres before it shipped —
26 checks, including that neither function can touch another player's cards.

---

# Migration 006 — cup ties and friendlies out of the league table

**What it fixes:** your season record (the "3W - 1D - 0L this season" line, and
the **Win 3 Matches** objective) is worked out from your match history. Every
match you play is saved to the same list — league games, cup ties and friendly
challenges — and nothing in the saved match said which was which, so cup and
friendly results were being counted as league results.

This migration adds a label to each saved match so the season table can leave
the cup and friendlies out.

**Do you have to run it?** No. The bigger half of this fix is in the app itself
and works immediately without touching the database: the app used to look at
only your last 20 matches and assume a six-game season always fit inside them,
which stopped being true once cup runs and friendlies filled that space — wins
you had genuinely earned dropped off the end and the "Win 3 Matches" objective
un-completed itself. That is fixed in the app. Until you run 006, cup and
friendly results just keep counting towards the season table the way they
always have. Nothing breaks either way.

## How to run migration 006

1. Go to **https://supabase.com/dashboard** and sign in.
2. Click your **TCG Manager** project.
3. In the left sidebar, click the **SQL Editor** icon (database symbol with
   `SQL` on it, roughly halfway down the list).
4. Click the green **+ New query** button at the top.
5. Open `server/sql/006_match_kind.sql` from this repo, select everything
   (**Ctrl+A**) and copy it (**Ctrl+C**).
6. Click into the big empty editor box on the Supabase page and paste
   (**Ctrl+V**).
7. Click the green **Run** button at the bottom right (or **Ctrl+Enter**).
8. You should see **Success. No rows returned**.

Safe to run more than once.

### Checking it worked

Paste this into the same editor and press Run:

```sql
select kind, count(*) from public.matches group by kind;
```

Straight after the migration you should see a single row with an empty `kind`
and your existing match count. Then play one league match and look again —
a `league` row appears with a count of 1.

### About your existing matches

Old matches keep an empty label and keep counting as league games. That is
deliberate: nothing saved about an old match can prove it was a cup tie — the
cup's eight teams include all six league clubs, so a cup tie against Storm City
looks identical to a league game against Storm City. Guessing would delete wins
you actually earned. Your numbers therefore stay exactly as they are now, and
they become exact one season after you run this, once every match in the
current season carries a real label.

### If something goes wrong

An error mentioning `relation "public.matches" does not exist` means you're on
the wrong Supabase project — check the project name at the top left.

Any other error: copy the full red message and send it over.


---

# Migration 007 — the economy moves into the database

**This one has two steps, days apart. Step 1 now, step 2 later. Read the
warning before step 2 — it is the one thing in this file that can break the
game for real players.**

**What it fixes:** right now every number in the game is worked out by the
JavaScript running on the player's own computer, and the database simply
believes it. Someone who opens the browser's developer console can type one
line and give themselves any card in the game, a maxed-out card level, or a
billion gems. Migrations 003 and 004 closed the holes *around* this. This one
closes the economy itself.

After it, the database decides — and the browser only asks:

- **which card a pack contains**, and what a pack costs;
- **how many gems a match, a cup round, a daily reward or an objective pays**;
- **what training costs**, and whether you can afford it;
- **which cards a brand-new account starts with**.

It also starts a **gem ledger**: every gem that moves is written down with a
reason, so "how did this account get 400,000 gems" now has an answer, and a bad
day can be undone.

**What it cannot fix:** whether you actually won a match. The match is played in
the browser, so a determined cheat can still claim wins they didn't earn — but
they now get 20 gems a time, no faster than a real match takes, and every one
is in the ledger. That is a different problem from "set your balance to a
billion instantly."

**Has it been tested?** Yes — the whole file was run against a real Postgres and
every function exercised: 192 checks, run four times over for different possible
shapes of your `profiles` table. That found and fixed four real bugs, including
one that would have destroyed shards. The app changes were tested separately
(162 checks) and the real page was driven through a pack opening in a browser.

---

## Step 1 — run the migration (safe to do any time)

Nothing here breaks anything. It only adds. A player still running the old
version of the game keeps playing exactly as before.

1. Go to **https://supabase.com/dashboard** and sign in.
2. Click your **TCG Manager** project.
3. In the left sidebar, click the **SQL Editor** icon (database symbol with
   `SQL` on it, roughly halfway down the list).
4. Click the green **+ New query** button at the top.
5. **Before pasting**, run this one line on its own to see whether any player
   owns the same card twice:

   ```sql
   select user_id, card_id, count(*) from public.user_cards
   group by 1,2 having count(*) > 1;
   ```

   You should get **no rows**. If you do get rows, send them over before
   continuing — the migration merges those duplicates into one row (adding the
   shards together, keeping the higher level) and deletes the extras, and it is
   worth a look first. It is not dangerous, it just cannot be undone.
6. Open `server/sql/007_server_authoritative_economy.sql` from this repo, select
   everything (**Ctrl+A**) and copy it (**Ctrl+C**).
7. Click into the big empty editor box and paste (**Ctrl+V**).
8. Click the green **Run** button at the bottom right (or **Ctrl+Enter**).
9. You should see **Success. No rows returned**.

Safe to run more than once. Run 002, 003, 004 and 006 first — this builds on
all of them.

### Checking step 1 worked

Paste these into the same editor and press Run:

```sql
select count(*) from public.pack_defs;        -- expect 6
select count(*) from public.objective_defs;   -- expect 12
select count(*) from public.gem_ledger;       -- expect 0 (the table is new)
select public.shards_for_duplicate('GOAT');   -- expect 12
```

Then, **in the game itself, signed in as a real player**: open a pack, open one
containing a card you already own (the shards should go up by the amount the
reveal showed), train a card, play a league match, and claim the daily reward.
Watch your gem balance — it should behave exactly as it always has. If it does,
the database is now the one deciding all of those numbers.

To see the ledger filling up:

```sql
select created_at, reason, delta, balance_after
from public.gem_ledger order by id desc limit 20;
```

---

## Step 2 — the lock-down (⚠️ NOT yet — read this)

Step 1 gives the database the ability to decide the numbers. Step 2 is what
takes the ability away from the browser. It is one line:

```sql
select public.economy_lock_down();
```

**Do not run it until all three of these are true:**

1. **The new version of the site is deployed and live**, and you have played it
   yourself. The old version cannot open packs, train, record a match, or —
   worst of all — give a brand-new account its starter squad once this runs.
   A new player would sign up and land in an empty game with no way out.
2. **A day or two has passed** since the deploy, so anyone with the old page
   still open in a tab has reloaded it.
3. **You know whether an Android app (APK) is in anyone's hands.** The Android
   build has the game's JavaScript baked inside it and does not update itself.
   If someone has an old build installed, this step breaks it permanently and
   there is no way to push them a fix. If you are not sure, ask before running
   this.

If anything goes wrong afterwards, this puts it all back immediately, and
nothing is lost:

```sql
select public.economy_unlock();
```

### Checking step 2 worked

Both commands print the list of profile columns the game is still allowed to
change. After the lock-down, `gems`, `wins` and the season columns should have
disappeared from it, while `team_name`, `avatar` and the rest remain.

Then the proof: open the game, press **F12**, click the **Console** tab, and
paste this line:

```js
sb.from("profiles").update({ gems: 999999999 }).eq("id", (await sb.auth.getUser()).data.user.id)
```

Before the lock-down that line worked. After it, it should come back with a
**permission denied** error and your balance should not move. That is the whole
point of this migration.

### If something goes wrong

If players report that packs, training or matches have stopped working after
step 2, run `select public.economy_unlock();` straight away — that returns the
game to exactly how it works today, and no data is lost. Then send over what
they saw.

Any other error: copy the full red message and send it over.
