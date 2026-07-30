// TCG Manager -- 3D match: the on-screen interface.
//
// Owns every DOM element layered over the WebGL canvas: scoreboard, clock,
// commentary toasts, goal banners, the on-screen controls, pause sheet and
// title cards. Split out of match3d.js so the interface can be reworked
// without touching simulation or rendering code.
//
// Notes for anyone changing this:
//  * This DOM lives in a fixed overlay appended to document.body, NOT inside
//    #stage. index.html's render() does `stage.innerHTML = appHTML()` on every
//    state change and would otherwise wipe the canvas and its GL context.
//  * Control widgets are CREATED here but their handlers are bound in
//    match3d.js -- it owns input state. Any new button must be exposed on the
//    returned `el` map so the core can wire it up.
//  * Target is a phone in portrait. Respect safe-area insets, keep touch
//    targets >= 44px, and never put a control where a thumb covers the ball.
//
// Contract used by match3d.js -- keep these stable:
//   H.build(ctx) -> { root, el }   ctx: { canvas, myName, myColor, oppName, oppColor }
//   H.toast(a, msg, ms) / H.banner(a, text, color, ms) / H.titleCard(a, title, sub, ms)
//   H.setScore(a, my, opp) / H.setClock(a, half, minute)
// `a` is the live match instance; `a.el` is the element map from build().
"use strict";

