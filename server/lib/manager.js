// TCG Manager -- Manager V1 page (Task D).
//
// ISOLATED BY DESIGN. Everything the Manager page needs lives in this file:
// its markup, its styles, its own click handling for its sub-tabs, and a guard
// so that if anything in here throws, the page shows a message instead of
// taking the whole app down with it (render() rebuilds every screen in one
// pass, so an exception here would otherwise blank the game).
//
// It CHANGES nothing. It reads the same state every other screen reads, and
// every action that does something real is an EXISTING action:
//   - "Train"          -> data-action="do-train"   (the game's own training
//                          handler and trainCard() in game-data.js, unchanged)
//   - "Home", "Play"   -> data-action="nav-tab"    (existing navigation)
//   - tapping a card   -> data-action="enlarge-card" via playerCard()
// No new tables, no new columns, no network calls of its own.
//
// What index.html gives it (all additive): window.tcgUI (the drawing helpers
// that live inside index.html's private scope), one line in the screen
// dispatcher, a Manager button on both Home layouts, and this <script> tag.
//
// Address: the app has no per-screen web addresses -- every screen is a
// `state.tab` value on one page, and a real /manager path would be a 404 on
// GitHub Pages. The page therefore lives at  index.html#manager : opening it
// sets that fragment (replaceState, so the Back button is unaffected), and
// loading the site with it opens the Manager directly.
"use strict";
(function(){

// ---------- state ----------
function mgr(){
  const s = window.state;
  if(!s.manager) s.manager = { tab:"team", pos:"ALL", market:"buy" };
  return s.manager;
}

// ---------- player value (PLACEHOLDER) ----------
// There is no value or price anywhere in the database -- this is an estimate
// made up for the Transfer Market placeholder, and is shown as one. Rarity
// sets the base, power scales it (squared, so the gap between a 70 and a 90
// feels like a real gap), and each training level adds 6%. Rounded to 10.
// Change the numbers here and every value on the page follows.
const RARITY_BASE = { Common:60, Uncommon:90, Rare:140, Epic:220, Elite:320,
  Ultra:460, Legendary:680, Mythic:950, Icon:1400, GOAT:2200 };
function playerValue(p){
  const base = RARITY_BASE[p.rarity] || 60;
  const power = Math.max(1, p.power || p.basePower || 60);
  const v = base * Math.pow(power / 75, 2) * (1 + 0.06 * (p.level || 0));
  return Math.max(10, Math.round(v / 10) * 10);
}

// ---------- helpers ----------
function fmt(n){ return Math.round(n).toLocaleString("en-US"); }
function thumbSrc(p){
  return p.imageThumbUrl || p.imageUrl ||
    (typeof window.cardPortraitURI === "function" ? window.cardPortraitURI(p, { detail:"thumb" }) : "");
}
function lineupPlayers(){
  const lu = (window.state.play && window.state.play.myLineup) || {};
  return Object.values(lu).filter(Boolean);
}
function ownedCards(){ return (window.state.players || []).filter(p => p.owned); }

// ---------- styles (scoped with the mgr prefix) ----------
function injectStyles(){
  if(document.getElementById("mgrStyles")) return;
  const css = `
.mgrHead{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.mgrBack{display:flex;align-items:center;gap:4px;padding:8px 12px;border-radius:12px;border:1px solid #ffffff1a;
  background:linear-gradient(160deg,#ffffff12,#ffffff05);color:var(--cream);font-size:11px;font-weight:900;letter-spacing:.06em;cursor:pointer}
.mgrTitle{font-family:'Teko',system-ui,sans-serif;font-weight:700;font-size:30px;line-height:1;color:var(--cream);letter-spacing:.03em}
.mgrV{font-size:9px;font-weight:900;letter-spacing:.12em;padding:3px 7px;border-radius:999px;background:var(--gold);color:var(--bg)}
.mgrStats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
.mgrStat{padding:9px 6px;border-radius:12px;background:var(--bg);text-align:center;min-width:0}
.mgrStat b{display:block;font-family:'Teko',system-ui,sans-serif;font-weight:700;font-size:20px;line-height:1.05;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mgrStat span{font-size:8px;font-weight:800;letter-spacing:.12em;color:var(--muted)}
.mgrTabs{display:flex;gap:6px;margin-bottom:12px}
.mgrTab{flex:1;padding:10px 4px;border-radius:12px;border:1px solid #ffffff14;background:var(--panel);color:var(--muted);
  font-size:11px;font-weight:900;letter-spacing:.06em;cursor:pointer}
.mgrTab.on{background:var(--turf);color:var(--bg);border-color:transparent}
.mgrChips{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
.mgrChip{padding:6px 11px;border-radius:999px;border:1px solid #ffffff1a;background:transparent;color:var(--muted);font-size:10px;font-weight:900;letter-spacing:.06em;cursor:pointer}
.mgrChip.on{background:var(--cream);color:var(--bg);border-color:transparent}
.mgrPitch{border-radius:16px;padding:12px 8px;margin-bottom:12px;
  background:radial-gradient(circle at 50% 0%,#2FD18022,transparent 60%),linear-gradient(180deg,#0F2A1C,#0B1F16);border:1px solid #2E6B4755}
.mgrLine{display:flex;justify-content:center;gap:8px;margin-bottom:8px}
.mgrLine:last-child{margin-bottom:0}
.mgrSlot{width:22%;max-width:92px;min-width:0}
.mgrEmpty{aspect-ratio:842/1191;border-radius:10px;border:2px dashed #6C84A366;display:flex;align-items:center;justify-content:center;
  color:var(--muted);font-size:10px;font-weight:900;letter-spacing:.08em}
.mgrLabel{font-size:10px;font-weight:900;letter-spacing:.14em;color:var(--muted);margin:14px 0 8px}
.mgrRow{display:flex;align-items:center;gap:10px;padding:9px;border-radius:14px;background:var(--panel);margin-bottom:8px;border:1px solid #ffffff0d;
  content-visibility:auto;contain-intrinsic-size:auto 82px}
.mgrThumb{width:44px;flex-shrink:0;aspect-ratio:842/1191;border-radius:6px;overflow:hidden;background:var(--bg);border:1px solid var(--rc,#ffffff22)}
.mgrThumb img{width:100%;height:100%;object-fit:cover;display:block}
.mgrInfo{flex:1;min-width:0}
.mgrName{font-weight:800;font-size:13px;color:var(--cream);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mgrMeta{font-size:10px;font-weight:700;letter-spacing:.04em;color:var(--muted);margin-top:1px}
.mgrBar{height:5px;border-radius:999px;background:var(--bg);overflow:hidden;margin-top:6px}
.mgrBar i{display:block;height:100%;border-radius:999px}
.mgrBtn{flex-shrink:0;padding:9px 12px;border-radius:11px;border:none;font-size:11px;font-weight:900;letter-spacing:.04em;cursor:pointer;min-width:74px}
.mgrBtn[disabled]{cursor:default}
.mgrValue{flex-shrink:0;text-align:right;margin-right:4px}
.mgrValue b{display:block;font-family:'Teko',system-ui,sans-serif;font-weight:700;font-size:19px;line-height:1;color:var(--gold)}
.mgrValue span{font-size:8px;font-weight:800;letter-spacing:.12em;color:var(--muted)}
.mgrNote{padding:12px;border-radius:14px;margin-bottom:12px;font-size:11px;line-height:1.45;color:var(--cream);
  background:linear-gradient(135deg,#FFB02018,#8B7FE814);border:1px solid #FFB02040}
.mgrTag{display:inline-block;font-size:8px;font-weight:900;letter-spacing:.1em;padding:2px 6px;border-radius:999px;margin-left:6px;vertical-align:1px}
`;
  const el = document.createElement("style");
  el.id = "mgrStyles";
  el.textContent = css;
  document.head.appendChild(el);
}

// ---------- sections ----------
function header(T){
  const C = T.COLORS;
  const club = (window.state.profile && window.state.profile.teamName) || "My Team";
  const col = (window.state.profile && window.state.profile.color) || C.turf;
  return `<div class="mgrHead">
      <button class="mgrBack scrimtap" data-action="nav-tab" data-tab="home">${T.icon("Home",14,C.cream)} HOME</button>
      <div style="flex:1;min-width:0">
        <div class="row" style="gap:8px;align-items:center">
          <div class="mgrTitle">MANAGER</div><span class="mgrV">V1</span>
        </div>
        <div class="row" style="gap:6px;align-items:center;margin-top:3px;min-width:0">
          ${T.crestHTML(club, col, 16)}
          <span style="font-size:11px;font-weight:800;color:${C.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${T.esc(club)}</span>
        </div>
      </div>
    </div>`;
}

function tabs(){
  const m = mgr();
  const t = [["team","MY TEAM"],["training","TRAINING"],["market","TRANSFERS"]];
  return `<div class="mgrTabs">${t.map(([k,l]) =>
    `<button class="mgrTab scrimtap${m.tab===k?" on":""}" data-mgr="tab" data-v="${k}">${l}</button>`).join("")}</div>`;
}

// a) My Team -- the squad the Play tab uses, read-only here.
function teamSection(T){
  const C = T.COLORS, S = window.state, pl = S.play || {};
  const formationKey = pl.formationKey || "balanced";
  const formation = T.FORMATIONS[formationKey] || { name: formationKey, counts:{} };
  const slots = window.buildSlots(formationKey, "my");
  const lu = pl.myLineup || {};
  const inSquad = lineupPlayers();
  const avg = inSquad.length ? Math.round(inSquad.reduce((s,p)=>s+p.power,0) / inSquad.length) : 0;
  const chem = T.chemistryFor(lu);
  const squadValue = inSquad.reduce((s,p)=>s+playerValue(p), 0);
  const shortName = formation.name.replace(/\s*\(.*\)/, "");
  const shape = (formation.name.match(/\(([^)]+)\)/) || [,""])[1];

  const stats = `<div class="mgrStats">
      <div class="mgrStat"><b style="color:${C.cream}">${T.esc(shape || shortName)}</b><span>${T.esc(shortName.toUpperCase())}</span></div>
      <div class="mgrStat"><b style="color:${inSquad.length===slots.length?C.turf:C.gold}">${inSquad.length}/${slots.length}</b><span>SQUAD</span></div>
      <div class="mgrStat"><b style="color:${C.gold}">${avg||"-"}</b><span>AVG POWER</span></div>
      <div class="mgrStat"><b style="color:${T.chemColor(chem.score)}">${chem.score}%</b><span>CHEMISTRY</span></div>
    </div>`;

  if(!inSquad.length){
    return stats + `<div class="panel" style="padding:20px;text-align:center">
        <div style="font-size:13px;color:${C.muted};margin-bottom:12px">You haven't picked a squad yet.</div>
        <button class="btn scrimtap wfull" data-action="nav-tab" data-tab="play"
          style="padding:11px 0;font-size:12px;font-weight:900;background:${C.turf};color:${C.bg}">SET UP YOUR SQUAD</button>
      </div>`;
  }

  // Drawn as the formation, attack at the top, like looking down the pitch.
  const lines = ["FWD","MID","DEF","GK"].map(pos => {
    const row = slots.filter(s => s.position === pos);
    if(!row.length) return "";
    return `<div class="mgrLine">${row.map(s => {
      const p = lu[s.id];
      return `<div class="mgrSlot">${p ? T.playerCard(p, { mode:"showcase" })
        : `<div class="mgrEmpty">${pos}</div>`}</div>`;
    }).join("")}</div>`;
  }).join("");

  const usedIds = new Set(inSquad.map(p => p.id));
  const bench = ownedCards().filter(p => !usedIds.has(p.id)).sort((a,b)=>b.power-a.power).slice(0, 4);

  return stats + `<div class="mgrPitch">${lines}</div>
    <div class="row between" style="align-items:center;margin-bottom:4px">
      <div style="font-size:11px;color:${C.muted}">Squad value <b style="color:${C.gold}">${fmt(squadValue)}</b> gems <span style="opacity:.7">(estimate)</span></div>
    </div>
    ${bench.length ? `<div class="mgrLabel">STRONGEST ON THE BENCH</div>
      <div class="grid3" style="grid-template-columns:repeat(4,1fr);gap:8px">${bench.map(p => `<div>${T.playerCard(p,{mode:"showcase"})}</div>`).join("")}</div>` : ""}
    <button class="btn scrimtap wfull" data-action="nav-tab" data-tab="play"
      style="margin-top:14px;padding:11px 0;font-size:12px;font-weight:900;background:${C.panel};color:${C.turf};border:1px solid ${C.turf}55">CHANGE SQUAD ON THE PLAY TAB</button>`;
}

function posChips(){
  const m = mgr();
  return `<div class="mgrChips">${["ALL","GK","DEF","MID","FWD"].map(p =>
    `<button class="mgrChip scrimtap${m.pos===p?" on":""}" data-mgr="pos" data-v="${p}">${p}</button>`).join("")}</div>`;
}

// b) Training -- a new list UI over the EXISTING training action. The Train
// button is data-action="do-train" with data-card-id, exactly what the card
// popup and the old training sheet send, so costs, checks and the database
// write are the game's own and cannot drift from them.
function trainingSection(T){
  const C = T.COLORS, S = window.state, m = mgr();
  const maxLv = (typeof MAX_CARD_LEVEL !== "undefined") ? MAX_CARD_LEVEL : 10;
  const cards = ownedCards().filter(p => m.pos === "ALL" || p.position === m.pos);
  const canTrain = p => p.level < maxLv && p.shards >= shardsForLevel(p.level) && S.gems >= gemsForLevel(p.level);
  cards.sort((a,b) => (canTrain(b)-canTrain(a)) || (b.power - a.power));
  const ready = ownedCards().filter(canTrain).length;
  const totalShards = ownedCards().reduce((s,p)=>s+(p.shards||0),0);

  const rows = cards.map(p => {
    const rc = (T.RARITY[p.rarity] || {}).color || C.muted;
    const maxed = p.level >= maxLv;
    const needS = maxed ? 0 : shardsForLevel(p.level), needG = maxed ? 0 : gemsForLevel(p.level);
    const okS = p.shards >= needS, okG = S.gems >= needG;
    const pct = maxed ? 100 : Math.min(100, Math.round(((p.shards||0) / needS) * 100));
    const btn = maxed
      ? `<button class="mgrBtn" disabled style="background:transparent;color:${C.gold};border:1px solid ${C.gold}55">MAX</button>`
      : `<button class="mgrBtn scrimtap" data-action="do-train" data-card-id="${p.id}" ${okS&&okG?"":"disabled"}
          style="background:${okS&&okG?C.turf:C.panelLight};color:${okS&&okG?C.bg:C.muted}">${okS&&okG?"TRAIN":!okS?"SHARDS":"GEMS"}</button>`;
    return `<div class="mgrRow">
        <div class="mgrThumb" style="--rc:${rc}"><img src="${T.esc(thumbSrc(p))}" alt="" loading="lazy"/></div>
        <div class="mgrInfo">
          <div class="mgrName">${T.esc(p.name)}</div>
          <div class="mgrMeta"><span style="color:${rc}">${(T.RARITY[p.rarity]||{}).label||p.rarity}</span> · ${p.position} · PWR ${p.power} · <span style="color:${C.cream}">LV ${p.level}/${maxLv}</span></div>
          ${maxed ? `<div class="mgrMeta" style="color:${C.gold};margin-top:6px">Fully trained</div>` : `
          <div class="mgrBar"><i style="width:${pct}%;background:${okS?C.turf:C.cyan}"></i></div>
          <div class="mgrMeta" style="margin-top:4px"><span style="color:${okS?C.turf:C.muted}">${p.shards||0}/${needS} shards</span> · <span style="color:${okG?C.gold:C.danger}">${needG} gems</span> → +1 PWR</div>`}
        </div>
        ${btn}
      </div>`;
  }).join("");

  return `<div class="mgrStats" style="grid-template-columns:repeat(3,1fr)">
      <div class="mgrStat"><b style="color:${C.turf}">${ready}</b><span>READY</span></div>
      <div class="mgrStat"><b style="color:${C.cyan}">${fmt(totalShards)}</b><span>SHARDS</span></div>
      <div class="mgrStat"><b style="color:${C.gold}">${fmt(S.gems)}</b><span>GEMS</span></div>
    </div>
    ${posChips()}
    ${rows || `<div class="panel" style="padding:18px;text-align:center;font-size:12px;color:${C.muted}">No cards here yet.</div>`}
    <div style="font-size:10px;color:${C.muted};text-align:center;margin-top:6px">Shards come from pulling a card you already own.</div>`;
}

// c) Transfer Market -- UI ONLY. Nothing here can buy, sell, or move a gem:
// every button is disabled, there is no handler behind it, and the values are
// the estimate from playerValue() above.
function marketSection(T){
  const C = T.COLORS, S = window.state, m = mgr();
  const usedIds = new Set(lineupPlayers().map(p => p.id));
  const list = m.market === "buy"
    ? (S.players || []).filter(p => !p.owned && !p.exclusive && p.active !== false)
    : ownedCards();
  const filtered = list.filter(p => m.pos === "ALL" || p.position === m.pos)
    .map(p => ({ p, v: playerValue(p) })).sort((a,b) => b.v - a.v);

  const rows = filtered.map(({p, v}) => {
    const rc = (T.RARITY[p.rarity] || {}).color || C.muted;
    return `<div class="mgrRow">
        <div class="mgrThumb" style="--rc:${rc}"><img src="${T.esc(thumbSrc(p))}" alt="" loading="lazy"/></div>
        <div class="mgrInfo">
          <div class="mgrName">${T.esc(p.name)}${usedIds.has(p.id) ? `<span class="mgrTag" style="background:${C.turf}22;color:${C.turf}">IN SQUAD</span>` : ""}</div>
          <div class="mgrMeta"><span style="color:${rc}">${(T.RARITY[p.rarity]||{}).label||p.rarity}</span> · ${p.position} · PWR ${p.power}${p.level?` · LV ${p.level}`:""}</div>
        </div>
        <div class="mgrValue"><b>${fmt(v)}</b><span>GEMS</span></div>
        <button class="mgrBtn" disabled style="background:${C.panelLight};color:${C.muted}">${m.market==="buy"?"BUY":"SELL"}<br><span style="font-size:8px;letter-spacing:.1em">SOON</span></button>
      </div>`;
  }).join("");

  return `<div class="mgrNote"><b style="color:${C.gold}">Transfer Market is coming soon.</b>
      Buying and selling are switched off. Nothing on this tab can spend or earn gems yet, and the values are estimates.</div>
    <div class="mgrTabs" style="margin-bottom:10px">
      <button class="mgrTab scrimtap${m.market==="buy"?" on":""}" data-mgr="market" data-v="buy">BUY</button>
      <button class="mgrTab scrimtap${m.market==="sell"?" on":""}" data-mgr="market" data-v="sell">SELL</button>
    </div>
    ${posChips()}
    ${rows || `<div class="panel" style="padding:18px;text-align:center;font-size:12px;color:${C.muted}">${m.market==="buy" ? "You already own every card in this list." : "No cards to show."}</div>`}`;
}

// ---------- page ----------
function build(){
  const T = window.tcgUI;
  if(!T) throw new Error("window.tcgUI missing -- index.html did not export its helpers");
  injectStyles();
  const m = mgr();
  const body = m.tab === "training" ? trainingSection(T)
             : m.tab === "market"   ? marketSection(T)
             : teamSection(T);
  return `<div class="view">${header(T)}${tabs()}${body}</div>`;
}

window.managerView = function(){
  try { return build(); }
  catch(err){
    console.error("[manager] page failed to render:", err);
    return `<div class="view"><div class="panel" style="padding:20px;text-align:center">
        <div style="font-weight:900;margin-bottom:8px">The Manager page hit a problem.</div>
        <div style="font-size:12px;opacity:.7;margin-bottom:14px">The rest of the game is fine.</div>
        <button class="btn scrimtap wfull" data-action="nav-tab" data-tab="home" style="padding:11px 0;font-weight:900">BACK TO HOME</button>
      </div></div>`;
  }
};

// Keeps  #manager  in the address bar while (and only while) the Manager is
// open. replaceState, never pushState: pushing would add Back-button history
// the rest of the app has never had, and Back would then do nothing visible.
// Only ever touches a fragment that is empty or exactly "#manager", so a
// Supabase sign-in link (#access_token=...) is never rewritten.
window.managerSyncUrl = function(tab){
  const want = tab === "manager";
  const hash = window.location.hash;
  if(want && hash === "#manager") return;
  if(!want && hash !== "#manager") return;
  if(want && hash && hash !== "#manager") return;
  try { history.replaceState(null, "", window.location.pathname + window.location.search + (want ? "#manager" : "")); }
  catch(_){}
};

// Its own click handling for its own sub-tabs, on data-mgr (never data-action),
// so the game's main click handler never sees these and none of its cases change.
document.getElementById("stage").addEventListener("click", function(e){
  const el = e.target.closest("[data-mgr]");
  if(!el) return;
  const m = mgr(), kind = el.dataset.mgr, v = el.dataset.v;
  if(kind === "tab") m.tab = v;
  else if(kind === "pos") m.pos = v;
  else if(kind === "market") m.market = v;
  else return;
  if(window.ensureAudio) window.ensureAudio();
  if(window.playTap) window.playTap();
  window.render();
});

// Opened by address: index.html#manager
if(window.location.hash === "#manager" && window.state){
  window.state.tab = "manager";
  // If sign-in already finished before this file loaded, nothing else will
  // re-render, and the player would sit on Home with #manager in the bar.
  if(window.state.authReady && window.render) window.render();
}

})();
