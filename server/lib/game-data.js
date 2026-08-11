// TCG Manager -- cards/squad/matches/economy (Phase A). Ported from the
// mobile app's GameContext.tsx. Same cross-scope note as auth.js: this only
// ever reaches into the game IIFE via `window.state`/`window.render`, never
// a bare `state`/`render`.
"use strict";

// Migration 007 moves every value-creating decision into the database. Each of
// the calls below asks for the outcome instead of announcing it, and each one
// falls back to the old direct write when the function is not there, because
// the migration is pasted into Supabase by hand at a different moment from
// when the site is deployed and either order has to work. rpcMissing() in
// supabase-client.js is the detector, and setBanned() in admin-api.js is the
// shape all of this follows.
//
// The fallbacks are not dead code waiting to be tidied: until 007 has been run
// they ARE the game. They can go once it has, and not before.

// The web version's own hardcoded roster (STARTER_PLAYERS in index.html)
// used to grant 10 fixed ids (GK1/DEF3/MID4/FWD2) out of the box -- but
// `cards` is now sourced from Supabase, seeded with the MOBILE app's roster
// (a completely different id->position mapping, generated independently --
// e.g. ids 1-6 are all GK there, not the web version's original mix).
// Hardcoding specific ids would silently break the moment either roster
// changes, so this picks the same GK1/DEF3/MID4/FWD2 split dynamically
// from whatever Common-tier cards actually exist in the live catalog.
const STARTER_SPLIT = { GK: 2, DEF: 5, MID: 6, FWD: 5 };
function pickStarterCardIds(cards) {
  const commons = cards.filter(c => c.rarity === "Common" && c.active !== false).sort((a, b) => a.id - b.id);
  const ids = [];
  Object.keys(STARTER_SPLIT).forEach(pos => {
    commons.filter(c => c.position === pos).slice(0, STARTER_SPLIT[pos]).forEach(c => ids.push(c.id));
  });
  return ids;
}

function playersById() {
  const map = {};
  window.state.players.forEach(p => { map[p.id] = p; });
  return map;
}

// {slotId: cardId|null} (DB shape, e.g. squads.lineup) -> {slotId:
// cardObject|null} (the shape state.play.myLineup already uses).
function resolveLineupIds(lineupIds, byId) {
  const out = {};
  Object.keys(lineupIds || {}).forEach(slotId => {
    const id = lineupIds[slotId];
    out[slotId] = (id != null && byId[id]) ? byId[id] : null;
  });
  return out;
}
// Inverse -- for writing state.play.myLineup back out to a jsonb column.
function lineupToIds(lineupObj) {
  const out = {};
  Object.keys(lineupObj || {}).forEach(slotId => {
    const card = lineupObj[slotId];
    out[slotId] = card ? card.id : null;
  });
  return out;
}

// Aggregates 4 already-computed zone results (from the existing local
// computeZone()) into a final win/draw/loss. Factored out of
// continueSecondHalf()'s inline math so challenge resolution (Phase D) can
// reuse the exact same aggregate logic without a third copy of it.
function decideMatchFromZones(zGK, zDEF, zMID, zFWD) {
  const zones = [zGK, zDEF, zMID, zFWD];
  let myWins = 0, oppWins = 0;
  zones.forEach(z => { if (z.result === "win") myWins++; else if (z.result === "lose") oppWins++; });
  const myTotalPower = zones.reduce((sum, z) => sum + z.myTotal, 0);
  const oppTotalPower = zones.reduce((sum, z) => sum + z.oppTotal, 0);
  const result = myWins !== oppWins
    ? (myWins > oppWins ? "win" : "loss")
    : (myTotalPower === oppTotalPower ? "draw" : (myTotalPower > oppTotalPower ? "win" : "loss"));
  return { zoneResults: zones, myWins, oppWins, myTotalPower, oppTotalPower, result };
}