(function () {
  const H = {};

  function h(tag, style, html) {
    const e = document.createElement(tag);
    if (style) e.setAttribute("style", style);
    if (html != null) e.innerHTML = html;
    return e;
  }
  H.h = h;

  H.build = function (ctx) {
    const el = {};
    const root = h("div",
      "position:fixed;inset:0;z-index:9000;background:#060A12;" +
      "touch-action:none;-webkit-user-select:none;user-select:none;overflow:hidden;" +
      "font-family:'Outfit',system-ui,sans-serif");

    root.appendChild(ctx.canvas);
    ctx.canvas.setAttribute("style", "position:absolute;inset:0;width:100%;height:100%;display:block");

    // --- top scoreboard
    const bar = h("div",
      "position:absolute;top:0;left:0;right:0;padding:calc(env(safe-area-inset-top,0px) + 8px) 10px 8px;" +
      "display:flex;align-items:center;justify-content:center;gap:10px;pointer-events:none;" +
      "background:linear-gradient(180deg,rgba(6,10,18,.86),rgba(6,10,18,0))");
    const chip = (color, name) => h("div",
      "display:flex;align-items:center;gap:6px;min-width:0",
      '<span style="width:10px;height:10px;border-radius:3px;flex:0 0 auto;background:' + color + '"></span>' +
      '<span style="font-size:11px;font-weight:800;color:#F3F6FA;white-space:nowrap;overflow:hidden;' +
      'text-overflow:ellipsis;max-width:23vw">' + name + "</span>");
    bar.appendChild(chip(ctx.myColor, ctx.myName));
    el.score = h("div",
      "font-family:'Teko',sans-serif;font-size:30px;line-height:1;font-weight:700;color:#fff;" +
      "letter-spacing:.04em;padding:0 4px;text-shadow:0 2px 10px rgba(0,0,0,.6)", "0 - 0");
    bar.appendChild(el.score);
    bar.appendChild(chip(ctx.oppColor, ctx.oppName));
    root.appendChild(bar);

    el.clock = h("div",
      "position:absolute;top:calc(env(safe-area-inset-top,0px) + 44px);left:50%;transform:translateX(-50%);" +
      "font-size:11px;font-weight:800;letter-spacing:.14em;color:#FFB020;pointer-events:none;" +
      "text-shadow:0 1px 6px rgba(0,0,0,.8)", "1ST HALF &middot; 0'");
    root.appendChild(el.clock);

    el.toast = h("div",
      "position:absolute;top:calc(env(safe-area-inset-top,0px) + 68px);left:50%;transform:translateX(-50%);" +
      "max-width:86vw;text-align:center;font-size:13px;font-weight:800;color:#F3F6FA;pointer-events:none;" +
      "opacity:0;transition:opacity .25s ease;text-shadow:0 2px 8px rgba(0,0,0,.9)");
    root.appendChild(el.toast);

    el.banner = h("div",
      "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
      "pointer-events:none;opacity:0;transition:opacity .2s ease");
    el.bannerText = h("div",
      "font-family:'Teko',sans-serif;font-size:14vw;font-weight:700;letter-spacing:.06em;color:#fff;" +
      "text-shadow:0 6px 30px rgba(0,0,0,.8)");
    el.banner.appendChild(el.bannerText);
    root.appendChild(el.banner);

    el.nameplate = h("div",
      "position:absolute;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 148px);" +
      "transform:translateX(-50%);pointer-events:none;font-size:11px;font-weight:800;color:#F3F6FA;" +
      "background:rgba(6,10,18,.55);border:1px solid rgba(255,255,255,.14);border-radius:999px;" +
      "padding:3px 10px;white-space:nowrap");
    root.appendChild(el.nameplate);

    // --- joystick (left thumb); base re-centres wherever the thumb lands
    el.stickBase = h("div",
      "position:absolute;left:22px;bottom:calc(env(safe-area-inset-bottom,0px) + 26px);" +
      "width:124px;height:124px;border-radius:50%;background:rgba(255,255,255,.07);" +
      "border:1px solid rgba(255,255,255,.16);pointer-events:none");
    el.stickKnob = h("div",
      "position:absolute;left:50%;top:50%;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;" +
      "background:rgba(243,246,250,.34);border:1px solid rgba(255,255,255,.4);" +
      "transition:transform .04s linear");
    el.stickBase.appendChild(el.stickKnob);
    root.appendChild(el.stickBase);

    // --- action buttons (right thumb)
    const mkBtn = (label, sub, color, bottom, right, size) => h("div",
      "position:absolute;right:" + right + "px;bottom:calc(env(safe-area-inset-bottom,0px) + " + bottom + "px);" +
      "width:" + size + "px;height:" + size + "px;border-radius:50%;display:flex;flex-direction:column;" +
      "align-items:center;justify-content:center;gap:1px;background:" + color + "33;border:2px solid " + color + ";" +
      "color:" + color + ";font-weight:900;font-size:" + (size > 74 ? 15 : 13) + "px;letter-spacing:.06em;" +
      "box-shadow:0 4px 18px rgba(0,0,0,.45);cursor:pointer",
      label + (sub ? '<span style="font-size:8px;opacity:.75;font-weight:800">' + sub + "</span>" : ""));
    el.btnShoot = mkBtn("SHOOT", "hold=power", "#FB5A5A", 96, 22, 86);
    el.btnPass = mkBtn("PASS", "", "#2FD180", 30, 118, 70);
    el.btnSprint = mkBtn("RUN", "", "#FFB020", 34, 26, 62);
    root.appendChild(el.btnShoot);
    root.appendChild(el.btnPass);
    root.appendChild(el.btnSprint);

    el.powerRing = h("div",
      "position:absolute;right:14px;bottom:calc(env(safe-area-inset-bottom,0px) + 88px);" +
      "width:102px;height:102px;border-radius:50%;pointer-events:none;opacity:0;transition:opacity .12s ease;" +
      "border:3px solid transparent");
    root.appendChild(el.powerRing);

    // --- pause / bail-out
    el.pause = h("div",
      "position:absolute;top:calc(env(safe-area-inset-top,0px) + 8px);right:10px;width:34px;height:34px;" +
      "border-radius:10px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);" +
      "display:flex;align-items:center;justify-content:center;color:#F3F6FA;font-size:13px;font-weight:900;" +
      "cursor:pointer;z-index:2", "II");
    root.appendChild(el.pause);

    el.pauseSheet = h("div",
      "position:absolute;inset:0;background:rgba(6,10,18,.86);display:none;flex-direction:column;" +
      "align-items:center;justify-content:center;gap:12px;z-index:3;padding:24px;text-align:center");
    el.pauseSheet.appendChild(h("div",
      "font-family:'Teko',sans-serif;font-size:44px;color:#fff;line-height:1", "PAUSED"));
    el.pauseSheet.appendChild(h("div", "font-size:12px;color:#6C84A3;max-width:280px;line-height:1.5",
      "Left thumb steers. PASS finds a teammate, hold SHOOT for power. " +
      "You always control the player nearest the ball."));
    el.resumeBtn = h("div",
      "margin-top:6px;padding:12px 30px;border-radius:14px;background:#2FD180;color:#080F1A;" +
      "font-weight:900;font-size:15px;cursor:pointer", "RESUME");
    el.quitBtn = h("div",
      "padding:9px 22px;border-radius:12px;border:1px solid #FB5A5A66;color:#FB5A5A;" +
      "font-weight:800;font-size:12px;cursor:pointer", "FORFEIT MATCH");
    el.pauseSheet.appendChild(el.resumeBtn);
    el.pauseSheet.appendChild(el.quitBtn);
    root.appendChild(el.pauseSheet);

    // --- kickoff / half title card
    el.card = h("div",
      "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;" +
      "background:rgba(6,10,18,.72);pointer-events:none;gap:6px;z-index:2");
    el.cardTitle = h("div", "font-family:'Teko',sans-serif;font-size:12vw;line-height:1;color:#fff", "");
    el.cardSub = h("div", "font-size:12px;font-weight:800;letter-spacing:.14em;color:#FFB020", "");
    el.card.appendChild(el.cardTitle);
    el.card.appendChild(el.cardSub);
    root.appendChild(el.card);

    return { root, el };
  };

  H.toast = function (a, msg, ms) {
    a.el.toast.innerHTML = msg;
    a.el.toast.style.opacity = "1";
    clearTimeout(a.toastTimer);
    a.toastTimer = setTimeout(() => { a.el.toast.style.opacity = "0"; }, ms || 1900);
  };

  H.banner = function (a, text, color, ms) {
    a.el.bannerText.textContent = text;
    a.el.bannerText.style.color = color || "#fff";
    a.el.banner.style.opacity = "1";
    clearTimeout(a.bannerTimer);
    a.bannerTimer = setTimeout(() => { a.el.banner.style.opacity = "0"; }, ms || 1400);
  };

  H.titleCard = function (a, title, sub, ms) {
    a.el.cardTitle.textContent = title;
    a.el.cardSub.textContent = sub || "";
    a.el.card.style.display = "flex";
    clearTimeout(a.cardTimer);
    if (ms) a.cardTimer = setTimeout(() => { a.el.card.style.display = "none"; }, ms);
  };

  H.setScore = function (a, my, opp) { a.el.score.textContent = my + " - " + opp; };
  H.setClock = function (a, half, minute) {
    a.el.clock.innerHTML = (half === 1 ? "1ST HALF" : "2ND HALF") + " &middot; " + minute + "'";
  };

  window.Match3DHud = H;
})();
