// TCG Manager -- auth (Phase A). Ported from the mobile app's AuthContext.tsx,
// adapted to operate on the shared `window.state` object instead of React
// state. This file is a separate top-level <script>, not wrapped in the game
// IIFE in index.html -- it can only see `state`/`render`/`rankForWins` because
// that IIFE explicitly exposes them as `window.state`/`window.render`/
// `window.rankForWins` (everything else it declares stays private to it).
"use strict";

// Both auth emails below default to whatever "Site URL" is configured in
// the Supabase dashboard (Authentication -> URL Configuration) if not told
// otherwise -- passing the page's own current origin explicitly means the
// email always links back to wherever the user actually was (the GitHub
// Pages/iOS install, or localhost during dev), never silently falling back
// to a stale dashboard setting. Supabase still requires that origin to be
// on the project's "Redirect URLs" allow-list, or it ignores this and
// falls back to the Site URL anyway.
function currentOrigin() {
  return window.location.origin + window.location.pathname;
}
function authSignUp(email, password) {
  return sb.auth.signUp({ email, password, options: { emailRedirectTo: currentOrigin() } }).then(({ data, error }) => ({ data, error: error ? error.message : null }));
}
function authSignIn(email, password) {
  return sb.auth.signInWithPassword({ email, password }).then(({ data, error }) => ({ data, error: error ? error.message : null }));
}
function authSignOut() {
  return sb.auth.signOut();
}
// Play Store policy requires a real self-service deletion path, not just a
// "contact support" form -- delete_own_account() (schema.sql, Phase K) wipes
// the caller's own auth.users row and everything cascading from it. The
// session is dead the instant this succeeds (the user row it was issued for
// no longer exists), so a plain signOut() afterward just clears local state
// to match reality rather than actually invalidating anything server-side.
function authDeleteAccount() {
  return sb.rpc("delete_own_account").then(({ error }) => {
    if (error) return { error: error.message };
    return sb.auth.signOut().then(() => ({ error: null }));
  });
}
function authSendPasswordReset(email) {
  return sb.auth.resetPasswordForEmail(email, { redirectTo: currentOrigin() }).then(({ error }) => ({ error: error ? error.message : null }));
}
function authChangePassword(newPassword) {
  return sb.auth.updateUser({ password: newPassword }).then(({ error }) => ({ error: error ? error.message : null }));
}

// Username/full name are collected on the signup form (see authView() in
// index.html) but can't be written straight into `profiles` from there --
// there's no session yet at that point (email confirmation may not happen
// for minutes/days), and profiles has no client-facing INSERT policy
// anyway (only the SECURITY DEFINER trigger can insert the row). Stashed
// here and applied the first time this account actually gets a session --
// "survive the gap until a real session shows up", for data that is the
// player's own identity rather than anything they could pay themselves with.
const PENDING_SIGNUP_PROFILE_KEY = "tcg-pending-signup-profile-v1";
function stashPendingSignupProfile(username, fullName) {
  try { localStorage.setItem(PENDING_SIGNUP_PROFILE_KEY, JSON.stringify({ username, fullName })); } catch (e) {}
}
function applyPendingSignupProfile() {
  if (window.state.profileRow && window.state.profileRow.username) return Promise.resolve();
  let pending = null;
  try { pending = JSON.parse(localStorage.getItem(PENDING_SIGNUP_PROFILE_KEY) || "null"); } catch (e) {}
  if (!pending || !pending.username) return Promise.resolve();
  return updateProfile({ username: pending.username, full_name: pending.fullName || null }).then(({ error }) => {
    // Left in place on failure (e.g. the username got taken by someone else
    // in the meantime) so it's retried on the next sign-in rather than the
    // account being permanently stuck with no username at all.
    if (error) { console.error("applyPendingSignupProfile failed:", error); return; }
    try { localStorage.removeItem(PENDING_SIGNUP_PROFILE_KEY); } catch (e) {}
  });
}

