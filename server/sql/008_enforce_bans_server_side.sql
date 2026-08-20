-- 008_enforce_bans_server_side.sql
--
-- Makes a ban actually stop someone playing.
--
-- Until now a ban was enforced entirely in the browser: loadProfile() in
-- auth.js signs the user out when it sees banned = true. Anyone who blocks that
-- one code path, or simply keeps using the JWT they already hold, carries on
-- with full read AND write access. The ban was a suggestion.
--
-- This is the moderation tool everything else leans on -- the answer to "what
-- if someone gives themselves gems" is "I ban them", and that answer needs the
-- ban to be real.
--
-- APPROACH. Deliberately NOT a rewrite of the existing row-level policies.
-- Nobody has a full record of what those policies were before migration 004
-- replaced some of them, and editing rules blind is how you lock yourself out
-- of your own game. Instead this adds a BEFORE INSERT OR UPDATE trigger to
-- every table a player can write, which refuses the write when the CALLER is
-- banned. Triggers compose with whatever policies already exist rather than
-- replacing them, so nothing that works today stops working.
--
-- Admin actions are unaffected: admin_set_banned() and friends are SECURITY
-- DEFINER, but auth.uid() still reports the real caller inside one, so the
-- check reads the ADMIN's banned flag (false) and lets it through. That is
-- also what lets an admin UNBAN somebody -- the banned player's own row can
-- still be written, just not by the banned player.
--
-- Safe to run more than once.


-- ===========================================================================
-- 1. Is the caller banned?
-- ===========================================================================
-- SECURITY DEFINER so it can read profiles.banned regardless of the caller's
-- own read permissions. Returns false when auth.uid() is null, which is the
-- SQL editor and the service role -- neither should ever be locked out.

create or replace function public.is_caller_banned()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select banned from public.profiles where id = auth.uid()), false);
$$;

revoke all on function public.is_caller_banned() from public, anon;
grant execute on function public.is_caller_banned() to authenticated;


-- ===========================================================================
-- 2. The guard
-- ===========================================================================

create or replace function public.reject_if_banned()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_caller_banned() then
    raise exception 'This account is banned.' using errcode = '42501';
  end if;
  return new;
end $$;


-- ===========================================================================
-- 3. Attach it to every table a player writes
-- ===========================================================================
-- Looped rather than written out eight times so a table added later only needs
-- its name adding here. Dropped first so re-running rebuilds cleanly.

do $$
declare
  t text;
  tables text[] := array[
    'profiles', 'user_cards', 'matches', 'squads',
    'messages', 'trades', 'challenges', 'friend_requests', 'cup_runs'
  ];
begin
  foreach t in array tables loop
    -- Skip anything this database doesn't have, so the file stays runnable
    -- against a project where some feature was never migrated in.
    if to_regclass('public.' || t) is null then
      raise notice 'skipping %, table not present', t;
      continue;
    end if;

    execute format('drop trigger if exists %I on public.%I', 'no_writes_when_banned_' || t, t);
    execute format(
      'create trigger %I before insert or update on public.%I
         for each row execute function public.reject_if_banned()',
      'no_writes_when_banned_' || t, t
    );
  end loop;
end $$;


-- ===========================================================================
-- 4. A signed-out visitor has no business deleting player rows
-- ===========================================================================
-- Spotted while auditing: `anon` held DELETE on profiles. Row-level security
-- almost certainly blocked it in practice (anon has no auth.uid(), so no row
-- matches an owner check), but a permission that is only harmless because
-- something else is holding the line is one policy edit away from being live.

revoke delete on public.profiles from anon;


-- ===========================================================================
-- Done. Check it worked:
--
--   select tgname, tgrelid::regclass as table_name
--   from pg_trigger
--   where not tgisinternal and tgname like 'no_writes_when_banned_%'
--   order by 2;
--
-- Expect one row per table above. Then ban a test account from the Admin tab
-- and confirm it can no longer open a pack or play a match.
-- ===========================================================================
