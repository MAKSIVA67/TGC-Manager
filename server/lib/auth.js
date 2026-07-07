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
// same "survive the gap until a real session shows up" idea as
// LEGACY_SAVE_KEY in game-data.js, just for different data.
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
function applyProfileRow(row) {
  const s = window.state;
  s.profile = {
    name: row.display_name || "Player",
    avatar: row.avatar || "⚽",
    teamName: row.team_name || "My Team",
    number: row.jersey_number || 7,
    color: s.profile.color || loadLocalTeamColor(),
    username: row.username || "",
    fullName: row.full_name || "",
  };
  s.gems = row.gems;
  s.stats = { wins: row.wins, losses: row.losses, draws: row.draws, streak: row.win_streak, bestStreak: row.best_streak };
  s.home = { dailyLastClaim: row.daily_last_claim, dailyStreak: row.daily_streak, objectivesClaimed: row.objectives_claimed || [] };
  s.season = {
    number: row.season_number, matchday: row.season_matchday, points: row.season_points,
    wins: s.season.wins || 0, losses: s.season.losses || 0, draws: s.season.draws || 0,
  };
  s.profileRow = row;
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
      unsubscribeFromChat();
      unsubscribeFromNotifications();
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
        loadCatalogAndOwnership(userId),
        loadSquad(userId),
        loadRecentMatchesAndSeason(userId),
        refreshFriendsList(),
        refreshFriendRequests(),
        refreshChallenges(),
        refreshTrades(),
      ]))
      .then(() => { ensureNotifStateSeeded(userId); subscribeToNotifications(userId); })
      .then(() => initializeNewAccountIfNeeded(userId))
      .then(() => { window.state.authReady = true; window.render(); handleStripeReturn(); });
  });
}
