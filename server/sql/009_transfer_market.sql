-- 009_transfer_market.sql
--
-- The transfer market: quick sell, player listings, daily scouting offers.
--
-- WHY IT HAS TO BE IN THE DATABASE: migration 007's lock-down is in force, so
-- the browser cannot write gems or cards at all. Every move below is a
-- SECURITY DEFINER function that decides the price itself, checks ownership
-- itself, and moves gems only through economy_apply_gems() so each one lands
-- in gem_ledger. economy_begin() locks the caller's profile row first, which
-- is what stops two taps from both spending the same gems, and refuses banned
-- accounts.
--
-- Needs 007 (economy_begin, economy_apply_gems, rarity_rank, gem_ledger) and
-- 008. Only ADDS things, plus one hardening of claim_starter_squad() (section
-- 7). Safe to run more than once.
--
-- ---------------------------------------------------------------------------
-- THE RULES, in one place
-- ---------------------------------------------------------------------------
--   * VALUE of a card = rarity base x (power / 75)^2 x (1 + 6% per training
--     level), rounded to 10. power is the printed power PLUS the level, the
--     same number the app shows. lib/manager.js has the identical formula for
--     display; this one is the one that pays.
--   * QUICK SELL pays 35% of value (rounded to 5, at least 5). Low on purpose:
--     it is a floor, not a way to farm packs. The best pack pays back a few
--     percent of its price in quick-sell value.
--   * PLAYER LISTINGS: price between the quick-sell price and 5x value. The
--     card leaves your collection while listed (escrow), so it cannot be
--     traded, sold twice or played. Buyer pays the price, seller gets it minus
--     a 5% market fee (a gem sink). At most 5 active listings per player.
--     Cancel any time and the card comes back.
--   * DAILY SCOUTING: 4 cards a day, the same 4 for everybody, rotating at
--     midnight UTC, Common to Ultra only -- Legendary and up stay pack-only so
--     the chase is not undercut. Price is 2x value (3x for Elite and Ultra).
--   * You can never go below 9 cards (one full squad), never sell or list a
--     card in your saved squad, and never buy a card you already own.
--
-- ---------------------------------------------------------------------------
-- THE EXPLOIT THIS FILE CLOSES (section 7)
-- ---------------------------------------------------------------------------
-- claim_starter_squad() grants 18 free Commons to any account that owns zero
-- cards. Once cards can be turned into gems, "sell everything, claim again,
-- sell again" would be an infinite gem machine. The 9-card floor stops it
-- through the market; trading everything away to a second account would
-- still reach zero, so the starter squad is now granted ONCE per account:
-- it is refused if the account was granted one after this migration, has
-- ever sold on the market, or has ever completed a trade.


-- ===========================================================================
-- 1. Value and prices
-- ===========================================================================

-- Written as ONE integer fraction on purpose: base x power^2 x (100 + 6 x level)
-- over 75^2 x 100 x 10. lib/market.js computes the same fraction in whole
-- numbers, so the price the app shows and the price this charges can never
-- differ by a rounding step. (Browser floating point turns 250 x 0.35 into
-- 87.4999..., which would have shown 85 gems for a sale that pays 90.)
create or replace function public.card_market_value(p_rarity text, p_power integer, p_level integer)
returns integer
language sql
immutable
as $$
  select greatest(10, (round(
    (case p_rarity
       when 'Common' then 60    when 'Uncommon' then 90   when 'Rare' then 140
       when 'Epic' then 220     when 'Elite' then 320     when 'Ultra' then 460
       when 'Legendary' then 680 when 'Mythic' then 950   when 'Icon' then 1400
       when 'GOAT' then 2200    else 60 end)::numeric
    * greatest(1, coalesce(p_power, 60)) * greatest(1, coalesce(p_power, 60))
    * (100 + 6 * greatest(0, coalesce(p_level, 0)))
    / 5625000) * 10)::integer);
$$;

-- 35% of value, rounded to 5: value x 7 / 100 is the count of fives.
create or replace function public.market_quick_sell_price(p_value integer)
returns integer
language sql
immutable
as $$
  select greatest(5, (round(p_value::numeric * 7 / 100) * 5)::integer);
