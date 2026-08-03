// TCG Manager -- cards/squad/matches/economy (Phase A). Ported from the
// mobile app's GameContext.tsx. Same cross-scope note as auth.js: this only
// ever reaches into the game IIFE via `window.state`/`window.render`, never
// a bare `state`/`render`.
"use strict";

const LEGACY_SAVE_KEY = "legendxi-preview-save-v1";
const LEGACY_SAVE_IMPORTED_KEY = "legendxi-save-imported-v1";
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
  ]).then(([cardsRes, ownedRes]) => {
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

// ---------------------------------------------------------------- training
// Levels are +1 power each, capped at 10. Cost curve is deliberately steep at
// the top so a maxed card is a real achievement rather than a formality.
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
    window.state.gems = data.gems;
    noteProfileWrite({ gems: data.gems });
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

// Season W/L/D isn't a column on `profiles` (only season_number/matchday/
// points are) -- derived here by filtering match history to the current
// season_number, so it's always self-consistent with `matches` instead of
// a second counter that could drift. A season is only 6 matchdays, so the
// last-20 fetch always covers a full season.
function loadRecentMatchesAndSeason(userId) {
  return sb.from("matches").select("*").eq("user_id", userId).order("played_at", { ascending: false }).limit(20)
    .then(({ data }) => {
      const matches = data || [];
      window.state.recentMatches = matches;
      const seasonNumber = window.state.season.number;
      const seasonMatches = matches.filter(m => m.season_number === seasonNumber);
      window.state.season.wins = seasonMatches.filter(m => m.result === "win").length;
      window.state.season.losses = seasonMatches.filter(m => m.result === "loss").length;
      window.state.season.draws = seasonMatches.filter(m => m.result === "draw").length;
    });
}

// New-account bootstrap. A local save on THIS browser wins over granting
// the fixed starter set (it already contains the starters plus anything
// unlocked since) -- and either path runs at most once per (browser,
// account), guarded by a separate localStorage marker key so a second
// account signing in later on the same browser never re-imports someone
// else's old save.
function initializeNewAccountIfNeeded(userId) {
  if (window.state.players.some(p => p.owned)) return Promise.resolve(); // already has cards, nothing to do

  let legacySave = null;
  try {
    const alreadyImported = localStorage.getItem(LEGACY_SAVE_IMPORTED_KEY);
    const raw = alreadyImported ? null : localStorage.getItem(LEGACY_SAVE_KEY);
    legacySave = raw ? JSON.parse(raw) : null;
  } catch (e) { legacySave = null; }

  if (legacySave && Array.isArray(legacySave.players)) {
    const validIds = new Set(window.state.players.map(c => c.id));
    const ownedIds = legacySave.players.filter(p => p.owned).map(p => p.id).filter(id => validIds.has(id));
    const rows = ownedIds.map(cardId => ({ user_id: userId, card_id: cardId }));
    const profileFields = {};
    if (typeof legacySave.gems === "number") profileFields.gems = legacySave.gems;
    if (legacySave.stats) {
      profileFields.wins = legacySave.stats.wins || 0;
      profileFields.losses = legacySave.stats.losses || 0;
      profileFields.draws = legacySave.stats.draws || 0;
      profileFields.win_streak = legacySave.stats.streak || 0;
      profileFields.best_streak = legacySave.stats.bestStreak || 0;
    }
    if (legacySave.season) {
      profileFields.season_number = legacySave.season.number || 1;
      profileFields.season_matchday = legacySave.season.matchday || 1;
      profileFields.season_points = legacySave.season.points || 0;
    }
    if (legacySave.home) {
      profileFields.daily_last_claim = legacySave.home.dailyLastClaim || null;
      profileFields.daily_streak = legacySave.home.dailyStreak || 0;
      profileFields.objectives_claimed = legacySave.home.objectivesClaimed || [];
    }
    return (rows.length ? sb.from("user_cards").insert(rows) : Promise.resolve())
      .then(() => Object.keys(profileFields).length ? updateProfile(profileFields) : Promise.resolve())
      .then(() => {
        try { localStorage.setItem(LEGACY_SAVE_IMPORTED_KEY, "1"); } catch (e) {}
        return loadCatalogAndOwnership(userId);
      });
  }

  const starterIds = pickStarterCardIds(window.state.players);
  const rows = starterIds.map(cardId => ({ user_id: userId, card_id: cardId }));
  if (!rows.length) return Promise.resolve();
  return sb.from("user_cards").insert(rows).then(({ error }) => {
    if (error) console.error("starter card grant failed:", error.message);
    return loadCatalogAndOwnership(userId);
  });
}

// Pack pick + gem cost are both already decided synchronously at click time
// (before the ~2.9s spin animation even starts) -- fired here immediately
// so the write happens in the background while the animation plays, adding
// no perceived latency. `landPack()` still flips the local owned flag once
// the animation completes, unchanged.
function commitPackOpen(cardId) {
  const session = window.state.session;
  const userId = session && session.user && session.user.id;
  if (!userId) return Promise.resolve();
  return sb.from("user_cards").insert({ user_id: userId, card_id: cardId }).then(({ error }) => {
    if (error) { console.error("commitPackOpen insert failed:", error.message); return; }
    return updateProfile({ gems: window.state.gems });
  });
}
function commitPackRefund() {
  return updateProfile({ gems: window.state.gems }).then(() => window.render());
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

function createCupRun(bracket) {
  const session = window.state.session;
  const userId = session && session.user && session.user.id;
  if (!userId) return Promise.resolve(null);
  return sb.from("cup_runs")
    .insert({ user_id: userId, status: "active", round: 0, bracket: bracket, gems_won: 0 })
    .select().maybeSingle()
    .then(({ data, error }) => {
      if (error) { console.error("createCupRun failed:", error.message); return null; }
      window.state.cup = data;
      return data;
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

function commitMatchResult(outcome, matchSeasonNumber, matchMatchday, opponentName, isChallengeMatch) {
  const session = window.state.session;
  const userId = session && session.user && session.user.id;
  if (!userId) return Promise.resolve();
  const s = window.state;
  const matchRow = {
    user_id: userId, season_number: matchSeasonNumber, matchday: matchMatchday,
    opponent_name: opponentName, formation: s.play.formationKey,
    result: outcome.result, zones_won: outcome.myWins,
    my_power: outcome.myTotalPower, opp_power: outcome.oppTotalPower, gems_earned: outcome.gemsEarned,
  };
  return sb.from("matches").insert(matchRow).then(({ error }) => {
    if (error) console.error("commitMatchResult insert failed:", error.message);
    const fields = {
      gems: s.gems, wins: s.stats.wins, losses: s.stats.losses, draws: s.stats.draws,
      win_streak: s.stats.streak, best_streak: s.stats.bestStreak,
    };
    if (!isChallengeMatch) {
      fields.season_number = s.season.number;
      fields.season_matchday = s.season.matchday;
      fields.season_points = s.season.points;
    }
    return updateProfile(fields);
  }).then(() => window.render());
}
