-- 004_tighten_write_rules.sql
--
-- Second security/integrity pass. Every policy below was written against the
-- ACTUAL write paths in server/lib/social.js and server/lib/game-data.js, not
-- against assumptions -- the app performs exactly these operations and no
-- others, so nothing here can break normal play.
--
-- IMPORTANT NOTE ON POLICY SHAPE
-- `using` is checked against the row as it exists BEFORE the update;
-- `with check` against the row AFTER. Several policies here restrict updates
-- to rows that are still 'pending' -- so `using` carries the pending test and
-- `with check` deliberately does NOT, otherwise the app could never move a row
-- OUT of pending (accepting a challenge would fail). Do not "tidy" that up.
--
-- Safe to run more than once.

-- ======================================================================
-- 1. A balance can never go negative
-- ======================================================================
-- The cup entry fee is deducted in a callback with no re-check, so spending
-- elsewhere in the gap drives the balance below zero and it gets persisted.
-- The client fix is separate; this stops the database recording a negative
-- balance whatever the client does. Existing negatives are clamped first, or
-- adding the constraint would fail.

update public.profiles set gems = 0 where gems < 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_gems_non_negative') then
    alter table public.profiles add constraint profiles_gems_non_negative check (gems >= 0);
  end if;
end $$;

-- A trade offering negative gems would drain the recipient instead of paying
-- them. The client only guards this when no cards are offered.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'trades_offered_gems_non_negative') then
    alter table public.trades add constraint trades_offered_gems_non_negative check (offered_gems >= 0);
  end if;
end $$;

-- Chat messages are trimmed to 500 chars in the browser only, which a console
-- call bypasses entirely.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_body_length') then
    alter table public.messages add constraint messages_body_length
      check (char_length(body) between 1 and 500);
  end if;
end $$;

-- ======================================================================
-- 2. Friend requests: only the ADDRESSEE may answer one
-- ======================================================================
-- respondToFriendRequest() updates by id with no check on who is calling. If
-- the existing policy allows either party (the natural way to write it), the
-- REQUESTER can accept their own request and force a friendship on anyone --
-- and friendship gates chat, the trade composer and collection visibility.
--
-- The app's only two UPDATE paths are both performed by the addressee:
-- respondToFriendRequest(), and the auto-accept branch of sendFriendRequest().

do $$
declare p record;
begin
  for p in select policyname from pg_policies
           where schemaname='public' and tablename='friend_requests' and cmd='UPDATE'
  loop
    execute format('drop policy %I on public.friend_requests', p.policyname);
    raise notice 'dropped friend_requests UPDATE policy: %', p.policyname;
  end loop;
end $$;

create policy "addressee answers the request"
  on public.friend_requests for update
  using      (auth.uid() = addressee_id and status = 'pending')
  with check (auth.uid() = addressee_id);

-- ======================================================================
-- 3. Challenges: only a party to it, only while pending
-- ======================================================================
-- declineChallengeRow() and resolveChallengeAccept() both update by id alone,
-- with no status guard. A COMPLETED challenge could be flipped back to
-- 'declined', destroying the stored result for both players; a double-click
-- could resolve the same challenge twice and pay the acceptor twice.

do $$
declare p record;
begin
  -- `cmd` must be selected, not just filtered on -- the notice below reads it.
  for p in select policyname, cmd from pg_policies
           where schemaname='public' and tablename='challenges' and cmd in ('UPDATE','INSERT')
  loop
    execute format('drop policy %I on public.challenges', p.policyname);
    raise notice 'dropped challenges % policy: %', p.cmd, p.policyname;
  end loop;
end $$;

-- You may only create a challenge in your OWN name.
create policy "challenge as yourself"
  on public.challenges for insert
  with check (auth.uid() = challenger_id);

create policy "parties settle a pending challenge"
  on public.challenges for update
  using      (auth.uid() in (challenger_id, opponent_id) and status = 'pending')
  with check (auth.uid() in (challenger_id, opponent_id));

-- ======================================================================
-- 4. Trades: only a party to it, only while pending
-- ======================================================================
-- cancelTrade()/declineTrade() update by id with no status or role guard, so a
-- COMPLETED trade could be flipped to 'cancelled' after the cards moved.
-- execute_trade() is SECURITY DEFINER and bypasses these, as it should.

do $$
declare p record;
begin
  -- `cmd` must be selected, not just filtered on -- the notice below reads it.
  for p in select policyname, cmd from pg_policies
           where schemaname='public' and tablename='trades' and cmd in ('UPDATE','INSERT')
  loop
    execute format('drop policy %I on public.trades', p.policyname);
    raise notice 'dropped trades % policy: %', p.cmd, p.policyname;
  end loop;
end $$;

create policy "offer trades as yourself"
  on public.trades for insert
  with check (auth.uid() = initiator_id);

create policy "parties settle a pending trade"
  on public.trades for update
  using      (auth.uid() in (initiator_id, recipient_id) and status = 'pending')
  with check (auth.uid() in (initiator_id, recipient_id));

-- ======================================================================
-- 5. Match history is yours alone
-- ======================================================================

do $$
declare p record;
begin
  for p in select policyname from pg_policies
           where schemaname='public' and tablename='matches' and cmd='INSERT'
  loop
    execute format('drop policy %I on public.matches', p.policyname);
    raise notice 'dropped matches INSERT policy: %', p.policyname;
  end loop;
end $$;

create policy "record your own matches"
  on public.matches for insert
  with check (auth.uid() = user_id);

-- ======================================================================
-- 6. Verification
-- ======================================================================
-- Run this afterwards; every row should read the way you'd say it out loud.
--
--   select tablename, policyname, cmd, qual as using_clause, with_check
--   from pg_policies
--   where schemaname='public'
--     and tablename in ('friend_requests','challenges','trades','matches')
--   order by tablename, cmd;
--
-- ======================================================================
-- STILL NOT FIXED BY THIS MIGRATION -- read before assuming you're done
-- ======================================================================
-- The economy is still calculated in the browser and trusted by the database.
-- A player can grant themselves cards (`user_cards` insert), max out training
-- (`user_cards` update), or set their own gems, because the app's own pack /
-- training / match-reward code does exactly those writes and RLS cannot tell
-- a legitimate one from a forged one.
--
-- Locking that down means moving pack opening, training and match settlement
-- into SECURITY DEFINER functions that debit gems and pick the card
-- server-side, then revoking direct INSERT/UPDATE on user_cards and the
-- economy columns of profiles. That is a paired SQL + client change and must
-- ship together, or the game stops working -- hence not in this file.
--
-- Also deliberately NOT done here: requiring an accepted friendship before a
-- message or challenge can be sent. It would close a real spam vector, but it
-- is a gameplay decision (it makes challenging a stranger impossible), so it
-- needs a call rather than being slipped into a security migration.