$$;

create or replace function public.market_scout_price(p_rarity text, p_value integer)
returns integer
language sql
immutable
as $$
  select (round(p_value::numeric * (case when public.rarity_rank(p_rarity) >= public.rarity_rank('Elite') then 3 else 2 end) / 10) * 10)::integer;
$$;

create or replace function public.market_fee(p_price integer)
returns integer
language sql
immutable
as $$
  select greatest(1, ceil(p_price::numeric * 5 / 100))::integer;
$$;


-- ===========================================================================
-- 2. Listings table
-- ===========================================================================

create table if not exists public.market_listings (
  id         bigint generated always as identity primary key,
  seller_id  uuid not null references auth.users(id) on delete cascade,
  card_id    bigint not null references public.cards(id) on delete cascade,
  level      integer not null default 0,
  shards     integer not null default 0,
  price      integer not null check (price > 0),
  status     text not null default 'active' check (status in ('active','sold','cancelled')),
  buyer_id   uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  closed_at  timestamptz
);

create index if not exists market_listings_active_idx on public.market_listings (status, created_at desc);
create index if not exists market_listings_seller_idx on public.market_listings (seller_id, status);

alter table public.market_listings enable row level security;

-- Readable: every active listing, plus anything you sold or bought. Nobody can
-- write it directly -- only the functions below, which run as the owner.
drop policy if exists market_listings_read on public.market_listings;
create policy market_listings_read on public.market_listings
  for select using (status = 'active' or seller_id = auth.uid() or buyer_id = auth.uid());

revoke insert, update, delete on public.market_listings from authenticated, anon;
grant select on public.market_listings to authenticated;


-- ===========================================================================
-- 3. Shared checks
-- ===========================================================================

