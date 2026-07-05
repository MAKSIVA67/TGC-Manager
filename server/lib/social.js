// TCG Manager -- friends/chat/challenges/trading (Phases B-E). Ported from
// the mobile app's social.ts. Same cross-scope note as auth.js/game-data.js:
// only ever reaches into the game IIFE via `window.state`/`window.render`.
"use strict";

// Builds an "either side of this unordered pair" OR-filter, e.g. for
// friend_requests/messages where either party could be in either column.
function pairFilter(col1, col2, a, b) {
  return `and(${col1}.eq.${a},${col2}.eq.${b}),and(${col1}.eq.${b},${col2}.eq.${a})`;
}

function searchPlayers(term, excludeId) {
  const trimmed = (term || "").trim();
  if (!trimmed) return Promise.resolve({ data: [], error: null });
  const pattern = `%${trimmed}%`;
  return sb.from("profiles").select("id, display_name, team_name, avatar, username")
    .or(`display_name.ilike.${pattern},team_name.ilike.${pattern},username.ilike.${pattern}`)
    .neq("id", excludeId).order("display_name").limit(25)
    .then(({ data, error }) => ({ data: data || [], error: error ? error.message : null }));
}

// Checks for an existing row between the pair first: none -> insert; the
// OTHER side already requested me -> auto-accept by updating instead of
// inserting a duplicate (this is what makes mutual requests instant without
// a DB trigger). Unique-violation (23505) and already-accepted/declined
// states get friendly messages instead of raw Postgres errors.
function sendFriendRequest(callerId, targetId) {
  return sb.from("friend_requests").select("*").or(pairFilter("requester_id", "addressee_id", callerId, targetId)).maybeSingle()
    .then(({ data: existing }) => {
      if (!existing) {
        return sb.from("friend_requests").insert({ requester_id: callerId, addressee_id: targetId }).then(({ error }) => {
          if (error && error.code === "23505") return { error: "A friend request already exists between you two." };
          return { error: error ? error.message : null };
        });
      }
      if (existing.status === "accepted") return { error: "You're already friends." };
      if (existing.status === "declined") return { error: "This request was declined and can't be resent." };
      if (existing.requester_id === callerId) return { error: "You've already sent a request to this player." };
      return sb.from("friend_requests")
        .update({ status: "accepted", responded_at: new Date().toISOString() }).eq("id", existing.id)
        .then(({ error }) => ({ error: error ? error.message : null }));
    });
}

function respondToFriendRequest(requestId, accept) {
  return sb.from("friend_requests")
    .update({ status: accept ? "accepted" : "declined", responded_at: new Date().toISOString() }).eq("id", requestId)
    .then(({ error }) => ({ error: error ? error.message : null }));
}

function listFriends(callerId) {
  return sb.from("friend_requests").select("requester_id, addressee_id").eq("status", "accepted")
    .or(`requester_id.eq.${callerId},addressee_id.eq.${callerId}`)
    .then(({ data, error }) => {
      if (error) return { data: [], error: error.message };
      const otherIds = (data || []).map(r => r.requester_id === callerId ? r.addressee_id : r.requester_id);
      if (!otherIds.length) return { data: [], error: null };
      return sb.from("profiles").select("id, display_name, team_name, avatar").in("id", otherIds)
        .then(({ data: profiles, error: profileError }) => ({ data: profiles || [], error: profileError ? profileError.message : null }));
    });
}

// Each returned request row is enriched with `otherProfile` (a single batch
// lookup of whichever side isn't the caller) so the UI can render names
// directly without a per-row fetch.
function listFriendRequests(callerId) {
  return sb.from("friend_requests").select("*").eq("status", "pending")
    .or(`requester_id.eq.${callerId},addressee_id.eq.${callerId}`)
    .order("created_at", { ascending: false })
    .then(({ data, error }) => {
      if (error) return { data: { incoming: [], outgoing: [] }, error: error.message };
      const rows = data || [];
      const otherIds = rows.map(r => r.requester_id === callerId ? r.addressee_id : r.requester_id);
      const uniqueIds = Array.from(new Set(otherIds));
      const profilesPromise = uniqueIds.length
        ? sb.from("profiles").select("id, display_name, team_name, avatar").in("id", uniqueIds).then(({ data: p }) => p || [])
        : Promise.resolve([]);
      return profilesPromise.then(profiles => {
        const byId = {};
        profiles.forEach(p => { byId[p.id] = p; });
        const withNames = rows.map(r => {
          const otherId = r.requester_id === callerId ? r.addressee_id : r.requester_id;
          return { ...r, otherProfile: byId[otherId] || { id: otherId, display_name: "Player", team_name: "" } };
        });
        return {
          data: {
            incoming: withNames.filter(r => r.addressee_id === callerId),
            outgoing: withNames.filter(r => r.requester_id === callerId),
          },
          error: null,
        };
      });
    });
}

