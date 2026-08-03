-- 005_atomic_shards_and_training.sql
--
-- Makes the two writes that move shards and training levels atomic, and the
-- first slice of the server-side economy work 004's closing note scoped out.
--
-- THE PROBLEM. Both writes are read-modify-write with ABSOLUTE values: the
-- browser takes the count it believes the row holds, adds or subtracts, and
-- stores the result. Two of them overlapping -- a second tab, or a duplicate
-- pull landing while a training spend is in flight -- means the second write
-- overwrites the first with a total computed before it happened. Nobody is
-- told; the update PostgREST reports back as successful destroyed the other
-- one. And because the browser is also the only thing checking that a card has
-- enough shards to train, a shard count that drifted ahead of the stored row
-- (a grant whose write failed) could be spent, materialising shards that were
-- never granted as a real, permanent +1 power level.
--
-- THE FIX. Do the arithmetic here instead. `shards = shards + n` is relative,
-- so it cannot lose a concurrent grant, and train_card() re-derives the cost
-- from the level IT reads under a row lock, so the browser's numbers are never
-- trusted for the decision to spend. Level and gems move in one transaction:
-- the player cannot be charged for a level that didn't apply, or gain one that
-- wasn't paid for.
--
-- WHAT THIS IS NOT. This does not stop a determined player cheating. Direct
-- INSERT/UPDATE on user_cards stays granted, because the client falls back to
-- it when this migration hasn't been run, and because the app is a PWA whose
-- older cached copies keep running for a while after a deploy -- revoking the
-- grant would silently break training for anyone still on one. Closing that
-- needs the whole economy moved server-side and the grants dropped in the same
-- change; the note at the bottom of 004 still stands.
--
-- Run 002 first (it adds user_cards.level and user_cards.shards).
-- Safe to run more than once: both functions are CREATE OR REPLACE.


-- ===========================================================================
-- 1. DUPLICATE PULLS -> SHARDS
-- ===========================================================================
-- Returns jsonb rather than raising, so the browser can tell "you don't own
-- that" from "the function isn't installed" without mapping error codes -- the
-- client falls back to its own compare-and-set on the latter.
--
-- The pack's gem cost is deliberately NOT deducted here. Pack prices live in
-- the client's PACKS table and this function has no way to check which pack
-- was opened, so inventing a cost server-side would be theatre.

create or replace function public.grant_card_shards(p_card_id bigint, p_shards integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_shards integer;
begin
  if v_uid is null then
    return jsonb_build_object('error', 'Not signed in.');
  end if;
  -- A negative grant would be a spend, and spends belong in train_card() where
  -- they are checked against a price.
  if p_shards is null or p_shards <= 0 then
    return jsonb_build_object('error', 'Nothing to grant.');
  end if;

  update public.user_cards
     set shards = shards + p_shards
   where user_id = v_uid and card_id = p_card_id
  returning shards into v_shards;

  if not found then
    return jsonb_build_object('error', 'You do not own that card.');
  end if;

  return jsonb_build_object('shards', v_shards);
end $$;


-- ===========================================================================
-- 2. SPENDING SHARDS ON A LEVEL
-- ===========================================================================
-- The cost curve is duplicated from shardsForLevel()/gemsForLevel() in
-- server/lib/game-data.js, and the cap from MAX_CARD_LEVEL there and the
-- user_cards_level_range constraint added by 002. Duplicated on purpose: a
-- price the client sends is a price the client can choose. Change one, change
-- all of them.
--
-- SELECT ... FOR UPDATE holds the row for the rest of the transaction, so a
-- duplicate pull arriving mid-training waits and then adds to the post-spend
-- total instead of overwriting it.

create or replace function public.train_card(p_card_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid         uuid := auth.uid();
  v_level       smallint;
  v_shards      integer;
  v_gems        integer;
  v_need_shards integer;
  v_need_gems   integer;
begin
  if v_uid is null then
    return jsonb_build_object('error', 'Not signed in.');
  end if;

  select level, shards into v_level, v_shards
    from public.user_cards
   where user_id = v_uid and card_id = p_card_id
     for update;

  if not found then
    return jsonb_build_object('error', 'You do not own that card.');
  end if;
  if v_level >= 10 then
    return jsonb_build_object('error', 'Already at maximum level.');
  end if;

  v_need_shards := 2 + v_level * 2;
  v_need_gems   := 40 + v_level * 30;

  if v_shards < v_need_shards then
    return jsonb_build_object('error', 'Not enough shards.');
  end if;

  select gems into v_gems from public.profiles where id = v_uid for update;
  if v_gems is null or v_gems < v_need_gems then
    return jsonb_build_object('error', 'Not enough gems.');
  end if;

  update public.user_cards
     set level  = level  + 1,
         shards = shards - v_need_shards
   where user_id = v_uid and card_id = p_card_id
  returning level, shards into v_level, v_shards;

  update public.profiles
     set gems = gems - v_need_gems
   where id = v_uid
  returning gems into v_gems;

  -- Every number the client needs to resync from, so it never has to guess
  -- what this transaction did.
  return jsonb_build_object('level', v_level, 'shards', v_shards, 'gems', v_gems);
end $$;


-- ===========================================================================
-- 3. WHO MAY CALL THEM
-- ===========================================================================
-- Both are SECURITY DEFINER and so bypass row-level security; they confine
-- themselves to auth.uid()'s own rows, which is the entire reason they can be
-- handed to players at all. A signed-out caller has no auth.uid() and no
-- legitimate reason to reach either, so `anon` is not granted -- same shape as
-- the admin helpers in 003.

revoke all on function public.grant_card_shards(bigint, integer) from public, anon;
revoke all on function public.train_card(bigint)                 from public, anon;
grant execute on function public.grant_card_shards(bigint, integer) to authenticated;
grant execute on function public.train_card(bigint)                 to authenticated;


-- ===========================================================================
-- 4. Verification
-- ===========================================================================
-- Both functions should be listed, and both should say `authenticated`:
--
--   select p.proname, p.prosecdef as security_definer,
--          pg_get_function_identity_arguments(p.oid) as args,
--          array_to_string(p.proacl, ', ') as grants
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname in ('grant_card_shards','train_card');
--
-- Then, signed in as yourself in the game: open a pack containing a card you
-- already own and check the shard count on that card went UP by the amount the
-- reveal claimed, then train a card and check its level went up by exactly one
-- and your gems down by exactly the quoted price.
-- ===========================================================================
