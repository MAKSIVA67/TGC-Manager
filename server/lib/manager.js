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
  if(!s.manager) s.manager = { tab:"team", pos:"ALL", market:"buy", sort:"new", sheet:null, sheetError:"", focus:null };
  return s.manager;
}

// ---------- player value ----------
// The same number the database charges (card_market_value in migration 009),
// via lib/market.js. The fallback is the identical integer formula, used only
// if market.js failed to load.
function playerValue(p){
  if(window.Market) return window.Market.cardValue(p);
  const base = ({ Common:60, Uncommon:90, Rare:140, Epic:220, Elite:320, Ultra:460,
    Legendary:680, Mythic:950, Icon:1400, GOAT:2200 })[p.rarity] || 60;
  const pw = Math.max(1, p.power || 60), lv = Math.max(0, p.level || 0);
  return Math.max(10, Math.round(base * pw * pw * (100 + 6 * lv) / 5625000) * 10);
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
.mgrScoutGrid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.mgrScout{display:flex;flex-direction:column;gap:6px;min-width:0}
.mgrPopIn{animation:mgrPop .45s cubic-bezier(.2,.9,.3,1.25) both}
.mgrScout:nth-child(2) .mgrPopIn{animation-delay:.06s}.mgrScout:nth-child(3) .mgrPopIn{animation-delay:.12s}.mgrScout:nth-child(4) .mgrPopIn{animation-delay:.18s}
@keyframes mgrPop{from{opacity:0;transform:translateY(10px) scale(.92)}to{opacity:1;transform:none}}
.mgrBtnWide{width:100%;min-width:0;padding:8px 4px;font-size:10px}
.mgrBtnCol{display:flex;flex-direction:column;gap:6px;flex-shrink:0}
.mgrBtnCol .mgrBtn{min-width:88px;padding:8px 8px}
.mgrFocus{border-color:#FFB020aa;box-shadow:0 0 0 2px #FFB02055}
.mgrFocusIn{animation:mgrFocusPulse 1.6s ease-in-out 2}
@keyframes mgrFocusPulse{50%{box-shadow:0 0 0 5px #FFB02033}}
.mgrExplain{padding:10px 12px;border-radius:14px;margin-bottom:10px;font-size:11px;line-height:1.5;background:var(--panel);border:1px solid #ffffff10;color:var(--cream)}
.mgrStamp{flex-shrink:0;font-size:10px;font-weight:900;letter-spacing:.08em;padding:6px 9px;border-radius:8px;border:1.5px solid;transform:rotate(-4deg)}
.mgrShimmer{background:linear-gradient(100deg,#ffffff08 30%,#ffffff18 50%,#ffffff08 70%);background-size:300% 100%;animation:mgrShim 1.4s linear infinite}
@keyframes mgrShim{to{background-position:-150% 0}}
.mgrSheetWrap{position:fixed;inset:0;z-index:65;display:flex;align-items:flex-end;justify-content:center;background:rgba(3,7,14,.72)}
.mgrSheetIn{animation:mgrFade .18s ease both}
.mgrSheetIn .mgrSheet{animation:mgrUp .32s cubic-bezier(.2,.9,.3,1) both}
@keyframes mgrFade{from{opacity:0}}
.mgrSheet{width:100%;max-width:440px;max-height:92vh;overflow-y:auto;padding:16px 16px calc(18px + env(safe-area-inset-bottom));border-radius:22px 22px 0 0;
  background:linear-gradient(180deg,#16283d,var(--panel));border:1px solid #ffffff14}
@keyframes mgrUp{from{transform:translateY(40%);opacity:.3}to{transform:none;opacity:1}}
.mgrSheetTitle{font-size:10px;font-weight:900;letter-spacing:.16em;color:var(--muted);text-align:center;margin-bottom:10px}
.mgrSheetCard{width:120px;margin:0 auto 8px}
.mgrSheetName{font-family:Teko,system-ui,sans-serif;font-weight:700;font-size:22px;text-align:center;color:var(--cream);margin-bottom:10px}
.mgrPrice{display:flex;align-items:center;justify-content:center;gap:14px;margin:4px 0 10px}
.mgrStep{width:46px;height:46px;border-radius:50%;border:1px solid #ffffff22;background:var(--panelLight);color:var(--cream);font-size:24px;font-weight:900;cursor:pointer}
.mgrPriceNum{text-align:center;min-width:120px}
.mgrPriceNum b{display:block;font-family:Teko,system-ui,sans-serif;font-size:40px;line-height:1;color:var(--gold)}
.mgrPriceNum span{font-size:9px;font-weight:900;letter-spacing:.14em;color:var(--muted)}
.mgrSum{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);padding:4px 2px}
.mgrSum b{color:var(--cream)}
.mgrSumTotal{border-top:1px solid #ffffff14;margin-top:4px;padding-top:8px;font-size:13px;color:var(--cream)}
.mgrErr{margin-top:10px;padding:9px 10px;border-radius:10px;background:#FB5A5A1f;border:1px solid #FB5A5A66;color:#FFB4B4;font-size:12px;text-align:center}
@media (prefers-reduced-motion:reduce){.mgrPopIn,.mgrSheetIn,.mgrSheetIn .mgrSheet,.mgrFocusIn,.mgrShimmer{animation:none!important}}
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
// How a listing's price compares with the player's value. Strategy needs a
// reference point: without one every price looks equally arbitrary.
function dealBadge(T, p, l){
  if(!window.Market) return "";
  const C = T.COLORS, v = window.Market.value(p.rarity, p.basePower + (l.level || 0), l.level || 0), r = l.price / v;
  const b = r <= 0.9 ? ["GREAT DEAL", C.turf] : r <= 1.2 ? ["FAIR PRICE", C.cyan] : r >= 2.5 ? ["PRICEY", C.danger] : null;
  return b ? `<span class="mgrTag" style="background:${b[1]}22;color:${b[1]}">${b[0]}</span>` : "";
}

// Transfer targets: for each position, which player on the market would lift
// your weakest starter the most per gem? This is what turns the market from a
// shop into a decision. Also points out when your own bench already beats a
// starter -- a free upgrade people miss.
function targetsHTML(T, lu, inSquad){
  const C = T.COLORS, S = window.state, M = window.Market, s = mkt();
  if(!M || !inSquad.length) return "";
  if(s.status === "idle") setTimeout(() => M.load(), 0);
  const eff = p => p.basePower + (p.level || 0);
  // Every slot of the formation, not just the keys the saved lineup happens to
  // have -- an EMPTY slot is the biggest upgrade there is and must be counted.
  const slots = window.buildSlots((S.play && S.play.formationKey) || "balanced", "my").map(x => x.id);
  const weakest = {};                               // position -> {power, player|null}
  slots.forEach(id => {
    const pos = id.replace(/[0-9]+$/, ""), p = lu[id];
    const pw = p ? eff(p) : 0;
    if(!weakest[pos] || pw < weakest[pos].power) weakest[pos] = { power: pw, player: p || null };
  });
  const usedIds = new Set(inSquad.map(p => p.id));
  const benchHints = Object.keys(weakest).map(pos => {
    const best = ownedCards().filter(p => p.position === pos && !usedIds.has(p.id)).sort((a,b) => eff(b) - eff(a))[0];
    return best && eff(best) > weakest[pos].power ? { pos, best, gain: eff(best) - weakest[pos].power } : null;
  }).filter(Boolean).sort((a,b) => b.gain - a.gain);
  const cands = [];
  if(s.status === "ready"){
    (s.listings || []).forEach(l => { const p = M.card(l.card_id); if(!p || p.owned || l.owned || !weakest[p.position]) return;
      const gain = p.basePower + (l.level || 0) - weakest[p.position].power; if(gain > 0) cands.push({ kind:"buy", id:l.id, p, price:l.price, gain, from:"market" }); });
    (s.scout || []).forEach(o => { const p = M.card(o.card_id); if(!p || p.owned || o.owned || !weakest[p.position]) return;
      const gain = p.basePower - weakest[p.position].power; if(gain > 0) cands.push({ kind:"scout", id:p.id, p, price:o.price, gain, from:"scouting" }); });
  }
  cands.sort((a,b) => (b.gain / b.price) - (a.gain / a.price));
  const top = cands.slice(0, 3);
  const rows = top.map(c => {
    const w = weakest[c.p.position], can = S.gems >= c.price;
    return `<div class="mgrRow">
        ${rowThumb(T, c.p)}
        <div class="mgrInfo">
          <div class="mgrName">${T.esc(c.p.name)}</div>
          <div class="mgrMeta"><b style="color:${C.turf}">+${c.gain} PWR</b> at ${c.p.position}${w.player ? " · replaces " + T.esc(w.player.name) : " · fills an empty slot"}</div>
          <div class="mgrMeta" style="margin-top:3px">from the ${c.from} · ${(c.gain / c.price * 100).toFixed(1)} power per 100 gems</div>
        </div>
        ${gemTag(T, c.price, "PRICE")}
        <button class="mgrBtn scrimtap" ${can ? `data-mgr="mask" data-kind="${c.kind}" data-v="${c.id}"` : "disabled"}
          style="background:${can ? C.gold : C.panelLight};color:${can ? C.bg : C.muted}">${can ? "BUY" : "NEED GEMS"}</button>
      </div>`; }).join("");
  const bench = benchHints[0] ? `<div class="mgrExplain" style="border-color:${C.turf}44">
      <b style="color:${C.turf}">Free upgrade:</b> ${T.esc(benchHints[0].best.name)} on your bench is <b>+${benchHints[0].gain}</b> over your weakest ${benchHints[0].pos}.
      Tap <b>EQUIP BEST SQUAD</b> on the Play tab.</div>` : "";
  const body = s.status === "ready"
    ? (rows || `<div style="font-size:11px;color:${C.muted};padding:4px 2px 8px">Nobody on the market right now beats your starters. Check back after tomorrow's scouting report.</div>`)
    : s.status === "missing" ? `<div style="font-size:11px;color:${C.muted};padding:4px 2px 8px">Transfer targets appear once the market opens.</div>`
    : `<div class="mgrNote mgrShimmer">Scouting the market…</div>`;
  return `<div class="mgrLabel">TRANSFER TARGETS</div>${bench}${body}`;
}

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
    ${targetsHTML(T, lu, inSquad)}
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

// c) Transfer Market -- LIVE (migration 009). Every button here asks the
// database; lib/market.js does the calls and only updates the screen after the
// server has confirmed. Before 009 is run the tab says so and keeps the buttons
// switched off, so an old database can never be half-used.
function mkt(){ return window.Market ? window.Market.state() : { status:"missing", listings:[], mine:[], scout:[] }; }
function busyIs(k){ const s = mkt(); return !!s.busy && s.busy === k; }

function marketNote(T){
  const C = T.COLORS, s = mkt();
  if(s.status === "missing") return `<div class="mgrNote"><b style="color:${C.gold}">The transfer market opens after one database update.</b>
      Everything below shows real prices, but buying and selling stay switched off until migration 009 has been run.</div>`;
  if(s.status === "error") return `<div class="mgrNote" style="border-color:${C.danger}66"><b style="color:${C.danger}">Couldn't load the market.</b>
      ${T.esc(s.error || "")}<div style="margin-top:8px"><button class="mgrBtn scrimtap" data-mgr="mreload" style="background:${C.panelLight};color:${C.cream}">TRY AGAIN</button></div></div>`;
  if(s.status === "loading" || s.status === "idle") return `<div class="mgrNote mgrShimmer">Loading the transfer market…</div>`;
  return "";
}

function rowThumb(T, p){
  const rc = (T.RARITY[p.rarity] || {}).color || T.COLORS.muted;
  return `<div class="mgrThumb" style="--rc:${rc}"><img src="${T.esc(thumbSrc(p))}" alt="" loading="lazy"/></div>`;
}
function rowMeta(T, p, level){
  const rc = (T.RARITY[p.rarity] || {}).color || T.COLORS.muted;
  const pw = p.basePower + (level != null ? level : (p.level || 0));
  const lv = level != null ? level : p.level;
  return `<span style="color:${rc}">${(T.RARITY[p.rarity]||{}).label||p.rarity}</span> · ${p.position} · PWR ${pw}${lv ? ` · LV ${lv}` : ""}`;
}
function gemTag(T, n, label){
  return `<div class="mgrValue"><b>${fmt(n)}</b><span>${label || "GEMS"}</span></div>`;
}

function buyTab(T){
  const C = T.COLORS, S = window.state, m = mgr(), s = mkt(), live = s.status === "ready";
  // render() rebuilds the page on every tap; the pop plays only the first time
  // the report is drawn, or every sort/filter tap would replay it.
  const pop = !m.scoutShown && (s.scout || []).length > 0; if(pop) m.scoutShown = true;
  // --- scouting report
  const scout = (s.scout || []).map(o => ({ o, p: window.Market && window.Market.card(o.card_id) })).filter(x => x.p);
  const scoutHTML = scout.length ? `<div class="mgrScoutGrid">${scout.map(({o, p}) => {
      const can = live && !o.owned && S.gems >= o.price;
      const label = o.owned || p.owned ? "OWNED" : busyIs("scout:" + p.id) ? "…" : S.gems < o.price ? "NEED GEMS" : "BUY";
      return `<div class="mgrScout">
        <div class="mgrScoutCard${pop ? " mgrPopIn" : ""}">${T.playerCard(p, { mode:"showcase" })}</div>
        <button class="mgrBtn mgrBtnWide scrimtap" ${can && !(o.owned||p.owned) ? `data-mgr="mask" data-kind="scout" data-v="${p.id}"` : "disabled"}
          style="background:${can && !(o.owned||p.owned) ? C.gold : C.panelLight};color:${can && !(o.owned||p.owned) ? C.bg : C.muted}">
          ${label}${label === "BUY" ? ` · ${fmt(o.price)}` : ""}</button>
      </div>`; }).join("")}</div>`
    : `<div class="panel" style="padding:14px;text-align:center;font-size:12px;color:${C.muted}">${live ? "No scouting report today." : "The scouting report appears once the market is open."}</div>`;

  // --- other managers' listings
  let rows = (s.listings || []).map(l => ({ l, p: window.Market && window.Market.card(l.card_id) })).filter(x => x.p)
    .filter(x => m.pos === "ALL" || x.p.position === m.pos);
  if(m.sort === "cheap") rows.sort((a, b) => a.l.price - b.l.price);
  const listHTML = rows.map(({l, p}) => {
    const owned = l.owned || p.owned, can = live && !owned && S.gems >= l.price;
    const label = owned ? "OWNED" : busyIs("buy:" + l.id) ? "…" : S.gems < l.price ? "NEED GEMS" : "BUY";
    return `<div class="mgrRow">
        ${rowThumb(T, p)}
        <div class="mgrInfo">
          <div class="mgrName">${T.esc(p.name)}</div>
          <div class="mgrMeta">${rowMeta(T, p, l.level)}</div>
          <div class="mgrMeta" style="margin-top:3px">listed by <span style="color:${C.cream}">${T.esc(l.seller_name || "a manager")}</span>${dealBadge(T, p, l)}</div>
        </div>
        ${gemTag(T, l.price, "PRICE")}
        <button class="mgrBtn scrimtap" ${can ? `data-mgr="mask" data-kind="buy" data-v="${l.id}"` : "disabled"}
          style="background:${can ? C.turf : C.panelLight};color:${can ? C.bg : C.muted}">${label}</button>
      </div>`; }).join("");

  return `<div class="row between" style="align-items:flex-end;margin:4px 0 8px">
      <div class="mgrLabel" style="margin:0">TODAY'S SCOUTING REPORT</div>
      <div style="font-size:10px;font-weight:800;color:${C.cyan}">${window.Market ? "new players in " + window.Market.scoutResetsIn() : ""}</div>
    </div>
    ${scoutHTML}
    <div class="row between" style="align-items:center;margin:16px 0 8px">
      <div class="mgrLabel" style="margin:0">FROM OTHER MANAGERS ${rows.length ? `(${rows.length})` : ""}</div>
      <div class="row" style="gap:6px">
        <button class="mgrChip scrimtap${m.sort !== "cheap" ? " on" : ""}" data-mgr="msort" data-v="new">NEWEST</button>
        <button class="mgrChip scrimtap${m.sort === "cheap" ? " on" : ""}" data-mgr="msort" data-v="cheap">CHEAPEST</button>
      </div>
    </div>
    ${posChips()}
    ${listHTML || `<div class="panel" style="padding:18px;text-align:center;font-size:12px;color:${C.muted}">
        No players listed${m.pos !== "ALL" ? " in this position" : ""} yet. Be the first: list one of yours in <b style="color:${C.cream}">SELL</b>.</div>`}`;
}

function sellTab(T){
  const C = T.COLORS, m = mgr(), s = mkt(), live = s.status === "ready", M = window.Market;
  const cards = ownedCards().filter(p => m.pos === "ALL" || p.position === m.pos)
    .map(p => ({ p, v: M ? M.cardValue(p) : playerValue(p) })).sort((a, b) => b.v - a.v);
  const active = (s.mine || []).filter(x => x.status === "active").length;
  const rows = cards.map(({p, v}) => {
    const why = M ? M.sellBlock(p) : null, qs = M ? M.quickSellPrice(v) : 0;
    const canQ = live && !why, canL = live && !why && active < (M ? M.MAX_LISTINGS : 5);
    const focus = m.focus === p.id, focusAnim = focus && !m.focusShown; if(focusAnim) m.focusShown = true;
    return `<div class="mgrRow${focus ? " mgrFocus" : ""}${focusAnim ? " mgrFocusIn" : ""}" data-mgr-row="${p.id}">
        ${rowThumb(T, p)}
        <div class="mgrInfo">
          <div class="mgrName">${T.esc(p.name)}</div>
          <div class="mgrMeta">${rowMeta(T, p)}</div>
          <div class="mgrMeta" style="margin-top:3px">value <b style="color:${C.gold}">${fmt(v)}</b>${why ? ` · <span style="color:${C.danger}">${T.esc(why)}</span>` : ""}</div>
        </div>
        <div class="mgrBtnCol">
          <button class="mgrBtn scrimtap" ${canQ ? `data-mgr="mask" data-kind="quick" data-v="${p.id}"` : "disabled"}
            style="background:${canQ ? C.gold : C.panelLight};color:${canQ ? C.bg : C.muted}">${busyIs("sell:" + p.id) ? "…" : "SELL +" + fmt(qs)}</button>
          <button class="mgrBtn scrimtap" ${canL ? `data-mgr="mlistopen" data-v="${p.id}"` : "disabled"}
            style="background:${canL ? C.panelLight : "transparent"};color:${canL ? C.cream : C.muted};border:1px solid ${canL ? C.cream + "44" : "#ffffff14"}">LIST</button>
        </div>
      </div>`; }).join("");
  return `<div class="mgrExplain">
      <div><b style="color:${C.gold}">SELL</b> pays instantly, at 35% of the player's value.</div>
      <div><b style="color:${C.cream}">LIST</b> lets other managers buy them at your price (5% market fee). ${active}/${M ? M.MAX_LISTINGS : 5} listed.</div>
      <div style="color:${C.muted}">You always keep at least 9 players, and players in your squad can't be sold.</div>
    </div>
    ${posChips()}
    ${rows || `<div class="panel" style="padding:18px;text-align:center;font-size:12px;color:${C.muted}">No cards here.</div>`}`;
}

function mineTab(T){
  const C = T.COLORS, s = mkt(), live = s.status === "ready", M = window.Market;
  const rows = (s.mine || []).map(l => ({ l, p: M && M.card(l.card_id) })).filter(x => x.p).map(({l, p}) => {
    const get = l.price - (l.fee != null ? l.fee : (M ? M.fee(l.price) : 0));
    const status = l.status === "active"
      ? `<button class="mgrBtn scrimtap" ${live ? `data-mgr="mcancel" data-v="${l.id}"` : "disabled"} style="background:${C.panelLight};color:${C.cream}">${busyIs("cancel:" + l.id) ? "…" : "CANCEL"}</button>`
      : l.status === "sold"
        ? `<span class="mgrStamp" style="color:${C.turf};border-color:${C.turf}">SOLD +${fmt(get)}</span>`
        : `<span class="mgrStamp" style="color:${C.muted};border-color:${C.muted}">CANCELLED</span>`;
    return `<div class="mgrRow" style="${l.status === "active" ? "" : "opacity:.7"}">
        ${rowThumb(T, p)}
        <div class="mgrInfo">
          <div class="mgrName">${T.esc(p.name)}</div>
          <div class="mgrMeta">${rowMeta(T, p, l.level)}</div>
          <div class="mgrMeta" style="margin-top:3px">listed at <b style="color:${C.gold}">${fmt(l.price)}</b> · you get ${fmt(get)}</div>
        </div>
        ${status}
      </div>`; }).join("");
  return rows || `<div class="panel" style="padding:18px;text-align:center;font-size:12px;color:${C.muted}">
      Nothing listed. Go to <b style="color:${C.cream}">SELL</b> and tap LIST on a player you don't need.</div>`;
}

// The confirm / price sheet. One at a time, drawn over the page.
function sheetHTML(T){
  const C = T.COLORS, m = mgr(), S = window.state, M = window.Market;
  if(!m.sheet || !M) return "";
  const sh = m.sheet, s = mkt();
  let p = null, title = "", body = "", confirm = "", confirmColor = C.turf, extra = "";
  if(sh.kind === "list"){
    p = M.card(sh.id); if(!p) return "";
    const b = M.listBounds(p), step = Math.max(5, Math.round(b.value / 20 / 5) * 5);
    const price = Math.min(b.max, Math.max(b.min, sh.price || b.value));
    const f = M.fee(price);
    title = "List on the transfer market";
    body = `<div class="mgrPrice">
        <button class="mgrStep scrimtap" data-mgr="mprice" data-v="${-step}">−</button>
        <div class="mgrPriceNum"><b>${fmt(price)}</b><span>GEMS</span></div>
        <button class="mgrStep scrimtap" data-mgr="mprice" data-v="${step}">+</button>
      </div>
      <div class="mgrChips" style="justify-content:center">
        ${[[1,"VALUE"],[1.5,"×1.5"],[2,"×2"],[3,"×3"]].map(([k, l]) => `<button class="mgrChip scrimtap" data-mgr="mpreset" data-v="${k}">${l}</button>`).join("")}
      </div>
      <div class="mgrSum"><span>Value</span><b>${fmt(b.value)}</b></div>
      <div class="mgrSum"><span>Market fee (5%)</span><b style="color:${C.danger}">−${fmt(f)}</b></div>
      <div class="mgrSum mgrSumTotal"><span>You receive when it sells</span><b style="color:${C.turf}">${fmt(price - f)}</b></div>
      <div style="font-size:10px;color:${C.muted};text-align:center;margin-top:6px">Allowed: ${fmt(b.min)} to ${fmt(b.max)}. The player leaves your squad list while listed; cancel any time to get them back.</div>`;
    confirm = busyIs("list:" + p.id) ? "LISTING…" : "LIST FOR " + fmt(price); confirmColor = C.cyan;
  } else if(sh.kind === "quick"){
    p = M.card(sh.id); if(!p) return "";
    const qs = M.quickSellPrice(M.cardValue(p));
    title = "Sell to the club";
    body = `<div style="text-align:center;font-size:13px;color:${C.cream}">You get <b style="color:${C.gold}">${fmt(qs)} gems</b> right now.</div>
      <div style="text-align:center;font-size:11px;color:${C.muted};margin-top:4px">Listing them could earn up to ${fmt(M.cardValue(p) * 5 - M.fee(M.cardValue(p) * 5))}. This can't be undone.</div>`;
    confirm = busyIs("sell:" + p.id) ? "SELLING…" : "SELL FOR " + fmt(qs); confirmColor = C.gold;
  } else if(sh.kind === "buy"){
    const l = (s.listings || []).find(x => x.id === sh.id); if(!l) return "";
    p = M.card(l.card_id); if(!p) return "";
    title = "Buy from " + (l.seller_name || "a manager");
    body = `<div style="text-align:center;font-size:13px;color:${C.cream}">Pay <b style="color:${C.gold}">${fmt(l.price)} gems</b>${l.level ? `, trained to level ${l.level}` : ""}.</div>
      <div style="text-align:center;font-size:11px;color:${C.muted};margin-top:4px">You have ${fmt(S.gems)}. You'll have ${fmt(S.gems - l.price)} left.</div>`;
    confirm = busyIs("buy:" + l.id) ? "BUYING…" : "BUY FOR " + fmt(l.price);
  } else if(sh.kind === "scout"){
    const o = (s.scout || []).find(x => x.card_id === sh.id); p = M.card(sh.id); if(!o || !p) return "";
    title = "Sign from the scouting report";
    body = `<div style="text-align:center;font-size:13px;color:${C.cream}">Pay <b style="color:${C.gold}">${fmt(o.price)} gems</b>.</div>
      <div style="text-align:center;font-size:11px;color:${C.muted};margin-top:4px">You have ${fmt(S.gems)}. You'll have ${fmt(S.gems - o.price)} left.</div>`;
    confirm = busyIs("scout:" + p.id) ? "SIGNING…" : "SIGN FOR " + fmt(o.price); confirmColor = C.gold;
  } else return "";
  if(m.sheetError) extra = `<div class="mgrErr">${T.esc(m.sheetError)}</div>`;
  const anim = !!m.sheetAnim; m.sheetAnim = false;   // slide in once, not on every +/- tap
  return `<div class="mgrSheetWrap${anim ? " mgrSheetIn" : ""}" data-mgr="mclose">
      <div class="mgrSheet" data-mgr="noop">
        <div class="mgrSheetTitle">${T.esc(title)}</div>
        <div class="mgrSheetCard">${T.playerCard(p, { mode:"showcase" })}</div>
        <div class="mgrSheetName">${T.esc(p.name)}</div>
        ${body}${extra}
        <button class="mgrBtn mgrBtnWide scrimtap" data-mgr="mconfirm" style="margin-top:14px;background:${confirmColor};color:${C.bg}">${confirm}</button>
        <button class="mgrBtn mgrBtnWide scrimtap" data-mgr="mclose" style="margin-top:8px;background:transparent;color:${C.muted}">NOT NOW</button>
      </div>
    </div>`;
}

function marketSection(T){
  const C = T.COLORS, S = window.state, m = mgr(), s = mkt();
  // First visit (and after 15 s): fetch. Deferred so render() is never re-entered.
  if(window.Market && (s.status === "idle" || (s.status === "ready" && Date.now() - s.loadedAt > 15000)))
    setTimeout(() => window.Market.load(), 0);
  const activeMine = (s.mine || []).filter(x => x.status === "active").length;
  const sub = m.market === "sell" ? sellTab(T) : m.market === "mine" ? mineTab(T) : buyTab(T);
  return `${marketNote(T)}
    <div class="mgrTabs" style="margin-bottom:10px">
      <button class="mgrTab scrimtap${m.market==="buy"?" on":""}" data-mgr="market" data-v="buy">BUY</button>
      <button class="mgrTab scrimtap${m.market==="sell"?" on":""}" data-mgr="market" data-v="sell">SELL</button>
      <button class="mgrTab scrimtap${m.market==="mine"?" on":""}" data-mgr="market" data-v="mine">MY LISTINGS${activeMine ? ` (${activeMine})` : ""}</button>
    </div>
    ${sub}`;
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
  return `<div class="view">${header(T)}${tabs()}${body}${sheetHTML(T)}</div>`;
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
function toast(msg){ if(typeof window.showToast === "function") window.showToast(msg); }
function runSheet(){
  const m = mgr(), sh = m.sheet, M = window.Market;
  if(!sh || !M) return;
  const p = sh.kind === "buy" ? null : M.card(sh.id);
  let job;
  if(sh.kind === "list") {
    const b = M.listBounds(p), price = Math.min(b.max, Math.max(b.min, sh.price || b.value));
    job = M.list(sh.id, price).then(r => r.error ? r : (toast(`${p.name} is on the market for ${fmt(price)} gems`), m.market = "mine", r));
  } else if(sh.kind === "quick") {
    const qs = M.quickSellPrice(M.cardValue(p));
    job = M.quickSell(sh.id).then(r => r.error ? r : (toast(`Sold ${p.name} for ${fmt(qs)} gems`), r));
  } else if(sh.kind === "buy") {
    const l = (M.state().listings || []).find(x => x.id === sh.id), bp = l && M.card(l.card_id);
    job = M.buy(sh.id).then(r => r.error ? r : (toast(`${bp ? bp.name : "Player"} joined your club!`), celebrate(bp), r));
  } else if(sh.kind === "scout") {
    job = M.buyScout(sh.id).then(r => r.error ? r : (toast(`${p.name} signed from the scouting report!`), celebrate(p), r));
  } else return;
  m.sheetError = "";
  window.render();
  job.then(r => {
    if(r && r.error){ m.sheetError = r.error; if(window.playLose) window.playLose(); }
    else { m.sheet = null; if(window.playWin) window.playWin(); }
    window.render();
  });
}
// A signing is a moment -- open the new player's card, as a pack reveal would.
function celebrate(p){
  if(!p) return;
  setTimeout(() => { window.state.enlargedCardId = p.id; window.render(); }, 250);
}

document.getElementById("stage").addEventListener("click", function(e){
  const el = e.target.closest("[data-mgr]");
  if(!el) return;
  const m = mgr(), kind = el.dataset.mgr, v = el.dataset.v, M = window.Market;
  if(kind === "noop") return;
  if(kind === "tab") { m.tab = v; m.scoutShown = false; }
  else if(kind === "pos") m.pos = v;
  else if(kind === "market") { m.market = v; m.focus = null; m.scoutShown = false; }
  else if(kind === "msort") m.sort = v;
  else if(kind === "mreload") { if(M) M.load(true); }
  else if(kind === "mask") { m.sheet = { kind: el.dataset.kind, id: Number(v) }; m.sheetError = ""; m.sheetAnim = true; }
  else if(kind === "mlistopen") {
    const p = M && M.card(v); if(!p) return;
    m.sheet = { kind: "list", id: p.id, price: M.cardValue(p) }; m.sheetError = ""; m.sheetAnim = true;
  }
  else if(kind === "mprice" && m.sheet) {
    const b = M.listBounds(M.card(m.sheet.id));
    m.sheet.price = Math.min(b.max, Math.max(b.min, (m.sheet.price || b.value) + Number(v)));
  }
  else if(kind === "mpreset" && m.sheet) {
    const b = M.listBounds(M.card(m.sheet.id));
    m.sheet.price = Math.min(b.max, Math.max(b.min, Math.round(b.value * Number(v) / 5) * 5));
  }
  else if(kind === "mconfirm") { runSheet(); return; }
  else if(kind === "mcancel") {
    const l = M && (M.state().mine || []).find(x => x.id === Number(v)), p = l && M.card(l.card_id);
    M.cancel(v).then(r => { if(r.error) toast(r.error); else toast(`${p ? p.name : "Player"} is back in your collection`); });
  }
  else if(kind === "mclose") { m.sheet = null; m.sheetError = ""; }
  // From the card popup: "Sell on the transfer market" jumps straight to the card.
  else if(kind === "goto-sell") {
    m.tab = "market"; m.market = "sell"; m.pos = "ALL"; m.focus = Number(v); m.focusShown = false;
    window.state.enlargedCardId = null; window.state.tab = "manager";
    setTimeout(() => { const r = document.querySelector('[data-mgr-row="' + Number(v) + '"]'); if(r) r.scrollIntoView({ block: "center", behavior: "smooth" }); }, 60);
  }
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