function loadCatalogAndOwnership(userId) {
  return Promise.all([
    sb.from("cards").select("*").order("id"),
    // level/shards (training) and league/region (chemistry) arrive with
    // migration 002. Selecting "*" rather than naming them means this keeps
    // working against a database where that migration hasn't been run yet --
    // the fields simply come back undefined and everything defaults.
    sb.from("user_cards").select("*").eq("user_id", userId),
    // The price open_pack() will actually charge. Read so the shop's
    // affordability check and the number on the button can never advertise a
    // cost the server disagrees with. Absent until 007 is run, in which case
    // the client's own PACKS costs stand -- same tolerance loadCupRun() has
    // for 002 not being run.
    sb.from("pack_defs").select("id,cost,active").then(r => r, () => ({ data: null, error: true })),
  ]).then(([cardsRes, ownedRes, packRes]) => {
    const costs = {};
    if (packRes && !packRes.error) {
      (packRes.data || []).forEach(p => { if (p.active !== false) costs[p.id] = p.cost; });
    }
    window.state.packCosts = costs;
    const ownedRows = ownedRes.data || [];
    const owned = {};
    ownedRows.forEach(r => { owned[r.card_id] = r; });
    window.state.players = (cardsRes.data || []).map(c => {
      const row = owned[c.id];
      const level = row && row.level ? row.level : 0;
      return {
        id: c.id, name: c.name, position: c.position,
        // basePower is the printed value; power is what the game actually
        // uses, so every existing power comparison picks up training for free.
        basePower: c.power,
        power: c.power + level,
        rarity: c.rarity,
        owned: !!row,
        level: level,
        shards: row && row.shards ? row.shards : 0,
        league: c.league || null, region: c.region || null,
        exclusive: !!c.exclusive, priceEUR: c.price_eur,
        imageUrl: c.image_url || null, imageThumbUrl: c.image_thumb_url || null,
        // Retired cards (roster shrink to 100 active players) stay owned by
        // whoever already had them, but drop out of pack odds and starter
        // selection -- see pickStarterCardIds() below and the "open-pack"
        // handler in index.html.
        active: c.active !== false,
      };
    });
  });
}

// ------------------------------------------------------- server-decided numbers
// The balances an economy RPC hands back are the STORED ones -- it debited and
// credited in the same transaction it did the work in. applyProfileRow() in
// auth.js merges rather than overwrites (`server + (local - baseline)`), so
// setting state without moving the baseline makes the next profile load add the
// difference a second time. That is exactly how the free-packs bug in 5ab7f72
// happened, in reverse. Set the value AND move the baseline, always together.
//
// Its opposite is equally deliberate: an optimistic spend at tap time (the pack
// cost) moves state.gems and does NOT call noteProfileWrite, so during the
// in-flight window the merge evaluates to the optimistic figure -- which is
// what keeps the shop feeling instant.
function applyServerEconomy(d) {
  if (!d) return;
  const s = window.state, fields = {};
  const num = (v) => typeof v === "number";
  if (num(d.gems))            { s.gems = d.gems;                     fields.gems = d.gems; }
  if (num(d.wins))            { s.stats.wins = d.wins;               fields.wins = d.wins; }
  if (num(d.losses))          { s.stats.losses = d.losses;           fields.losses = d.losses; }
  if (num(d.draws))           { s.stats.draws = d.draws;             fields.draws = d.draws; }
  if (num(d.win_streak))      { s.stats.streak = d.win_streak;       fields.win_streak = d.win_streak; }
  if (num(d.best_streak))     { s.stats.bestStreak = d.best_streak;  fields.best_streak = d.best_streak; }
  if (num(d.season_number))   { s.season.number = d.season_number;   fields.season_number = d.season_number; }
  if (num(d.season_matchday)) { s.season.matchday = d.season_matchday; fields.season_matchday = d.season_matchday; }
  if (num(d.season_points))   { s.season.points = d.season_points;   fields.season_points = d.season_points; }
  noteProfileWrite(fields);
}

// ---------------------------------------------------------------- training
// Levels are +1 power each, capped at 10. Cost curve is deliberately steep at
// the top so a maxed card is a real achievement rather than a formality.
//
// These two now only PRICE a level for the training panel; train_card() in 007
// charges it, and 007 carries its own copy of the same curve. If either one
// moves, move both, or the panel quotes a price the server will not honour.
const MAX_CARD_LEVEL = 10;
function shardsForLevel(level) { return 2 + level * 2; }        // 2,4,6,... 20
function gemsForLevel(level) { return 40 + level * 30; }        // 40,70,...,310

// Shards and levels used to be read-modify-written as ABSOLUTE values built
// from whatever this browser happened to hold, so two writes racing -- a second
// tab, or a duplicate pull landing while a training spend is in flight --
// silently threw one of them away, and the loser still reported success.
// Migration 005 moves the arithmetic into the database: relative (`shards =
// shards + n`), inside one transaction, returning the row it actually
// committed. Until it is run, the *Fallback() paths below compare-and-set
// against the values the row really held, which still refuses a lost update
// instead of reporting one as a success. Same graceful degradation as
// setBanned() in admin-api.js, and rpcMissing() there is the detector.
//
// Nothing is applied optimistically any more. Only a value the server has
// confirmed is ever copied into local state, because a card's shard count
// being ahead of the stored row is precisely what let never-granted shards be
// spent on a real, permanent +1 power level. Both callers already wait on the
// promise before rendering, so the optimism bought no responsiveness anyway.
function applyCardRow(card, row) {
  if (!card || !row) return;
  if (typeof row.shards === "number") card.shards = row.shards;
  if (typeof row.level === "number") {
    card.level = row.level;
    card.power = card.basePower + row.level;
  }
}