// ---- UI-facing wrappers, called directly from index.html's click handler ----

function refreshFriendsList() {
  const uid = window.state.session.user.id;
  return listFriends(uid).then(({ data }) => {
    window.state.friendsUI.friends = data || [];
    window.state.friendsUI.friendsLoaded = true;
    window.render();
  });
}
function refreshFriendRequests() {
  const uid = window.state.session.user.id;
  return listFriendRequests(uid).then(({ data }) => {
    window.state.friendsUI.requests = data || { incoming: [], outgoing: [] };
    window.state.friendsUI.requestsLoaded = true;
    window.render();
  });
}
function submitFriendSearch(term) {
  const uid = window.state.session.user.id;
  window.state.friendsUI.searchStatus = "Searching…";
  window.render();
  return searchPlayers(term, uid).then(({ data, error }) => {
    window.state.friendsUI.searchResults = data || [];
    window.state.friendsUI.searchStatus = error ? error : ((data || []).length ? "" : "No players found.");
    window.render();
  });
}
function submitFriendRequest(targetId) {
  const uid = window.state.session.user.id;
  return sendFriendRequest(uid, targetId).then(({ error }) => {
    if (error) { window.state.friendsUI.searchStatus = error; window.render(); return; }
    window.state.friendsUI.searchStatus = "Request sent.";
    window.render();
    return refreshFriendRequests();
  });
}
function submitFriendRequestResponse(requestId, accept) {
  return respondToFriendRequest(requestId, accept).then(({ error }) => {
    if (error) console.error("respondToFriendRequest failed:", error);
    return Promise.all([refreshFriendRequests(), refreshFriendsList()]);
  });
}

// ---- Chat (Phase C) ----

function listMessages(userId, friendId) {
  return sb.from("messages").select("*").or(pairFilter("sender_id", "recipient_id", userId, friendId))
    .order("created_at", { ascending: true }).limit(200)
    .then(({ data, error }) => ({ data: data || [], error: error ? error.message : null }));
}
function sendMessage(userId, friendId, body) {
  const trimmed = (body || "").trim().slice(0, 500);
  if (!trimmed) return Promise.resolve({ data: null, error: "Message can't be empty." });
  return sb.from("messages").insert({ sender_id: userId, recipient_id: friendId, body: trimmed }).select().single()
    .then(({ data, error }) => ({ data, error: error ? error.message : null }));
}

let chatChannel = null;

function openChat(friendId, friendName) {
  const myId = window.state.session.user.id;
  window.state.friendsUI.chat = { friendId, friendName, messages: [], draft: "", loading: true };
  // Opening the conversation is the read receipt -- drop this friend from
  // the unread set immediately, before messages even finish loading.
  window.state.friendsUI.chatUnreadFriendIds = window.state.friendsUI.chatUnreadFriendIds.filter(id => id !== friendId);
  window.render();
  listMessages(myId, friendId).then(({ data }) => {
    window.state.friendsUI.chat.messages = data;
    window.state.friendsUI.chat.loading = false;
    window.render();
    scrollChatToBottom();
  });
  subscribeToChat(myId, friendId);
}
function closeChat() {
  unsubscribeFromChat();
  window.state.friendsUI.chat = { friendId: null, friendName: "", messages: [], draft: "", loading: false };
  window.render();
}
function sendChatMessage() {
  const chat = window.state.friendsUI.chat;
  const myId = window.state.session.user.id;
  const body = chat.draft;
  if (!body || !body.trim()) return;
  chat.draft = "";
  window.render();
  sendMessage(myId, chat.friendId, body).then(({ data, error }) => {
    if (error) { console.error("sendMessage failed:", error); return; }
    // Appended here rather than relying on the realtime echo -- the
    // recipient_id-scoped subscription below never fires for our own sends.
    chat.messages = [...chat.messages, data];
    window.render();
    scrollChatToBottom();
  });
}
// Realtime filter is server-side scoped to recipient_id only (Realtime
// filters can't express an OR across two columns) -- the sender check
// below is what actually scopes it to the currently-open conversation.
function subscribeToChat(myId, friendId) {
  unsubscribeFromChat();
  chatChannel = sb.channel("messages-" + myId)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `recipient_id=eq.${myId}` }, (payload) => {
      const chat = window.state.friendsUI.chat;
      if (!chat.friendId || payload.new.sender_id !== chat.friendId) return;
      chat.messages = [...chat.messages, payload.new];
      window.render();
      scrollChatToBottom();
    })
    .subscribe();
}
function unsubscribeFromChat() {
  if (chatChannel) { sb.removeChannel(chatChannel); chatChannel = null; }
}
function scrollChatToBottom() {
  setTimeout(() => { const el = document.getElementById("chatScroll"); if (el) el.scrollTop = el.scrollHeight; }, 50);
}

