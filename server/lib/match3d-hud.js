// TCG Manager -- 3D match: the on-screen interface.
//
// Owns every DOM element layered over the WebGL canvas: the broadcast
// scoreboard, match clock, radar, commentary toasts, goal celebrations, the
// on-screen controls, pause sheet and match-flow title cards. Split out of
// match3d.js so the interface can be reworked without touching simulation or
// rendering code.
//
// Notes for anyone changing this:
//  * This DOM lives in a fixed overlay appended to document.body, NOT inside
//    #stage. index.html's render() does `stage.innerHTML = appHTML()` on every
//    state change and would otherwise wipe the canvas and its GL context.
//  * Control widgets are CREATED here but their handlers are bound in
//    match3d.js -- it owns input state. Any new button must be exposed on the
//    returned `el` map so the core can wire it up.
//  * Target is a phone in portrait. Respect safe-area insets, keep touch
//    targets >= 44px, and never put a control where a thumb covers the ball:
//    the two bottom corners are the only safe places for controls.
//  * Everything sits over a 60fps canvas, so motion is transform/opacity only
//    (via the Web Animations API, which needs no stylesheet) and nothing
//    reads layout in a loop. Deliberately no backdrop-filter: blurring a
//    surface that is repainted every frame forces a GPU readback per frame.
//
// Contract used by match3d.js -- keep these stable:
//   H.build(ctx) -> { root, el }   ctx: { canvas, myName, myColor, oppName, oppColor }
//   H.toast(a, msg, ms) / H.banner(a, text, color, ms) / H.titleCard(a, title, sub, ms)
//   H.setScore(a, my, opp) / H.setClock(a, half, minute)
// Optional extras the core may call (all no-ops if it doesn't):
//   H.setMode(a, "attack"|"defend")   swaps the right-hand button cluster
//   H.updateRadar(a, data)            data: { players:[{x,z,team,controlled}], ball:{x,z} }
//   H.flash(a, color, ms) / H.hideHint(a)
//   H.setMentality(a, idx)            lights the tactics chip for MENTALITY[idx]
//   H.setOppMentality(a, idx)         shows what shape the opposition switched to
//   H.SHAPES                          the mentality display table (order must
//                                     match MENTALITY[] in match3d.js)
// `a` is the live match instance; `a.el` is the element map from build().
"use strict";

