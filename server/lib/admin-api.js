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
function fetchProfileById(id) {
  return sb.from("profiles").select("id, display_name, team_name, gems, is_admin, banned").eq("id", id).single()
    .then(({ data, error }) => ({ data, error: error ? error.message : null }));
}
function searchProfiles(term) {
  const pattern = `%${(term || "").trim()}%`;
  return sb.from("profiles").select("id, display_name, team_name, gems, is_admin, banned")
    .or(`display_name.ilike.${pattern},team_name.ilike.${pattern}`)
    .order("display_name").limit(25)
    .then(({ data, error }) => ({ data: data || [], error: error ? error.message : null }));
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
function openPlayerDetail(playerId) {
  window.state.adminUI.viewingPlayerId = playerId;
  window.state.adminUI.viewingPlayer = null;
  window.state.adminUI.playerStatus = "Loading…";
  window.render();
  fetchProfileById(playerId).then(({ data, error }) => {
    window.state.adminUI.viewingPlayer = data;
    window.state.adminUI.gemsInput = data ? String(data.gems) : "";
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