// ---- Challenges (Phase D) ----

function sendChallenge(callerId, opponentId, formation, lineupIds) {
  return sb.from("challenges").insert({
    challenger_id: callerId, opponent_id: opponentId,
    challenger_formation: formation, challenger_lineup: lineupIds,
  }).then(({ error }) => {
    if (error && error.code === "23505") return { error: "There's already a pending challenge between you two." };
    return { error: error ? error.message : null };
  });
}
function listChallenges(callerId) {
  return sb.from("challenges").select("*")
    .or(`challenger_id.eq.${callerId},opponent_id.eq.${callerId}`)
    .order("created_at", { ascending: false })
    .then(({ data, error }) => ({ data: data || [], error: error ? error.message : null }));
}
function fetchChallenge(id) {
  return sb.from("challenges").select("*").eq("id", id).single()
    .then(({ data, error }) => ({ data, error: error ? error.message : null }));
}
function declineChallengeRow(challengeId) {
  return sb.from("challenges").update({ status: "declined", resolved_at: new Date().toISOString() }).eq("id", challengeId)
    .then(({ error }) => ({ error: error ? error.message : null }));
}

// Resolves an accepted challenge: fetch the row, resolve both lineups,
// compute all 4 zones via the existing local match-sim (window.computeZone,
// exposed by index.html's IIFE), aggregate via decideMatchFromZones
// (game-data.js), and write the authoritative result back -- ALWAYS from
// the CHALLENGER's perspective, per the schema's own convention.
function resolveChallengeAccept(challengeId, myFormation, myLineupIds) {
  return fetchChallenge(challengeId).then(({ data: challenge, error }) => {
    if (error || !challenge) return { error: error || "Challenge not found." };
    if (challenge.status !== "pending") return { error: "This challenge is no longer pending." };
    const byId = playersById();
    const challengerLU = resolveLineupIds(challenge.challenger_lineup, byId);
    const opponentLU = resolveLineupIds(myLineupIds, byId);
    const zGK = window.computeZone("GK", challengerLU, opponentLU);
    const zDEF = window.computeZone("DEF", challengerLU, opponentLU);
    const zMID = window.computeZone("MID", challengerLU, opponentLU);
    const zFWD = window.computeZone("FWD", challengerLU, opponentLU);
    const outcome = decideMatchFromZones(zGK, zDEF, zMID, zFWD);
    const result = outcome.result === "win" ? "challenger" : outcome.result === "loss" ? "opponent" : "draw";
    const zoneResults = { GK: zGK.result, DEF: zDEF.result, MID: zMID.result, FWD: zFWD.result };
    return sb.from("challenges").update({
      opponent_formation: myFormation, opponent_lineup: myLineupIds,
      zone_results: zoneResults, result, status: "completed", resolved_at: new Date().toISOString(),
    }).eq("id", challengeId).then(({ error: updateError }) => ({
      error: updateError ? updateError.message : null,
      data: { challenge, challengerLU },
    }));
  });
}

function flipZoneResult(r) { return r === "win" ? "lose" : r === "lose" ? "win" : "tie"; }
// zone_results is always stored from the CHALLENGER's perspective -- flip
// each zone (and the overall result) for the opponent's own view, so both
// sides always see their own win/loss, never a copy of the other's.
function viewerChallengeOutcome(challenge, viewerId) {
  const zr = challenge.zone_results || {};
  const isChallenger = challenge.challenger_id === viewerId;
  const zones = {};
  ["GK", "DEF", "MID", "FWD"].forEach(k => { zones[k] = isChallenger ? zr[k] : flipZoneResult(zr[k]); });
  const result = isChallenger
    ? (challenge.result === "challenger" ? "win" : challenge.result === "opponent" ? "loss" : "draw")
    : (challenge.result === "opponent" ? "win" : challenge.result === "challenger" ? "loss" : "draw");
  return { zones, result };
}