function readUserCard(userId, cardId) {
  return sb.from("user_cards").select("level, shards")
    .eq("user_id", userId).eq("card_id", cardId).maybeSingle()
    .then(({ data, error }) => ({ row: data || null, error: error ? error.message : null }));
}

// The expected values go on as extra filters, so the UPDATE matches nothing at
// all if anyone touched the row in between; .select() then reports how many
// rows were really written, turning a lost update into a detectable conflict
// rather than a write that quietly discarded someone else's.
function casUserCard(userId, cardId, expected, fields) {
  let q = sb.from("user_cards").update(fields).eq("user_id", userId).eq("card_id", cardId);
  Object.keys(expected).forEach(k => { q = q.eq(k, expected[k]); });
  return q.select("level, shards").then(({ data, error }) => ({
    row: (data && data[0]) || null,
    error: error ? error.message : null,
  }));
}

// A duplicate pull. The client never stores a second user_cards row -- every
// "do I own this?" check in the app is a set membership test and would break.
// The duplicate becomes shards on the row that already exists.
//
// Resolves { error } because the pack's gem cost is deducted locally at click
// time and only persisted here: swallowing a failure charged for shards that
// don't exist, and skipping the write entirely refunded the pack on reload, so
// packs became free once a collection was complete. The caller now decides.
const SHARD_GRANT_ATTEMPTS = 3;

function grantShards(cardId, n) {
  const session = window.state.session;
  const userId = session && session.user && session.user.id;
  if (!userId) return Promise.resolve({ error: "Not signed in." });
  const card = window.state.players.find(p => p.id === cardId);

  return sb.rpc("grant_card_shards", { p_card_id: cardId, p_shards: n }).then(({ data, error }) => {
    if (error && rpcMissing(error)) return grantShardsFallback(userId, cardId, n, SHARD_GRANT_ATTEMPTS);
    if (error) return { error: error.message };
    if (data && data.error) return { error: data.error };
    return { row: data };
  }).then(res => {
    if (res.error) { console.error("grantShards failed:", res.error); return { error: res.error }; }
    applyCardRow(card, res.row);
    // The shards are stored at this point, so a failure to persist the gem
    // cost must not be reported as a failed grant -- that would hand the cost
    // back for a pack that really did pay out.
    return updateProfile({ gems: window.state.gems }).then(() => ({ error: null }));
  });
}

// Re-reading before each attempt is the point: the whole failure mode is a
// stale base value, so retrying against the same one would lose the same
// update again. A grant is safe to retry because it adds a fixed amount.
function grantShardsFallback(userId, cardId, n, attemptsLeft) {
  return readUserCard(userId, cardId).then(({ row, error }) => {
    if (error) return { error: error };
    if (!row) return { error: "You don't own that card." };
    const have = row.shards || 0;
    return casUserCard(userId, cardId, { shards: have }, { shards: have + n }).then(({ row: written, error: e2 }) => {
      if (e2) return { error: e2 };
      if (written) return { row: written };
      if (attemptsLeft > 1) return grantShardsFallback(userId, cardId, n, attemptsLeft - 1);
      return { error: "That card is being changed somewhere else." };
    });
  });
}

function trainCard(cardId) {
  const session = window.state.session;
  const userId = session && session.user && session.user.id;
  if (!userId) return Promise.resolve({ error: "Not signed in." });
  const card = window.state.players.find(p => p.id === cardId);
  if (!card || !card.owned) return Promise.resolve({ error: "You don't own that card." });
  // Deliberately no local shard check: the shard count is the one number that
  // can be ahead of the database, and gating on it is what let a failed grant
  // buy a level. Affordability is decided against the stored row, below.
  if (card.level >= MAX_CARD_LEVEL) return Promise.resolve({ error: "Already at maximum level." });
  if (window.state.gems < gemsForLevel(card.level)) return Promise.resolve({ error: "Not enough gems." });

  return sb.rpc("train_card", { p_card_id: cardId }).then(({ data, error }) => {
    if (error && rpcMissing(error)) return trainCardFallback(userId, card);
    if (error) return { error: error.message };
    if (data && data.error) return { error: data.error };
    // The RPC debits the gems in the same transaction as the level, so the
    // balance it hands back IS the stored one. Declaring it to auth.js as our
    // own write keeps knownServer level with reality; without that,
    // applyProfileRow would add the local spend on top and charge twice.
    applyServerEconomy(data);
    return { row: data };
  }).then(res => {
    if (res.error) { console.error("trainCard failed:", res.error); return { error: res.error }; }
    applyCardRow(card, res.row);
    return { error: null, level: card.level };
  });
}

