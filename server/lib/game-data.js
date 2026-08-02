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

// A duplicate pull. The client never stores a second user_cards row -- every
// "do I own this?" check in the app is a set membership test and would break.
// The duplicate becomes shards on the row that already exists.
function grantShards(cardId, n) {
  const session = window.state.session;
  const userId = session && session.user && session.user.id;
  if (!userId) return Promise.resolve();
  const card = window.state.players.find(p => p.id === cardId);
  const next = ((card && card.shards) || 0) + n;
  if (card) card.shards = next;
  return sb.from("user_cards").update({ shards: next })
    .eq("user_id", userId).eq("card_id", cardId)
    .then(({ error }) => { if (error) console.error("grantShards failed:", error.message); });
}

function trainCard(cardId) {
  const session = window.state.session;
  const userId = session && session.user && session.user.id;
  if (!userId) return Promise.resolve({ error: "Not signed in." });
  const card = window.state.players.find(p => p.id === cardId);
  if (!card || !card.owned) return Promise.resolve({ error: "You don't own that card." });
  if (card.level >= MAX_CARD_LEVEL) return Promise.resolve({ error: "Already at maximum level." });
  const needShards = shardsForLevel(card.level);
  const needGems = gemsForLevel(card.level);
  if (card.shards < needShards) return Promise.resolve({ error: "Not enough shards." });
  if (window.state.gems < needGems) return Promise.resolve({ error: "Not enough gems." });

  const newLevel = card.level + 1;
  const newShards = card.shards - needShards;
  // Applied locally first so the card jumps immediately; the writes below are
  // the same optimistic pattern the rest of the app uses.
  card.level = newLevel;
  card.shards = newShards;
  card.power = card.basePower + newLevel;
  window.state.gems -= needGems;

  return sb.from("user_cards").update({ level: newLevel, shards: newShards })
    .eq("user_id", userId).eq("card_id", cardId)
    .then(({ error }) => {
      if (error) console.error("trainCard failed:", error.message);
      return updateProfile({ gems: window.state.gems });
    })
    .then(() => ({ error: null, level: newLevel }));
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
  return Promise.all([loadProfile(userId), loadCatalogAndOwnership(userId), loadSquad(userId)]).then(() => window.render());
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