// Maps a `profiles` row (snake_case DB columns, shared with the mobile app)
// onto the exact shape the existing view code already reads on
// window.state.profile/stats/gems/home -- so homeView()/profileView()/etc
// need no changes, only their data source changes. Season win/loss/draw
// counts are deliberately NOT part of this row (only season_number/matchday/
// points are) -- see loadRecentMatchesAndSeason() in game-data.js, which
// derives them from match history instead and is expected to have already
// populated state.season.wins/losses/draws before/after this runs.
// The profile values the server is believed to hold: whatever we last received
// from it, or last sent to it. Everything the player spends is applied to local
// state FIRST and persisted a round trip later, so `local - knownServer` is
// exactly the change that hasn't landed yet. Re-applying a row on top of that
// without accounting for it is what made packs free: claim a reward, open a
// pack while the claim's write is still in flight, and the realtime echo of
// the claim reset gems to the pre-pack balance -- which the pack's own
// updateProfile then wrote back as the truth. Card granted, cost refunded.
// The same reset re-armed a claimed objective's button and paid it twice.
let knownServer = null;

function snapshotServer(row) {
  return {
    gems: row.gems,
    wins: row.wins, losses: row.losses, draws: row.draws,
    win_streak: row.win_streak, best_streak: row.best_streak,
    season_number: row.season_number, season_matchday: row.season_matchday,
    season_points: row.season_points,
    daily_last_claim: row.daily_last_claim, daily_streak: row.daily_streak,
    objectives_claimed: row.objectives_claimed || [],
  };
}

// Server value plus whatever local hasn't persisted yet. Falls back to the
// server value outright on the first load, when there is no baseline.
function merged(serverValue, localValue, baseValue) {
  if (knownServer == null) return serverValue;
  const n = Number(serverValue) + (Number(localValue) - Number(baseValue));
  return Number.isFinite(n) ? n : serverValue;
}

// Called whenever WE write a field, so the baseline moves forward with our own
// writes instead of trailing behind them and double-counting the difference.
function noteProfileWrite(fields) {
  if (!knownServer || !fields) return;
  Object.keys(fields).forEach(k => {
    if (k in knownServer) knownServer[k] = fields[k];
  });
}

function applyProfileRow(row) {
  const s = window.state;
  const k = knownServer;
  s.profile = {
    name: row.display_name || "Player",
    avatar: row.avatar || "⚽",
    teamName: row.team_name || "My Team",
    number: row.jersey_number || 7,
    color: s.profile.color || loadLocalTeamColor(),
    username: row.username || "",
    fullName: row.full_name || "",
  };
  s.gems = merged(row.gems, s.gems, k && k.gems);
  s.stats = {
    wins:       merged(row.wins,        s.stats.wins,       k && k.wins),
    losses:     merged(row.losses,      s.stats.losses,     k && k.losses),
    draws:      merged(row.draws,       s.stats.draws,      k && k.draws),
    streak:     merged(row.win_streak,  s.stats.streak,     k && k.win_streak),
    bestStreak: merged(row.best_streak, s.stats.bestStreak, k && k.best_streak),
  };
  // Objectives are append-only, so the union can never drop a claim that is
  // still in flight -- which is what re-enabled an already-claimed button.
  const localClaimed = (s.home && s.home.objectivesClaimed) || [];
  const claimed = Array.from(new Set([...(row.objectives_claimed || []), ...localClaimed]));
  // Daily claim dates are ISO yyyy-mm-dd, so a plain string compare orders
  // them. Keep whichever side has actually claimed more recently.
  const localDaily = s.home || {};
  const localDailyNewer = !!localDaily.dailyLastClaim &&
    (!row.daily_last_claim || localDaily.dailyLastClaim > row.daily_last_claim);
  s.home = {
    dailyLastClaim: localDailyNewer ? localDaily.dailyLastClaim : row.daily_last_claim,
    dailyStreak:    localDailyNewer ? localDaily.dailyStreak    : row.daily_streak,
    objectivesClaimed: claimed,
  };
  // A season rollover is written the same optimistic way, so a stale row could
  // wind the season back and re-arm the doubled end-of-season payout.
  const localSeason = s.season || {};
  const localSeasonAhead = !!k && (
    localSeason.number > row.season_number ||
    (localSeason.number === row.season_number && localSeason.matchday > row.season_matchday));
  s.season = {
    number:   localSeasonAhead ? localSeason.number   : row.season_number,
    matchday: localSeasonAhead ? localSeason.matchday : row.season_matchday,
    points:   localSeasonAhead ? localSeason.points   : row.season_points,
    wins: s.season.wins || 0, losses: s.season.losses || 0, draws: s.season.draws || 0,
  };
  s.profileRow = row;
  knownServer = snapshotServer(row);
  s.prevRankName = rankForWins(s.stats.wins).name;
}