-- Is this card in the player's SAVED squad? squads.lineup is {"GK":41,"DEF1":43,...};
-- compared as text so a number or a string id both match.
create or replace function public.market_card_in_squad(p_user uuid, p_card_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.squads s, jsonb_each(coalesce(s.lineup, '{}'::jsonb)) e
     where s.user_id = p_user
       and e.value is not null and jsonb_typeof(e.value) <> 'null'
       and (e.value #>> '{}') = p_card_id::text);
$$;

-- The card a player is about to give up, with its value, or an exception
-- saying exactly why they can't. Shared by quick sell and listing.
create or replace function public.market_take_card_check(p_user uuid, p_card_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uc    public.user_cards%rowtype;
  v_card  public.cards%rowtype;
  v_owned integer;
  v_value integer;
begin
  select * into v_uc from public.user_cards where user_id = p_user and card_id = p_card_id for update;
  if not found then
    raise exception 'You do not own that card.' using errcode = '22023';
  end if;
  select * into v_card from public.cards where id = p_card_id;
  if coalesce(v_card.exclusive, false) then
    raise exception 'Exclusive cards cannot be sold.' using errcode = '22023';
  end if;
  if public.market_card_in_squad(p_user, p_card_id) then
    raise exception 'That player is in your squad. Take them out of your squad first.' using errcode = '22023';
  end if;
  select count(*) into v_owned from public.user_cards where user_id = p_user;
  if v_owned <= 9 then
    raise exception 'You need at least 9 cards to field a team, so you cannot sell any more.' using errcode = '22023';
  end if;
  v_value := public.card_market_value(v_card.rarity, v_card.power + coalesce(v_uc.level, 0), v_uc.level);
  return jsonb_build_object('card_id', p_card_id, 'rarity', v_card.rarity, 'name', v_card.name,
    'level', coalesce(v_uc.level, 0), 'shards', coalesce(v_uc.shards, 0), 'value', v_value);
end $$;

-- Give a card to a player, keeping the better level and adding shards if they
-- somehow own it already (only possible for a seller getting a cancelled
-- listing back after pulling the same card from a pack meanwhile).
create or replace function public.market_give_card(p_user uuid, p_card_id bigint, p_level integer, p_shards integer)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.user_cards (user_id, card_id, level, shards)
  values (p_user, p_card_id, coalesce(p_level, 0), coalesce(p_shards, 0))
  on conflict (user_id, card_id) do update
     set level  = greatest(public.user_cards.level, excluded.level),
         shards = public.user_cards.shards + excluded.shards;
$$;


-- ===========================================================================
-- 4. Quick sell
-- ===========================================================================

create or replace function public.market_quick_sell(p_card_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_info    jsonb;
  v_price   integer;
  v_gems    integer;
begin
  v_profile := public.economy_begin();
  v_info := public.market_take_card_check(v_profile.id, p_card_id);
  v_price := public.market_quick_sell_price((v_info->>'value')::integer);
  delete from public.user_cards where user_id = v_profile.id and card_id = p_card_id;
  v_gems := public.economy_apply_gems(v_profile.id, v_price, 'market_quick_sell',
    jsonb_build_object('card_id', p_card_id, 'value', v_info->'value', 'level', v_info->'level'));
  return jsonb_build_object('card_id', p_card_id, 'price', v_price, 'gems', v_gems);
end $$;


-- ===========================================================================
-- 5. Player listings
-- ===========================================================================

create or replace function public.market_list_card(p_card_id bigint, p_price integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_info    jsonb;
  v_value   integer;
  v_min     integer;
  v_max     integer;
  v_active  integer;
  v_id      bigint;
begin
  v_profile := public.economy_begin();
  select count(*) into v_active from public.market_listings where seller_id = v_profile.id and status = 'active';
  if v_active >= 5 then
    raise exception 'You already have 5 players on the market. Cancel one or wait for a sale.' using errcode = '22023';
  end if;
  v_info  := public.market_take_card_check(v_profile.id, p_card_id);
  v_value := (v_info->>'value')::integer;
  v_min   := public.market_quick_sell_price(v_value);
  v_max   := v_value * 5;
  if p_price is null or p_price < v_min or p_price > v_max then
    raise exception 'Price must be between % and % gems for this player.', v_min, v_max using errcode = '22023';
  end if;
  delete from public.user_cards where user_id = v_profile.id and card_id = p_card_id;
  insert into public.market_listings (seller_id, card_id, level, shards, price)
  values (v_profile.id, p_card_id, (v_info->>'level')::integer, (v_info->>'shards')::integer, p_price)
  returning id into v_id;
  return jsonb_build_object('listing_id', v_id, 'card_id', p_card_id, 'price', p_price,
    'fee', public.market_fee(p_price), 'gems', v_profile.gems);
end $$;

create or replace function public.market_cancel_listing(p_listing_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_l       public.market_listings%rowtype;
begin
  v_profile := public.economy_begin();
  select * into v_l from public.market_listings where id = p_listing_id for update;
  if not found or v_l.seller_id <> v_profile.id then
    raise exception 'That listing is not yours.' using errcode = '22023';
  end if;
  if v_l.status <> 'active' then
    raise exception 'That player has already been sold or taken off the market.' using errcode = '22023';
  end if;
  update public.market_listings set status = 'cancelled', closed_at = now() where id = v_l.id;
  perform public.market_give_card(v_profile.id, v_l.card_id, v_l.level, v_l.shards);
  return jsonb_build_object('listing_id', v_l.id, 'card_id', v_l.card_id, 'level', v_l.level, 'shards', v_l.shards);
end $$;

create or replace function public.market_buy_listing(p_listing_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_l       public.market_listings%rowtype;
  v_fee     integer;
  v_gems    integer;
begin
  v_profile := public.economy_begin();
  select * into v_l from public.market_listings where id = p_listing_id for update;
  if not found or v_l.status <> 'active' then
    raise exception 'That player has just been sold or taken off the market.' using errcode = '22023';
  end if;
  if v_l.seller_id = v_profile.id then
    raise exception 'You cannot buy your own listing.' using errcode = '22023';
  end if;
  -- A banned seller must not keep earning from the market.
  if exists (select 1 from public.profiles where id = v_l.seller_id and banned) then
    raise exception 'That player is no longer for sale.' using errcode = '22023';
  end if;
  if exists (select 1 from public.user_cards where user_id = v_profile.id and card_id = v_l.card_id) then
    raise exception 'You already own this player.' using errcode = '22023';
  end if;
  if v_profile.gems < v_l.price then
    raise exception 'Not enough gems.' using errcode = '22023';
  end if;
  v_fee := public.market_fee(v_l.price);
  v_gems := public.economy_apply_gems(v_profile.id, -v_l.price, 'market_buy',
    jsonb_build_object('listing_id', v_l.id, 'card_id', v_l.card_id, 'seller', v_l.seller_id));
  perform public.economy_apply_gems(v_l.seller_id, v_l.price - v_fee, 'market_sale',
    jsonb_build_object('listing_id', v_l.id, 'card_id', v_l.card_id, 'buyer', v_profile.id, 'fee', v_fee));
  perform public.market_give_card(v_profile.id, v_l.card_id, v_l.level, v_l.shards);
  update public.market_listings set status = 'sold', buyer_id = v_profile.id, closed_at = now() where id = v_l.id;
  return jsonb_build_object('listing_id', v_l.id, 'card_id', v_l.card_id, 'price', v_l.price,
    'level', v_l.level, 'shards', v_l.shards, 'gems', v_gems);
end $$;

-- Active listings from OTHER players, newest first, with the seller's name
-- and whether the caller already owns the card. Read-only.
create or replace function public.market_browse()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.created_at desc)
      from (
        select l.id, l.card_id, l.level, l.price, l.created_at,
               coalesce(p.display_name, 'A manager') as seller_name,
               exists (select 1 from public.user_cards u where u.user_id = v_uid and u.card_id = l.card_id) as owned
          from public.market_listings l
          left join public.profiles p on p.id = l.seller_id
         where l.status = 'active' and l.seller_id <> v_uid
           and not coalesce(p.banned, false)
         order by l.created_at desc
         limit 100
      ) x), '[]'::jsonb);
end $$;

-- The caller's own listings (active first, then the last 20 closed ones).
create or replace function public.market_my_listings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(x) order by (x.status = 'active') desc, x.created_at desc)
      from (
        (select id, card_id, level, price, status, created_at, closed_at, public.market_fee(price) as fee
           from public.market_listings where seller_id = v_uid and status = 'active')
        union all
        (select id, card_id, level, price, status, created_at, closed_at, public.market_fee(price) as fee
           from public.market_listings where seller_id = v_uid and status <> 'active'
          order by closed_at desc nulls last limit 20)
      ) x), '[]'::jsonb);
end $$;


-- ===========================================================================
-- 6. Daily scouting
-- ===========================================================================
-- The same 4 cards for everyone on a given UTC day: md5 of the date and the
-- card id is a stable shuffle nobody can steer. Common to Ultra only.

create or replace function public.market_scout_today()
returns table (card_id bigint, rarity text, price integer)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.rarity,
         public.market_scout_price(c.rarity, public.card_market_value(c.rarity, c.power, 0))
    from public.cards c
   where coalesce(c.active, true) and coalesce(c.exclusive, false) = false
     and public.rarity_rank(c.rarity) <= public.rarity_rank('Ultra')
   order by md5((now() at time zone 'utc')::date::text || ':' || c.id::text)
   limit 4;
$$;

create or replace function public.market_scout_offers()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('card_id', s.card_id, 'rarity', s.rarity, 'price', s.price,
             'owned', exists (select 1 from public.user_cards u where u.user_id = v_uid and u.card_id = s.card_id)))
      from public.market_scout_today() s), '[]'::jsonb);
