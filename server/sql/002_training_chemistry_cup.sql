-- TCG Manager -- migration 002
-- Adds: card training (levels + shards), squad chemistry (league/region),
-- and the knockout cup.
--
-- Safe to run more than once: every statement is guarded with IF NOT EXISTS or
-- an ON CONFLICT clause, so a second run changes nothing.
--
-- Paste the whole file into the Supabase SQL editor and press Run.


-- ===========================================================================
-- 1. CARD TRAINING
-- ===========================================================================
-- Packs can now roll a card you already own. Rather than storing a second
-- user_cards row (which would break the "do I own this?" checks all over the
-- client), a duplicate pull adds SHARDS to the row you already have, and
-- shards are spent to raise the card's LEVEL. Each level is +1 power.

alter table public.user_cards add column if not exists level  smallint not null default 0;
alter table public.user_cards add column if not exists shards integer  not null default 0;

-- Levels are capped in the client, but the database should not trust it.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_cards_level_range'
  ) then
    alter table public.user_cards
      add constraint user_cards_level_range check (level >= 0 and level <= 10);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'user_cards_shards_nonneg'
  ) then
    alter table public.user_cards
      add constraint user_cards_shards_nonneg check (shards >= 0);
  end if;
end $$;


-- ===========================================================================
-- 2. CHEMISTRY
-- ===========================================================================
-- Players link when they share a league or a region. Coarse grouping on
-- purpose: it is far less data to get wrong than real club sides, and it still
-- makes squad building a puzzle instead of "pick the eleven biggest numbers".

alter table public.cards add column if not exists league text;
alter table public.cards add column if not exists region text;

-- Backfill. Everything starts unassigned so nothing silently gets a wrong
-- link; the admin panel can set these, and the statements below give the
-- squad a sensible starting spread based on rarity tier.
update public.cards set region = 'World'  where region is null and rarity in ('Icon','GOAT');
update public.cards set league = 'Legends' where league is null and rarity in ('Icon','GOAT');
update public.cards set region = 'World'  where region is null;
update public.cards set league = 'Free Agents' where league is null;


-- ===========================================================================
-- 3. KNOCKOUT CUP
-- ===========================================================================
-- One row per cup run. The bracket itself is a jsonb blob: it is only ever
-- read and written whole by the owning client, so giving each tie its own row
-- would buy nothing and cost a join.

create table if not exists public.cup_runs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  status       text not null default 'active',   -- active | won | eliminated
  round        smallint not null default 0,      -- 0=QF, 1=SF, 2=Final
  bracket      jsonb not null default '[]'::jsonb,
  gems_won     integer not null default 0,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create index if not exists cup_runs_user_idx on public.cup_runs (user_id, created_at desc);

-- Only one active run per player, so "continue my cup" is unambiguous.
create unique index if not exists cup_runs_one_active
  on public.cup_runs (user_id) where status = 'active';

alter table public.cup_runs enable row level security;

-- Owner-only access, matching how user_cards/squads/matches are already
-- locked down. Policies are dropped first so re-running the file is safe.
drop policy if exists cup_runs_select_own on public.cup_runs;
create policy cup_runs_select_own on public.cup_runs
  for select using (auth.uid() = user_id);

drop policy if exists cup_runs_insert_own on public.cup_runs;
create policy cup_runs_insert_own on public.cup_runs
  for insert with check (auth.uid() = user_id);

drop policy if exists cup_runs_update_own on public.cup_runs;
create policy cup_runs_update_own on public.cup_runs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists cup_runs_delete_own on public.cup_runs;
create policy cup_runs_delete_own on public.cup_runs
  for delete using (auth.uid() = user_id);


-- ===========================================================================
-- Done. Check it worked:
--   select level, shards from public.user_cards limit 1;
--   select league, region from public.cards limit 5;
--   select * from public.cup_runs limit 1;   -- empty table, but must exist
-- ===========================================================================
