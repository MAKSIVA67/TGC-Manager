-- 003_lock_down_admin_columns.sql
--
-- Closes a privilege-escalation hole.
--
-- Supabase's default grants give `authenticated` (and `anon`) UPDATE on every
-- column of every table, and leaves row-level security as the only boundary.
-- RLS can restrict WHICH ROWS you may write, but never WHICH COLUMNS -- so the
-- policy that (correctly) lets a player update their own profile row also let
-- them write `is_admin` and `banned` on it. One line in the browser console:
--
--     sb.from("profiles").update({ is_admin: true, banned: false })
--       .eq("id", <their own id>)
--
-- ...promoted any player to a full admin of the game: card CRUD, promo codes,
-- other players' gems and bans, and the admin_profiles RPC that exposes email
-- addresses. A banned player could also simply unban themselves.
--
-- The fix is column-level privileges. Postgres has no "revoke one column"
-- when a table-level grant exists, so this revokes UPDATE on the table and
-- re-grants it on every column EXCEPT the four the client has no business
-- writing. The column list is built dynamically so this keeps working if the
-- table gains columns later -- anything new is granted by default, which
-- matches how the app already treats profile fields.
--
-- The admin panel legitimately needs to set those two columns, so they move
-- behind SECURITY DEFINER functions that verify the caller is an admin
-- server-side, where the check can't be bypassed.
--
-- Safe to run more than once.

-- ---------------------------------------------------------------- privileges

do $$
declare
  cols text;
begin
  select string_agg(quote_ident(column_name), ', ')
    into cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'profiles'
    -- id/created_at are identity, is_admin/banned are the privilege columns.
    and column_name not in ('id', 'created_at', 'is_admin', 'banned');

  execute 'revoke update on public.profiles from authenticated, anon';
  execute 'grant update (' || cols || ') on public.profiles to authenticated';
  -- anon is deliberately NOT re-granted: a signed-out caller has no auth.uid()
  -- and so no legitimate profile write.
end $$;

-- ------------------------------------------------------------------- helpers

-- Is the CALLER an admin? Defined here rather than trusting any client flag.
create or replace function public.caller_is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------------- bans

create or replace function public.admin_set_banned(target_id uuid, new_banned boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.caller_is_admin() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;
  -- Locking yourself out of your own game is unrecoverable from the app.
  if new_banned and target_id = auth.uid() then
    raise exception 'You cannot ban yourself.' using errcode = '22023';
  end if;
  update public.profiles set banned = new_banned where id = target_id;
end $$;

-- -------------------------------------------------------------- admin rights

create or replace function public.admin_set_admin(target_id uuid, new_is_admin boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.caller_is_admin() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;
  -- Same reasoning: don't let the last admin demote themselves by accident.
  if not new_is_admin and target_id = auth.uid() then
    raise exception 'You cannot remove your own admin status.' using errcode = '22023';
  end if;
  update public.profiles set is_admin = new_is_admin where id = target_id;
end $$;

-- Only signed-in callers may even attempt these; the functions themselves then
-- decide whether the caller is actually an admin.
revoke all on function public.caller_is_admin()                     from public, anon;
revoke all on function public.admin_set_banned(uuid, boolean)       from public, anon;
revoke all on function public.admin_set_admin(uuid, boolean)        from public, anon;
grant execute on function public.caller_is_admin()                  to authenticated;
grant execute on function public.admin_set_banned(uuid, boolean)    to authenticated;
grant execute on function public.admin_set_admin(uuid, boolean)     to authenticated;

-- ------------------------------------------------------------- verification
--
-- After running this, re-run the audit query and confirm that `is_admin` and
-- `banned` no longer appear:
--
--   select grantee, privilege_type, column_name
--   from information_schema.column_privileges
--   where table_schema='public' and table_name='profiles'
--     and grantee in ('authenticated','anon') and privilege_type='UPDATE'
--   order by column_name;
--
-- Expect: no `anon` rows at all, and no `is_admin`/`banned` rows.
