# Proposal: duplicate cards (x2, x3) and trading spare copies

**Status: PROPOSAL ONLY. Nothing here is built, and nothing here should be run
against the database.** This is Task C from the Manager V1 brief. It could not
be built as written, because the game doesn't store duplicate cards. It needs
one decision from you first.

## What the brief asked for

1. In My Cards, a badge on the card corner when you own more than one copy:
   x2, x3, counted from `user_cards` grouped by card.
2. Tapping a card with more than one copy opens a popup with a **Trade** button.
   Trade opens the friend list, you pick a friend, and a trade offer is created.
3. You can never trade your last copy. At most "count minus 1" is tradable.

## Why it can't be built today

**The game never keeps a second copy of a card.** When a pack gives you a card
you already own, you get **shards** instead, and shards pay for training:

| Rarity of the duplicate | Shards you get |
|---|---|
| Common, Uncommon, Rare | 2 |
| Epic, Elite | 3 |
| Ultra | 4 |
| Legendary | 6 |
| Mythic | 8 |
| Icon, GOAT | 12 |

The database is built around this. Migration 007 adds a rule that each player
can have **one row per card** in `user_cards`, and calls a second row "a corrupt
state". So `GROUP BY card_id` always counts 1: no card could ever show x2, and
"count minus 1" is always 0, so nothing could ever be traded.

Two smaller differences: the trade table is called `trades`, not
`trade_offer`. And the "pick a friend, create an offer" part already exists
(Friends → a friend → Trade). It was broken until Task A fixed card taps in the
trade screen.

## The three options

### Option 1: keep it as it is

Duplicates stay shards. No badges and no spare-copy trading. You can still
trade any card through the Friends tab, including your only copy.

- Cost: nothing.
- Downside: no sense of "I have spares to trade".

### Option 2: duplicates become copies, and shards come from somewhere else

A duplicate pull adds a copy (x2, x3). Training then needs a new source, for
example "sacrifice a copy to level up", which is how many card games do it.

- Cost: redesigning training, which you've already tuned, and existing shard
  balances need a plan.
- Downside: the biggest change to the economy of the three.

### Option 3 (recommended): duplicates become copies, and a spare can be turned into shards

A duplicate pull adds a copy instead of paying shards straight away. Every
spare copy gets two buttons:

- **Trade**: offer it to a friend. You can never trade your last copy.
- **Convert**: turn it into exactly the shards it would have paid before (the
  table above).

Training stays exactly as it is. A spare copy is worth the same shards as
before, so the economy doesn't move. The player just gets to choose between
trading and converting.

- Cost: one database change and three server-side functions updated (below),
  plus the My Cards badge and popup.
- Downside: players must press Convert to get shards they used to get
  automatically. A "Convert all spares" button would solve that.

## What Option 3 needs, in order

1. **Your decision:** Option 1, 2 or 3.
   - **And one more:** today the Friends → Trade screen lets a player trade
     their **only** copy of a card. The brief says "never trade the last
     copy", but also "preserve every existing gameplay path", and those two
     conflict. Either only spare copies become tradable (safer for players,
     but it changes today's trading), or spares get the new buttons and the
     old trade screen keeps allowing any card.
2. **The current text of the database function `execute_trade`.** It does the
   actual swap when a trade is accepted, and it lives in the mobile project's
   `schema.sql`, which isn't on this computer. It has to learn to move one
   copy instead of the whole row. To get it:
   1. Supabase dashboard → your project → **SQL Editor** → **+ New query**.
   2. Paste `select pg_get_functiondef('public.execute_trade'::regproc);` and
      click **Run**.
   3. Copy the result and send it over.
3. **Whether migration 007 has been run.** Pack opening changes differently
   depending on the answer. The health-check query from earlier tells us.

## Draft of the database change (DO NOT RUN)

This is a sketch so you can see the size of it. It isn't complete: the
`execute_trade` part can't be written until step 2 above.

```sql
-- PROPOSAL -- DO NOT RUN.
-- 1. Count copies on the existing row, instead of adding rows.
--    Everyone's current cards start at 1 copy, so nothing changes for them.
alter table public.user_cards
  add column if not exists copies integer not null default 1
  check (copies >= 1);

-- 2. Opening a pack: a card you already own adds a copy
--    (instead of paying shards).
--    -> change open_pack() (migration 007) and grant_card_shards()
--       (migration 005): the duplicate branch becomes
--       update user_cards set copies = copies + 1 ...

-- 3. New: convert one spare copy into shards. Refuses the last copy.
--    convert_spare_copy(p_card_id) -> copies - 1, shards + shardsForDuplicate

-- 4. execute_trade: move ONE copy, never the last one.
--    Waiting on its current definition (see step 2).
```

## What the app side would look like (Option 3)

- **My Cards:** an "x2" or "x3" badge in the card's corner when `copies > 1`.
- **Card popup:** when `copies > 1`, two new buttons, **Trade a spare** and
  **Convert to N shards**. Trade opens the existing Friends list and trade
  screen with this card already in your offer.
- **Trade screen:** each card shows how many spares you have. Your last copy
  can't be selected, so it can't be traded by accident.
- Every existing button and screen stays as it is.
