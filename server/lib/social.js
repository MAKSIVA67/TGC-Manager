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
  return sb.from("profiles").select("id, display_name, team_name, avatar")
    .or(`display_name.ilike.${pattern},team_name.ilike.${pattern}`)
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
    refreshChallenges();
    window.beginChallengeMatch(data.challenge, data.challengerLU);
  });
}
function submitDeclineChallenge(challengeId) {
  declineChallengeRow(challengeId).then(() => refreshChallenges());
}
function viewChallengeResult(challengeId) {
  window.state.friendsUI.viewingChallengeId = challengeId;
  window.render();
}
function closeChallengeResult() {
  window.state.friendsUI.viewingChallengeId = null;
  window.render();
}