function trainCardFallback(userId, card) {
  return readUserCard(userId, card.id).then(({ row, error }) => {
    if (error) return { error: error };
    if (!row) return { error: "You don't own that card." };
    const level = row.level || 0;
    const shards = row.shards || 0;
    if (level >= MAX_CARD_LEVEL) return { error: "Already at maximum level." };
    const needShards = shardsForLevel(level);
    const needGems = gemsForLevel(level);
    if (shards < needShards) return { error: "Not enough shards." };
    if (window.state.gems < needGems) return { error: "Not enough gems." };
    return casUserCard(userId, card.id, { level: level, shards: shards },
                       { level: level + 1, shards: shards - needShards })
      .then(({ row: written, error: e2 }) => {
        if (e2) return { error: e2 };
        // Unlike a grant, a spend is never retried: the cost curve is keyed to
        // the level, so the row having moved means the next attempt would
        // charge a price the player was never shown. Nothing was written, so
        // there is nothing to undo -- but reporting success here is exactly
        // what took the gems for a level that does not exist.
        if (!written) return { error: "That card changed while you were training it — try again." };
        window.state.gems -= needGems;
        return updateProfile({ gems: window.state.gems }).then(() => ({ row: written }));
      });
  });
}

function loadSquad(userId) {
  return sb.from("squads").select("*").eq("user_id", userId).maybeSingle().then(({ data }) => {
    if (data) {
      window.state.play.formationKey = data.formation;
      window.state.play.myLineup = resolveLineupIds(data.lineup || {}, playersById());
    }
  });
}

