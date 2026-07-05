// TCG Manager -- admin card/player management (Phase F). Ported from the
// mobile app's admin.ts. Authorization is entirely enforced by the
// is_admin()-gated RLS policies already in the schema -- these are plain
// CRUD calls with no client-side permission logic, since a non-admin's
// write is simply rejected by Postgres regardless of what the UI does.
"use strict";

function friendlyAdminError(error) {
  if (!error) return null;
  if (error.code === "23503") return "Can't delete this card -- one or more players already own it.";
  return error.message;
}

function fetchAllCards() {
  return sb.from("cards").select("*").order("id").then(({ data, error }) => ({ data: data || [], error: friendlyAdminError(error) }));
}
function createCard(input) {
  return sb.from("cards").insert(input).select().single().then(({ data, error }) => ({ data, error: friendlyAdminError(error) }));
}
function updateCard(id, fields) {
  return sb.from("cards").update(fields).eq("id", id).then(({ error }) => ({ error: friendlyAdminError(error) }));
}
function deleteCard(id) {
  return sb.from("cards").delete().eq("id", id).then(({ error }) => ({ error: friendlyAdminError(error) }));
}
// profiles has no email column (it only ever lived in the protected
// auth.users table) -- admin_profiles() is a SECURITY DEFINER RPC that
// joins across into it, gated on is_admin() server-side. One function
// covers all three shapes below (single/search/paginated); see schema.sql.
function fetchProfileById(id) {
  return sb.rpc("admin_profiles", { target_id: id })
    .then(({ data, error }) => ({ data: (data && data[0]) || null, error: error ? error.message : null }));
}
function searchProfiles(term) {
  return sb.rpc("admin_profiles", { search_term: term })
    .then(({ data, error }) => ({ data: data || [], error: error ? error.message : null }));
}
const PLAYERS_PAGE_SIZE = 20;
function fetchAllProfilesPage(page) {
  const pageOffset = page * PLAYERS_PAGE_SIZE;
  return Promise.all([
    sb.rpc("admin_profiles", { page_offset: pageOffset, page_limit: PLAYERS_PAGE_SIZE }),
    sb.rpc("admin_profiles_count"),
  ]).then(([listRes, countRes]) => ({
    data: listRes.data || [],
    count: countRes.data || 0,
    error: (listRes.error && listRes.error.message) || (countRes.error && countRes.error.message) || null,
  }));
}
function updateProfileInfo(targetId, fields) {
  return sb.from("profiles").update(fields).eq("id", targetId).then(({ error }) => ({ error: error ? error.message : null }));
}
// Resets one player back to a fresh-signup-like state (cards, squad, match
// history, gems, streaks, season). Starter ids computed here (same logic as
// signup's initializeNewAccountIfNeeded) and passed to the SECURITY DEFINER
// RPC, which is the only thing actually allowed to touch another user's
// user_cards/squads/matches rows (their RLS only permits the owner).
function resetPlayerProgress(targetId) {
  const starterIds = pickStarterCardIds(window.state.players);
  return sb.rpc("admin_reset_player_progress", { target_id: targetId, starter_card_ids: starterIds })
    .then(({ error }) => ({ error: error ? error.message : null }));
}
function setGems(targetId, newGems) {
  return sb.from("profiles").update({ gems: newGems }).eq("id", targetId).then(({ error }) => ({ error: error ? error.message : null }));
}
// Self-ban/self-demote guards below are UX niceties only, not real security
// -- matches the mobile app's own documented caveat (a technically savvy
// user could still hit the REST API directly; RLS is the real boundary).
function setBanned(targetId, banned, callerId) {
  if (banned && targetId === callerId) return Promise.resolve({ error: "You can't ban yourself." });
  return sb.from("profiles").update({ banned }).eq("id", targetId).then(({ error }) => ({ error: error ? error.message : null }));
}
function setAdmin(targetId, isAdminFlag, callerId) {
  if (!isAdminFlag && targetId === callerId) return Promise.resolve({ error: "You can't remove your own admin status." });
  return sb.from("profiles").update({ is_admin: isAdminFlag }).eq("id", targetId).then(({ error }) => ({ error: error ? error.message : null }));
}

// ---- UI-facing wrappers ----