end $$;

create or replace function public.market_buy_scout(p_card_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_price   integer;
  v_gems    integer;
begin
  v_profile := public.economy_begin();
  select s.price into v_price from public.market_scout_today() s where s.card_id = p_card_id;
  if v_price is null then
    raise exception 'That player is not in today''s scouting report.' using errcode = '22023';
  end if;
  if exists (select 1 from public.user_cards where user_id = v_profile.id and card_id = p_card_id) then
    raise exception 'You already own this player.' using errcode = '22023';
  end if;
  if v_profile.gems < v_price then
    raise exception 'Not enough gems.' using errcode = '22023';
  end if;
  v_gems := public.economy_apply_gems(v_profile.id, -v_price, 'market_scout_buy',
    jsonb_build_object('card_id', p_card_id));
  perform public.market_give_card(v_profile.id, p_card_id, 0, 0);
  return jsonb_build_object('card_id', p_card_id, 'price', v_price, 'gems', v_gems);
end $$;


-- ===========================================================================
-- 7. Starter squad: once per account
-- ===========================================================================

create table if not exists public.starter_claims (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  claimed_at timestamptz not null default now()
);
alter table public.starter_claims enable row level security;
revoke all on public.starter_claims from authenticated, anon;

-- Same grant as 007's version, same cards, same return shape. Extra refusals,
-- aimed at exactly the loop and nothing else:
--   * a starter squad was already recorded for this account (from now on), or
--   * the account has ever sold on the market, or completed a trade -- the
--     only two ways to empty a collection on purpose.
-- Deliberately NOT "any economy history": a player whose first claim failed
-- on a bad connection and who then collected a daily reward would be locked
-- out of their starter squad for good.
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
  if exists (select 1 from public.starter_claims where user_id = v_profile.id)
     or exists (select 1 from public.gem_ledger
                 where user_id = v_profile.id
                   and reason in ('market_quick_sell', 'market_sale'))
     or exists (select 1 from public.trades
                 where (initiator_id = v_profile.id or recipient_id = v_profile.id)
                   and status not in ('pending', 'cancelled', 'declined')) then
    return jsonb_build_object('granted', 0, 'already_had_cards', false, 'already_claimed', true);
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
  insert into public.starter_claims (user_id) values (v_profile.id) on conflict (user_id) do nothing;
  return jsonb_build_object('granted', v_granted, 'already_had_cards', false);
end $$;


-- ===========================================================================
-- 8. Who may call what
-- ===========================================================================
-- Players call the market functions. The helpers are internal: they take a
-- user id as an argument, so they must NEVER be callable directly, or anyone
-- could ask "give card X to user Y".

revoke all on function public.market_card_in_squad(uuid, bigint) from public, anon, authenticated;
revoke all on function public.market_take_card_check(uuid, bigint) from public, anon, authenticated;
revoke all on function public.market_give_card(uuid, bigint, integer, integer) from public, anon, authenticated;
revoke all on function public.market_scout_today() from public, anon, authenticated;

revoke all on function public.market_quick_sell(bigint) from public, anon;
revoke all on function public.market_list_card(bigint, integer) from public, anon;
revoke all on function public.market_cancel_listing(bigint) from public, anon;
revoke all on function public.market_buy_listing(bigint) from public, anon;
revoke all on function public.market_browse() from public, anon;
revoke all on function public.market_my_listings() from public, anon;
revoke all on function public.market_scout_offers() from public, anon;
revoke all on function public.market_buy_scout(bigint) from public, anon;

grant execute on function public.market_quick_sell(bigint) to authenticated;
grant execute on function public.market_list_card(bigint, integer) to authenticated;
grant execute on function public.market_cancel_listing(bigint) to authenticated;
grant execute on function public.market_buy_listing(bigint) to authenticated;
grant execute on function public.market_browse() to authenticated;
grant execute on function public.market_my_listings() to authenticated;
grant execute on function public.market_scout_offers() to authenticated;
grant execute on function public.market_buy_scout(bigint) to authenticated;

-- The pure price helpers are harmless and the app may use them to show prices.
grant execute on function public.card_market_value(text, integer, integer) to authenticated, anon;
grant execute on function public.market_quick_sell_price(integer) to authenticated, anon;
grant execute on function public.market_scout_price(text, integer) to authenticated, anon;
grant execute on function public.market_fee(integer) to authenticated, anon;


-- ===========================================================================
-- 9. Checking it worked (run these after the file)
-- ===========================================================================
--   select public.card_market_value('Rare', 74, 0);          -- expect 140
--   select public.market_quick_sell_price(140);              -- expect 50
--   select count(*) from public.market_listings;             -- expect 0
--   select * from public.market_scout_today();               -- 4 rows