(function () {
  const H = {};

  // App palette, kept in one place so every widget agrees.
  const C = {
    bg: "#080F1A", panel: "#132234", panel2: "#1C3348",
    turf: "#2FD180", gold: "#FFB020", pink: "#E14F8A", cyan: "#2FB6D9",
    cream: "#F3F6FA", muted: "#6C84A3", danger: "#FB5A5A",
  };
  const ST = "env(safe-area-inset-top,0px)";
  const SB = "env(safe-area-inset-bottom,0px)";
  const DISPLAY = "'Teko',system-ui,sans-serif";

  // Pitch dimensions, mirrored from match3d.js -- only used for radar mapping.
  const PITCH_W = 68, PITCH_L = 105;

  function h(tag, style, html) {
    const e = document.createElement(tag);
    if (style) e.setAttribute("style", style);
    if (html != null) e.innerHTML = html;
    return e;
  }
  H.h = h;

  // WAAPI wrapper: keeps pops/entrances off the stylesheet (none exists) and
  // on the compositor. Silently degrades where animate() is missing.
  function anim(node, frames, opts) {
    if (!node || !node.animate) return null;
    try { return node.animate(frames, opts); } catch (e) { return null; }
  }

  function ic(body, size) {
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
      'style="display:block;pointer-events:none">' + body + "</svg>";
  }
  const ICON = {
    shoot: '<circle cx="14" cy="12" r="6"/><path d="M2.5 8h4M1.5 12h4M2.5 16h4"/>',
    pass: '<path d="M4 12h13"/><path d="M12 7l5 5-5 5"/>',
    through: '<path d="M3 18c3.5-8.5 11.5-11 18-9"/><path d="M16.4 4.4 21 9l-4.8 2.6"/>',
    skill: '<path d="M12 3.4l2.2 5.2 5.4.5-4.1 3.7 1.2 5.4L12 15.4 7.3 18.2l1.2-5.4-4.1-3.7 5.4-.5z"/>',
    sprint: '<path d="M5 6l5 6-5 6M12 6l5 6-5 6"/>',
    tackle: '<path d="M12 3.2l7 2.5v5.4c0 4.6-3 7.2-7 9.7-4-2.5-7-5.1-7-9.7V5.7z"/><path d="M9.2 12.1l2 2.1 3.8-4.2"/>',
    swap: '<path d="M4 9h12l-3.4-3.4M20 15H8l3.4 3.4"/>',
    pause: '<path d="M9 5v14M15 5v14"/>',
  };

  // "Rival FC" -> "RIV", "AC Milan" -> "ACM". Broadcast boards never have room
  // for a full club name on a phone, and ellipsised names read as broken.
  function abbrev(name) {
    const words = String(name || "").toUpperCase().replace(/[^A-Z0-9 ]/g, "").split(/\s+/).filter(Boolean);
    if (!words.length) return "TBD";
    let out = words[0].slice(0, 3);
    for (let i = 1; i < words.length && out.length < 3; i++) out += words[i].slice(0, 3 - out.length);
    return out || "TBD";
  }

  // Team mentality, presentation side. The simulation owns the numbers and
  // passes an INDEX; this array owns what that index looks like, and the two
  // must stay in the same order as MENTALITY[] in match3d.js.
  // `top` is where the line sits in the little pitch glyph -- the whole point
  // of the glyph is that you can read "how high do we sit" without reading.
  const SHAPES = [
    { short: "DEF", name: "DEFENSIVE", color: C.cyan, top: 68 },
    { short: "BAL", name: "BALANCED", color: C.turf, top: 50 },
    { short: "ATT", name: "ATTACKING", color: C.gold, top: 32 },
    { short: "ALL-OUT", name: "ALL-OUT ATTACK", color: C.danger, top: 14 },
  ];
  H.SHAPES = SHAPES;

  // A 12x16 pitch with a line across it. currentColor so it re-tints for free
  // when the chip goes active.
  function shapeGlyph(top) {
    return '<span style="position:relative;display:block;width:11px;height:15px;flex:0 0 auto;' +
      'border-radius:2px;border:1px solid currentColor;opacity:.85">' +
      '<span style="position:absolute;left:1px;right:1px;top:' + top + '%;height:2px;' +
      'background:currentColor"></span></span>';
  }

  // Wraps a legend row so setControlMode can show only the rows describing
  // controls that are actually on screen. The note below about an incomplete
  // legend cuts both ways: a legend listing buttons that are NOT there is
  // worse still, because the player goes looking for them mid-match.
  function tag(schemes, html) {
    return "<div data-schemes=\"" + schemes + "\">" + html + "</div>";
  }

  function legendRow(color, label, text) {
    return '<div style="display:flex;align-items:center;gap:9px">' +
      '<span style="flex:0 0 auto;width:56px;text-align:center;padding:3px 0 4px;border-radius:7px;' +
      "background:" + color + "22;border:1px solid " + color + "66;color:" + color + ";" +
      'font-size:9px;font-weight:900;letter-spacing:.06em">' + label + "</span>" +
      '<span style="font-size:11.5px;color:#C7D4E4;line-height:1.35">' + text + "</span></div>";
  }

  H.build = function (ctx) {
    const el = {};
    // Private HUD state. Hung off `el` too so the public methods (which only
    // get `a`) can reach the same object the build-time closures use.
    const s = {
      myColor: ctx.myColor || C.turf, oppColor: ctx.oppColor || C.danger,
      myName: ctx.myName || "My Team", oppName: ctx.oppName || "Opponent",
      el: el, mode: "attack", modeExplicit: false, guess: null, guessRuns: 0,
      my: 0, opp: 0, radarOn: false, hintShown: false, poll: 0, timers: [],
    };
    el._hud = s;

    const root = h("div",
      "position:fixed;inset:0;z-index:9000;background:#060A12;" +
      "touch-action:none;overscroll-behavior:none;-webkit-user-select:none;user-select:none;" +
      "overflow:hidden;font-family:'Outfit',system-ui,sans-serif;" +
      "-webkit-tap-highlight-color:transparent");
    s.root = root;

    root.appendChild(ctx.canvas);
    ctx.canvas.setAttribute("style", "position:absolute;inset:0;width:100%;height:100%;display:block");

    // Scrims. The turf is bright green; without these the white HUD text and
    // the button outlines wash out completely at the top and bottom of frame.
    root.appendChild(h("div",
      "position:absolute;top:0;left:0;right:0;height:180px;pointer-events:none;z-index:1;" +
      "background:linear-gradient(180deg,rgba(4,8,14,.80),rgba(4,8,14,.30) 55%,rgba(4,8,14,0))"));
    root.appendChild(h("div",
      "position:absolute;bottom:0;left:0;right:0;height:250px;pointer-events:none;z-index:1;" +
      "background:linear-gradient(0deg,rgba(4,8,14,.72),rgba(4,8,14,.22) 55%,rgba(4,8,14,0))"));

    // ---------------------------------------------------------- scoreboard
    // Stacked in a full-width, non-interactive flex column: the board, the
    // clock module and the commentary toast can then never collide, whatever
    // length the strings are, and the board keeps a clean transform for pops.
    const topStack = h("div",
      "position:absolute;top:calc(" + ST + " + 8px);left:0;right:0;z-index:3;pointer-events:none;" +
      "display:flex;flex-direction:column;align-items:center");

    const board = h("div",
      "display:flex;align-items:stretch;height:38px;border-radius:10px;overflow:hidden;" +
      "background:linear-gradient(180deg,rgba(28,51,72,.97),rgba(11,20,33,.97));" +
      "border:1px solid rgba(255,255,255,.13);box-shadow:0 8px 22px rgba(0,0,0,.55)");
    s.board = board;

    const teamSide = (color, name, mine) => {
      const bar = '<span style="width:5px;align-self:stretch;flex:0 0 auto;background:' + color + ';' +
        "box-shadow:0 0 12px " + color + '99"></span>';
      const txt = '<span style="display:flex;align-items:center;padding:0 10px;font-family:' + DISPLAY + ";" +
        "font-size:23px;font-weight:600;letter-spacing:.05em;color:" + C.cream + ';">' + abbrev(name) + "</span>";
      return h("div", "display:flex;align-items:stretch", mine ? bar + txt : txt + bar);
    };
    board.appendChild(teamSide(s.myColor, s.myName, true));

    el.score = h("div",
      "display:flex;align-items:center;justify-content:center;min-width:66px;padding:0 6px;" +
      "background:rgba(0,0,0,.42);box-shadow:inset 0 0 0 1px rgba(255,255,255,.06);" +
      "font-family:" + DISPLAY + ";font-size:28px;font-weight:600;color:#fff;letter-spacing:.03em;" +
      "line-height:1;text-shadow:0 2px 8px rgba(0,0,0,.5)");
    board.appendChild(el.score);
    board.appendChild(teamSide(s.oppColor, s.oppName, false));
    topStack.appendChild(board);

    // Clock module hangs off the bottom edge of the board, TV-graphic style,
    // with a hairline showing how far through the 90 we are.
    const clockChip = h("div",
      "position:relative;display:flex;align-items:center;gap:8px;margin-top:-1px;padding:3px 13px 5px;" +
      "border-radius:0 0 10px 10px;background:rgba(11,20,33,.97);border:1px solid rgba(255,255,255,.13);" +
      "border-top:none;overflow:hidden;box-shadow:0 6px 14px rgba(0,0,0,.4)");
    el.clockHalf = h("span",
      "font-size:8.5px;font-weight:800;letter-spacing:.18em;color:" + C.muted, "1ST HALF");
    el.clock = h("span",
      "font-family:" + DISPLAY + ";font-size:17px;line-height:1;font-weight:600;color:" + C.gold +
      ";letter-spacing:.03em", "0'");
    el.clockBar = h("div",
      "position:absolute;left:0;bottom:0;height:2px;width:100%;transform:scaleX(0);" +
      "transform-origin:left center;background:linear-gradient(90deg," + C.gold + "," + C.pink + ")");
    clockChip.appendChild(el.clockHalf);
    clockChip.appendChild(h("span",
      "width:3px;height:3px;border-radius:50%;background:" + C.gold + ";opacity:.6"));
    clockChip.appendChild(el.clock);
    clockChip.appendChild(el.clockBar);
    topStack.appendChild(clockChip);

    // Commentary line. Capped at 62vw so it can never reach the radar sitting
    // at the top-left corner.
    el.toast = h("div",
      "margin-top:10px;max-width:62vw;display:flex;align-items:center;gap:7px;padding:5px 12px 6px;" +
      "border-radius:999px;background:rgba(10,17,28,.86);border:1px solid rgba(255,255,255,.10);" +
      "opacity:0;transition:opacity .22s ease;box-shadow:0 6px 18px rgba(0,0,0,.45)");
    topStack.appendChild(el.toast);
    root.appendChild(topStack);

    // ---------------------------------------------------------------- radar
    // A canvas, not DOM dots: it redraws ~20x a second and rebuilding elements
    // at that rate over a live GL canvas is exactly the thrash to avoid.
    // Hidden until the first data arrives, so it never shows as a dead box if
    // the core has no getRadar().
    el.radar = h("div",
      "position:absolute;left:12px;top:calc(" + ST + " + 62px);width:58px;height:88px;z-index:3;" +
      "border-radius:9px;overflow:hidden;pointer-events:none;opacity:0;transition:opacity .35s ease;" +
      "background:linear-gradient(180deg,rgba(9,26,20,.72),rgba(6,16,12,.72));" +
      "border:1px solid rgba(255,255,255,.14);box-shadow:0 6px 16px rgba(0,0,0,.45)");
    el.radarCanvas = h("canvas", "width:100%;height:100%;display:block");
    el.radar.appendChild(el.radarCanvas);
    root.appendChild(el.radar);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    s.rw = 58; s.rh = 88;
    el.radarCanvas.width = Math.round(s.rw * dpr);
    el.radarCanvas.height = Math.round(s.rh * dpr);
    s.rctx = el.radarCanvas.getContext ? el.radarCanvas.getContext("2d") : null;
    if (s.rctx) s.rctx.scale(dpr, dpr);

    // ------------------------------------------------------------- nameplate
    // Sits centred between the two thumb clusters, above both of them.
    const plateWrap = h("div",
      "position:absolute;left:0;right:0;bottom:calc(" + SB + " + 194px);z-index:3;pointer-events:none;" +
      "display:flex;flex-direction:column;align-items:center;gap:6px");
    el.modeChip = h("div",
      "padding:3px 12px 4px;border-radius:999px;font-size:9px;font-weight:900;letter-spacing:.16em;" +
      "opacity:0;transition:opacity .2s ease;background:rgba(10,17,28,.8);border:1px solid " + C.turf + ";" +
      "color:" + C.turf, "ATTACK");
    el.nameplate = h("div",
      "max-width:52vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
      "font-size:11px;font-weight:800;color:" + C.cream + ";background:rgba(10,17,28,.62);" +
      "border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:3px 11px 4px;" +
      "text-shadow:0 1px 4px rgba(0,0,0,.7)");
    plateWrap.appendChild(el.modeChip);
    plateWrap.appendChild(el.nameplate);
    root.appendChild(plateWrap);

    // -------------------------------------------------------------- joystick
    // Floating stick: the core re-parents the base under wherever the left
    // thumb lands (it offsets by half of 124px, so the size must stay 124).
    el.stickBase = h("div",
      "position:absolute;left:22px;bottom:calc(" + SB + " + 30px);width:124px;height:124px;" +
      "border-radius:50%;z-index:2;pointer-events:none;" +
      "background:radial-gradient(circle at 50% 50%,rgba(255,255,255,.10),rgba(255,255,255,.03) 70%);" +
      "border:1.5px solid rgba(255,255,255,.20);box-shadow:0 6px 20px rgba(0,0,0,.35)");
    el.stickKnob = h("div",
      "position:absolute;left:50%;top:50%;width:54px;height:54px;margin:-27px 0 0 -27px;border-radius:50%;" +
      "background:radial-gradient(circle at 50% 35%,rgba(255,255,255,.55),rgba(200,215,235,.28));" +
      "border:1.5px solid rgba(255,255,255,.55);box-shadow:0 3px 12px rgba(0,0,0,.45);" +
      "transition:transform .04s linear");
    el.stickBase.appendChild(el.stickKnob);
    root.appendChild(el.stickBase);

    // -------------------------------------------------------- action buttons
    // Right thumb only. Laid out as an arc rooted at the bottom-right corner
    // where the thumb rests; nothing sits left of 55% of the screen width,
    // which is the core's floating-stick zone. Attack and defend sets share
    // the same two big slots so muscle memory survives the swap.
    const mkBtn = (label, icon, color, size, right, bottom) => {
      const iconPx = size >= 90 ? 27 : size >= 70 ? 22 : size >= 56 ? 19 : 17;
      const fs = size >= 90 ? 13 : size >= 70 ? 11 : size >= 56 ? 9.5 : 9;
      const b = h("div",
        "position:absolute;right:" + right + "px;bottom:calc(" + SB + " + " + bottom + "px);" +
        "width:" + size + "px;height:" + size + "px;border-radius:50%;z-index:2;" +
        "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;" +
        "background:radial-gradient(circle at 50% 28%," + color + "4D," + color + "1A 72%),rgba(8,14,24,.55);" +
        "border:1.6px solid " + color + "CC;color:" + color + ";" +
        "box-shadow:0 6px 16px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.18);" +
        "font-weight:900;font-size:" + fs + "px;letter-spacing:.07em;cursor:pointer;touch-action:none;" +
        "transition:transform .08s ease,filter .08s ease",
        ic(icon, iconPx) + "<span>" + label + "</span>");
      // Press feedback only -- the core owns the actual input handling, so
      // these listeners never preventDefault or stop propagation.
      const dn = () => { b.style.transform = "scale(.92)"; b.style.filter = "brightness(1.35)"; };
      const up = () => { b.style.transform = ""; b.style.filter = ""; };
      b.addEventListener("pointerdown", dn);
      b.addEventListener("pointerup", up);
      b.addEventListener("pointercancel", up);
      b.addEventListener("pointerleave", up);
      root.appendChild(b);
      return b;
    };

    el.btnShoot = mkBtn("SHOOT", ICON.shoot, C.danger, 78, 20, 96);
    el.btnTackle = mkBtn("TACKLE", ICON.tackle, C.cyan, 78, 20, 96);
    el.btnPass = mkBtn("PASS", ICON.pass, C.turf, 60, 104, 46);
    el.btnSwitch = mkBtn("SWITCH", ICON.swap, C.cream, 60, 104, 46);
    el.btnThrough = mkBtn("THRU", ICON.through, C.gold, 54, 28, 186);
    el.btnSkill = mkBtn("SKILL", ICON.skill, C.pink, 48, 110, 132);
    el.btnSprint = mkBtn("RUN", ICON.sprint, C.gold, 54, 18, 28);

    // ---- simple scheme -------------------------------------------------
    // Maksim's brief: this should feel like a football manager, not FIFA.
    // Seven buttons is a console pad; most people will never learn it. The
    // simple scheme is ONE big button that says what it will do right now --
    // PASS when a team-mate is ahead of you, SHOOT when nobody is, TACKLE when
    // the other side has the ball. It sits in the SAME place whatever it says,
    // so the thumb never has to hunt for it. There is deliberately no separate
    // slide button: TACKLE already lunges by itself when you are close enough,
    // so a second control would only let the player get that decision wrong.
    el.btnPrimary = mkBtn("PASS", ICON.pass, C.turf, 96, 18, 92);

    // Charge ring, concentric with the SHOOT/TACKLE slot. The core writes
    // opacity / borderColor / transform on it, so nothing here may rely on a
    // transform of its own for positioning.
    el.powerRing = h("div",
      "position:absolute;right:10px;bottom:calc(" + SB + " + 86px);width:98px;height:98px;" +
      "border-radius:50%;pointer-events:none;z-index:2;opacity:0;transition:opacity .12s ease;" +
      "border:3px solid transparent;box-shadow:0 0 18px rgba(0,0,0,.35)");
    root.appendChild(el.powerRing);

    // ------------------------------------------------------ tactics selector
    // Bottom-centre: the one strip of screen neither thumb cluster uses (the
    // stick floats in the left 55%, the buttons hug the right edge). Four fixed
    // chips rather than a menu, because changing shape has to cost exactly one
    // tap and no pause -- opening a sheet mid-move is a goal conceded.
    // Sized for landscape: the whole module is ~60px tall, which at a 430px
    // viewport leaves the hint card and the nameplate clear above it.
    const tacWrap = h("div",
      "position:absolute;left:50%;bottom:calc(" + SB + " + 8px);transform:translateX(-50%);z-index:4;" +
      "display:flex;flex-direction:column;gap:4px;padding:5px 6px 6px;border-radius:13px;" +
      "background:linear-gradient(180deg,rgba(19,34,52,.90),rgba(9,16,26,.92));" +
      "border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 22px rgba(0,0,0,.5)");
    el.tactics = tacWrap;

    const tacHead = h("div",
      "display:flex;align-items:center;justify-content:space-between;gap:14px;padding:0 4px;" +
      "font-size:8px;font-weight:900;letter-spacing:.14em;white-space:nowrap");
    el.tacticName = h("div", "color:" + C.turf, "BALANCED");
    el.tacticOpp = h("div", "color:" + C.muted, "THEM · BALANCED");
    tacHead.appendChild(el.tacticName);
    tacHead.appendChild(el.tacticOpp);
    tacWrap.appendChild(tacHead);

    const tacRow = h("div", "display:flex;align-items:stretch;gap:4px");
    el.tacticBtns = [];
    for (let i = 0; i < SHAPES.length; i++) {
      const sh = SHAPES[i];
      const chip = h("div",
        "display:flex;align-items:center;justify-content:center;gap:6px;flex:0 0 auto;" +
        "height:36px;padding:0 10px;border-radius:10px;cursor:pointer;touch-action:none;" +
        "font-size:10px;font-weight:900;letter-spacing:.07em;" +
        "transition:background .14s ease,color .14s ease,border-color .14s ease," +
        "box-shadow .14s ease,transform .08s ease",
        shapeGlyph(sh.top) + "<span>" + sh.short + "</span>");
      // Visual press feedback only; match3d.js owns the actual binding.
      chip.addEventListener("pointerdown", () => { chip.style.transform = "scale(.94)"; });
      const rel = () => { chip.style.transform = ""; };
      chip.addEventListener("pointerup", rel);
      chip.addEventListener("pointercancel", rel);
      chip.addEventListener("pointerleave", rel);
      tacRow.appendChild(chip);
      el.tacticBtns.push(chip);
    }
    tacWrap.appendChild(tacRow);
    root.appendChild(tacWrap);

    // ------------------------------------------------------------ pause bug
    el.pause = h("div",
      "position:absolute;top:calc(" + ST + " + 10px);right:12px;width:40px;height:40px;z-index:4;" +
      "border-radius:12px;background:rgba(12,22,36,.82);border:1px solid rgba(255,255,255,.16);" +
      "display:flex;align-items:center;justify-content:center;color:" + C.cream + ";cursor:pointer;" +
      "box-shadow:0 6px 16px rgba(0,0,0,.45)", ic(ICON.pause, 18));
    root.appendChild(el.pause);

    // ----------------------------------------------------------- first-run hint
    // Floats above the control zone, never over it, and fades on its own so a
    // returning player is never blocked. pointer-events:none: play can start
    // mid-hint.
    // The offset is capped against viewport height, not fixed. The match is
    // played in landscape, where the screen is only ~430px tall -- a flat
    // 258px offset pushed this card off the top edge and straight over the
    // scoreboard. It stays clear of the controls horizontally (they hug the
    // left and right edges; this is centred and capped at 330px).
    el.hint = h("div",
      "position:absolute;left:0;right:0;bottom:calc(" + SB + " + min(258px, 24vh));z-index:2;" +
      "pointer-events:none;display:flex;justify-content:center;opacity:0;transition:opacity .4s ease");
    el.hint.appendChild(h("div",
      "width:84vw;max-width:330px;max-height:min(230px,54vh);overflow:hidden;" +
      "padding:13px 15px 15px;border-radius:16px;" +
      "background:linear-gradient(180deg,rgba(19,34,52,.94),rgba(9,16,26,.94));" +
      "border:1px solid rgba(255,255,255,.14);box-shadow:0 14px 34px rgba(0,0,0,.55);" +
      "display:flex;flex-direction:column;gap:8px",
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">' +
      '<span style="width:16px;height:2px;border-radius:2px;background:' + C.gold + '"></span>' +
      '<span style="font-size:10px;font-weight:900;letter-spacing:.2em;color:' + C.gold + '">HOW TO PLAY</span>' +
      "</div>" +
      // Every button on screen gets a line. An incomplete legend is worse than
      // none -- players assume the controls they weren't told about don't exist.
      tag("pro simple", legendRow(C.cream, "DRAG", "Left half of the screen steers. Aim with it too")) +
      tag("simple", legendRow(C.turf, "ACTION", "One button. It says what it will do: pass, shoot or tackle")) +
      tag("pro", legendRow(C.danger, "SHOOT", "Hold to charge power, release to strike")) +
      tag("pro", legendRow(C.turf, "PASS", "Tap to find the best-placed teammate")) +
      tag("pro", legendRow(C.gold, "THRU", "Slide a pass into space behind the defence")) +
      tag("pro", legendRow(C.pink, "SKILL", "Burst past your marker")) +
      tag("pro simple", legendRow(C.gold, "RUN", "Hold to sprint")) +
      tag("auto", legendRow(C.turf, "WATCH", "Your team plays itself. Sit back and manage")) +
      tag("pro simple auto", legendRow(C.cyan, "SHAPE", "Change tactics any time — no pause needed"))));
    root.appendChild(el.hint);

    // --------------------------------------------------------------- banner
    el.banner = h("div",
      "position:absolute;inset:0;z-index:5;display:flex;align-items:center;justify-content:center;" +
      "pointer-events:none;opacity:0;transition:opacity .2s ease");
    const bannerWrap = h("div",
      "position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:118px");
    el.bannerRibbon = h("div",
      "position:absolute;left:-6%;right:-6%;top:50%;height:76px;margin-top:-38px;transform:skewY(-3deg);" +
      "border-top:1px solid rgba(255,255,255,.22);border-bottom:1px solid rgba(255,255,255,.22)");
    el.bannerText = h("div",
      "position:relative;font-family:" + DISPLAY + ";font-size:min(17vw,96px);line-height:1;font-weight:700;" +
      "letter-spacing:.05em;color:#fff;text-shadow:0 6px 30px rgba(0,0,0,.85)");
    bannerWrap.appendChild(el.bannerRibbon);
    bannerWrap.appendChild(el.bannerText);
    el.banner.appendChild(bannerWrap);
    root.appendChild(el.banner);

    // Full-screen edge glow used for goals and possession swings. A vignette
    // rather than a full wash so it never hides the ball.
    el.flash = h("div",
      "position:absolute;inset:0;z-index:6;pointer-events:none;opacity:0");
    root.appendChild(el.flash);
    // Confetti host: goal chips are created and destroyed here.
    el.fx = h("div", "position:absolute;inset:0;z-index:6;pointer-events:none;overflow:hidden");
    root.appendChild(el.fx);

    // ----------------------------------------------------------- title card
    el.card = h("div",
      "position:absolute;inset:0;z-index:7;display:flex;align-items:center;justify-content:center;" +
      "pointer-events:none;background:radial-gradient(120% 70% at 50% 45%,rgba(8,15,26,.62),rgba(4,8,14,.9))");
    el.cardPanel = h("div",
      "display:flex;flex-direction:column;align-items:center;gap:7px;padding:0 20px;text-align:center");
    el.cardPanel.appendChild(h("div",
      "width:44px;height:3px;border-radius:2px;background:linear-gradient(90deg," + C.gold + "," + C.pink + ")"));
    el.cardTitle = h("div",
      "font-family:" + DISPLAY + ";font-size:min(15vw,86px);line-height:1;font-weight:700;letter-spacing:.04em;" +
      "color:#fff;text-shadow:0 8px 34px rgba(0,0,0,.7)", "");
    el.cardSub = h("div",
      "font-size:11px;font-weight:900;letter-spacing:.2em;color:" + C.gold, "");
    el.cardPanel.appendChild(el.cardTitle);
    el.cardPanel.appendChild(el.cardSub);
    const kitStrip = h("div",
      "display:flex;align-items:center;gap:10px;margin-top:8px;padding:6px 14px;border-radius:999px;" +
      "background:rgba(10,17,28,.6);border:1px solid rgba(255,255,255,.12);font-size:10px;font-weight:800;" +
      "letter-spacing:.12em;color:" + C.cream,
      '<span style="width:9px;height:9px;border-radius:3px;background:' + s.myColor + '"></span>' +
      abbrev(s.myName) +
      '<span style="color:' + C.muted + ';font-weight:700">VS</span>' + abbrev(s.oppName) +
      '<span style="width:9px;height:9px;border-radius:3px;background:' + s.oppColor + '"></span>');
    el.cardPanel.appendChild(kitStrip);
    el.card.appendChild(el.cardPanel);
    root.appendChild(el.card);

    // ----------------------------------------------------------- pause sheet
    el.pauseSheet = h("div",
      "position:absolute;inset:0;z-index:8;display:none;flex-direction:column;align-items:center;" +
      "justify-content:center;padding:20px;background:rgba(5,9,16,.92)");
    const sheet = h("div",
      "width:100%;max-width:340px;padding:18px 18px 16px;border-radius:20px;" +
      "background:linear-gradient(180deg," + C.panel + ",#0C1626);border:1px solid rgba(255,255,255,.13);" +
      "box-shadow:0 24px 60px rgba(0,0,0,.65);display:flex;flex-direction:column;gap:14px");
    sheet.appendChild(h("div",
      "display:flex;align-items:baseline;gap:10px",
      '<span style="font-family:' + DISPLAY + ';font-size:38px;line-height:.9;color:#fff">PAUSED</span>' +
      '<span style="flex:1;height:1px;background:linear-gradient(90deg,rgba(255,255,255,.22),transparent)"></span>'));

    el.pauseScore = h("div",
      "display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;" +
      "border-radius:12px;background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.08)");
    el.pauseSheet.appendChild(sheet);

    const sideTag = (color, name, right) =>
      '<span style="display:flex;align-items:center;gap:7px;min-width:0;' +
      (right ? "flex-direction:row-reverse;" : "") + '">' +
      '<span style="width:4px;height:22px;border-radius:2px;flex:0 0 auto;background:' + color + '"></span>' +
      '<span style="font-size:11px;font-weight:800;color:' + C.cream + ";white-space:nowrap;overflow:hidden;" +
      'text-overflow:ellipsis;max-width:26vw">' + name + "</span></span>";
    el.pauseScore.innerHTML =
      sideTag(s.myColor, s.myName, false) +
      '<span id="" style="font-family:' + DISPLAY + ';font-size:26px;color:#fff;letter-spacing:.04em">0 - 0</span>' +
      sideTag(s.oppColor, s.oppName, true);
    s.pauseScoreNum = el.pauseScore.children[1];
    sheet.appendChild(el.pauseScore);

    sheet.appendChild(h("div",
      "display:flex;flex-direction:column;gap:7px",
      legendRow(C.cream, "DRAG", "Steer with the left half of the screen") +
      legendRow(C.danger, "SHOOT", "Hold to charge, release to strike") +
      legendRow(C.turf, "PASS", "Tap to lay it off") +
      legendRow(C.gold, "THRU", "Thread it in behind the defence") +
      legendRow(C.cyan, "TACKLE", "Win the ball back when they have it")));

    el.resumeBtn = h("div",
      "display:flex;align-items:center;justify-content:center;height:48px;border-radius:14px;" +
      "background:linear-gradient(180deg,#4FE39C," + C.turf + ");color:#06251A;cursor:pointer;" +
      "font-family:" + DISPLAY + ";font-size:24px;letter-spacing:.06em;" +
      "box-shadow:0 8px 20px rgba(47,209,128,.28)", "RESUME");
    el.quitBtn = h("div",
      "display:flex;align-items:center;justify-content:center;height:40px;border-radius:12px;" +
      "border:1px solid " + C.danger + "55;color:" + C.danger + ";cursor:pointer;font-size:11px;" +
      "font-weight:900;letter-spacing:.14em", "FORFEIT MATCH");
    sheet.appendChild(el.resumeBtn);
    sheet.appendChild(el.quitBtn);
    root.appendChild(el.pauseSheet);

    // ------------------------------------------------------------ initial state
    renderScore(s, 0, 0, null);
    applyMode(s, "attack", true);
    applyShape(s, 1, true);
    applyOppShape(s, 1);
    el.nameplate.textContent = "";

    // Hint choreography: wait for the kickoff card to clear, hold ~6s, and
    // bail early the moment the player touches anything.
    s.timers.push(setTimeout(() => {
      if (!root.isConnected) return;
      s.hintShown = true;
      el.hint.style.opacity = "1";
      anim(el.hint.firstChild, [{ transform: "translateY(14px)" }, { transform: "translateY(0)" }],
        { duration: 320, easing: "cubic-bezier(.2,.9,.3,1)" });
    }, 1500));
    s.timers.push(setTimeout(() => { if (s.hintShown) hideHint(s); }, 8200));
    const bail = () => { if (s.hintShown) hideHint(s); };
    root.addEventListener("pointerdown", bail);
    root.addEventListener("touchstart", bail, { passive: true });

    // Radar self-drive. The core may push data via H.updateRadar; if it never
    // does we pull from Match3D.getRadar() instead, and if that doesn't exist
    // either the radar simply stays hidden. Polls at 20Hz, not per frame --
    // the dots are readable well below 60fps and this costs nothing.
    s.poll = setInterval(() => {
      if (!root.isConnected) { clearInterval(s.poll); s.timers.forEach(clearTimeout); return; }
      if (s.pushed) return;
      const M = window.Match3D;
      if (!M || typeof M.getRadar !== "function") return;
      let d = null;
      try { d = M.getRadar(); } catch (e) { return; }
      if (d) drawRadar(s, d);
    }, 50);

    return { root, el };
  };

  // ------------------------------------------------------------------ radar

  // Pitch is 68 (x) by 105 (z), centred on the origin. My team attacks toward
  // +z, and the chase camera looks down +z with world +x on the LEFT of the
  // screen -- so x is mirrored here to keep the radar agreeing with what the
  // player sees, opponent goal at the top.
  function drawRadar(s, data) {
    const g = s.rctx;
    if (!g || !data) return;
    const w = s.rw, hh = s.rh;
    g.clearRect(0, 0, w, hh);

    const px = (x) => (0.5 - x / PITCH_W) * w;
    const pz = (z) => (0.5 - z / PITCH_L) * hh;

    g.lineWidth = 1;
    g.strokeStyle = "rgba(255,255,255,.16)";
    g.beginPath();
    g.moveTo(0, hh / 2); g.lineTo(w, hh / 2);
    g.stroke();
    g.beginPath();
    g.arc(w / 2, hh / 2, w * 0.135, 0, Math.PI * 2);
    g.stroke();
    const boxW = w * (40.3 / PITCH_W), boxD = hh * (16.5 / PITCH_L);
    g.strokeRect((w - boxW) / 2, 0.5, boxW, boxD);
    g.strokeRect((w - boxW) / 2, hh - boxD - 0.5, boxW, boxD);
    // Opponent goal marker -- gives the radar an obvious "up is forward".
    g.fillStyle = "rgba(255,176,32,.5)";
    g.fillRect(w / 2 - 5, 0, 10, 2);

    const list = data.players || [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p) continue;
      const mine = p.team === "my" || p.team === 0 || p.team === true;
      const x = px(p.x || 0), y = pz(p.z || 0);
      if (p.controlled) {
        g.beginPath(); g.arc(x, y, 4.6, 0, Math.PI * 2);
        g.fillStyle = "rgba(255,255,255,.28)"; g.fill();
      }
      g.beginPath(); g.arc(x, y, p.controlled ? 2.8 : 2.2, 0, Math.PI * 2);
      g.fillStyle = mine ? s.myColor : s.oppColor;
      g.fill();
      if (p.controlled) { g.lineWidth = 1.2; g.strokeStyle = "#fff"; g.stroke(); g.lineWidth = 1; }
    }
    if (data.ball) {
      const bx = px(data.ball.x || 0), by = pz(data.ball.z || 0);
      g.beginPath(); g.arc(bx, by, 3.6, 0, Math.PI * 2);
      g.fillStyle = "rgba(255,255,255,.22)"; g.fill();
      g.beginPath(); g.arc(bx, by, 1.9, 0, Math.PI * 2);
      g.fillStyle = "#fff"; g.fill();
    }

    if (!s.radarOn) { s.radarOn = true; s.el.radar.style.opacity = "1"; }
    guessMode(s, data);
  }

  // If the core never calls setMode we infer attack/defend from whoever is
  // nearest the ball, so the defend-only buttons still appear. Needs a few
  // consecutive agreeing samples (~150ms) so a scramble doesn't strobe the UI.
  function guessMode(s, data) {
    if (s.modeExplicit || !data || !data.ball || !data.players) return;
    let best = null, bd = 1e9;
    for (let i = 0; i < data.players.length; i++) {
      const p = data.players[i];
      if (!p) continue;
      const dx = (p.x || 0) - (data.ball.x || 0), dz = (p.z || 0) - (data.ball.z || 0);
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return;
    const want = (best.team === "my" || best.team === 0 || best.team === true) ? "attack" : "defend";
    if (want === s.guess) s.guessRuns++; else { s.guess = want; s.guessRuns = 1; }
    if (s.guessRuns >= 3 && want !== s.mode) applyMode(s, want, false);
  }

  H.updateRadar = function (a, data) {
    const s = a && a.el && a.el._hud;
    if (!s) return;
    s.pushed = true;   // core drives it; stop the fallback poll
    let d = data;
    if (!d && window.Match3D && typeof window.Match3D.getRadar === "function") {
      try { d = window.Match3D.getRadar(); } catch (e) { d = null; }
    }
    if (d) drawRadar(s, d);
  };

  // ------------------------------------------------------------- attack/defend

  function applyMode(s, mode, silent) {
    const el = s.el;
    const m = mode === "defend" ? "defend" : "attack";
    if (s.mode === m && !silent) return;
    s.mode = m;
    const atk = m === "attack";
    // Swapping the attack and defence sets is a PRO-scheme idea. In the simple
    // scheme there is one button whose label already follows the situation, and
    // in auto there are no buttons at all -- so this must not re-show the set
    // setControlMode just hid. Possession changes constantly, so without this
    // guard the full seven reappear within a second of kick off.
    const pro = (s.controlMode || "pro") === "pro";
    const vis = (node, on) => { if (node) node.style.display = (pro && on) ? "flex" : "none"; };
    vis(el.btnShoot, atk);
    vis(el.btnThrough, atk);
    vis(el.btnSkill, atk);
    vis(el.btnTackle, !atk);
    vis(el.btnSwitch, !atk);
    vis(el.btnPass, atk);
    if (silent) return;

    const col = atk ? C.turf : C.cyan;
    el.modeChip.textContent = atk ? "ATTACK" : "DEFEND";
    el.modeChip.style.color = col;
    el.modeChip.style.borderColor = col;
    el.modeChip.style.opacity = "1";
    clearTimeout(s.modeTimer);
    s.modeTimer = setTimeout(() => { el.modeChip.style.opacity = "0"; }, 1100);
    anim(el.modeChip, [{ transform: "scale(.8)" }, { transform: "scale(1)" }],
      { duration: 220, easing: "cubic-bezier(.2,1.3,.4,1)" });
    // Swapping the cluster is a possession change: give it a quick edge pulse
    // so the player registers it without looking away from the ball.
    edgeFlash(s, col, 0.42, 420);
    // Pop whichever big button just took over the primary slot.
    anim(atk ? el.btnShoot : el.btnTackle,
      [{ transform: "scale(.72)", opacity: 0.2 }, { transform: "scale(1)", opacity: 1 }],
      { duration: 200, easing: "cubic-bezier(.2,1.2,.4,1)" });
  }

  // ------------------------------------------------------------- mentality UI

  function applyShape(s, idx, silent) {
    const el = s.el;
    if (!el.tacticBtns) return;
    idx = idx >= 0 && idx < SHAPES.length ? idx : 1;
    s.shape = idx;
    for (let i = 0; i < el.tacticBtns.length; i++) {
      const b = el.tacticBtns[i], sh = SHAPES[i], on = i === idx;
      b.style.background = on ? sh.color + "26" : "rgba(255,255,255,.035)";
      b.style.border = "1px solid " + (on ? sh.color : "rgba(255,255,255,.10)");
      b.style.color = on ? sh.color : "#7E96B2";
      b.style.boxShadow = on
        ? "inset 0 0 0 1px " + sh.color + "55,0 4px 14px " + sh.color + "33"
        : "none";
    }
    const cur = SHAPES[idx];
    if (el.tacticName) {
      el.tacticName.textContent = cur.name;
      el.tacticName.style.color = cur.color;
    }
    if (!silent) {
      anim(el.tacticBtns[idx], [{ transform: "scale(.9)" }, { transform: "scale(1)" }],
        { duration: 240, easing: "cubic-bezier(.2,.9,.3,1)" });
      if (el.tacticName) {
        anim(el.tacticName, [{ opacity: 0.2 }, { opacity: 1 }], { duration: 260, easing: "ease-out" });
      }
    }
  }

  function applyOppShape(s, idx) {
    const el = s.el;
    if (!el.tacticOpp) return;
    const sh = SHAPES[idx >= 0 && idx < SHAPES.length ? idx : 1];
    el.tacticOpp.textContent = "THEM · " + sh.name;
    // Only colour it when they have actually committed one way or the other --
    // a permanently lit label stops meaning anything.
    el.tacticOpp.style.color = (idx === 0 || idx === 3) ? sh.color : C.muted;
  }

  // idx is an index into SHAPES / MENTALITY -- the sim owns which one is live.
  H.setMentality = function (a, idx) {
    const s = a && a.el && a.el._hud;
    if (!s) return;
    applyShape(s, idx, false);
  };

  H.setOppMentality = function (a, idx) {
    const s = a && a.el && a.el._hud;
    if (!s) return;
    applyOppShape(s, idx);
  };

  H.setMode = function (a, mode) {
    const s = a && a.el && a.el._hud;
    if (!s) return;
    s.modeExplicit = true;
    applyMode(s, mode, false);
  };

  // ------------------------------------------------------------------ effects

  function edgeFlash(s, color, peak, ms) {
    const f = s.el.flash;
    f.style.background = "radial-gradient(120% 78% at 50% 50%,transparent 42%," + color + "00 55%," +
      color + "AA 100%)";
    if (!anim(f, [{ opacity: 0 }, { opacity: peak, offset: 0.22 }, { opacity: 0 }],
      { duration: ms || 500, easing: "ease-out" })) {
      f.style.opacity = "0";
    }
  }

  H.flash = function (a, color, ms) {
    const s = a && a.el && a.el._hud;
    if (s) edgeFlash(s, color || C.cream, 0.5, ms || 500);
  };

  function confetti(s, color) {
    const host = s.el.fx;
    if (!host || !host.animate) return;
    const cols = [color, C.gold, C.cream, s.myColor];
    for (let i = 0; i < 16; i++) {
      const c = h("div",
        "position:absolute;top:-16px;left:" + (6 + Math.random() * 88) + "%;width:6px;height:11px;" +
        "border-radius:2px;background:" + cols[i % cols.length] + ";opacity:.95");
      host.appendChild(c);
      const an = anim(c,
        [{ transform: "translateY(-20px) rotate(0deg)", opacity: 1 },
         { transform: "translateY(" + (window.innerHeight * 0.75) + "px) rotate(" +
           (360 + Math.random() * 540) + "deg)", opacity: 0 }],
        { duration: 1200 + Math.random() * 700, delay: Math.random() * 260, easing: "cubic-bezier(.3,.6,.5,1)" });
      if (an) an.onfinish = () => { if (c.parentNode) c.parentNode.removeChild(c); };
      else if (c.parentNode) c.parentNode.removeChild(c);
    }
  }

  // ------------------------------------------------------------------ toast

  // Accent is derived from the message itself so the core keeps calling plain
  // toast(a, "...") and still gets colour-coded feedback.
  function accentFor(msg) {
    const t = String(msg || "");
    if (/goal|scores/i.test(t)) return C.gold;
    if (/save|keeper|block/i.test(t)) return C.cyan;
    if (/shot|strike/i.test(t)) return C.danger;
    if (/→|pass/i.test(t)) return C.turf;
    if (/their|them|they/i.test(t)) return C.pink;
    return C.cream;
  }

  H.toast = function (a, msg, ms) {
    const el = a.el, s = el._hud;
    const col = accentFor(msg);
    el.toast.innerHTML =
      '<span style="flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:' + col +
      ";box-shadow:0 0 9px " + col + '"></span>' +
      '<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      'font-size:12px;font-weight:700;color:' + C.cream + '">' + msg + "</span>";
    el.toast.style.borderColor = col + "55";
    el.toast.style.opacity = "1";
    anim(el.toast, [{ transform: "translateY(-8px)" }, { transform: "translateY(0)" }],
      { duration: 220, easing: "cubic-bezier(.2,.9,.3,1)" });
    if (s) { clearTimeout(a.toastTimer); }
    a.toastTimer = setTimeout(() => { el.toast.style.opacity = "0"; }, ms || 1900);
  };

  // ----------------------------------------------------------------- banner

  H.banner = function (a, text, color, ms) {
    const el = a.el, s = el._hud;
    const col = color || "#fff";
    const big = /goal/i.test(String(text));
    el.bannerText.textContent = text;
    el.bannerText.style.color = col;
    el.bannerRibbon.style.background =
      "linear-gradient(90deg,transparent," + col + "26 14%," + col + "4D 50%," + col + "26 86%,transparent)";
    el.banner.style.opacity = "1";
    anim(el.bannerText,
      [{ transform: "scale(.6)", opacity: 0 },
       { transform: "scale(1.06)", opacity: 1, offset: 0.45 },
       { transform: "scale(1)", opacity: 1 }],
      { duration: big ? 620 : 420, easing: "cubic-bezier(.15,1.1,.35,1)" });
    anim(el.bannerRibbon,
      [{ transform: "skewY(-3deg) scaleX(0)" }, { transform: "skewY(-3deg) scaleX(1)" }],
      { duration: 420, easing: "cubic-bezier(.2,.9,.3,1)" });
    if (s) {
      edgeFlash(s, col, big ? 0.68 : 0.4, big ? 760 : 460);
      if (big) confetti(s, col);
    }
    clearTimeout(a.bannerTimer);
    a.bannerTimer = setTimeout(() => { el.banner.style.opacity = "0"; }, ms || 1400);
  };

  // ------------------------------------------------------------- title card

  H.titleCard = function (a, title, sub, ms) {
    const el = a.el;
    el.cardTitle.textContent = title;
    el.cardSub.textContent = sub || "";
    el.card.style.display = "flex";
    anim(el.card, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
    anim(el.cardPanel,
      [{ transform: "scale(.9) translateY(10px)", opacity: 0 }, { transform: "scale(1) translateY(0)", opacity: 1 }],
      { duration: 380, easing: "cubic-bezier(.15,1.05,.35,1)" });
    clearTimeout(a.cardTimer);
    if (ms) a.cardTimer = setTimeout(() => { el.card.style.display = "none"; }, ms);
  };

  // ------------------------------------------------------------ score / clock

  function renderScore(s, my, opp, changed) {
    const el = s.el;
    const num = (v) => '<span style="display:inline-block">' + v + "</span>";
    el.score.innerHTML = num(my) + '<span style="opacity:.3;margin:0 1px"> - </span>' + num(opp);
    if (s.pauseScoreNum) s.pauseScoreNum.textContent = my + " - " + opp;
    if (changed == null) return;
    const node = el.score.children[changed === "my" ? 0 : 2];
    anim(node, [{ transform: "scale(2)" }, { transform: "scale(1)" }],
      { duration: 520, easing: "cubic-bezier(.15,1.2,.35,1)" });
    anim(s.board, [{ transform: "scale(1)" }, { transform: "scale(1.07)", offset: 0.3 }, { transform: "scale(1)" }],
      { duration: 560, easing: "ease-out" });
  }

  H.setScore = function (a, my, opp) {
    const s = a.el._hud;
    if (!s) { a.el.score.textContent = my + " - " + opp; return; }
    const changed = my !== s.my ? "my" : opp !== s.opp ? "opp" : null;
    s.my = my; s.opp = opp;
    renderScore(s, my, opp, changed);
  };

  H.setClock = function (a, half, minute) {
    const el = a.el;
    el.clock.textContent = minute + "'";
    if (el.clockHalf) el.clockHalf.textContent = half === 1 ? "1ST HALF" : "2ND HALF";
    if (el.clockBar) {
      el.clockBar.style.transform = "scaleX(" + Math.max(0, Math.min(1, minute / 90)) + ")";
    }
    // Last three minutes of either half run hot -- cheap tension, one property.
    const closing = (half === 1 && minute >= 42) || (half !== 1 && minute >= 87);
    el.clock.style.color = closing ? C.danger : C.gold;
  };

  // -------------------------------------------------------------------- hint

  function hideHint(s) {
    if (!s.hintShown) return;
    s.hintShown = false;
    s.el.hint.style.opacity = "0";
  }
  H.hideHint = function (a) {
    const s = a && a.el && a.el._hud;
    if (s) hideHint(s);
  };

  // Which control scheme is on screen. "auto" hides the lot -- the AI is
  // playing and the player is watching -- "simple" shows the one big button,
  // "pro" restores the full set for anyone who wants it.
  H.setControlMode = function (a, mode) {
    const s = a && a.el && a.el._hud;
    const e = a && a.el;
    if (!e) return;
    if (s) s.controlMode = mode;
    const pro = mode === "pro", simple = mode === "simple", auto = mode === "auto";
    const show = (node, on) => { if (node) node.style.display = on ? "flex" : "none"; };
    show(e.btnPrimary, simple);
    show(e.btnShoot, pro);
    show(e.btnTackle, false);
    show(e.btnPass, pro);
    show(e.btnSwitch, false);
    show(e.btnThrough, pro);
    show(e.btnSkill, pro);
    show(e.btnSprint, !auto);
    if (e.stickBase) e.stickBase.style.display = auto ? "none" : "block";
    if (e.powerRing) e.powerRing.style.opacity = "0";
    if (e.hint) {
      e.hint.style.display = auto ? "none" : "";
      e.hint.querySelectorAll("[data-schemes]").forEach(function (row) {
        row.style.display = row.getAttribute("data-schemes").split(" ").indexOf(mode) > -1 ? "" : "none";
      });
    }
  };

  // Called every frame by the core while in the simple scheme. Cheap: it only
  // touches the DOM when the action actually changes, because writing the same
  // label sixty times a second is how you make a phone warm.
  H.setPrimaryAction = function (a, kind) {
    const e = a && a.el;
    const s = e && e._hud;
    if (!e || !e.btnPrimary || !s) return;
    if (s.primaryKind === kind) return;
    s.primaryKind = kind;
    const spec = {
      pass:   { label: "PASS",   icon: ICON.pass,   color: C.turf },
      shoot:  { label: "SHOOT",  icon: ICON.shoot,  color: C.danger },
      tackle: { label: "TACKLE", icon: ICON.tackle, color: C.cyan },
    }[kind] || { label: "PASS", icon: ICON.pass, color: C.turf };
    e.btnPrimary.innerHTML = ic(spec.icon, 27) + "<span>" + spec.label + "</span>";
    e.btnPrimary.style.color = spec.color;
    e.btnPrimary.style.borderColor = spec.color + "CC";
    e.btnPrimary.style.background =
      "radial-gradient(circle at 50% 28%," + spec.color + "4D," + spec.color + "1A 72%),rgba(8,14,24,.55)";
  };

  window.Match3DHud = H;
})();