// Banned users are force-signed-out the moment their profile loads --
// initial load, auth-state-change, and after every updateProfile/refresh --
// so nothing in the app is ever handed a live profile for a banned account.
function loadProfile(userId) {
  return sb.from("profiles").select("*").eq("id", userId).single().then(({ data, error }) => {
    if (error || !data) return { error: error ? error.message : "Profile not found." };
    if (data.banned) {
      window.state.justBanned = true;
      return sb.auth.signOut().then(() => ({ error: null }));
    }
    applyProfileRow(data);
    return { error: null };
  });
}

// Nearly every gems/stats/season/profile-field mutation in this app routes
// through here (same as the mobile app's AuthContext.updateProfile) --
// writes, then reloads so state always mirrors exactly what's in Postgres.
function updateProfile(fields) {
  const session = window.state.session;
  if (!session || !session.user) return Promise.resolve({ error: "Not signed in." });
  return sb.from("profiles").update(fields).eq("id", session.user.id).then(({ error }) => {
    if (error) return { error: error.message };
    // Move the baseline forward BEFORE the reload, or the difference between
    // local and server gets counted a second time when the row comes back.
    noteProfileWrite(fields);
    return loadProfile(session.user.id).then(() => ({ error: null }));
  });
}

let lastHandledUserId = null;

function initAuthListener() {
  sb.auth.getSession().then(({ data }) => {
    window.state.session = data.session;
    if (data.session && data.session.user) handleSignedIn(data.session.user.id);
    else { window.state.authReady = true; window.render(); }
  });
  sb.auth.onAuthStateChange((event, newSession) => {
    window.state.session = newSession;
    // A clicked password-reset email link lands here as its own event, with
    // a real (if narrowly-scoped) session already attached -- show the
    // "set a new password" screen instead of loading the app straight away,
    // or the recovery link would silently just sign the user in.
    if (event === "PASSWORD_RECOVERY") {
      window.state.passwordRecovery = true;
      window.state.authReady = true;
      window.render();
      return;
    }
    if (newSession && newSession.user) {
      if (newSession.user.id !== lastHandledUserId) handleSignedIn(newSession.user.id);
    } else {
      lastHandledUserId = null;
      // Otherwise the next account to sign in on this browser inherits the
      // previous one's baseline and gets their unpersisted delta applied.
      knownServer = null;
      unsubscribeFromChat();
      unsubscribeFromNotifications();
      unsubscribeFromAdminLiveUpdates();
      window.state.authReady = true;
      window.state.tab = "home";
      window.render();
    }
  });
}

// Runs once per sign-in (fresh session found at boot, or a just-completed
// signin/signup): apply any pending signup-time username/full name, load
// profile, catalog+ownership, squad, match history/season record, and the
// friends/requests/challenges/trades lists notifications are derived from,
// seed the notifications "already viewed" baseline (first sign-in on this
// browser only), start the live notifications subscription, then (new
// accounts only) either import this browser's old local save or grant the
// fixed starter set, before the first real render.
function handleSignedIn(userId) {
  lastHandledUserId = userId;
  loadProfile(userId).then(({ error }) => {
    if (error || window.state.justBanned) { window.state.authReady = true; window.render(); return; }
    applyPendingSignupProfile()
      .then(() => Promise.all([
        // loadSquad MUST follow the catalog: it resolves the saved lineup's
        // card ids against state.players, which loadCatalogAndOwnership fills.
        // Run in parallel and the (much smaller) squads query usually wins the
        // race, resolving every slot to null -- i.e. the saved squad is wiped
        // and the player is dumped back to "0/11 positions filled".
        loadCatalogAndOwnership(userId).then(() => loadSquad(userId)),
        loadRecentMatchesAndSeason(userId),
        // Resolves to null (and hides the cup) if migration 002 hasn't been
        // run, so it can't block sign-in on a database without the table.
        loadCupRun(),
        refreshFriendsList(),
        refreshFriendRequests(),
        refreshChallenges(),
        refreshTrades(),
      ]))
      .then(() => { ensureNotifStateSeeded(userId); subscribeToNotifications(userId); subscribeToAdminLiveUpdates(userId); })
      .then(() => initializeNewAccountIfNeeded(userId))
      .then(() => { window.state.authReady = true; window.render(); handleStripeReturn(); });
  });
}
