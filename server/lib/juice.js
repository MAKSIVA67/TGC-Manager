// TCG Manager -- "juice": the small motions that make the game feel alive.
//
//   1. Holographic tilt on the card popup: the card follows your finger in 3D
//      and a glare slides across it (CSS in index.html, .tilt*).
//   2. The gem counter counts up or down instead of jumping, and pulses green
//      or red with the direction of the change.
//
// Rules this file keeps, because the app has to stay smooth on a phone:
//   * Only CSS custom properties and classes are written, on the one element
//     being touched; everything visible moves by transform/opacity.
//   * Pointer moves are coalesced into one update per animation frame.
//   * Nothing holds on to DOM nodes across renders -- render() rebuilds #stage
//     on every state change, so elements are looked up fresh each time.
//   * prefers-reduced-motion switches the tilt and the counting off.
"use strict";
(function(){

var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
var stage = document.getElementById("stage");

// ---------------------------------------------------------------- tilt
var active = null, pending = null, raf = 0;
function apply(){
  raf = 0;
  if(!pending) return;
  var el = pending.el, px = pending.px, py = pending.py; pending = null;
  var card = el.querySelector(".tiltCard");
  if(!card) return;
  // px/py are 0..1 across the card. Up to ~11 degrees each way: enough to
  // feel physical, not so much that the text becomes hard to read.
  card.style.setProperty("--rx", ((0.5 - py) * 20).toFixed(2) + "deg");
  card.style.setProperty("--ry", ((px - 0.5) * 24).toFixed(2) + "deg");
  card.style.setProperty("--ts", "1.03");
  card.style.setProperty("--gx", ((px - 0.5) * 60).toFixed(1) + "%");
  card.style.setProperty("--gy", ((py - 0.5) * 60).toFixed(1) + "%");
  card.style.setProperty("--go", "0.75");
  card.style.setProperty("--hx", ((px - 0.5) * 36).toFixed(1) + "%");
  card.style.setProperty("--ho", (0.12 + Math.abs(px - 0.5) * 0.36).toFixed(2));   // subtle: strong colour-dodge tints the whole card
}
function release(el){
  if(!el) return;
  el.classList.remove("tilting");
  var card = el.querySelector(".tiltCard");
  if(card) ["--rx","--ry","--ts","--gx","--gy","--go","--hx","--ho"].forEach(function(k){ card.style.removeProperty(k); });
}
function onMove(e){
  if(reduce) return;
  var el = e.target.closest && e.target.closest("[data-tilt]");
  if(el !== active){ release(active); active = el; if(el) el.classList.add("tilting"); }
  if(!el) return;
  var r = el.getBoundingClientRect();
  if(!r.width || !r.height) return;
  pending = { el: el,
    px: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    py: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  if(!raf) raf = requestAnimationFrame(apply);
}
function onEnd(e){
  if(!active) return;
  // A finger lifting ends the tilt; a mouse only when it leaves the card.
  if(e.type === "pointerout" && e.relatedTarget && active.contains(e.relatedTarget)) return;
  release(active); active = null;
}
stage.addEventListener("pointermove", onMove, { passive: true });
stage.addEventListener("pointerdown", onMove, { passive: true });
stage.addEventListener("pointerup", function(e){ if(e.pointerType !== "mouse") onEnd(e); });
stage.addEventListener("pointercancel", onEnd);
stage.addEventListener("pointerout", function(e){ if(e.pointerType === "mouse") onEnd(e); });

// ---------------------------------------------------------------- gems
// The number on screen chases state.gems over ~0.7 s. render() may rebuild the
// header mid-count, so every frame re-finds the .gemCount elements and writes
// the current value into whichever ones exist now.
var shown = null, tween = null, settledAt = 0;
function ease(t){ return 1 - Math.pow(1 - t, 3); }
function paint(value, cls){
  var els = document.querySelectorAll(".gemCount");
  for(var i = 0; i < els.length; i++){
    els[i].textContent = String(value);
    if(cls && !els[i].classList.contains(cls)){ els[i].classList.remove("gemUp","gemDown"); els[i].classList.add(cls); }
  }
}
function tick(now){
  if(!tween) return;
  var t = Math.min(1, (now - tween.start) / tween.dur);
  var v = Math.round(tween.from + (tween.to - tween.from) * ease(t));
  paint(v, tween.to > tween.from ? "gemUp" : "gemDown");
  if(t < 1) { requestAnimationFrame(tick); return; }
  shown = tween.to; tween = null;
  setTimeout(function(){ if(!tween){ var els = document.querySelectorAll(".gemCount"); for(var i=0;i<els.length;i++) els[i].classList.remove("gemUp","gemDown"); } }, 450);
}
function afterRender(){
  var s = window.state;
  if(!s || !s.authReady || typeof s.gems !== "number") return;
  // The first few seconds after sign-in are loading, not a change: jump.
  if(shown === null || !settledAt){ shown = s.gems; settledAt = settledAt || Date.now(); return; }
  if(Date.now() - settledAt < 3000){ shown = s.gems; return; }
  if(reduce){ shown = s.gems; return; }
  if(tween){
    if(tween.to !== s.gems){                     // retarget mid-count
      var now = performance.now(), t = Math.min(1, (now - tween.start) / tween.dur);
      tween = { from: Math.round(tween.from + (tween.to - tween.from) * ease(t)), to: s.gems, start: now, dur: 700 };
    }
    // The rebuilt header was written with the final number; put the running
    // count back so it doesn't flash ahead.
    var n2 = performance.now(), t2 = Math.min(1, (n2 - tween.start) / tween.dur);
    paint(Math.round(tween.from + (tween.to - tween.from) * ease(t2)), tween.to > tween.from ? "gemUp" : "gemDown");
    return;
  }
  if(s.gems !== shown){
    tween = { from: shown, to: s.gems, start: performance.now(), dur: Math.min(1100, 450 + Math.abs(s.gems - shown) / 8) };
    paint(shown, s.gems > shown ? "gemUp" : "gemDown");
    requestAnimationFrame(tick);
  }
}

// ---------------------------------------------------------------- sharp popup
// Grids use the 300 px thumbnail, which is right for a tile but soft when the
// popup shows the card at full width. Once the popup is open, fetch the full
// design and swap it in when it has loaded -- but only on a fast connection
// without Data Saver, because the originals are about 2.4 MB each.
function fastNet(){
  var c = navigator.connection;
  if(!c) return true;
  if(c.saveData) return false;
  return !c.effectiveType || c.effectiveType === "4g";
}
var upgrading = {};
function sharpenPopup(){
  var s = window.state; if(!s || s.enlargedCardId == null || !fastNet()) return;
  var p = (s.players || []).find(function(x){ return x.id === s.enlargedCardId; });
  if(!p || !p.imageUrl || p.imageUrl === p.imageThumbUrl) return;
  var img = document.querySelector("#cardModalSlot .tiltCard img");
  if(!img || img.getAttribute("src") === p.imageUrl) return;
  var url = p.imageUrl;
  var swap = function(){ var now = document.querySelector("#cardModalSlot .tiltCard img"); if(now && window.state.enlargedCardId === p.id) now.src = url; };
  if(upgrading[url] === "done") { swap(); return; }
  if(upgrading[url]) return;
  upgrading[url] = "loading";
  var pre = new Image();
  pre.onload = function(){ upgrading[url] = "done"; swap(); };
  pre.onerror = function(){ delete upgrading[url]; };
  pre.src = url;
}
window.afterCardModal = sharpenPopup;

// Chain rather than replace, in case anything else hooks renders later.
var prev = window.afterRender;
window.afterRender = function(){ if(prev) prev(); afterRender(); sharpenPopup(); };

})();
