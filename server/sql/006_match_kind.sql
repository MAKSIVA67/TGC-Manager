-- 006_match_kind.sql
--
-- Tells league games, cup ties and friendly challenges apart in `matches`.
--
-- Every match the client plays is inserted into this table, and the row had
-- nothing on it saying WHICH COMPETITION it belonged to. The season table
-- (wins/draws/losses under "Season N · Matchday M") is derived from these rows
-- rather than kept as a counter, precisely so it can never drift from the
-- history -- but with no way to exclude them, a cup run and a few friendlies
-- were being counted as league results.
--
-- The same missing distinction caused a second, worse bug: the client read
-- only the last 20 rows and assumed a 6-matchday season always fit inside
-- them. Cup ties and friendlies do not advance a matchday, so enough of them
-- pushed genuine league results out of that window and the record silently
-- shrank -- which in turn un-completed the "Win 3 Matches" objective for
-- players who had legitimately earned it. The client fix is separate and does
-- not need this migration to work; this file is what lets it stop counting cup
-- and friendly results as well.
--
-- Safe to run more than once.


-- ===========================================================================
-- 1. THE COLUMN
-- ===========================================================================
-- Deliberately nullable with NO default. Null means "written before this
-- column existed" -- it is not an assertion that the match was a league game,
-- and giving it a default would turn it into one. A player still running a
-- cached copy of the old client keeps inserting null rows after this runs, and
-- those deserve to read as unknown too.

alter table public.matches add column if not exists kind text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'matches_kind_known') then
    alter table public.matches add constraint matches_kind_known
      check (kind is null or kind in ('league', 'cup', 'friendly'));
  end if;
end $$;

-- The season record now asks for every row of one season instead of the last
-- 20 of all time, so that is the lookup worth indexing.
create index if not exists matches_user_season_idx
  on public.matches (user_id, season_number);

-- PostgREST rejects an insert naming a column it hasn't seen yet, from its own
-- cached copy of the schema, without asking Postgres. It picks the change up
-- by itself within a minute or so; this just stops matches played in that
-- window quietly falling back to an unlabelled row.
notify pgrst, 'reload schema';


-- ===========================================================================
-- 2. NO BACKFILL -- ON PURPOSE
-- ===========================================================================
-- There is live player data in this table and nothing in an existing row can
-- identify a cup tie. The obvious tell, opponent_name, does not work: the
-- eight-team cup field is a SUPERSET of the six league clubs (Ironclad FC,
-- Blaze United, Falcon Rovers, Crimson Athletic, Storm City, Aurora Sporting,
-- plus Vantage Rangers and Kestrel Town), so a cup tie against Storm City is
-- byte-for-byte a league game against Storm City. Friendlies carry whatever
-- the opposing player typed as their team name, which can be any of those.
--
-- Guessing would mean quietly rewriting real history, and every wrong guess
-- deletes a win somebody actually earned -- the exact failure this migration
-- exists to stop. So old rows keep their null, the client counts a null row as
-- a league game (see isLeagueMatchRow() in server/lib/game-data.js), and the
-- numbers every player currently sees stay put. From the moment this runs new
-- rows are stamped correctly, so the mixed-up seasons age out by themselves:
-- one season after the migration, every row of the current season is stamped
-- and the table is exact.


-- ===========================================================================
-- 3. THE APP WITHOUT THIS MIGRATION
-- ===========================================================================
-- Nothing here has to be run for the game to work. The client never names
-- `kind` in a query (it selects *), and when the insert of a finished match is
-- rejected because the column is not in PostgREST's schema cache it writes the
-- row a second time without it. Until this runs, the record simply keeps
-- counting cup and friendly results the way it always has -- the last-20
-- truncation, which is the bug that actually loses wins, is fixed in the
-- client alone.


-- ===========================================================================
-- Done. Check it worked:
--
--   select kind, count(*) from public.matches group by kind;
--
-- Expect one row reading `null` with your existing match count, and -- after
-- playing a league game, a cup tie and a friendly -- `league`, `cup` and
-- `friendly` appearing with a count of 1 each.
-- ===========================================================================
