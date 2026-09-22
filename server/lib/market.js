// TCG Manager -- transfer market client (talks to migration 009).
//
// Every price here is DISPLAY ONLY. The database decides and charges them
// (card_market_value, market_quick_sell_price, market_fee, market_scout_price
// in server/sql/009_transfer_market.sql), because since 007's lock-down the
// browser cannot write gems or cards at all. The formulas below are the same
// integer fractions as the SQL -- a parity test runs both over every rarity,
// power 1-130 and level 0-10 -- so what the button says is what gets charged.
//
// Before 009 has been run the market functions do not exist; every call then
// resolves to { missing: true } and the Manager page says so instead of
// failing. Nothing else in the game depends on this file.
"use strict";
(function(global){

var RARITY_BASE = { Common:60, Uncommon:90, Rare:140, Epic:220, Elite:320,
  Ultra:460, Legendary:680, Mythic:950, Icon:1400, GOAT:2200 };
var RANK = ["Common","Uncommon","Rare","Epic","Elite","Ultra","Legendary","Mythic","Icon","GOAT"];
var MIN_CARDS = 9, MAX_LISTINGS = 5;

// ---------- prices (mirror 009 exactly; whole-number arithmetic only) ----------
// power = the card's printed power + its training level (what the app shows).
function value(rarity, power, level){
  var base = RARITY_BASE[rarity] || 60;
  var pw = Math.max(1, power || 60), lv = Math.max(0, level || 0);
  return Math.max(10, Math.round(base * pw * pw * (100 + 6 * lv) / 5625000) * 10);
}
function quickSellPrice(v){ return Math.max(5, Math.round(v * 7 / 100) * 5); }
function fee(price){ return Math.max(1, Math.ceil(price * 5 / 100)); }
function scoutPrice(rarity, v){
  return Math.round(v * (RANK.indexOf(rarity) >= RANK.indexOf("Elite") ? 3 : 2) / 10) * 10;
}
function cardValue(p){ return value(p.rarity, p.power, p.level); }
function listBounds(p){ var v = cardValue(p); return { min: quickSellPrice(v), max: v * 5, value: v }; }

var pricing = { value: value, quickSellPrice: quickSellPrice, fee: fee, scoutPrice: scoutPrice,
  cardValue: cardValue, listBounds: listBounds, MIN_CARDS: MIN_CARDS, MAX_LISTINGS: MAX_LISTINGS };

// Running under node (the parity test) -- export the maths and stop here.
if (typeof module !== "undefined" && module.exports && typeof window === "undefined") { module.exports = pricing; return; }

// ---------- state ----------
function st(){
  var s = global.state;
  if (!s.market) s.market = { status: "idle", listings: [], mine: [], scout: [], error: "", busy: null, loadedAt: 0 };
  return s.market;
}
function card(id){ return (global.state.players || []).find(function(p){ return p.id === Number(id); }) || null; }
function ownedCount(){ return (global.state.players || []).filter(function(p){ return p.owned; }).length; }
function inCurrentSquad(id){
  var lu = (global.state.play && global.state.play.myLineup) || {};
  return Object.keys(lu).some(function(k){ return lu[k] && lu[k].id === Number(id); });
}

// Why a card cannot be sold right now, or null if it can. Mirrors the checks
// in market_take_card_check(); the server re-checks all of them anyway.
function sellBlock(p){
  if (!p || !p.owned) return "You don't own this player.";
  if (p.exclusive) return "Exclusive cards can't be sold.";
  if (inCurrentSquad(p.id)) return "In your squad";
  if (ownedCount() <= MIN_CARDS) return "Keep 9 to play";
  return null;
}

// ---------- calls ----------
function rpc(name, args){
  return sb.rpc(name, args || {}).then(function(res){
    if (res.error && typeof rpcMissing === "function" && rpcMissing(res.error)) return { missing: true };
    if (res.error) return { error: res.error.message || "Something went wrong." };
    return { data: res.data };
  }, function(e){ return { error: (e && e.message) || "No connection. Check your internet and try again." }; });
}

function load(force){
  var m = st();
  if (!force && m.status === "loading") return Promise.resolve();
  if (!force && m.status === "ready" && Date.now() - m.loadedAt < 15000) return Promise.resolve();
  m.status = m.status === "ready" ? "ready" : "loading";
  m.error = "";
  global.render();
  return Promise.all([rpc("market_browse"), rpc("market_my_listings"), rpc("market_scout_offers")]).then(function(r){
    if (r.some(function(x){ return x.missing; })) { m.status = "missing"; global.render(); return; }
    var bad = r.find(function(x){ return x.error; });
    if (bad) { m.status = "error"; m.error = bad.error; global.render(); return; }
    // Anything that is not a list is treated as an empty one: the page must
    // never crash on an unexpected answer.
    var arr = function(x){ return Array.isArray(x) ? x : []; };
    m.listings = arr(r[0].data); m.mine = arr(r[1].data); m.scout = arr(r[2].data);
    m.status = "ready"; m.loadedAt = Date.now();
    console.log("[market] loaded", { listings: m.listings.length, mine: m.mine.length, scout: m.scout.length });
    global.render();
  });
}

// Local bookkeeping after the server confirms. Nothing is applied before that.
function loseCard(p){ if (!p) return; p.owned = false; p.level = 0; p.shards = 0; p.power = p.basePower; }
function gainCard(p, level, shards){
  if (!p) return; p.owned = true;
  if (typeof applyCardRow === "function") applyCardRow(p, { level: level || 0, shards: shards || 0 });
  else { p.level = level || 0; p.shards = shards || 0; p.power = p.basePower + (level || 0); }
}
function gems(d){ if (d && typeof d.gems === "number" && typeof applyServerEconomy === "function") applyServerEconomy({ gems: d.gems }); }

function act(kind, name, args, onOk){
  var m = st();
  if (m.busy) return Promise.resolve({ error: "Hang on, still working on the last one." });
  m.busy = kind; global.render();
  return rpc(name, args).then(function(r){
    m.busy = null;
    if (r.missing) { m.status = "missing"; global.render(); return r; }
    if (r.error) { global.render(); return r; }
    onOk(r.data || {});
    m.loadedAt = 0;              // stale now; the reload below refreshes lists
    load(true);
    return r;
  });
}

function quickSell(cardId){
  var p = card(cardId), why = sellBlock(p);
  if (why) return Promise.resolve({ error: why });
  return act("sell:" + cardId, "market_quick_sell", { p_card_id: Number(cardId) }, function(d){
    loseCard(p); gems(d);
    console.log("[market] quick sell", d);
  });
}
function list(cardId, price){
  var p = card(cardId), why = sellBlock(p);
  if (why) return Promise.resolve({ error: why });
  var b = listBounds(p);
  if (!(price >= b.min && price <= b.max)) return Promise.resolve({ error: "Price must be between " + b.min + " and " + b.max + " gems." });
  return act("list:" + cardId, "market_list_card", { p_card_id: Number(cardId), p_price: Math.round(price) }, function(d){
    loseCard(p);
    console.log("[market] listed", d);
  });
}
function cancel(listingId){
  return act("cancel:" + listingId, "market_cancel_listing", { p_listing_id: Number(listingId) }, function(d){
    gainCard(card(d.card_id), d.level, d.shards);
    console.log("[market] cancelled", d);
  });
}
function buy(listingId){
  return act("buy:" + listingId, "market_buy_listing", { p_listing_id: Number(listingId) }, function(d){
    gainCard(card(d.card_id), d.level, d.shards); gems(d);
    console.log("[market] bought", d);
  });
}
function buyScout(cardId){
  return act("scout:" + cardId, "market_buy_scout", { p_card_id: Number(cardId) }, function(d){
    gainCard(card(d.card_id), 0, 0); gems(d);
    console.log("[market] scouted", d);
  });
}

// Time until the scouting report rotates (midnight UTC), as "5h 12m".
function scoutResetsIn(){
  var now = new Date(), next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  var mins = Math.max(0, Math.round((next - now.getTime()) / 60000));
  return Math.floor(mins / 60) + "h " + (mins % 60) + "m";
}

global.Market = Object.assign({}, pricing, {
  state: st, load: load, quickSell: quickSell, list: list, cancel: cancel, buy: buy, buyScout: buyScout,
  sellBlock: sellBlock, card: card, scoutResetsIn: scoutResetsIn
});

})(typeof window !== "undefined" ? window : globalThis);