// ---- UI-facing wrappers ----

function refreshChallenges() {
  const uid = window.state.session.user.id;
  return listChallenges(uid).then(({ data }) => {
    window.state.friendsUI.challenges = data || [];
    window.state.friendsUI.challengesLoaded = true;
    window.render();
  });
}
function submitChallengeFriend(opponentId) {
  const uid = window.state.session.user.id;
  const pl = window.state.play;
  const mySlots = window.buildSlots(pl.formationKey, "my");
  const filled = Object.values(pl.myLineup).filter(Boolean).length;
  if (filled !== mySlots.length) {
    window.state.friendsUI.challengeStatus = "Build a complete squad in the Play tab first.";
    window.render();
    return;
  }
  const lineupIds = lineupToIds(pl.myLineup);
  window.state.friendsUI.challengeStatus = "Sending challenge…";
  window.render();
  sendChallenge(uid, opponentId, pl.formationKey, lineupIds).then(({ error }) => {
    window.state.friendsUI.challengeStatus = error || "Challenge sent!";
    window.render();
    refreshChallenges();
  });
}
function submitAcceptChallenge(challengeId) {
  const pl = window.state.play;
  const mySlots = window.buildSlots(pl.formationKey, "my");
  const filled = Object.values(pl.myLineup).filter(Boolean).length;
  if (filled !== mySlots.length) {
    window.state.friendsUI.challengeStatus = "Build a complete squad in the Play tab first, then accept.";
    window.render();
    return;
  }
  const lineupIds = lineupToIds(pl.myLineup);
  window.state.friendsUI.challengeStatus = "Loading match…";
  window.render();
  resolveChallengeAccept(challengeId, pl.formationKey, lineupIds).then(({ error, data }) => {
    if (error) { window.state.friendsUI.challengeStatus = error; window.render(); return; }
    window.state.friendsUI.challengeStatus = "";
    markChallengeViewed(window.state.session.user.id, challengeId);
    refreshChallenges();
    window.beginChallengeMatch(data.challenge, data.challengerLU);
  });
}
function submitDeclineChallenge(challengeId) {
  markChallengeViewed(window.state.session.user.id, challengeId);
  declineChallengeRow(challengeId).then(() => refreshChallenges());
}
function viewChallengeResult(challengeId) {
  markChallengeViewed(window.state.session.user.id, challengeId);
  window.state.friendsUI.viewingChallengeId = challengeId;
  window.render();
}
function closeChallengeResult() {
  window.state.friendsUI.viewingChallengeId = null;
  window.render();
}

// ---- Trading (Phase E) ----

function fetchFriendCollection(friendId) {
  return sb.from("user_cards").select("card_id").eq("user_id", friendId)
    .then(({ data, error }) => ({ data: (data || []).map(r => r.card_id), error: error ? error.message : null }));
}
function sendTradeOffer(initiatorId, recipientId, offeredCardIds, requestedCardIds, offeredGems) {
  if (!requestedCardIds.length) return Promise.resolve({ error: "Pick at least one of their cards to request." });
  if (!offeredCardIds.length && offeredGems <= 0) return Promise.resolve({ error: "Offer at least one card or some gems." });
  return sb.from("trades").insert({
    initiator_id: initiatorId, recipient_id: recipientId,
    offered_card_ids: offeredCardIds, requested_card_ids: requestedCardIds, offered_gems: offeredGems,
  }).then(({ error }) => ({ error: error ? error.message : null }));
}
function listTrades(callerId) {
  return sb.from("trades").select("*")
    .or(`initiator_id.eq.${callerId},recipient_id.eq.${callerId}`)
    .order("created_at", { ascending: false })
    .then(({ data, error }) => ({ data: data || [], error: error ? error.message : null }));
}
function cancelTrade(tradeId) {
  return sb.from("trades").update({ status: "cancelled", resolved_at: new Date().toISOString() }).eq("id", tradeId)
    .then(({ error }) => ({ error: error ? error.message : null }));
}
function declineTrade(tradeId) {
  return sb.from("trades").update({ status: "declined", resolved_at: new Date().toISOString() }).eq("id", tradeId)
    .then(({ error }) => ({ error: error ? error.message : null }));
}
function viewerTradeSides(trade, viewerId) {
  const isInitiator = trade.initiator_id === viewerId;
  return isInitiator
    ? { youGive: { cardIds: trade.offered_card_ids, gems: trade.offered_gems }, youGet: { cardIds: trade.requested_card_ids, gems: 0 } }
    : { youGive: { cardIds: trade.requested_card_ids, gems: 0 }, youGet: { cardIds: trade.offered_card_ids, gems: trade.offered_gems } };
}
// The ONLY atomic multi-row/multi-user mutation in this schema -- re-
// validates both sides still own what they're putting up (ownership may
// have changed since the offer was sent) and moves cards/gems all-or-
// nothing. Never reimplement this client-side.
function acceptTrade(tradeId) {
  return sb.rpc("execute_trade", { trade_id: tradeId }).then(({ error }) => ({ error: error ? error.message : null }));
}

