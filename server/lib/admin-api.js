// TCG Manager -- admin card/player management (Phase F). Ported from the
// mobile app's admin.ts. Authorization is entirely enforced by the
// is_admin()-gated RLS policies already in the schema -- these are plain
// CRUD calls with no client-side permission logic, since a non-admin's
// write is simply rejected by Postgres regardless of what the UI does.
"use strict";

function friendlyAdminError(error) {
  if (!error) return null;
  if (error.code === "23503") return "Can't delete this card -- one or more players already own it.";
  if (error.code === "23505") return "A promo code with that name already exists.";
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
// Card artwork (Phase O). One file per card, stored at `<cardId>.<ext>` in
// the public `card-images` Storage bucket -- upsert:true so re-uploading for
// the same card just replaces the object in place, no orphaned old files to
// clean up. A `?v=timestamp` query string is appended to the stored URL
// (not the storage path itself) purely to cache-bust the CDN/browser cache
// on re-upload -- without it, replacing an image keeps showing the old one
// until a hard refresh, since the path/URL would otherwise be byte-identical.
function uploadCardImage(cardId, file) {
  const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
  const path = `${cardId}.${ext}`;
  return sb.storage.from("card-images").upload(path, file, { upsert: true, cacheControl: "3600" })
    .then(({ error: uploadError }) => {
      if (uploadError) return { error: uploadError.message };
      const { data } = sb.storage.from("card-images").getPublicUrl(path);
      const url = data.publicUrl + "?v=" + Date.now();
      return updateCard(cardId, { image_url: url }).then(({ error }) => ({ error, url }));
    });
}
function removeCardImage(cardId) {
  return updateCard(cardId, { image_url: null });
}
// Bulk upload (matches the numbering convention from the exported roster
// spreadsheet: row 1 -> "1.png", row 2 -> "2.png", etc, where "row N" is the
// Nth active card ordered by id -- the exact same deterministic order the
// spreadsheet export used). Uploads sequentially (not in parallel) so the
// status log updates one file at a time and one failed/misnamed file
// doesn't take down a batch of concurrent requests.
function bulkUploadCardImages(fileList, onProgress) {
  const files = Array.from(fileList).sort((a, b) => {
    const na = parseInt(a.name, 10), nb = parseInt(b.name, 10);
    return (isNaN(na) ? 0 : na) - (isNaN(nb) ? 0 : nb);
  });
  return fetchAllCards().then(({ data: allCards, error }) => {
    if (error) return [{ file: "", error }];
    const activeSorted = allCards.filter(c => c.active).sort((a, b) => a.id - b.id);
    const results = [];
    let i = 0;
    function next() {
      if (i >= files.length) return Promise.resolve(results);
      const file = files[i++];
      const m = file.name.match(/^(\d+)\./);
      const finish = (entry) => { results.push(entry); if (onProgress) onProgress(results.slice(), files.length); return next(); };
      if (!m) return finish({ file: file.name, error: `Filename must start with a number, e.g. "1.png" -- skipped.` });
      const rowNum = parseInt(m[1], 10);
      const card = activeSorted[rowNum - 1];
      if (!card) return finish({ file: file.name, error: `No active card at row ${rowNum} -- skipped.` });
      return uploadCardImage(card.id, file).then(({ error }) => finish({ file: file.name, cardId: card.id, cardName: card.name, error }));
    }
    return next();
  });
}
// Promo codes (Phase F addendum #3). Plain CRUD gated by the same
// is_admin()-enforced RLS shape as cards above -- redemption itself goes
// through the redeem_promo_code() RPC in game-data.js, not through here.
function fetchAllPromoCodes() {
  return sb.from("promo_codes").select("*").order("created_at", { ascending: false })
    .then(({ data, error }) => ({ data: data || [], error: friendlyAdminError(error) }));
}
function createPromoCode(input) {
  return sb.from("promo_codes").insert(input).select().single().then(({ data, error }) => ({ data, error: friendlyAdminError(error) }));
}
function updatePromoCode(code, fields) {
  return sb.from("promo_codes").update(fields).eq("code", code).then(({ error }) => ({ error: friendlyAdminError(error) }));
}
function deletePromoCode(code) {
  return sb.from("promo_codes").delete().eq("code", code).then(({ error }) => ({ error: friendlyAdminError(error) }));
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
function submitCardImageUpload(cardId, file) {
  const ui = window.state.adminUI;
  ui.cardImageStatus = "Uploading…";
  window.render();
  uploadCardImage(cardId, file).then(({ error }) => {
    ui.cardImageStatus = error || "";
    if (!error) {
      const card = ui.cards.find(c => c.id === cardId);
      if (card) card.image_url = null; // refreshed below with the real url
    }
    refreshAdminCards().then(refreshGameState);
    window.render();
  });
}
function submitCardImageRemove(cardId) {
  const ui = window.state.adminUI;
  ui.cardImageStatus = "Removing…";
  window.render();
  removeCardImage(cardId).then(({ error }) => {
    ui.cardImageStatus = error || "";
    refreshAdminCards().then(refreshGameState);
    window.render();
  });
}
function openBulkImageUpload() {
  window.state.adminUI.bulkUploadOpen = true;
  window.state.adminUI.bulkUpload = { uploading: false, log: [], total: 0 };
  window.render();
}
function closeBulkImageUpload() {
  window.state.adminUI.bulkUploadOpen = false;
  window.render();
}
function submitBulkImageUpload(fileList) {
  const ui = window.state.adminUI;
  ui.bulkUpload = { uploading: true, log: [], total: fileList.length };
  window.render();
  bulkUploadCardImages(fileList, (log, total) => {
    ui.bulkUpload = { uploading: true, log, total };
    window.render();
  }).then((log) => {
    ui.bulkUpload = { uploading: false, log, total: fileList.length };
    refreshAdminCards().then(refreshGameState);
    window.render();
  });
}
function refreshPromoCodes() {
  return fetchAllPromoCodes().then(({ data }) => {
    window.state.adminUI.promoCodes = data;
    window.state.adminUI.promoCodesLoaded = true;
    window.render();
  });
}
function openPromoCodeForm(code) {
  const ui = window.state.adminUI;
  if (code == null) {
    ui.editingPromoCode = "new";
    ui.promoCodeForm = { code: "", gems: 5000, maxRedemptions: "", expiresAt: "", active: true };
  } else {
    const pc = ui.promoCodes.find(c => c.code === code);
    ui.editingPromoCode = code;
    ui.promoCodeForm = {
      code: pc.code,
      gems: pc.gems,
      maxRedemptions: pc.max_redemptions == null ? "" : String(pc.max_redemptions),
      expiresAt: pc.expires_at ? pc.expires_at.slice(0, 10) : "",
      active: pc.active,
    };
  }
  ui.promoCodeStatus = "";
  window.render();
}
function closePromoCodeForm() {
  window.state.adminUI.editingPromoCode = null;
  window.render();
}
function submitPromoCodeForm() {
  const ui = window.state.adminUI;
  const f = ui.promoCodeForm;
  const isNew = ui.editingPromoCode === "new";
  const code = (f.code || "").trim().toUpperCase();
  const gems = Math.max(1, Number(f.gems) || 0);
  if (isNew && !code) { ui.promoCodeStatus = "Enter a code."; window.render(); return; }
  const maxRedemptions = f.maxRedemptions === "" ? null : Math.max(1, Number(f.maxRedemptions) || 1);
  const expiresAt = f.expiresAt ? new Date(f.expiresAt + "T23:59:59").toISOString() : null;
  const fields = { gems, max_redemptions: maxRedemptions, expires_at: expiresAt, active: !!f.active };
  ui.promoCodeStatus = "Saving…";
  window.render();
  const op = isNew ? createPromoCode({ code, ...fields }) : updatePromoCode(ui.editingPromoCode, fields);
  op.then(({ error }) => {
    if (error) { ui.promoCodeStatus = error; window.render(); return; }
    closePromoCodeForm();
    refreshPromoCodes();
  });
}
function submitDeletePromoCode(code) {
  deletePromoCode(code).then(({ error }) => {
    if (error) { window.state.adminUI.promoCodeStatus = error; window.render(); return; }
    closePromoCodeForm();
    refreshPromoCodes();
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