function refreshAdminCards() {
  return fetchAllCards().then(({ data }) => {
    window.state.adminUI.cards = data;
    window.state.adminUI.cardsLoaded = true;
    window.render();
  });
}
function openCardForm(cardId) {
  const ui = window.state.adminUI;
  if (cardId == null) {
    ui.editingCard = "new";
    ui.cardForm = { name: "", position: "GK", power: 50, rarity: "Common" };
  } else {
    const card = ui.cards.find(c => c.id === cardId);
    ui.editingCard = cardId;
    ui.cardForm = { name: card.name, position: card.position, power: card.power, rarity: card.rarity };
  }
  ui.cardStatus = "";
  window.render();
}
function closeCardForm() {
  window.state.adminUI.editingCard = null;
  window.render();
}
function submitCardForm() {
  const ui = window.state.adminUI;
  const f = ui.cardForm;
  const name = (f.name || "").trim();
  const power = Math.max(1, Math.min(100, Number(f.power) || 1));
  if (!name) { ui.cardStatus = "Enter a player name."; window.render(); return; }
  const payload = { name, position: f.position, power, rarity: f.rarity };
  ui.cardStatus = "Saving…";
  window.render();
  const op = ui.editingCard === "new" ? createCard(payload) : updateCard(ui.editingCard, payload);
  op.then(({ error }) => {
    if (error) { ui.cardStatus = error; window.render(); return; }
    closeCardForm();
    refreshAdminCards();
    refreshGameState();
  });
}
function submitDeleteCard(cardId) {
  deleteCard(cardId).then(({ error }) => {
    if (error) { window.state.adminUI.cardStatus = error; window.render(); return; }
    closeCardForm();
    refreshAdminCards();
    refreshGameState();
  });
}
function submitPlayerSearch(term) {
  window.state.adminUI.playerSearchStatus = "Searching…";
  window.render();
  searchProfiles(term).then(({ data, error }) => {
    window.state.adminUI.playerSearchResults = data;
    window.state.adminUI.playerSearchStatus = error || (data.length ? "" : "No players found.");
    window.render();
  });
}
// Paginated "browse every user" list, shown when the search box is empty.
function refreshAllPlayers(page) {
  const ui = window.state.adminUI;
  ui.allPlayersStatus = "Loading…";
  window.render();
  fetchAllProfilesPage(page).then(({ data, count, error }) => {
    ui.allPlayers = data;
    ui.allPlayersPage = page;
    ui.allPlayersTotal = count;
    ui.allPlayersLoaded = true;
    ui.allPlayersStatus = error || "";
    window.render();
  });
}
function openPlayerDetail(playerId) {
  window.state.adminUI.viewingPlayerId = playerId;
  window.state.adminUI.viewingPlayer = null;
  window.state.adminUI.playerStatus = "Loading…";
  window.state.adminUI.resetConfirming = false;
  window.state.adminUI.resetStatus = "";
  window.render();
  fetchProfileById(playerId).then(({ data, error }) => {
    window.state.adminUI.viewingPlayer = data;
    window.state.adminUI.gemsInput = data ? String(data.gems) : "";
    window.state.adminUI.editDisplayName = data ? (data.display_name || "") : "";
    window.state.adminUI.editTeamName = data ? (data.team_name || "") : "";
    window.state.adminUI.profileInfoStatus = "";
    window.state.adminUI.playerStatus = error || "";
    window.render();
  });
}
function closePlayerDetail() {
  window.state.adminUI.viewingPlayerId = null;
  window.state.adminUI.viewingPlayer = null;
  window.render();
}
function submitSetGems() {
  const ui = window.state.adminUI;
  const newGems = Math.max(0, Number(ui.gemsInput) || 0);
  setGems(ui.viewingPlayerId, newGems).then(({ error }) => {
    ui.playerStatus = error || "Gems updated.";
    if (!error) openPlayerDetail(ui.viewingPlayerId); else window.render();
  });
}
function submitProfileInfo() {
  const ui = window.state.adminUI;
  const displayName = (ui.editDisplayName || "").trim();
  const teamName = (ui.editTeamName || "").trim();
  if (!displayName) { ui.profileInfoStatus = "Enter a display name."; window.render(); return; }
  ui.profileInfoStatus = "Saving…";
  window.render();
  updateProfileInfo(ui.viewingPlayerId, { display_name: displayName, team_name: teamName }).then(({ error }) => {
    ui.profileInfoStatus = error || "Saved.";
    if (!error) ui.viewingPlayer = { ...ui.viewingPlayer, display_name: displayName, team_name: teamName };
    window.render();
  });
}
function submitToggleBan(banned) {
  const ui = window.state.adminUI;
  const callerId = window.state.session.user.id;
  setBanned(ui.viewingPlayerId, banned, callerId).then(({ error }) => {
    ui.playerStatus = error || "";
    if (!error) openPlayerDetail(ui.viewingPlayerId); else window.render();
  });
}
function submitToggleAdmin(isAdminFlag) {
  const ui = window.state.adminUI;
  const callerId = window.state.session.user.id;
  setAdmin(ui.viewingPlayerId, isAdminFlag, callerId).then(({ error }) => {
    ui.playerStatus = error || "";
    if (!error) openPlayerDetail(ui.viewingPlayerId); else window.render();
  });
}
function armResetProgress() {
  window.state.adminUI.resetConfirming = true;
  window.render();
}
function cancelResetProgress() {
  window.state.adminUI.resetConfirming = false;
  window.render();
}
function submitResetProgress() {
  const ui = window.state.adminUI;
  const targetId = ui.viewingPlayerId;
  ui.resetStatus = "Resetting…";
  window.render();
  resetPlayerProgress(targetId).then(({ error }) => {
    ui.resetConfirming = false;
    if (error) { ui.resetStatus = error; window.render(); return; }
    fetchProfileById(targetId).then(({ data }) => {
      ui.viewingPlayer = data;
      ui.gemsInput = data ? String(data.gems) : "";
      ui.resetStatus = "Progress reset.";
      window.render();
    });
  });
}