// ---- UI-facing wrappers ----

function openTradeComposer(friendId, friendName) {
  window.state.friendsUI.trade = { friendId, friendName, friendCollection: [], offerIds: [], requestIds: [], gems: 0, status: "Loading their collection…", loading: true };
  window.render();
  fetchFriendCollection(friendId).then(({ data, error }) => {
    const t = window.state.friendsUI.trade;
    t.friendCollection = data || [];
    t.status = error || "";
    t.loading = false;
    window.render();
  });
}
function closeTradeComposer() {
  window.state.friendsUI.trade = { friendId: null, friendName: "", friendCollection: [], offerIds: [], requestIds: [], gems: 0, status: "", loading: false };
  window.render();
}
function toggleTradeOffer(cardId) {
  const t = window.state.friendsUI.trade;
  const idx = t.offerIds.indexOf(cardId);
  if (idx >= 0) t.offerIds.splice(idx, 1); else t.offerIds.push(cardId);
  window.render();
}
function toggleTradeRequest(cardId) {
  const t = window.state.friendsUI.trade;
  const idx = t.requestIds.indexOf(cardId);
  if (idx >= 0) t.requestIds.splice(idx, 1); else t.requestIds.push(cardId);
  window.render();
}
function submitTradeOffer() {
  const uid = window.state.session.user.id;
  const t = window.state.friendsUI.trade;
  t.status = "Sending offer…";
  window.render();
  sendTradeOffer(uid, t.friendId, t.offerIds, t.requestIds, t.gems).then(({ error }) => {
    if (error) { t.status = error; window.render(); return; }
    closeTradeComposer();
    refreshTrades();
  });
}
function refreshTrades() {
  const uid = window.state.session.user.id;
  return listTrades(uid).then(({ data }) => {
    window.state.friendsUI.trades = data || [];
    window.state.friendsUI.tradesLoaded = true;
    window.render();
  });
}
function viewTrade(tradeId) {
  markTradeViewed(window.state.session.user.id, tradeId);
  window.state.friendsUI.viewingTradeId = tradeId;
  window.render();
}
function closeTradeView() {
  window.state.friendsUI.viewingTradeId = null;
  window.state.friendsUI.tradeActionStatus = "";
  window.render();
}
function submitAcceptTrade(tradeId) {
  window.state.friendsUI.tradeActionStatus = "Completing trade…";
  window.render();
  acceptTrade(tradeId).then(({ error }) => {
    if (error) { window.state.friendsUI.tradeActionStatus = error; window.render(); return; }
    markTradeViewed(window.state.session.user.id, tradeId);
    closeTradeView();
    refreshTrades();
    refreshGameState();
  });
}
function submitDeclineTrade(tradeId) {
  markTradeViewed(window.state.session.user.id, tradeId);
  declineTrade(tradeId).then(() => { closeTradeView(); refreshTrades(); });
}
function submitCancelTrade(tradeId) {
  markTradeViewed(window.state.session.user.id, tradeId);
  cancelTrade(tradeId).then(() => { closeTradeView(); refreshTrades(); });
}