function saveSquadRemote() {
  const session = window.state.session;
  const userId = session && session.user && session.user.id;
  if (!userId) return Promise.resolve();
  const formation = window.state.play.formationKey;
  const lineup = lineupToIds(window.state.play.myLineup);
  return sb.from("squads")
    .upsert({ user_id: userId, formation, lineup, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
    .then(({ error }) => { if (error) console.error("saveSquadRemote failed:", error.message); });
}

// ------------------------------------------------------- match history kind
// Cup ties and friendly challenges are recorded in `matches` next to league
// games and nothing on the row told them apart, so both counted towards the
// league table. Migration 006 adds `kind` and every write below stamps it.
const MATCH_KIND_LEAGUE = "league";
const MATCH_KIND_CUP = "cup";
const MATCH_KIND_FRIENDLY = "friendly";

// An unstamped row counts as a league game. Rows written before 006 -- and
// rows an older cached client writes after it -- have no `kind`, and a cup tie
// is genuinely indistinguishable from a league game after the fact, because
// the eight-team cup field is a superset of the six league clubs and
// opponent_name therefore proves nothing. Counting them leaves every existing
// player's record reading exactly as it does today; the alternative is
// deleting history the column can't vouch for, which is the same silent
// under-reporting this whole change exists to stop. The pollution ages out on
// its own one season after the migration runs.
function isLeagueMatchRow(row) {
  return row.kind == null || row.kind === MATCH_KIND_LEAGUE;
}

// Unlike a missing FUNCTION (admin-api.js's rpcMissing(), where the call fails
// and a different code path takes over), a missing COLUMN fails the write it
// was attached to -- PostgREST rejects the insert against its schema cache as
// PGRST204 before Postgres ever sees it, and Postgres itself reports 42703 --
// so the only recovery is to send the row again without the field.
function columnMissing(error) {
  return !!error && (error.code === "PGRST204" || error.code === "42703" ||
                     /could not find.*column|column .*does not exist/i.test(error.message || ""));
}

// Season W/L/D isn't a column on `profiles` (only season_number/matchday/
// points are) -- derived here from match history, so it's always
// self-consistent with `matches` instead of a second counter that could drift.
//
// Two queries rather than one, because the two answers need different rows.
// The record must see EVERY league game of the current season, so the season
// is filtered server-side and left unbounded; the recent list wants the newest
// handful whatever season or kind they are, so it keeps its limit. One
// last-20 fetch used to serve both, on the assumption that a 6-matchday season
// always fits -- but cup ties and friendlies land in the same table without
// advancing a matchday, so a couple of cup runs push real league results out
// of the window and the record silently shrinks, taking obj_win3's "Win 3
// Matches" with it.
//
// `select("*")` rather than naming `kind`: naming a column that migration 006
// hasn't added yet fails the whole query, the same reason
// loadCatalogAndOwnership selects everything.
function loadRecentMatchesAndSeason(userId) {
  const seasonNumber = window.state.season.number;
  return Promise.all([
    sb.from("matches").select("*").eq("user_id", userId).order("played_at", { ascending: false }).limit(20),
    sb.from("matches").select("*").eq("user_id", userId).eq("season_number", seasonNumber),
  ]).then(([recentRes, seasonRes]) => {
    window.state.recentMatches = recentRes.data || [];
    // A failed query is not a 0-0-0 season. Treating one as such would wipe a
    // record that is already correct in state whenever the network blips.
    if (seasonRes.error) { console.error("season record load failed:", seasonRes.error.message); return; }
    const league = (seasonRes.data || []).filter(isLeagueMatchRow);
    window.state.season.wins = league.filter(m => m.result === "win").length;
    window.state.season.losses = league.filter(m => m.result === "loss").length;
    window.state.season.draws = league.filter(m => m.result === "draw").length;
  });
}

// New-account bootstrap. claim_starter_squad() picks the same GK2/DEF5/MID6/
// FWD5 split of lowest-id active Commons that pickStarterCardIds() does, and
// does nothing if the account already owns anything, so it is safe on every
// sign-in.
//
// The import of a pre-Supabase `localStorage` save is GONE, not moved. It read
// a JSON blob out of the browser and inserted whatever card ids and gem
// balance it named: `localStorage.setItem("legendxi-preview-save-v1",
// '{"gems":1e9}')` before signing up for the first time minted a balance
// without needing a developer console at all. Clamping the numbers (5ab7f72)
// narrowed it; nothing short of deleting it closes it. Anyone still holding
// such a save on the browser they play on loses the import path -- the blob
// itself is untouched, only the code that read it is gone.
function initializeNewAccountIfNeeded(userId) {
  if (window.state.players.some(p => p.owned)) return Promise.resolve(); // already has cards, nothing to do

  return sb.rpc("claim_starter_squad").then(({ error }) => {
    if (error && rpcMissing(error)) return grantStarterSquadFallback(userId);
    if (error) { console.error("starter squad grant failed:", error.message); return null; }
    return null;
  }).then(() => loadCatalogAndOwnership(userId));
}

function grantStarterSquadFallback(userId) {
  const starterIds = pickStarterCardIds(window.state.players);
  const rows = starterIds.map(cardId => ({ user_id: userId, card_id: cardId }));
  if (!rows.length) return Promise.resolve(null);
  return sb.from("user_cards").insert(rows).then(({ error }) => {
    if (error) console.error("starter card grant failed:", error.message);
    return null;
  });
}

// ------------------------------------------------------------------- packs
// The roll happens in the database. The browser never sees the pool weighting,
// never sees a seed, and cannot retry an outcome it dislikes -- which is the
// entire reason the published odds are now the real odds.
//
// Resolves the shape the shop reveal needs:
//   { card, duplicate, shards_gained, level, shards, gems, cost, error }
// `card.power` is the PRINTED power. The level is added here, on the client,
// because basePower (printed) vs power (printed + level) is an invariant every
// power comparison in the game depends on and the server has no business
// setting the second one.
//
// `{ rpcMissing: true }` rather than an error when 007 is absent: the caller
// owns the local-roll fallback, because the pool and the weights live in
// index.html next to the reel that draws them.
function openPackRemote(packId) {
  const session = window.state.session;
  if (!session || !session.user) return Promise.resolve({ error: "Not signed in." });
  return sb.rpc("open_pack", { p_pack_id: packId }).then(({ data, error }) => {
    if (error && rpcMissing(error)) return { rpcMissing: true };
    if (error) return { error: error.message };
    if (!data || !data.card) return { error: "That pack couldn't be opened." };
    applyServerEconomy(data);
    applyPackResult(data);
    return data;
  });
}

// FALLBACK ONLY -- the insert open_pack() replaces. The gem cost was deducted
// from local state at tap time and is persisted here, in the same round trip,
// because a card granted without the cost persisting is a free pack.
function commitPackOpenFallback(cardId) {
  const session = window.state.session;
  const userId = session && session.user && session.user.id;
  if (!userId) return Promise.resolve({ error: "Not signed in." });
  return sb.from("user_cards").insert({ user_id: userId, card_id: cardId }).then(({ error }) => {
    if (error) { console.error("pack insert failed:", error.message); return { error: error.message }; }
    return updateProfile({ gems: window.state.gems });
  });
}

// Folds an opened pack into state.players. A duplicate must NOT create a
// second entry -- 007 backs that with a unique index rather than trusting this
// to branch correctly, but the local collection is still a set and is still
// updated in place.
function applyPackResult(data) {
  const card = data && data.card;
  if (!card) return;
  const p = window.state.players.find(x => x.id === card.id);
  if (!p) return;
  p.owned = true;
  if (typeof data.level === "number") { p.level = data.level; p.power = p.basePower + data.level; }
  if (typeof data.shards === "number") p.shards = data.shards;
}

// -------------------------------------------------------------------- cup
// An 8-team single-elimination knockout: quarter-final, semi-final, final.
// The bracket is one jsonb blob rather than a row per tie -- it is only ever
// read and written whole by the owning client, so splitting it would buy
// nothing and cost a join.
//
// Every call here tolerates the cup_runs table not existing yet (migration
// 002). On failure it resolves with null and the UI simply hides the cup.
const CUP_ROUND_NAMES = ["Quarter-final", "Semi-final", "Final"];
const CUP_ROUND_REWARD = [120, 260, 600];   // gems for winning each round

function loadCupRun() {
  const session = window.state.session;
  const userId = session && session.user && session.user.id;
  if (!userId) return Promise.resolve(null);
  return sb.from("cup_runs").select("*").eq("user_id", userId).eq("status", "active")
    .maybeSingle()
    .then(({ data, error }) => {
      if (error) { window.state.cupAvailable = false; return null; }
      window.state.cupAvailable = true;
      window.state.cup = data || null;
      return data || null;
    })
    .catch(() => { window.state.cupAvailable = false; return null; });
}

// cup_enter() charges the fee and creates the run in one transaction, which
// deletes an entire class of bug the handler in index.html used to guard by
// hand: there is no longer a window in which the gems have gone and the run
// has not appeared, or the reverse.
//
// Resolves { run, gems, error, charged }. `charged` says whether the fee has
// already been taken -- true on the RPC path (the transaction did it), false on
// the fallback, where the caller still has to pay it the old way.
function createCupRun(bracket) {
  const session = window.state.session;
  const userId = session && session.user && session.user.id;
  if (!userId) return Promise.resolve({ error: "Not signed in." });
  return sb.rpc("cup_enter", { p_bracket: bracket }).then(({ data, error }) => {
    if (error && rpcMissing(error)) return createCupRunFallback(userId, bracket);
    if (error) return { error: error.message };
    applyServerEconomy(data);
    window.state.cup = data.run;
    return { run: data.run, gems: data.gems, charged: true };
  });
}

function createCupRunFallback(userId, bracket) {
  return sb.from("cup_runs")
    .insert({ user_id: userId, status: "active", round: 0, bracket: bracket, gems_won: 0 })
    .select().maybeSingle()
    .then(({ data, error }) => {
      if (error) { console.error("createCupRun failed:", error.message); return { error: error.message }; }
      window.state.cup = data;
      return { run: data, charged: false };
    });
}

// Winning a tie pays its reward and advances the round in one transaction, so
// the "credit only after the save succeeded" dance the caller used to do --
// and the reload-replays-the-same-tie-for-the-same-gems bug behind it -- has
// nothing left to guard. Resolves { won, champion, reward, round, gems, error }.
function cupAdvanceRemote(won) {
  const cup = window.state.cup;
  if (!cup) return Promise.resolve({ error: "No active cup run." });
  return sb.rpc("cup_advance", { p_won: won }).then(({ data, error }) => {
    if (error && rpcMissing(error)) return cupAdvanceFallback(won, cup);
    if (error) return { error: error.message };
    applyServerEconomy(data);
    return data;
  });
}

function cupAdvanceFallback(won, cup) {
  const round = Math.max(0, Math.min(cup.round | 0, CUP_ROUND_REWARD.length - 1));
  if (!won) {
    return saveCupRun({ status: "eliminated" })
      .then(res => res.error ? { error: res.error } : { won: false, champion: false, reward: 0, round: round });
  }
  const reward = CUP_ROUND_REWARD[round] || 0;
  const champion = round >= CUP_ROUND_REWARD.length - 1;
  const results = ((cup.bracket && cup.bracket.results) || []).concat(["win"]);
  const fields = { round: round + 1, bracket: Object.assign({}, cup.bracket || {}, { results: results }),
                   gems_won: (cup.gems_won || 0) + reward };
  if (champion) fields.status = "won";
  return saveCupRun(fields).then(res => {
    if (res.error) return { error: res.error };
    // Only once the run has actually advanced, for the same reason as before:
    // paying first meant a failed save left the round unchanged and reloading
    // replayed the tie for the reward again.
    window.state.gems += reward;
    return updateProfile({ gems: window.state.gems })
      .then(() => ({ won: true, champion: champion, reward: reward, round: round, gems: window.state.gems }));
  });
}

function cupForfeitRemote() {
  return sb.rpc("cup_forfeit").then(({ error }) => {
    if (error && rpcMissing(error)) return saveCupRun({ status: "eliminated" });
    return { error: error ? error.message : null };
  });
}

// Resolves { error } so callers can tell a failed save from a successful one.
// It used to swallow errors, which meant a failed write left the stored round
// behind while the reward had already been paid -- reloading replayed the same
// round for the same gems.
function saveCupRun(fields) {
  const cup = window.state.cup;
  if (!cup) return Promise.resolve({ error: "No active cup run." });
  const prev = {};
  Object.keys(fields).forEach(k => { prev[k] = cup[k]; cup[k] = fields[k]; });
  const payload = Object.assign({}, fields);
  if (payload.status && payload.status !== "active") payload.finished_at = new Date().toISOString();
  return sb.from("cup_runs").update(payload).eq("id", cup.id)
    .then(({ error }) => {
      if (error) {
        console.error("saveCupRun failed:", error.message);
        Object.keys(prev).forEach(k => { cup[k] = prev[k]; });
        return { error: error.message };
      }
      return { error: null };
    });
}

// Promo codes (Phase F addendum #3). The actual grant happens entirely
// server-side inside the redeem_promo_code() RPC (SECURITY DEFINER, so it
// can validate against the admin-only promo_codes table and credit gems
// atomically) -- this just calls it and reloads the profile so state.gems
// reflects whatever the RPC actually applied, same "write then reload"
// pattern as updateProfile() in auth.js.
function redeemPromoCode(code) {
  const session = window.state.session;
  const userId = session && session.user && session.user.id;
  if (!userId) return Promise.resolve({ gemsGranted: 0, error: "Not signed in." });
  return sb.rpc("redeem_promo_code", { p_code: code }).then(({ data, error }) => {
    if (error) return { gemsGranted: 0, error: error.message };
    return loadProfile(userId).then(() => {
      window.render();
      return { gemsGranted: data, error: null };
    });
  });
}

// ------------------------------------------------- daily and objective claims
// Both are fully checkable server-side, unlike a match result: the daily's only
// input is the date, and objective progress is re-measured from the same rows
// the client derives it from. The button can therefore no longer pay out an
// objective that is not actually complete, or a daily twice on the same day.
//
// `local` carries what the client would have paid on its own (the ladder, the
// streak, today's date) -- used only when 007 is absent.
function claimDailyRemote(local) {
  return sb.rpc("claim_daily").then(({ data, error }) => {
    if (error && rpcMissing(error)) return claimDailyFallback(local);
    if (error) return { error: error.message };
    applyServerEconomy(data);
    window.state.home = Object.assign({}, window.state.home,
      { dailyLastClaim: data.last_claim, dailyStreak: data.streak });
    noteProfileWrite({ daily_last_claim: data.last_claim, daily_streak: data.streak });
    return { reward: data.reward, streak: data.streak };
  });
}

function claimDailyFallback(local) {
  window.state.gems += local.reward;
  window.state.home = Object.assign({}, window.state.home,
    { dailyLastClaim: local.today, dailyStreak: local.streak + 1 });
  return updateProfile({
    gems: window.state.gems,
    daily_last_claim: window.state.home.dailyLastClaim,
    daily_streak: window.state.home.dailyStreak,
  }).then(({ error }) => error ? { error: error } : { reward: local.reward, streak: local.streak + 1 });
}

function claimObjectiveRemote(objectiveId, localReward) {
  return sb.rpc("claim_objective", { p_objective_id: objectiveId }).then(({ data, error }) => {
    if (error && rpcMissing(error)) return claimObjectiveFallback(objectiveId, localReward);
    if (error) return { error: error.message };
    applyServerEconomy(data);
    markObjectiveClaimed(objectiveId);
    return { reward: data.reward };
  });
}

function claimObjectiveFallback(objectiveId, localReward) {
  window.state.gems += localReward;
  markObjectiveClaimed(objectiveId);
  return updateProfile({ gems: window.state.gems, objectives_claimed: window.state.home.objectivesClaimed })
    .then(({ error }) => error ? { error: error } : { reward: localReward });
}

// Objectives are append-only, which is what lets applyProfileRow() union a
// claim that is still in flight instead of re-arming the button.
function markObjectiveClaimed(objectiveId) {
  const have = window.state.home.objectivesClaimed || [];
  const claimed = have.includes(objectiveId) ? have : have.concat([objectiveId]);
  window.state.home = Object.assign({}, window.state.home, { objectivesClaimed: claimed });
  noteProfileWrite({ objectives_claimed: claimed });
}

// matchSeasonNumber/matchMatchday are passed explicitly (captured by the
// caller BEFORE any season-rollover reassignment) since a match must be
// recorded under the season/matchday it was actually played in, not
// whatever state.season has become by the time this runs.
// Re-fetches everything for the current user -- used after a trade
// completes, since the other side's RPC-driven card/gem swap happened
// entirely server-side and neither side's local state knows about it yet.
function refreshGameState() {
  const session = window.state.session;
  const userId = session && session.user && session.user.id;
  if (!userId) return Promise.resolve();
  // loadSquad is chained, not parallel -- it resolves lineup ids against
  // state.players, so running it alongside the catalog load leaves the lineup
  // holding pre-refresh card objects (including ones just traded away).
  return Promise.all([
    loadProfile(userId),
    loadCatalogAndOwnership(userId).then(() => loadSquad(userId)),
  ]).then(() => window.render());
}

// The row is written once with `kind` and, only if the database hasn't had
// migration 006 run yet, once more without it -- losing the match entirely
// would cost the player a result they have already been shown.
function insertMatchRow(row) {
  return sb.from("matches").insert(row).then(({ error }) => {
    if (!columnMissing(error)) {
      if (error) console.error("commitMatchResult insert failed:", error.message);
      return { error: error || null };
    }
    const legacyRow = Object.assign({}, row);
    delete legacyRow.kind;
    return sb.from("matches").insert(legacyRow).then(({ error: retryError }) => {
      if (retryError) console.error("commitMatchResult insert failed:", retryError.message);
      return { error: retryError || null };
    });
  });
}

// The one economy call that cannot verify what it is told: the match is played
// in the browser, and short of simulating it server-side there is no way to
// prove a claimed win happened. settle_match does the two things that ARE
// available -- it decides the reward, the streak, the season bookkeeping and
// the history row itself instead of accepting the client's figures, and it
// refuses to record results faster than a match can be played. Nothing here
// sends a gem amount or a stat any more.
//
// Resolves { gems_earned, season_bonus, season_rollover, gems, wins, ...,
// error }, or { fellBack: true } when 007 is absent -- in which case
// applyLocalRewards() has run and the old client-side arithmetic is what the
// player got. It is passed in rather than run up front precisely so that the
// numbers are only ever computed locally when nothing else will compute them.
function settleMatchRemote(ctx, applyLocalRewards) {
  const session = window.state.session;
  if (!session || !session.user) return Promise.resolve({ error: "Not signed in." });
  const outcome = ctx.outcome;
  return sb.rpc("settle_match", {
    p_result: outcome.result,
    p_kind: ctx.kind,
    p_zones_won: outcome.myWins || 0,
    p_my_power: Math.round(outcome.myTotalPower || 0),
    p_opp_power: Math.round(outcome.oppTotalPower || 0),
    p_opponent_name: ctx.opponentName,
    p_formation: ctx.formation,
  }).then(({ data, error }) => {
    if (error && rpcMissing(error)) {
      const local = applyLocalRewards();
      return commitMatchResult(Object.assign({}, outcome, { gemsEarned: local.gemsEarned }),
                               local.seasonNumber, local.matchday, ctx.opponentName, ctx.kind)
        .then(() => ({ fellBack: true }));
    }
    if (error) { console.error("settle_match failed:", error.message); return { error: error.message }; }
    applyServerEconomy(data);
    return data;
  });
}

function commitMatchResult(outcome, matchSeasonNumber, matchMatchday, opponentName, matchKind) {
  const session = window.state.session;
  const userId = session && session.user && session.user.id;
  if (!userId) return Promise.resolve();
  const s = window.state;
  const matchRow = {
    user_id: userId, season_number: matchSeasonNumber, matchday: matchMatchday,
    opponent_name: opponentName, formation: s.play.formationKey,
    result: outcome.result, zones_won: outcome.myWins,
    my_power: outcome.myTotalPower, opp_power: outcome.oppTotalPower, gems_earned: outcome.gemsEarned,
    kind: matchKind,
  };
  return insertMatchRow(matchRow).then(({ error }) => {
    const fields = {
      gems: s.gems, wins: s.stats.wins, losses: s.stats.losses, draws: s.stats.draws,
      win_streak: s.stats.streak, best_streak: s.stats.bestStreak,
    };
    // Season points and matchday are a running total of the rows in `matches`,
    // and W/L/D is read straight back out of the same rows -- so persisting
    // them for a match the insert never recorded parks the profile permanently
    // ahead of the table it is meant to summarise (12 pts against a 3W-1D
    // record), with nothing left to reconcile the two from. Gems and the
    // lifetime stats are their own counters and the player has already been
    // paid them on screen, so those are still written.
    if (matchKind === MATCH_KIND_LEAGUE && !error) {
      fields.season_number = s.season.number;
      fields.season_matchday = s.season.matchday;
      fields.season_points = s.season.points;
    }
    return updateProfile(fields);
  }).then(() => window.render());
}
