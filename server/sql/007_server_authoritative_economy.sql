-- 007_server_authoritative_economy.sql
--
--   ####################################################################
--   #  NOT READY TO RUN. THIS IS A DESIGN, NOT A SHIPPABLE MIGRATION.  #
--   ####################################################################
--
--   The client half does not exist yet. Nothing in server/index.html or
--   server/lib/*.js calls open_pack(), settle_match(), claim_daily(),
--   claim_objective(), cup_enter(), cup_advance(), cup_forfeit() or
--   claim_starter_squad() -- those rewrites are specified in
--   server/ECONOMY_DESIGN.md and have not been written.
--
--   Running phase 1 today would install a set of functions nobody calls.
--   That is inert rather than harmful, but it has not been executed against
--   a real Postgres even once, so it is not known to apply cleanly -- and
--   `select public.economy_lock_down()` WOULD break the live game outright,
--   because it revokes the writes the current client depends on.
--
--   Before any of this runs: write the client changes, apply phase 1 to a
--   throwaway Postgres and exercise every function (migration 005 was
--   verified this way with pglite -- 26 checks, and it caught nothing wrong,
--   but the point is that it was checked), deploy the site, confirm players
--   have picked it up, and only then run the lock-down.
--
--   Migration 005 already made TRAINING server-authoritative, which is the
--   slice of this design that has actually shipped. train_card() below is
--   deliberately declared with the same bigint signature so it replaces that
--   one rather than colliding with it.
--
--
-- Moves the economy out of the browser and into the database.
--
-- Everything that creates or destroys value -- pack opening, training, match
-- rewards, the cup, daily and objective claims, the starter squad -- is
-- currently computed in the browser and written straight to Postgres. The
-- app's own code performs exactly those writes, so RLS cannot tell a real one
-- from a console-typed one, and one line grants any card, any level, any
-- balance. Migrations 003 and 004 closed the privilege and integrity holes
-- around that; this closes the economy itself.
--
--
-- THIS FILE RUNS IN TWO PHASES. READ THIS BEFORE PASTING.
--
--   PHASE 1 -- everything below runs the moment you paste the file.
--     It only ADDS: one unique index, three small tables, and a set of
--     SECURITY DEFINER functions. It revokes nothing and changes no existing
--     policy, so a player still running the OLD cached JavaScript keeps
--     playing exactly as before while the new client starts using the
--     functions. Safe to run before or after the site is deployed.
--
--   PHASE 2 -- the lock-down. Does NOT run on paste. It lives inside
--   economy_lock_down(), which you invoke deliberately:
--
--       select public.economy_lock_down();
--
--     That is the statement that actually revokes the client's direct write
--     access. Run it only once the new site is live and players have picked
--     it up. An old cached client hitting a locked-down database cannot open
--     packs, train, record a match or -- worst of all -- receive a starter
--     squad on signup.
--
--   Reversing phase 2 is one statement:
--
--       select public.economy_unlock();
--
--     It restores the grants exactly as 003 left them (is_admin and banned
--     stay revoked). Nothing in phase 1 needs undoing; the functions are
--     harmless when unused.
--
-- Safe to run more than once, in either phase.
--
--
-- WHAT THIS CAN AND CANNOT PROVE
--
-- Pack rolls, prices, training costs, reward amounts, the daily ladder,
-- objective progress and cup payouts all become facts the database decides.
-- A client can no longer choose them.
--
-- A match RESULT cannot be proven. The match is played in the browser -- that
-- is the whole game -- and short of simulating it server-side there is no way
-- to know a claimed win happened. settle_match therefore does the two things
-- that are actually available: it decides the reward itself rather than
-- accepting the client's figure, and it rate-limits how often a result can be
-- recorded. That turns "set gems to 999999999" into "grind fake wins at 20
-- gems a go, no faster than a real match takes", and every one of them is
-- written to gem_ledger where it can be seen and reversed.


-- ===========================================================================
-- PHASE 1
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. One user_cards row per (player, card) -- enforced, not just intended
-- ---------------------------------------------------------------------------
-- Every ownership check in the app is a set-membership test over user_cards,
-- so a second row for the same card is a corrupt state, not a duplicate pull.
-- The client already avoids it by branching on `owned`, but two tabs opening
-- packs at once beat that check, and nothing stopped a console insert.
--
-- open_pack() below leans on this index for its ON CONFLICT clause, so it has
-- to exist first -- and any duplicates already in the table have to be merged
-- before it can be created, or the CREATE fails and the whole file aborts.

do $$
begin
  -- Merging keeps the earliest row, sums the shards and takes the highest
  -- level, which is the reading most generous to the player and the one that
  -- matches what the app believed it had stored.
  with dupes as (
    select ctid,
           row_number() over (partition by user_id, card_id order by ctid) as rn,
           sum(shards)  over (partition by user_id, card_id) as total_shards,
           max(level)   over (partition by user_id, card_id) as top_level
      from public.user_cards
  )
  update public.user_cards uc
     set shards = d.total_shards,
         level  = d.top_level
    from dupes d
   where uc.ctid = d.ctid
     and d.rn = 1
     -- Without this the statement rewrites every row in the table on a clean
     -- database, which is a lot of churn for no change.
     and (uc.shards is distinct from d.total_shards or uc.level is distinct from d.top_level);

  with dupes as (
    select ctid, row_number() over (partition by user_id, card_id order by ctid) as rn
      from public.user_cards
  )
  delete from public.user_cards uc
   using dupes d
   where uc.ctid = d.ctid and d.rn > 1;
end $$;

do $$
declare
  has_unique boolean;
begin
  -- A unique constraint may already exist under a name this file doesn't
  -- know, so match on the COLUMNS rather than on a name.
  select exists (
    select 1
      from pg_index i
      join pg_class     t on t.oid = i.indrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'user_cards'
       and i.indisunique
       and (select array_agg(a.attname::text order by a.attname)
              from unnest(i.indkey) k
              join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k)
           = array['card_id', 'user_id']
  ) into has_unique;

  if not has_unique then
    execute 'create unique index user_cards_owner_card_uniq on public.user_cards (user_id, card_id)';
    raise notice 'created unique index user_cards_owner_card_uniq';
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 2. Gem ledger
-- ---------------------------------------------------------------------------
-- profiles.gems stays the balance -- it is read by the leaderboard, the admin
-- panel, execute_trade and the purchase-crediting RPC, and deriving it from a
-- ledger would put all of those on a new code path for no security gain,
-- since the protection comes from who may WRITE, not from where the number
-- lives. The ledger is here as an audit trail: every function below records
-- what it moved and why, so "how did this account get 400,000 gems" has an
-- answer, and a bad day can be reversed without guessing.
--
-- Nothing outside the SECURITY DEFINER functions can write it.

create table if not exists public.gem_ledger (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  delta         integer not null,
  balance_after integer not null,
  reason        text not null,
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists gem_ledger_user_idx on public.gem_ledger (user_id, created_at desc);

alter table public.gem_ledger enable row level security;

-- Readable by its owner (useful when a player asks where their gems went),
-- writable by nobody: there is deliberately no INSERT/UPDATE/DELETE policy.
drop policy if exists gem_ledger_select_own on public.gem_ledger;
create policy gem_ledger_select_own on public.gem_ledger
  for select using (auth.uid() = user_id);

revoke insert, update, delete on public.gem_ledger from authenticated, anon;
grant select on public.gem_ledger to authenticated;


-- ---------------------------------------------------------------------------
-- 3. Pack definitions
-- ---------------------------------------------------------------------------
-- Cost and odds move server-side because they are exactly what a client would
-- otherwise get to choose. Seeded from the PACKS array in index.html; the
-- insert is ON CONFLICT DO NOTHING so re-running this file never overwrites
-- odds that have since been tuned in the database.

create table if not exists public.pack_defs (
  id         text primary key,
  name       text not null,
  cost       integer not null check (cost >= 0),
  weights    jsonb not null,
  sort_order smallint not null default 0,
  active     boolean not null default true
);

alter table public.pack_defs enable row level security;

drop policy if exists pack_defs_readable on public.pack_defs;
create policy pack_defs_readable on public.pack_defs for select using (true);

revoke insert, update, delete on public.pack_defs from authenticated, anon;
grant select on public.pack_defs to authenticated, anon;

insert into public.pack_defs (id, name, cost, weights, sort_order) values
  ('bronze',    'Bronze Pack',     250, '{"Common":48,"Uncommon":30,"Rare":13,"Epic":4,"Elite":3.5,"Ultra":1,"Legendary":0.4,"Mythic":0.08,"Icon":0.018,"GOAT":0.002}'::jsonb, 1),
  ('silver',    'Silver Pack',     500, '{"Common":30,"Uncommon":25,"Rare":20,"Epic":15,"Elite":6,"Ultra":2.5,"Legendary":1.2,"Mythic":0.25,"Icon":0.045,"GOAT":0.005}'::jsonb, 2),
  ('gold',      'Gold Pack',      1000, '{"Common":10,"Uncommon":15,"Rare":25,"Epic":25,"Elite":15,"Ultra":7,"Legendary":2.5,"Mythic":0.4,"Icon":0.09,"GOAT":0.01}'::jsonb, 3),
  ('legendary', 'Legendary Pack', 2000, '{"Elite":45,"Ultra":30,"Legendary":18,"Mythic":5,"Icon":1.8,"GOAT":0.2}'::jsonb, 4),
  ('mythic',    'Mythic Pack',    4000, '{"Ultra":55,"Legendary":32,"Mythic":10,"Icon":2.5,"GOAT":0.5}'::jsonb, 5),
  ('goat',      'GOAT Pack',      7500, '{"Legendary":60,"Mythic":30,"Icon":8,"GOAT":2}'::jsonb, 6)
on conflict (id) do nothing;


-- ---------------------------------------------------------------------------
-- 4. Objective definitions
-- ---------------------------------------------------------------------------
-- The client's OBJECTIVES array carries a `progress` callback, which cannot
-- cross into SQL. Each one is re-expressed here as a named metric the
-- evaluator below knows how to measure, so a claim is checked against the
-- database rather than against whatever number the browser reports.

create table if not exists public.objective_defs (
  id     text primary key,
  reward integer not null check (reward >= 0),
  target integer not null check (target > 0),
  metric text not null
);

alter table public.objective_defs enable row level security;

drop policy if exists objective_defs_readable on public.objective_defs;
create policy objective_defs_readable on public.objective_defs for select using (true);

revoke insert, update, delete on public.objective_defs from authenticated, anon;
grant select on public.objective_defs to authenticated, anon;

insert into public.objective_defs (id, reward, target, metric) values
  ('obj_win3',       25,   3, 'season_wins'),
  ('obj_collect10',  20,  10, 'cards_owned'),
  ('obj_epic',       30,   1, 'owns_epic_or_better'),
  ('obj_streak3',    35,   3, 'best_streak'),
  ('obj_win10',      60,  10, 'season_wins'),
  ('obj_win25',     120,  25, 'season_wins'),
  ('obj_collect50',  80,  50, 'cards_owned'),
  ('obj_collect100',150, 100, 'cards_owned'),
  ('obj_legendary',  70,   1, 'owns_legendary_or_better'),
  ('obj_streak5',    90,   5, 'best_streak'),
  ('obj_streak10',  200,  10, 'best_streak'),
  ('obj_trades3',    50,   3, 'trades_completed')
on conflict (id) do nothing;


-- ---------------------------------------------------------------------------
-- 5. Small shared helpers
-- ---------------------------------------------------------------------------

-- Mirrors RARITY_ORDER in index.html. Used for pack bucket ordering and for
-- the "Epic or better" style objective tests.
create or replace function public.rarity_rank(p_rarity text)
returns integer
language sql
immutable
as $$
  select coalesce(
    array_position(
      array['Common','Uncommon','Rare','Epic','Elite','Ultra','Legendary','Mythic','Icon','GOAT'],
      p_rarity),
    0);
$$;

-- Mirrors shardsForDuplicate() in index.html.
create or replace function public.shards_for_duplicate(p_rarity text)
returns integer
language sql
immutable
as $$
  select case
    when public.rarity_rank(p_rarity) >= public.rarity_rank('Icon')      then 12
    when public.rarity_rank(p_rarity) >= public.rarity_rank('Mythic')    then 8
    when public.rarity_rank(p_rarity) >= public.rarity_rank('Legendary') then 6
    when public.rarity_rank(p_rarity) >= public.rarity_rank('Ultra')     then 4
    when public.rarity_rank(p_rarity) >= public.rarity_rank('Epic')      then 3
    else 2
  end;
$$;

-- The single place gems move. Returns the new balance so callers never have
-- to re-read it, and writes the ledger row in the same statement pair so a
-- balance change without an audit entry is impossible.
--
-- Deliberately NOT granted to authenticated: it is only reachable from the
-- functions below, which run as the owner.
create or replace function public.economy_apply_gems(
  p_user   uuid,
  p_delta  integer,
  p_reason text,
  p_detail jsonb default '{}'::jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance integer;
begin
  update public.profiles set gems = gems + p_delta where id = p_user returning gems into v_balance;
  if not found then
    raise exception 'Profile not found.' using errcode = 'P0002';
  end if;
  insert into public.gem_ledger (user_id, delta, balance_after, reason, detail)
  values (p_user, p_delta, v_balance, p_reason, coalesce(p_detail, '{}'::jsonb));
  return v_balance;
end $$;

-- Every entry point starts here: resolves the caller, takes the row lock that
-- serialises that player's economy actions (so two tabs cannot both pass a
-- balance check against the same gems), and refuses banned accounts.
create or replace function public.economy_begin()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.profiles%rowtype;
begin
  if v_uid is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  select * into v_row from public.profiles where id = v_uid for update;
  if not found then
    raise exception 'Profile not found.' using errcode = 'P0002';
  end if;
  if v_row.banned then
    raise exception 'This account is banned.' using errcode = '42501';
  end if;
  return v_row;
end $$;


-- ---------------------------------------------------------------------------
-- 6. open_pack
-- ---------------------------------------------------------------------------
-- The roll happens here, on a number the browser never sees and cannot
-- influence. The client keeps its spin animation: it starts the reel on the
-- tap and calls this in parallel, then drops the returned card into the
-- landing slot before the reel settles -- the 2.9s spin is a latency budget
-- that a single PostgREST call fits inside many times over.
--
-- A duplicate adds shards to the row that already exists; ON CONFLICT makes
-- that structural rather than a client convention.

create or replace function public.open_pack(p_pack_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile   public.profiles%rowtype;
  v_pack      public.pack_defs%rowtype;
  v_card      public.cards%rowtype;
  v_rarity    text;
  v_roll      numeric := random();
  v_duplicate boolean;
  v_gained    integer := 0;
  v_shards    integer;
  v_level     integer;
  v_gems      integer;
begin
  v_profile := public.economy_begin();

  select * into v_pack from public.pack_defs where id = p_pack_id and active;
  if not found then
    raise exception 'That pack is not available.' using errcode = '22023';
  end if;
  if v_profile.gems < v_pack.cost then
    raise exception 'Not enough gems.' using errcode = '22023';
  end if;

  -- Pick the rarity bucket by weight, then a card uniformly within it -- the
  -- same two-step pickWeighted() does, so the published odds still hold.
  -- Buckets with no cards in the pool are dropped BEFORE the running total is
  -- taken, or their weight would silently vanish into a neighbour.
  select b.rarity into v_rarity
    from (
      select p.rarity,
             sum(p.w) over (order by public.rarity_rank(p.rarity)) as cumulative,
             sum(p.w) over ()                                      as total
        from (
          select c.rarity, coalesce((v_pack.weights ->> c.rarity)::numeric, 0) as w
            from public.cards c
           where coalesce(c.active, true)
             and coalesce(c.exclusive, false) = false
           group by c.rarity
        ) p
       where p.w > 0
    ) b
   where v_roll * b.total <= b.cumulative
   order by b.cumulative
   limit 1;

  if v_rarity is null then
    -- No card in the catalog matches this pack at all. Raising rolls the
    -- whole transaction back, so nothing is charged.
    raise exception 'No cards are available in that pack right now.' using errcode = '22023';
  end if;

  select * into v_card
    from public.cards
   where coalesce(active, true)
     and coalesce(exclusive, false) = false
     and rarity = v_rarity
   order by random()
   limit 1;

  select true into v_duplicate from public.user_cards
   where user_id = v_profile.id and card_id = v_card.id;
  v_duplicate := coalesce(v_duplicate, false);

  if v_duplicate then
    v_gained := public.shards_for_duplicate(v_card.rarity);
    update public.user_cards
       set shards = shards + v_gained
     where user_id = v_profile.id and card_id = v_card.id
     returning shards, level into v_shards, v_level;
  else
    insert into public.user_cards (user_id, card_id) values (v_profile.id, v_card.id)
    on conflict (user_id, card_id) do nothing;
    select shards, level into v_shards, v_level
      from public.user_cards where user_id = v_profile.id and card_id = v_card.id;
  end if;

  v_gems := public.economy_apply_gems(
    v_profile.id, -v_pack.cost, 'pack_open',
    jsonb_build_object('pack', v_pack.id, 'card_id', v_card.id, 'duplicate', v_duplicate));

  -- The card is returned whole so the reveal needs no second round trip, and
  -- `power` is the PRINTED value: the client adds the level itself, keeping
  -- basePower/power the one invariant it has always been.
  return jsonb_build_object(
    'card', jsonb_build_object(
      'id', v_card.id, 'name', v_card.name, 'position', v_card.position,
      'power', v_card.power, 'rarity', v_card.rarity,
      'league', v_card.league, 'region', v_card.region,
      'image_url', v_card.image_url, 'image_thumb_url', v_card.image_thumb_url),
    'duplicate',     v_duplicate,
    'shards_gained', v_gained,
    'level',         coalesce(v_level, 0),
    'shards',        coalesce(v_shards, 0),
    'cost',          v_pack.cost,
    'gems',          v_gems);
end $$;


-- ---------------------------------------------------------------------------
-- 7. train_card
-- ---------------------------------------------------------------------------
-- 002 capped the level RANGE at 10 but never the COST, so the level could be
-- set to 10 for free. The curve lives here now; the client's copy becomes a
-- display of the price rather than the thing that charges it.

-- bigint, NOT integer, so this REPLACES the train_card() migration 005 already
-- installed instead of sitting beside it as a second overload. Two overloads
-- and PostgREST cannot choose between them -- every training call would fail
-- with "could not choose the best candidate function" and the fallback path
-- would not catch it, because the function is not missing, it is ambiguous.
create or replace function public.train_card(p_card_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile     public.profiles%rowtype;
  v_owned       public.user_cards%rowtype;
  v_need_shards integer;
  v_need_gems   integer;
  v_gems        integer;
begin
  v_profile := public.economy_begin();

  select * into v_owned from public.user_cards
   where user_id = v_profile.id and card_id = p_card_id for update;
  if not found then
    raise exception 'You do not own that card.' using errcode = '22023';
  end if;
  if v_owned.level >= 10 then
    raise exception 'Already at maximum level.' using errcode = '22023';
  end if;

  -- Mirrors shardsForLevel()/gemsForLevel() in lib/game-data.js.
  v_need_shards := 2 + v_owned.level * 2;
  v_need_gems   := 40 + v_owned.level * 30;

  if v_owned.shards < v_need_shards then
    raise exception 'Not enough shards.' using errcode = '22023';
  end if;
  if v_profile.gems < v_need_gems then
    raise exception 'Not enough gems.' using errcode = '22023';
  end if;

  update public.user_cards
     set level  = level + 1,
         shards = shards - v_need_shards
   where user_id = v_profile.id and card_id = p_card_id
   returning level, shards into v_owned.level, v_owned.shards;

  v_gems := public.economy_apply_gems(
    v_profile.id, -v_need_gems, 'train_card',
    jsonb_build_object('card_id', p_card_id, 'level', v_owned.level));

  return jsonb_build_object(
    'card_id', p_card_id, 'level', v_owned.level, 'shards', v_owned.shards, 'gems', v_gems);
end $$;


-- ---------------------------------------------------------------------------
-- 8. settle_match
-- ---------------------------------------------------------------------------
-- The one function here that cannot verify what it is told. See the note at
-- the top of the file: it takes the outcome on trust, then decides the reward,
-- the streak, the season bookkeeping and the history row itself, and refuses
-- to do any of it faster than a real match can be played.
--
-- p_kind: 'league' advances the season; 'cup', 'challenge' and 'friendly'
-- deliberately do not, matching finalizeMatch()'s isCupMatch/isChallengeMatch
-- suppression.

create or replace function public.settle_match(
  p_result        text,
  p_kind          text default 'league',
  p_zones_won     integer default 0,
  p_my_power      integer default 0,
  p_opp_power     integer default 0,
  p_opponent_name text default null,
  p_formation     text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile  public.profiles%rowtype;
  v_last     timestamptz;
  v_recent   integer;
  v_earned   integer;
  v_won      boolean;
  v_draw     boolean;
  v_streak   integer;
  v_best     integer;
  v_points   integer;
  v_bonus    integer := 0;
  v_rollover boolean := false;
  v_season   integer;
  v_matchday integer;
  v_gems     integer;
begin
  if p_result not in ('win', 'draw', 'loss') then
    raise exception 'Unknown match result.' using errcode = '22023';
  end if;
  if coalesce(p_kind, 'league') not in ('league', 'cup', 'challenge', 'friendly') then
    raise exception 'Unknown match kind.' using errcode = '22023';
  end if;

  v_profile := public.economy_begin();

  -- A real match cannot finish this fast, so anything that does is a script.
  -- The window is short on purpose: the legacy timed match is only about
  -- forty seconds end to end and must never be rejected.
  select max(played_at) into v_last from public.matches where user_id = v_profile.id;
  if v_last is not null and v_last > now() - interval '15 seconds' then
    raise exception 'That match was recorded too quickly after the last one.' using errcode = '22023';
  end if;

  select count(*) into v_recent from public.matches
   where user_id = v_profile.id and played_at > now() - interval '24 hours';
  if v_recent >= 400 then
    raise exception 'Too many matches recorded today.' using errcode = '22023';
  end if;

  v_won  := p_result = 'win';
  v_draw := p_result = 'draw';
  -- WIN_GEMS / DRAW_GEMS / LOSS_GEMS in index.html.
  v_earned := case when v_won then 20 when v_draw then 10 else 5 end;

  -- A draw resets the streak, same as the client's `won ? streak+1 : 0`.
  v_streak := case when v_won then coalesce(v_profile.win_streak, 0) + 1 else 0 end;
  v_best   := greatest(coalesce(v_profile.best_streak, 0), v_streak);

  v_season   := v_profile.season_number;
  v_matchday := v_profile.season_matchday;
  v_points   := v_profile.season_points;

  if coalesce(p_kind, 'league') = 'league' then
    v_points := coalesce(v_points, 0) + case when v_won then 3 when v_draw then 1 else 0 end;
    if coalesce(v_matchday, 1) >= 6 then
      v_rollover := true;
      v_bonus    := v_points * 2;
      v_season   := coalesce(v_season, 1) + 1;
      v_matchday := 1;
      v_points   := 0;
    else
      v_matchday := coalesce(v_matchday, 1) + 1;
    end if;
  end if;

  insert into public.matches (
    user_id, season_number, matchday, opponent_name, formation,
    result, zones_won, my_power, opp_power, gems_earned)
  values (
    v_profile.id, v_profile.season_number, v_profile.season_matchday,
    p_opponent_name, p_formation,
    p_result, greatest(coalesce(p_zones_won, 0), 0),
    greatest(coalesce(p_my_power, 0), 0), greatest(coalesce(p_opp_power, 0), 0),
    v_earned + v_bonus);

  update public.profiles
     set wins            = coalesce(wins, 0)   + case when v_won then 1 else 0 end,
         losses          = coalesce(losses, 0) + case when not v_won and not v_draw then 1 else 0 end,
         draws           = coalesce(draws, 0)  + case when v_draw then 1 else 0 end,
         win_streak      = v_streak,
         best_streak     = v_best,
         season_number   = v_season,
         season_matchday = v_matchday,
         season_points   = v_points
   where id = v_profile.id;

  v_gems := public.economy_apply_gems(
    v_profile.id, v_earned + v_bonus, 'match_reward',
    jsonb_build_object('result', p_result, 'kind', p_kind, 'season_bonus', v_bonus));

  return jsonb_build_object(
    'gems_earned',     v_earned,
    'season_bonus',    v_bonus,
    'season_rollover', v_rollover,
    'gems',            v_gems,
    'wins',            coalesce(v_profile.wins, 0)   + case when v_won then 1 else 0 end,
    'losses',          coalesce(v_profile.losses, 0) + case when not v_won and not v_draw then 1 else 0 end,
    'draws',           coalesce(v_profile.draws, 0)  + case when v_draw then 1 else 0 end,
    'win_streak',      v_streak,
    'best_streak',     v_best,
    'season_number',   v_season,
    'season_matchday', v_matchday,
    'season_points',   v_points);
end $$;


-- ---------------------------------------------------------------------------
-- 9. The cup
-- ---------------------------------------------------------------------------
-- The bracket stays client-generated and is stored as given: it is the AI
-- opponents' names and ratings, which is decoration on top of a result the
-- database already cannot verify. What the database does own is the entry
-- fee, the round number and the payout -- so a run cannot be re-cashed, and
-- the fee cannot be dodged or double-charged.
--
-- cup_enter also fixes, structurally, the bug the client has to guard by hand:
-- charging and creating the run in one transaction means there is no window in
-- which the gems have gone and the run has not appeared, or the reverse.

create or replace function public.cup_enter(p_bracket jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_run     public.cup_runs%rowtype;
  v_gems    integer;
begin
  v_profile := public.economy_begin();

  if exists (select 1 from public.cup_runs where user_id = v_profile.id and status = 'active') then
    raise exception 'You already have a cup run in progress.' using errcode = '22023';
  end if;
  -- CUP_ENTRY_COST in index.html.
  if v_profile.gems < 150 then
    raise exception 'Not enough gems to enter the cup.' using errcode = '22023';
  end if;

  insert into public.cup_runs (user_id, status, round, bracket, gems_won)
  values (v_profile.id, 'active', 0, coalesce(p_bracket, '[]'::jsonb), 0)
  returning * into v_run;

  v_gems := public.economy_apply_gems(
    v_profile.id, -150, 'cup_entry', jsonb_build_object('run_id', v_run.id));

  return jsonb_build_object('run', to_jsonb(v_run), 'gems', v_gems);
end $$;

create or replace function public.cup_advance(p_won boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile   public.profiles%rowtype;
  v_run       public.cup_runs%rowtype;
  v_reward    integer;
  v_champion  boolean;
  v_gems      integer;
  v_results   jsonb;
  v_bracket   jsonb;
begin
  v_profile := public.economy_begin();

  select * into v_run from public.cup_runs
   where user_id = v_profile.id and status = 'active' for update;
  if not found then
    raise exception 'You have no cup run in progress.' using errcode = '22023';
  end if;
  if v_run.round < 0 or v_run.round > 2 then
    raise exception 'That cup run is already finished.' using errcode = '22023';
  end if;

  if not p_won then
    update public.cup_runs
       set status = 'eliminated', finished_at = now()
     where id = v_run.id;
    return jsonb_build_object('won', false, 'champion', false, 'reward', 0,
                              'round', v_run.round, 'gems', v_profile.gems);
  end if;

  -- CUP_REWARD per round, from index.html's CUP_REWARDS.
  v_reward   := (array[120, 260, 600])[v_run.round + 1];
  v_champion := v_run.round >= 2;

  -- cup_runs.bracket defaults to an empty ARRAY in migration 002 while the
  -- client stores an OBJECT, and jsonb_set errors on an array with a text
  -- path -- so anything that isn't an object is replaced rather than patched.
  v_bracket := case when jsonb_typeof(v_run.bracket) = 'object' then v_run.bracket else '{}'::jsonb end;
  v_results := coalesce(v_bracket -> 'results', '[]'::jsonb) || to_jsonb('win'::text);

  update public.cup_runs
     set round       = v_run.round + 1,
         bracket     = jsonb_set(v_bracket, '{results}', v_results, true),
         gems_won    = coalesce(gems_won, 0) + v_reward,
         status      = case when v_champion then 'won' else 'active' end,
         finished_at = case when v_champion then now() else null end
   where id = v_run.id;

  v_gems := public.economy_apply_gems(
    v_profile.id, v_reward, 'cup_reward',
    jsonb_build_object('run_id', v_run.id, 'round', v_run.round, 'champion', v_champion));

  return jsonb_build_object('won', true, 'champion', v_champion, 'reward', v_reward,
                            'round', v_run.round, 'gems', v_gems);
end $$;

-- Withdrawing is the one cup write with no money in it, but cup_runs loses
-- its direct UPDATE grant in phase 2, so it needs a door of its own.
create or replace function public.cup_forfeit()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  update public.cup_runs
     set status = 'eliminated', finished_at = now()
   where user_id = v_uid and status = 'active';
  return jsonb_build_object('ok', true);
end $$;


-- ---------------------------------------------------------------------------
-- 10. Daily reward
-- ---------------------------------------------------------------------------
-- Fully checkable server-side, unlike the match rewards -- the only input is
-- the date. Dates are taken in UTC because the client's todayStr() is
-- `new Date().toISOString().slice(0,10)`, which is UTC too; using the
-- database's local date would let a player near midnight claim twice.

create or replace function public.claim_daily()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_today   date := (now() at time zone 'utc')::date;
  v_last    date;
  v_streak  integer;
  v_reward  integer;
  v_gems    integer;
begin
  v_profile := public.economy_begin();

  -- The column may be a date or a text 'YYYY-MM-DD' depending on how the
  -- table was first created; casting through text handles both.
  v_last := nullif(v_profile.daily_last_claim::text, '')::date;

  if v_last = v_today then
    raise exception 'Today''s reward has already been claimed.' using errcode = '22023';
  end if;

  -- activeDailyStreak() in index.html: a streak survives only if the last
  -- claim was today or yesterday.
  v_streak := case when v_last = v_today - 1 then coalesce(v_profile.daily_streak, 0) else 0 end;
  -- DAILY_REWARDS ladder.
  v_reward := (array[10, 15, 20, 25, 35, 45, 60])[(v_streak % 7) + 1];

  update public.profiles
     set daily_last_claim = to_char(v_today, 'YYYY-MM-DD'),
         daily_streak     = v_streak + 1
   where id = v_profile.id;

  v_gems := public.economy_apply_gems(
    v_profile.id, v_reward, 'daily_reward', jsonb_build_object('streak', v_streak + 1));

  return jsonb_build_object('reward', v_reward, 'streak', v_streak + 1,
                            'last_claim', to_char(v_today, 'YYYY-MM-DD'), 'gems', v_gems);
end $$;


-- ---------------------------------------------------------------------------
-- 11. Objectives
-- ---------------------------------------------------------------------------
-- Progress is re-measured here rather than believed. Season wins come from
-- the matches table filtered to the current season, exactly as the client
-- derives them, so the two can never disagree about whether a target is met.

create or replace function public.objective_progress(p_user uuid, p_metric text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer := 0;
begin
  if p_metric = 'season_wins' then
    select count(*) into v_n from public.matches m
      join public.profiles p on p.id = m.user_id
     where m.user_id = p_user and m.result = 'win' and m.season_number = p.season_number;
  elsif p_metric = 'cards_owned' then
    select count(*) into v_n from public.user_cards where user_id = p_user;
  elsif p_metric = 'best_streak' then
    select coalesce(best_streak, 0) into v_n from public.profiles where id = p_user;
  elsif p_metric = 'owns_epic_or_better' then
    select count(*) into v_n from public.user_cards uc
      join public.cards c on c.id = uc.card_id
     where uc.user_id = p_user and public.rarity_rank(c.rarity) >= public.rarity_rank('Epic');
    v_n := least(v_n, 1);
  elsif p_metric = 'owns_legendary_or_better' then
    select count(*) into v_n from public.user_cards uc
      join public.cards c on c.id = uc.card_id
     where uc.user_id = p_user and public.rarity_rank(c.rarity) >= public.rarity_rank('Legendary');
    v_n := least(v_n, 1);
  elsif p_metric = 'trades_completed' then
    select count(*) into v_n from public.trades
     where status = 'completed' and p_user in (initiator_id, recipient_id);
  else
    raise exception 'Unknown objective metric: %', p_metric using errcode = '22023';
  end if;
  return coalesce(v_n, 0);
end $$;

create or replace function public.claim_objective(p_objective_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_def     public.objective_defs%rowtype;
  v_have    integer;
  v_gems    integer;
  v_is_pg_array boolean;
begin
  v_profile := public.economy_begin();

  select * into v_def from public.objective_defs where id = p_objective_id;
  if not found then
    raise exception 'Unknown objective.' using errcode = '22023';
  end if;
  -- to_jsonb() of either a text[] or a jsonb column gives a jsonb array, so
  -- the membership test works without this file having to know which one
  -- profiles.objectives_claimed actually is.
  if to_jsonb(v_profile.objectives_claimed) ? p_objective_id then
    raise exception 'That objective has already been claimed.' using errcode = '22023';
  end if;

  v_have := public.objective_progress(v_profile.id, v_def.metric);
  if v_have < v_def.target then
    raise exception 'That objective is not complete yet.' using errcode = '22023';
  end if;

  -- The append cannot be written once for both types. plpgsql only parses a
  -- statement when it is first reached, so the branch that does not apply is
  -- never compiled and cannot fail.
  select data_type = 'ARRAY' into v_is_pg_array
    from information_schema.columns
   where table_schema = 'public' and table_name = 'profiles'
     and column_name = 'objectives_claimed';

  if v_is_pg_array then
    update public.profiles
       set objectives_claimed = coalesce(objectives_claimed, array[]::text[]) || array[p_objective_id]
     where id = v_profile.id;
  else
    update public.profiles
       set objectives_claimed = coalesce(objectives_claimed, '[]'::jsonb) || to_jsonb(p_objective_id)
     where id = v_profile.id;
  end if;

  v_gems := public.economy_apply_gems(
    v_profile.id, v_def.reward, 'objective_reward', jsonb_build_object('objective', p_objective_id));

  return jsonb_build_object('objective', p_objective_id, 'reward', v_def.reward, 'gems', v_gems);
end $$;


-- ---------------------------------------------------------------------------
-- 12. Starter squad
-- ---------------------------------------------------------------------------
-- Replaces the client-side grant in initializeNewAccountIfNeeded(), including
-- its legacy-localStorage branch -- that branch reads a JSON blob out of the
-- browser and inserts whatever card ids and gem balance it names, which is a
-- free-cards hole that needs no console at all.
--
-- The split (2 GK, 5 DEF, 6 MID, 5 FWD from the lowest-id active Commons) is
-- pickStarterCardIds() moved verbatim, so the same cards are granted as
-- before. Does nothing if the player already owns anything, so it is safe to
-- call on every sign-in.

create or replace function public.claim_starter_squad()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_granted integer := 0;
begin
  v_profile := public.economy_begin();

  if exists (select 1 from public.user_cards where user_id = v_profile.id) then
    return jsonb_build_object('granted', 0, 'already_had_cards', true);
  end if;

  with ranked as (
    select c.id, c.position,
           row_number() over (partition by c.position order by c.id) as rn
      from public.cards c
     where c.rarity = 'Common' and coalesce(c.active, true)
  )
  insert into public.user_cards (user_id, card_id)
  select v_profile.id, r.id
    from ranked r
    join (values ('GK', 2), ('DEF', 5), ('MID', 6), ('FWD', 5)) as split(pos, n)
      on split.pos = r.position
   where r.rn <= split.n
  on conflict (user_id, card_id) do nothing;

  get diagnostics v_granted = row_count;
  return jsonb_build_object('granted', v_granted, 'already_had_cards', false);
end $$;


-- ---------------------------------------------------------------------------
-- 13. Admin gem grants
-- ---------------------------------------------------------------------------
-- The admin panel sets another player's balance with a direct profiles
-- update, and the Admin tab has a "give myself gems" button doing the same.
-- Both stop working the moment gems loses its column grant, so they move
-- behind an admin-checked function -- the same shape 003 used for bans.

create or replace function public.admin_set_gems(target_id uuid, new_gems integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current integer;
  v_gems    integer;
begin
  if not public.caller_is_admin() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;
  if new_gems < 0 then
    raise exception 'A balance cannot be negative.' using errcode = '22023';
  end if;

  select gems into v_current from public.profiles where id = target_id for update;
  if not found then
    raise exception 'Profile not found.' using errcode = 'P0002';
  end if;

  v_gems := public.economy_apply_gems(
    target_id, new_gems - coalesce(v_current, 0), 'admin_set',
    jsonb_build_object('by', auth.uid()));
  return v_gems;
end $$;


-- ---------------------------------------------------------------------------
-- 14. Who may call what
-- ---------------------------------------------------------------------------
-- Same shape as 003: nothing is reachable by an anonymous caller, and the
-- internal helpers are reachable by nobody -- the entry points run as the
-- owner, so they can call them regardless.

revoke all on function public.economy_apply_gems(uuid, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.economy_begin()                                from public, anon, authenticated;
revoke all on function public.objective_progress(uuid, text)                 from public, anon, authenticated;

revoke all on function public.open_pack(text)                                          from public, anon;
revoke all on function public.train_card(bigint)                                       from public, anon;
revoke all on function public.settle_match(text, text, integer, integer, integer, text, text) from public, anon;
revoke all on function public.cup_enter(jsonb)                                         from public, anon;
revoke all on function public.cup_advance(boolean)                                     from public, anon;
revoke all on function public.cup_forfeit()                                            from public, anon;
revoke all on function public.claim_daily()                                            from public, anon;
revoke all on function public.claim_objective(text)                                    from public, anon;
revoke all on function public.claim_starter_squad()                                    from public, anon;
revoke all on function public.admin_set_gems(uuid, integer)                            from public, anon;

grant execute on function public.open_pack(text)                                          to authenticated;
grant execute on function public.train_card(bigint)                                       to authenticated;
grant execute on function public.settle_match(text, text, integer, integer, integer, text, text) to authenticated;
grant execute on function public.cup_enter(jsonb)                                         to authenticated;
grant execute on function public.cup_advance(boolean)                                     to authenticated;
grant execute on function public.cup_forfeit()                                            to authenticated;
grant execute on function public.claim_daily()                                            to authenticated;
grant execute on function public.claim_objective(text)                                    to authenticated;
grant execute on function public.claim_starter_squad()                                    to authenticated;
grant execute on function public.admin_set_gems(uuid, integer)                            to authenticated;

-- rarity_rank/shards_for_duplicate are pure arithmetic over public constants;
-- exposing them lets the client show a price without a second copy of the
-- table, and they leak nothing.
grant execute on function public.rarity_rank(text)          to authenticated, anon;
grant execute on function public.shards_for_duplicate(text) to authenticated, anon;


-- ===========================================================================
-- PHASE 2 -- the lock-down
-- ===========================================================================
-- Nothing below runs on paste. economy_lock_down() and economy_unlock() are
-- deliberately NOT granted to authenticated or anon, so the only way to call
-- either is from the Supabase SQL editor, which is the only place that should
-- be deciding this.
--
--     select public.economy_lock_down();   -- close it
--     select public.economy_unlock();      -- put it back
--
-- Both return the list of profile columns the client is left able to write,
-- so the result is also the audit.

create or replace function public.economy_lock_down()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  cols text;
begin
  -- Postgres has no "revoke one column" while a table-level grant exists, so
  -- this repeats 003's trick with a longer exclusion list: revoke UPDATE on
  -- the table, re-grant it per column, leave out the economy. Built from
  -- information_schema so a column added later is granted by default, which
  -- matches how the app already treats profile fields -- at the cost that a
  -- future economy column has to be added to this list by hand.
  select string_agg(quote_ident(column_name), ', ' order by column_name)
    into cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'profiles'
    and column_name not in (
      -- identity and privilege, from migration 003
      'id', 'created_at', 'is_admin', 'banned',
      -- the economy
      'gems',
      'wins', 'losses', 'draws', 'win_streak', 'best_streak',
      'season_number', 'season_matchday', 'season_points',
      'daily_last_claim', 'daily_streak', 'objectives_claimed');

  execute 'revoke update on public.profiles from authenticated, anon';
  execute 'grant update (' || cols || ') on public.profiles to authenticated';

  -- Ownership and training. SELECT stays: the client reads its own
  -- collection constantly. execute_trade and admin_reset_player_progress are
  -- SECURITY DEFINER and are unaffected by any of this.
  revoke insert, update, delete on public.user_cards from authenticated, anon;

  -- Match history is written by settle_match now.
  revoke insert, update, delete on public.matches from authenticated, anon;

  -- Cup runs are created and advanced by cup_enter/cup_advance/cup_forfeit.
  revoke insert, update, delete on public.cup_runs from authenticated, anon;

  return cols;
end $$;

create or replace function public.economy_unlock()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  cols text;
begin
  -- Restores the state migration 003 left behind -- NOT Supabase's default.
  -- is_admin and banned stay revoked; anon gets nothing back.
  select string_agg(quote_ident(column_name), ', ' order by column_name)
    into cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'profiles'
    and column_name not in ('id', 'created_at', 'is_admin', 'banned');

  execute 'revoke update on public.profiles from authenticated, anon';
  execute 'grant update (' || cols || ') on public.profiles to authenticated';

  grant insert, update, delete on public.user_cards to authenticated;
  grant insert                 on public.matches    to authenticated;
  grant insert, update, delete on public.cup_runs   to authenticated;

  return cols;
end $$;

revoke all on function public.economy_lock_down() from public, anon, authenticated;
revoke all on function public.economy_unlock()    from public, anon, authenticated;


-- ===========================================================================
-- 15. Verification
-- ===========================================================================
--
-- After PHASE 1 (pasting this file), all of these should succeed:
--
--   select count(*) from public.pack_defs;         -- 6
--   select count(*) from public.objective_defs;    -- 12
--   select count(*) from public.gem_ledger;        -- 0, but the table exists
--   select public.shards_for_duplicate('GOAT');    -- 12
--
--   -- no player should own the same card twice any more:
--   select user_id, card_id, count(*) from public.user_cards
--   group by 1,2 having count(*) > 1;              -- no rows
--
--   -- the odds still add up to what the shop advertises:
--   select id, cost, (select sum(value::numeric) from jsonb_each_text(weights)) as total_weight
--   from public.pack_defs order by sort_order;
--
-- Then, SIGNED IN AS A REAL PLAYER in the app (not the SQL editor -- these
-- read auth.uid()), open a pack, train a card and play a match. Phase 1
-- changes nothing for the old client, so this is testing the new one.
--
--
-- After PHASE 2 (select public.economy_lock_down();), the console lines that
-- used to work should all fail:
--
--   sb.from("user_cards").insert({ user_id: me, card_id: 1 })      -- denied
--   sb.from("user_cards").update({ level: 10, shards: 99999 })     -- denied
--   sb.from("profiles").update({ gems: 999999999 })                -- denied
--
-- and this should list only cosmetic/identity columns:
--
--   select column_name from information_schema.column_privileges
--   where table_schema='public' and table_name='profiles'
--     and grantee='authenticated' and privilege_type='UPDATE'
--   order by column_name;
--
-- If anything in the game breaks, `select public.economy_unlock();` puts it
-- all back immediately and nothing is lost.