// ---- Notifications (Phase H) ----
// "Unread" for trades/challenges/friend requests is entirely derived from
// data already being fetched (a pending item awaiting MY action is always
// a notification; nothing extra to track) -- the only thing that needs
// local bookkeeping is "a resolved trade/challenge I haven't looked at yet"
// (localStorage, per account) and "chat messages that arrived while I
// wasn't looking" (in-memory only, cleared the moment a conversation is
// opened -- see openChat() above).
function notifStorageKey(userId) { return "tcg-notif-viewed-v1-" + userId; }
function loadNotifState(userId) {
  try {
    const raw = JSON.parse(localStorage.getItem(notifStorageKey(userId)));
    return raw && typeof raw === "object"
      ? { viewedChallengeIds: raw.viewedChallengeIds || [], viewedTradeIds: raw.viewedTradeIds || [] }
      : { viewedChallengeIds: [], viewedTradeIds: [] };
  } catch (e) { return { viewedChallengeIds: [], viewedTradeIds: [] }; }
}
function saveNotifState(userId, s) { try { localStorage.setItem(notifStorageKey(userId), JSON.stringify(s)); } catch (e) {} }
function markChallengeViewed(userId, challengeId) {
  const s = loadNotifState(userId);
  if (!s.viewedChallengeIds.includes(challengeId)) { s.viewedChallengeIds.push(challengeId); saveNotifState(userId, s); }
}
function markTradeViewed(userId, tradeId) {
  const s = loadNotifState(userId);
  if (!s.viewedTradeIds.includes(tradeId)) { s.viewedTradeIds.push(tradeId); saveNotifState(userId, s); }
}
// First-ever load for this account on this browser: everything already
// resolved before notifications existed is retroactively "viewed" so
// existing trade/challenge history doesn't dump a fake backlog of
// notifications on people the moment this feature ships. Only called once,
// right after the initial challenges/trades fetch at sign-in (see
// handleSignedIn() in auth.js) -- a no-op every time after the first.
function ensureNotifStateSeeded(userId) {
  if (localStorage.getItem(notifStorageKey(userId)) != null) return;
  const fUI = window.state.friendsUI;
  saveNotifState(userId, {
    viewedChallengeIds: (fUI.challenges || []).filter(c => c.resolved_at).map(c => c.id),
    viewedTradeIds: (fUI.trades || []).filter(t => t.resolved_at).map(t => t.id),
  });
}
// Read by index.html to badge the Friends tab and its Requests/Trades
// sub-tabs, and to dot each friend row's Chat button.
function notifBadges() {
  const session = window.state.session;
  const uid = session && session.user && session.user.id;
  if (!uid) return { requests: 0, challenges: 0, trades: 0, chat: 0, total: 0 };
  const s = loadNotifState(uid);
  const fUI = window.state.friendsUI;
  const requests = (fUI.requests.incoming || []).length;
  const challenges = (fUI.challenges || []).filter(c =>
    c.status === "pending" ? c.opponent_id === uid : (!!c.resolved_at && !s.viewedChallengeIds.includes(c.id))
  ).length;
  const trades = (fUI.trades || []).filter(t =>
    t.status === "pending" ? t.recipient_id === uid : (!!t.resolved_at && !s.viewedTradeIds.includes(t.id))
  ).length;
  const chat = (fUI.chatUnreadFriendIds || []).length;
  return { requests, challenges, trades, chat, total: requests + challenges + trades + chat };
}

// One realtime channel per session covering every event type that should
// raise a notification. friend_requests/challenges/trades need no column
// filter -- Supabase Realtime authorizes each change against the same RLS
// policy a normal SELECT would use, so this only ever receives rows this
// user is actually a party to. messages keeps the same recipient_id filter
// subscribeToChat() uses, for the same reason noted there.
let notifChannel = null;
function subscribeToNotifications(userId) {
  unsubscribeFromNotifications();
  notifChannel = sb.channel("notifications-" + userId)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "friend_requests" }, () => refreshFriendRequests())
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "friend_requests" }, () => { refreshFriendRequests(); refreshFriendsList(); })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "challenges" }, () => refreshChallenges())
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "challenges" }, () => refreshChallenges())
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "trades" }, () => refreshTrades())
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "trades" }, () => refreshTrades())
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `recipient_id=eq.${userId}` }, (payload) => {
      const fUI = window.state.friendsUI;
      if (payload.new.sender_id === fUI.chat.friendId) return; // conversation is already open, not a "notification"
      if (!fUI.chatUnreadFriendIds.includes(payload.new.sender_id)) {
        fUI.chatUnreadFriendIds = [...fUI.chatUnreadFriendIds, payload.new.sender_id];
        window.render();
      }
    })
    .subscribe();
}
function unsubscribeFromNotifications() {
  if (notifChannel) { sb.removeChannel(notifChannel); notifChannel = null; }
}
