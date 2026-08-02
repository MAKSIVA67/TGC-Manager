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
