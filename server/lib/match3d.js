// TCG Manager -- live 3D match arena: simulation, AI, input, orchestration.
//
// Replaces the old "watch four zone comparisons resolve on a timer" match with
// a real, playable game: you drive one outfield player, everyone else is AI,
// and the scoreline comes from goals you actually score.
//
// Architecture notes (these matter if you touch this file):
//
// 1. The arena mounts into its OWN fixed-position overlay appended to
//    document.body -- deliberately NOT inside #stage. index.html's render()
//    does `stage.innerHTML = appHTML()` on every state change, which would
//    destroy a WebGL canvas and its GL context. Living outside #stage means
//    the scene survives arbitrary re-renders, and the engine owns its own
//    HUD DOM imperatively instead of going through appHTML().
// 2. Everything is procedural -- pitch lines are drawn into a CanvasTexture at
//    boot, players are capsules+spheres, "shadows" are flat dark ellipses.
//    The repo has zero 3D assets and no build step, so nothing here may
//    depend on an external file beyond the three.js CDN script itself.
// 3. Card `power` (the only stat cards actually have) is expanded into real
//    gameplay attributes in deriveAttrs() -- speed, shot, passing, tackling,
//    keeper reflex, stamina, composure -- so a stronger squad genuinely plays
//    better instead of just winning a dice roll.
// 4. If three.js or WebGL is unavailable, available() returns false and
//    index.html silently falls back to the legacy timed zone reveal. The old
//    path is kept intact for exactly this reason -- never assume the 3D mode
//    can run.
//
// Two structural rules that keep this playable on a phone:
//
// 5. THINKING IS CADENCED, STEERING IS NOT. Anything O(players^2) -- role
//    assignment, marking, defensive line, run targets -- happens in
//    updateTactics() roughly 7x/second and writes a single target point onto
//    each player. The per-frame path then only steers toward that point, so
//    the 60Hz loop stays O(players). Hot loops are indexed `for`, not forEach,
//    and nothing in them allocates.
// 6. INPUT IS CAMERA-RELATIVE, DERIVED FROM THE CAMERA. The stick is a screen
//    vector; it is converted through the chase cam's actual ground-plane basis
//    (see stickWorld) rather than a hard-coded axis mapping. Doing it by hand
//    is how "up" ended up meaning "run at your own goal" -- three.js' lookAt
//    puts world +X on the LEFT of the screen when the camera faces +Z, which
//    is not the mapping you would guess.
//
// Control model (what the player can actually do):
//   ON THE BALL   stick steers -- PASS (stick biases who) -- hold SHOOT to
//                 charge, stick at release aims it -- THROUGH plays a runner
//                 in behind -- SKILL feints past a close defender or knocks
//                 the ball into space -- RUN sprints, at a stamina cost.
//   OFF THE BALL  SWITCH cycles the player you drive (stick picks a direction
//                 to switch toward) and pins auto-switch off until you win it
//                 back -- TACKLE lunges when you are close enough, otherwise
//                 sends the nearest teammate to press.
"use strict";

(function () {

  // ---------------------------------------------------------------- constants

  // Real pitch proportions (metres). Using true dimensions keeps camera
  // framing, run distances and shot power all in sane human units.
  const PITCH_W = 68, PITCH_L = 105;
  const GOAL_W = 7.32, GOAL_H = 2.44, GOAL_DEPTH = 2.0;
  const BALL_R = 0.36;

  // My team defends -Z and attacks +Z. Opponent is the mirror.
  const MY_GOAL_Z = -PITCH_L / 2, OPP_GOAL_Z = PITCH_L / 2;

  const GRAVITY = -22;            // exaggerated so lofted balls come down fast
  const GROUND_FRICTION = 1.9;    // m/s^2 bleed on a rolling ball
  const AIR_DRAG = 0.06;
  const BOUNCE = 0.55;

  const POSSESS_R = 1.5;          // how close to take a loose ball
  const DRIBBLE_AHEAD = 0.95;     // ball sits this far in front of the carrier
  const TACKLE_R = 1.9;
  const LUNGE_REACH = 3.4;        // how far away you may commit a sliding press
  const LUNGE_TIME = 0.32;

  // Sprint economics. A full bar is ~7s flat out, and recovery is slower than
  // the drain, so holding RUN permanently leaves you walking in the last third
  // of a half -- that is the whole point of making it a decision.
  const STAM_DRAIN = 0.145, STAM_JOG = 0.028, STAM_REGEN = 0.085;
  const SPRINT_BOOST = 1.22;

  const TEAM_MY = "my", TEAM_OPP = "opp";

  // Off-ball roles, assigned by updateTactics(). Numbers, not strings, because
  // these are compared every frame.
  const R_HOLD = 0, R_PRESS = 1, R_COVER = 2, R_MARK = 3,
        R_SUPPORT = 4, R_RUN = 5, R_TAKER = 6, R_GK = 7;

  // Per-position tuning applied on top of the power-derived baseline.
  const ROLE_MOD = {
    GK:  { speed: -0.12, shot: -0.25, pass: 0.00, tackle: 0.00, reflex: 0.35 },
    DEF: { speed: -0.04, shot: -0.12, pass: 0.02, tackle: 0.22, reflex: 0.00 },
    MID: { speed:  0.02, shot:  0.00, pass: 0.18, tackle: 0.06, reflex: 0.00 },
    FWD: { speed:  0.10, shot:  0.20, pass: 0.00, tackle: -0.06, reflex: 0.00 },
  };

  // -------------------------------------------------------------- mentalities
  //
  // The managerial dial, switchable mid-match without pausing. There is no
  // separate "tactics engine" here: every field below is read by the shape code
  // that already existed (updateTactics / attackRole / defendRole / aiKeeper)
  // and by the pass model, so a change bends the same machinery rather than
  // running a parallel one. Order matters -- the index is the HUD's index.
  const MENTALITY = [
    {
      key: "defensive", name: "DEFENSIVE", short: "DEF", icon: "🛡",
      blurb: "Sit deep, stay compact",
      line: -14,        // metres added to the defensive line's depth
      lineMax: 62,      // how high that line is ever allowed to get
      commit: -8,       // lowers the bar for "make an attacking run"
      runBonus: -6,     // how far beyond the line the runners go
      support: 0.38,    // how far the holding shape squeezes up behind the ball
      urge: 0.94,       // attacking-run urgency
      pressRanks: 1,    // how many players leave shape to hunt the ball
      press: 0.90,      // pressing urgency
      standoff: 2.2,    // presser holds this far goal-side instead of diving in
      chase: 0.78,      // how far a marker will travel from his slot
      markSlack: -4,    // how far in front of the line a marker may stand
      recover: 1.30,    // hustle back when caught upfield of the line
      risk: 0.62,       // passing risk appetite
      thru: 0.50,       // relative value of a through ball to the AI
      shootRange: -4,   // metres added to the AI's shooting range
      gkLine: 0,        // how much of the defensive line's height the GK follows
      gkPush: 0,        // metres the keeper is ever allowed to leave his line by
      gkSweep: -3,      // extra radius the keeper will sweep loose balls from
    },
    {
      key: "balanced", name: "BALANCED", short: "BAL", icon: "⚖",
      blurb: "Hold shape, pick your moment",
      line: 0, lineMax: 82, commit: 0, runBonus: 0, support: 0.55, urge: 1.0,
      pressRanks: 1, press: 1.0, standoff: 0, chase: 1.0, markSlack: 0,
      recover: 1.12, risk: 1.0, thru: 1.0, shootRange: 0,
      gkLine: 0.04, gkPush: 3, gkSweep: 0,
    },
    {
      key: "attacking", name: "ATTACKING", short: "ATT", icon: "⚔",
      blurb: "High line, get after them",
      line: 11, lineMax: 88, commit: 16, runBonus: 6, support: 0.72, urge: 1.06,
      pressRanks: 2, press: 1.07, standoff: 0, chase: 1.15, markSlack: 5,
      recover: 0.98, risk: 1.32, thru: 1.40, shootRange: 4,
      gkLine: 0.16, gkPush: 9, gkSweep: 6,
    },
    {
      key: "allout", name: "ALL-OUT ATTACK", short: "ALL-OUT", icon: "🔥",
      blurb: "Everyone up. No safety net",
      line: 26, lineMax: 94, commit: 55, runBonus: 14, support: 0.95, urge: 1.14,
      pressRanks: 3, press: 1.16, standoff: 0, chase: 1.45, markSlack: 14,
      recover: 0.84, risk: 1.75, thru: 1.90, shootRange: 9,
      gkLine: 0.45, gkPush: 28, gkSweep: 22,
    },
  ];
  const MENT_BAL = 1;

  function mentalityFor(a, team) {
    return MENTALITY[(team === TEAM_MY ? a.mind.my : a.mind.opp)] || MENTALITY[MENT_BAL];
  }

  // ------------------------------------------------------------------- module

  const M = {};
  let THREE = null;
  // Sibling modules (own <script> tags, loaded before this one). Bound in
  // begin() rather than at parse time so script order can't bite us.
  let VIS = null, HUD = null;

  // Live match instance. Null between matches.
  let A = null;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }
  function dist(ax, az, bx, bz) { return Math.sqrt(dist2(ax, az, bx, bz)); }
  function lastName(n) { const p = String(n || "").trim().split(/\s+/); return p[p.length - 1] || "Player"; }

  // Turn a card's single `power` number into the spread of attributes a
  // real-time game needs. 60 power is "just about playable", 100 is elite --
  // the gap is deliberately meaningful but not so wide that a weak squad
  // can't win with good play.
  function deriveAttrs(card, position) {
    const power = (card && card.power) || 70;
    const n = clamp((power - 58) / 42, 0, 1);
    const mod = ROLE_MOD[position] || ROLE_MOD.MID;
    return {
      power: power,
      topSpeed: (6.4 + n * 3.0) * (1 + mod.speed),
      accel: 17 + n * 13,
      agility: 0.72 + n * 0.42,          // how sharply they can change direction
      shotPower: (17 + n * 13) * (1 + mod.shot),
      shotAccuracy: clamp(0.42 + n * 0.46 + mod.shot * 0.3, 0.15, 0.96),
      passAccuracy: clamp(0.5 + n * 0.42 + mod.pass, 0.2, 0.98),
      control: 0.45 + n * 0.45,          // resists being tackled
      tackle: clamp(0.35 + n * 0.45 + mod.tackle, 0.1, 0.95),
      reflex: clamp(0.4 + n * 0.45 + mod.reflex, 0.2, 0.98),
      vision: 12 + n * 16,               // how far the AI looks for a pass
      composure: 0.34 + n * 0.52,        // decision quality: less noise, faster
      endurance: 0.78 + n * 0.44,        // stamina drain/recovery multiplier
    };
  }

  // ---------------------------------------------------------------- available

  let webglOk = null;
  function hasWebGL() {
    if (webglOk !== null) return webglOk;
    try {
      const c = document.createElement("canvas");
      webglOk = !!(window.WebGLRenderingContext &&
        (c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl")));
    } catch (e) { webglOk = false; }
    return webglOk;
  }

  M.available = function () {
    if (!window.THREE) return false;
    if (!window.Match3DVisuals || !window.Match3DHud) return false;
    if (!hasWebGL()) return false;
    return true;
  };

  M.isRunning = function () { return !!A; };

  // Thin pass-throughs to the HUD module so the many call sites below stay
  // readable. HUD owns the DOM; this file only decides when to show things.
  function toast(a, msg, ms) { HUD.toast(a, msg, ms); }
  function banner(a, text, color, ms) { HUD.banner(a, text, color, ms); }
  function titleCard(a, title, sub, ms) { HUD.titleCard(a, title, sub, ms); }

  // ------------------------------------------------------------------- roster

  // Maps the {slotId: card} lineup shape (and buildSlots' percentage layout)
  // into world-space players. Reuses window.buildSlots so formation data has
  // exactly one definition in the codebase.
  function buildTeam(team, lineup, formationKey, colorHex, shared, scene) {
    const slots = (window.buildSlots ? window.buildSlots(formationKey, team) : []) || [];
    const out = [];
    slots.forEach((slot) => {
      const card = lineup ? lineup[slot.id] : null;
      // x% -> width axis, y% -> length axis (matches the 2D pitch overlay the
      // rest of the app draws, so formations "look" the same in 3D).
      const hx = (slot.x / 100 - 0.5) * PITCH_W;
      const hz = -((slot.y / 100) - 0.5) * PITCH_L;
      const attrs = deriveAttrs(card, slot.position);
      const rig = VIS.createPlayer(THREE, shared, colorHex, slot.position === "GK", out.length + 1);
      const mesh = rig.group;
      rig.phase = out.length * 1.7;   // desync the run cycles across the team
      mesh.position.set(hx, 0, hz);
      scene.add(mesh);
      out.push({
        team, slotId: slot.id, position: slot.position,
        card: card || { name: "Reserve", power: 62, rarity: "Common" },
        name: card ? card.name : "Reserve",
        attrs, mesh, rig,
        homeX: hx, homeZ: hz,
        x: hx, z: hz, vx: 0, vz: 0,
        facing: team === TEAM_MY ? 0 : Math.PI,
        isGK: slot.position === "GK",
        cooldown: 0,      // blocks instant re-tackle / re-shoot
        stun: 0,
        stamina: 1,
        // --- tactical state, all written by updateTactics()
        role: R_HOLD, tgtX: hx, tgtZ: hz, urgency: 0.86,
        mark: null, marked: false,
        // --- action state
        lunge: 0, lungeX: 0, lungeZ: 0, lungeHit: false,
        knock: 0, skill: 0, celebrate: 0,
        chaseX: 0, chaseZ: 0, chaseUntil: -1,
        think: 0, _bd: 0,
        // Per-player animation state object, allocated once. Reused every frame
        // so the render path never allocates, but NOT shared between players --
        // the visuals module is free to hold onto it between frames.
        st: {
          speed: 0, facing: 0, t: 0, kicking: false, stunned: false,
          hasBall: false, controlled: false, tackling: false, celebrating: false,
          sprinting: false, stamina: 1, team: team,
        },
      });
    });
    return out;
  }

  // ----------------------------------------------------------- stick -> world

  // The joystick is a SCREEN vector and the chase cam yaws with play, so the
  // mapping has to come from the camera, not from a fixed axis pair. Derived
  // on the XZ plane: forward = camLook - camPos, screen-right = forward x up.
  // (For a camera facing +Z that right vector is world -X. Hard-coding the
  // "obvious" mapping is exactly how the stick ended up 180 degrees out.)
  function stickWorld(a, sx, sy) {
    const o = a._sw;
    let fx = a.camLook.x - a.camPos.x, fz = a.camLook.z - a.camPos.z;
    const fl = Math.hypot(fx, fz);
    if (fl < 0.001) { fx = 0; fz = 1; } else { fx /= fl; fz /= fl; }
    const up = -sy;                       // screen-up is "away from the camera"
    o.x = -fz * sx + fx * up;
    o.z = fx * sx + fz * up;
    o.mag = Math.min(1, Math.hypot(sx, sy));
    const l = Math.hypot(o.x, o.z);
    if (l > 0.0001) { o.x /= l; o.z /= l; } else { o.x = 0; o.z = 0; o.mag = 0; }
    return o;
  }

  // ----------------------------------------------------------------- controls

  function bindControls(a) {
    const stick = { active: false, id: null, ox: 0, oy: 0 };
    a.input = {
      mx: 0, mz: 0, sprint: false, shootHeld: 0,
      wantPass: false, wantShoot: 0, wantThrough: false,
      wantSwitch: false, wantTackle: false, wantSkill: false,
      aimX: 0, aimZ: 0, aimMag: 0,
    };

    const R = 56; // joystick travel in px
    const el = a.el;

    function setKnob(dx, dy) {
      if (el.stickKnob) el.stickKnob.style.transform = "translate(" + dx + "px," + dy + "px)";
    }

    // Touch/mouse: the whole left 55% of the screen acts as a floating stick so
    // the thumb never has to find a fixed target mid-match.
    function isStickZone(x) { return x < window.innerWidth * 0.55; }

    function onDown(e) {
      const t = e.changedTouches ? e.changedTouches[0] : e;
      if (a.paused) return;
      if (isStickZone(t.clientX) && !stick.active) {
        stick.active = true; stick.id = t.identifier != null ? t.identifier : "mouse";
        stick.ox = t.clientX; stick.oy = t.clientY;
        // Re-centre the visible base under the thumb.
        if (el.stickBase) {
          el.stickBase.style.left = (t.clientX - 62) + "px";
          el.stickBase.style.bottom = "auto";
          el.stickBase.style.top = (t.clientY - 62) + "px";
        }
      }
    }
    function onMove(e) {
      const list = e.changedTouches ? e.changedTouches : [e];
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        const id = t.identifier != null ? t.identifier : "mouse";
        if (stick.active && id === stick.id) {
          let dx = t.clientX - stick.ox, dy = t.clientY - stick.oy;
          const len = Math.hypot(dx, dy);
          if (len > R) { dx = dx / len * R; dy = dy / len * R; }
          setKnob(dx, dy);
          const nx = dx / R, ny = dy / R;
          const mag = Math.min(1, Math.hypot(nx, ny));
          if (mag > 0.14) {
            const ang = Math.atan2(ny, nx);
            a.input.mx = Math.cos(ang) * mag;
            a.input.mz = Math.sin(ang) * mag;
          } else { a.input.mx = 0; a.input.mz = 0; }
        }
      }
    }
    function onUp(e) {
      const list = e.changedTouches ? e.changedTouches : [e];
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        const id = t.identifier != null ? t.identifier : "mouse";
        if (stick.active && id === stick.id) {
          stick.active = false;
          a.input.mx = 0; a.input.mz = 0;
          setKnob(0, 0);
        }
      }
    }

    a.handlers = { onDown, onMove, onUp };
    const root = a.root;
    root.addEventListener("touchstart", onDown, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: true });
    root.addEventListener("touchend", onUp, { passive: true });
    root.addEventListener("touchcancel", onUp, { passive: true });
    root.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    // Buttons. Every binding is defensive: the HUD module owns which controls
    // exist, and new ones land there before they land here (or after).
    const press = (e2, down, up) => {
      if (!e2) return;
      const d = (ev) => { ev.preventDefault(); ev.stopPropagation(); down(); };
      const u = (ev) => { ev.preventDefault(); ev.stopPropagation(); if (up) up(); };
      e2.addEventListener("touchstart", d, { passive: false });
      e2.addEventListener("touchend", u, { passive: false });
      e2.addEventListener("mousedown", d);
      e2.addEventListener("mouseup", u);
    };

    press(el.btnPass, () => { a.input.wantPass = true; snapAim(a); });
    press(el.btnSprint, () => { a.input.sprint = true; }, () => { a.input.sprint = false; });
    press(el.btnShoot,
      () => { a.input.shootHeld = 0.0001; if (el.powerRing) el.powerRing.style.opacity = "1"; },
      () => {
        snapAim(a);
        a.input.wantShoot = clamp(a.input.shootHeld / 0.62, 0.35, 1);
        a.input.shootHeld = 0;
        if (el.powerRing) el.powerRing.style.opacity = "0";
      });
    // --- controls the HUD module is adding; bound only if they exist.
    press(el.btnThrough, () => { a.input.wantThrough = true; snapAim(a); });
    press(el.btnSwitch, () => { a.input.wantSwitch = true; snapAim(a); });
    press(el.btnTackle, () => { a.input.wantTackle = true; snapAim(a); });
    press(el.btnSkill, () => { a.input.wantSkill = true; snapAim(a); });

    // Mentality chips. press() swallows the event, so a tap on the tactics bar
    // can never also be read as the floating joystick starting a drag.
    if (el.tacticBtns) {
      for (let i = 0; i < el.tacticBtns.length; i++) {
        (function (idx) {
          press(el.tacticBtns[idx], () => { setMyMentality(a, idx); });
        })(i);
      }
    }

    // Keyboard for desktop play/testing. Keys mirror the buttons 1:1.
    const keys = a.keys = {};
    a.onKeyDown = (e) => {
      if (!A) return;
      const k = e.key.toLowerCase();
      if (keys[k]) { if (k === " ") e.preventDefault(); return; }   // ignore autorepeat
      keys[k] = true;
      if (k === " ") { a.input.shootHeld = 0.0001; if (el.powerRing) el.powerRing.style.opacity = "1"; }
      if (k === "x" || k === "e") { a.input.wantPass = true; snapAim(a); }
      if (k === "q") { a.input.wantThrough = true; snapAim(a); }
      if (k === "f" || k === "tab") { a.input.wantSwitch = true; snapAim(a); }
      if (k === "c" || k === "v") { a.input.wantTackle = true; snapAim(a); }
      if (k === "r") { a.input.wantSkill = true; snapAim(a); }
      // 1-4 mirror the tactics chips for desktop play and automated testing.
      if (k >= "1" && k <= "4") setMyMentality(a, parseInt(k, 10) - 1);
      if (k === "escape" || k === "p") togglePause(a);
      if ([" ", "tab", "arrowup", "arrowdown", "arrowleft", "arrowright"].indexOf(k) >= 0) e.preventDefault();
    };
    a.onKeyUp = (e) => {
      if (!A) return;
      const k = e.key.toLowerCase();
      keys[k] = false;
      if (k === " ") {
        snapAim(a);
        a.input.wantShoot = clamp(a.input.shootHeld / 0.62, 0.35, 1);
        a.input.shootHeld = 0;
        if (el.powerRing) el.powerRing.style.opacity = "0";
      }
    };
    window.addEventListener("keydown", a.onKeyDown);
    window.addEventListener("keyup", a.onKeyUp);

    if (el.pause) el.pause.addEventListener("click", (e) => { e.stopPropagation(); togglePause(a); });
    if (el.resumeBtn) el.resumeBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePause(a, false); });
    if (el.quitBtn) el.quitBtn.addEventListener("click", (e) => { e.stopPropagation(); forfeit(a); });

    a.onResize = () => {
      if (!A) return;
      const w = window.innerWidth, hh = window.innerHeight;
      a.renderer.setSize(w, hh, false);
      a.camera.aspect = w / hh;
      a.camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", a.onResize);
    window.addEventListener("orientationchange", a.onResize);
  }

  // Freeze the stick as a world direction at the instant a button fires -- the
  // action is consumed a frame later and the thumb may have moved by then.
  function snapAim(a) {
    const s = stickWorld(a, a.input.mx, a.input.mz);
    a.input.aimX = s.x; a.input.aimZ = s.z; a.input.aimMag = s.mag;
  }

  // Merge keyboard into the same movement vector the stick writes.
  function readKeyboard(a) {
    const k = a.keys;
    if (!k) return;
    let kx = 0, ky = 0;
    if (k["a"] || k["arrowleft"]) kx -= 1;
    if (k["d"] || k["arrowright"]) kx += 1;
    if (k["w"] || k["arrowup"]) ky -= 1;      // screen-space, same as the stick
    if (k["s"] || k["arrowdown"]) ky += 1;
    if (kx || ky) {
      const l = Math.hypot(kx, ky);
      a.input.mx = kx / l; a.input.mz = ky / l;
    }
    a.input.sprint = a.input.sprint || !!(k["shift"] || k["shiftkey"]);
  }

  function clearWants(a) {
    const i = a.input;
    i.wantShoot = 0; i.wantPass = false; i.wantThrough = false;
    i.wantSwitch = false; i.wantTackle = false; i.wantSkill = false;
  }

  function togglePause(a, force) {
    const want = force === undefined ? !a.paused : force;
    a.paused = want;
    if (a.el.pauseSheet) a.el.pauseSheet.style.display = want ? "flex" : "none";
    if (!want) a.last = performance.now();
  }

  function forfeit(a) {
    // Treated as a normal full-time with whatever the score is -- the result
    // still commits, so quitting can't be used to dodge a loss.
    a.forfeited = true;
    endMatch(a);
  }

  // -------------------------------------------------------------- ball & play

  // True only when the ball is genuinely in play: no kickoff freeze, no
  // celebration, no restart being walked up to.
  function ballLive(a) { return a.kickoffFreeze <= 0 && a.celebrate <= 0 && !a.restart; }

  function resetKickoff(a, towardTeam) {
    a.ball.x = 0; a.ball.y = BALL_R; a.ball.z = 0;
    a.ball.vx = 0; a.ball.vy = 0; a.ball.vz = 0;
    a.ball.owner = null;
    a.restart = null; a.celebrate = 0; a.celebrateBy = null;
    a.pressMate = null; a.pressUntil = -1;
    for (let i = 0; i < a.players.length; i++) {
      const p = a.players[i];
      p.x = p.homeX; p.z = p.homeZ; p.vx = 0; p.vz = 0;
      p.stun = 0; p.cooldown = 0; p.lunge = 0; p.knock = 0; p.skill = 0;
      p.celebrate = 0; p.chaseUntil = -1; p.mark = null;
      p.tgtX = p.homeX; p.tgtZ = p.homeZ; p.role = p.isGK ? R_GK : R_HOLD;
    }
    // The conceding side restarts, so nudge one of their midfielders onto it.
    const starters = a.players.filter((p) => p.team === towardTeam && p.position === "MID");
    if (starters.length) {
      const s = starters[0];
      s.x = -0.6; s.z = towardTeam === TEAM_MY ? -1.2 : 1.2;
      a.ball.owner = s;
    }
    a.kickoffFreeze = 0.9;
    a.tacticTimer = 0;
  }

  function possessionChange(a, p) {
    a.ball.owner = p;
    a.ball.vx = a.ball.vy = a.ball.vz = 0;
    a.ball.y = BALL_R;
    p.cooldown = 0.25;
    p.chaseUntil = -1;
    p.knock = 0;
    // Keepers take a beat to look up before distributing; outfielders don't.
    p.think = p.isGK ? 0.7 : 0.1;
  }

  function attackDirZ(team) { return team === TEAM_MY ? 1 : -1; }
  function goalZFor(team) { return team === TEAM_MY ? OPP_GOAL_Z : MY_GOAL_Z; }
  function ownGoalZFor(team) { return team === TEAM_MY ? MY_GOAL_Z : OPP_GOAL_Z; }
  function oppListFor(a, team) { return team === TEAM_MY ? a.teamOpp : a.teamMy; }
  function mateListFor(a, team) { return team === TEAM_MY ? a.teamMy : a.teamOpp; }

  // How much sharper the AI plays for this team. 0 for the human's side; the
  // opponent's value comes from index.html's `toughness` streak scaler when it
  // passes one, otherwise from the raw squad-power gap so the hook still does
  // something today.
  function edgeFor(a, team) { return team === TEAM_MY ? 0 : a.oppEdge; }

  function nearestOppDist(a, team, x, z) {
    const list = oppListFor(a, team);
    let best = 1e9;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o.stun > 0) continue;
      const d = dist2(o.x, o.z, x, z);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  // Cheapest useful "is this lane open" test: perpendicular distance from every
  // opponent to the segment, counting only the ones actually between the ends.
  // Used for shot blocking, pass lanes and through-ball routes.
  function laneClearance(a, team, x0, z0, x1, z1) {
    const dx = x1 - x0, dz = z1 - z0;
    const len2 = dx * dx + dz * dz;
    if (len2 < 0.01) return 99;
    const list = oppListFor(a, team);
    let worst = 99;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      const t = ((o.x - x0) * dx + (o.z - z0) * dz) / len2;
      if (t < 0.06 || t > 0.98) continue;
      const d = dist(o.x, o.z, x0 + dx * t, z0 + dz * t);
      if (d < worst) worst = d;
    }
    return worst;
  }

  // ------------------------------------------------------------------ actions

  // Shot. Direction is a BLEND of the goal and the stick: with the stick
  // centred it auto-aims (forgiving, which a phone needs), and the harder you
  // push the more of your own aim survives -- up to the point where you can
  // genuinely drag one wide. Power is hold duration; spray is attributes,
  // pressure, distance and whether you were flat out.
  function shoot(a, p, powerFrac, pressure, aimX, aimZ, aimMag) {
    const gz = goalZFor(p.team);
    const d = dist(p.x, p.z, 0, gz);
    const sprinting = Math.hypot(p.vx, p.vz) > p.attrs.topSpeed * 0.92;
    let acc = p.attrs.shotAccuracy
      * (1 - clamp(pressure, 0, 0.55))
      * clamp(1.25 - d / 46, 0.35, 1.1)
      * (sprinting ? 0.86 : 1)
      * (0.72 + p.stamina * 0.3);

    // Pick a target inside the goal, biased away from the keeper, then let the
    // stick's sideways component slide it across the mouth.
    const gk = a.gk[p.team === TEAM_MY ? TEAM_OPP : TEAM_MY];
    let goalX = rand(-GOAL_W / 2 + 0.5, GOAL_W / 2 - 0.5);
    if (gk) goalX = gk.x > 0 ? rand(-GOAL_W / 2 + 0.4, -0.3) : rand(0.3, GOAL_W / 2 - 0.4);
    const mag = aimMag || 0;
    if (mag > 0.2) goalX = clamp(goalX + aimX * mag * (GOAL_W * 0.9), -GOAL_W / 2 - 2.5, GOAL_W / 2 + 2.5);
    const spray = (1 - acc) * 7.5;
    goalX += rand(-spray, spray);

    // Direction: goal-ward unit vector, rotated toward the stick.
    let dx = goalX - p.x, dz = gz - p.z;
    let flat = Math.hypot(dx, dz) || 1;
    dx /= flat; dz /= flat;
    if (mag > 0.2) {
      const w = mag * 0.5;
      dx = dx * (1 - w) + aimX * w;
      dz = dz * (1 - w) + aimZ * w;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
    }

    // Height: distance-driven loft, plus stick-back = chip, stick-forward =
    // drilled. Toward the goal is `dz` sign-matched to the attacking direction.
    const towardGoal = dz * (gz > 0 ? 1 : -1);
    const aimY = clamp(rand(0.35, GOAL_H - 0.35) + rand(-spray, spray) * 0.35, 0.15, GOAL_H + 1.6);
    const loftBias = mag > 0.2 ? clamp(-towardGoal, -0.6, 1) * 0.9 : 0;

    const speed = p.attrs.shotPower * (0.55 + powerFrac * 0.6) * (0.88 + p.stamina * 0.14);
    a.ball.owner = null;
    a.ball.x = p.x + dx * 0.7;
    a.ball.z = p.z + dz * 0.7;
    a.ball.y = BALL_R + 0.15;
    a.ball.vx = dx * speed;
    a.ball.vz = dz * speed;
    a.ball.vy = clamp(aimY / Math.max(1, d) * speed * 0.55 + d * 0.045 + loftBias * 3.2, 0.4, 11);
    p.cooldown = 0.5;
    p.stamina = Math.max(0, p.stamina - 0.02);
    p.facing = Math.atan2(dx, dz);
    a.lastTouch = p;
    a.stat[p.team].shots++;
    if (window.playKick) window.playKick();
  }

  // Pass target search. `aim` biases the choice toward whatever direction the
  // human is holding, which is the difference between "a pass" and "the pass
  // I meant" -- with the stick centred it falls back to pure evaluation.
  function bestPassTarget(a, p, aimX, aimZ, aimMag) {
    const mates = mateListFor(a, p.team);
    const dir = attackDirZ(p.team);
    const gz = goalZFor(p.team);
    // Risk appetite. It is one number and it moves three things: how tight a
    // lane we will squeeze the ball through, how much a forward pass is worth
    // against a safe one, and how much we care that the receiver is free.
    const risk = mentalityFor(a, p.team).risk;
    const minLane = 0.85 / risk;
    let best = null, bestScore = -1e9;
    for (let i = 0; i < mates.length; i++) {
      const q = mates[i];
      if (q === p || q.isGK) continue;
      const d = dist(p.x, p.z, q.x, q.z);
      if (d < 3.5 || d > p.attrs.vision + 10) continue;
      const clear = laneClearance(a, p.team, p.x, p.z, q.x, q.z);
      if (clear < minLane) continue;              // straight into a defender
      const pressQ = nearestOppDist(a, p.team, q.x, q.z);
      const forward = (q.z - p.z) * dir;
      let s = 30 + forward * (1.35 * risk) + clamp(pressQ, 0, 11) * (2.3 / risk)
        + clamp(clear, 0, 5) * 2.8 - d * (0.5 / risk) + (q.attrs.power - 70) * 0.25;
      const qGoal = dist(q.x, q.z, 0, gz);
      if (qGoal < 26) s += (26 - qGoal) * 1.2;    // a shooting position is gold
      if (q.chaseUntil > a.t) s += 22;            // already running -- find them
      if (aimMag > 0.25) {
        const align = ((q.x - p.x) / d) * aimX + ((q.z - p.z) / d) * aimZ;
        s += align * 58 * aimMag;
        if (align < -0.15) s -= 28;
      }
      if (s > bestScore) { bestScore = s; best = q; }
    }
    a._score = bestScore;
    return best;
  }

  function pass(a, p, target) {
    if (!target) return false;
    const acc = p.attrs.passAccuracy * (0.78 + p.stamina * 0.24);
    const d = dist(p.x, p.z, target.x, target.z);
    // Lead the receiver slightly; misplace it by an accuracy-scaled offset.
    const leadX = target.x + target.vx * 0.28 + rand(-1, 1) * (1 - acc) * d * 0.3;
    const leadZ = target.z + target.vz * 0.28 + rand(-1, 1) * (1 - acc) * d * 0.3;
    const dx = leadX - p.x, dz = leadZ - p.z;
    const flat = Math.hypot(dx, dz) || 1;
    const speed = clamp(d * 1.5 + 7, 9, 26);
    a.ball.owner = null;
    a.ball.x = p.x + (dx / flat) * 0.7;
    a.ball.z = p.z + (dz / flat) * 0.7;
    a.ball.y = BALL_R + 0.1;
    a.ball.vx = (dx / flat) * speed;
    a.ball.vz = (dz / flat) * speed;
    // Clip it over a defender standing in the lane rather than into their shins.
    a.ball.vy = laneClearance(a, p.team, p.x, p.z, leadX, leadZ) < 1.9 ? 4.6 : (d > 18 ? 3.4 : 0.5);
    p.cooldown = 0.32;
    p.facing = Math.atan2(dx / flat, dz / flat);
    a.lastTouch = p;
    a.stat[p.team].passes++;
    if (window.playTap) window.playTap();
    return true;
  }

  // Through ball: aimed at SPACE ahead of a runner, not at their feet, and it
  // commits the receiver to chasing it. Writes the landing point to a._thruX/Z.
  function bestThroughTarget(a, p, aimX, aimZ, aimMag) {
    const mates = mateListFor(a, p.team);
    const dir = attackDirZ(p.team);
    const gz = goalZFor(p.team);
    const maxZ = PITCH_L / 2 - 5;
    const risk = mentalityFor(a, p.team).risk;
    let best = null, bestScore = -1e9, bx = 0, bz = 0;
    for (let i = 0; i < mates.length; i++) {
      const q = mates[i];
      if (q === p || q.isGK) continue;
      const forward = (q.z - p.z) * dir;
      if (forward < -6) continue;                       // no through balls backwards
      const d = dist(p.x, p.z, q.x, q.z);
      if (d < 4 || d > p.attrs.vision + 16) continue;
      // A bolder side asks for a bigger ball into space in front of the runner.
      const lead = clamp((6.5 + q.attrs.topSpeed * 0.85) * (0.75 + risk * 0.3), 6, 20);
      let lx = q.x + q.vx * 0.35, lz = q.z + dir * lead;
      lx = clamp(lx, -PITCH_W / 2 + 3, PITCH_W / 2 - 3);
      lz = clamp(lz, -maxZ, maxZ);
      if ((lz - q.z) * dir < 2.5) continue;             // no room left to run into
      const clear = laneClearance(a, p.team, p.x, p.z, lx, lz);
      const space = nearestOppDist(a, p.team, lx, lz);
      const landGoal = dist(lx, lz, 0, gz);
      let s = 18 + forward * 1.1 + space * 3.4 + clamp(clear, 0, 5) * 2.2 - d * 0.35;
      if (landGoal < 30) s += (30 - landGoal) * 1.35;
      if (aimMag > 0.25) {
        const l = Math.hypot(lx - p.x, lz - p.z) || 1;
        const align = ((lx - p.x) / l) * aimX + ((lz - p.z) / l) * aimZ;
        s += align * 55 * aimMag;
        if (align < -0.15) s -= 30;
      }
      if (s > bestScore) { bestScore = s; best = q; bx = lx; bz = lz; }
    }
    a._score = bestScore; a._thruX = bx; a._thruZ = bz;
    return best;
  }

  function throughBall(a, p, target, lx, lz) {
    if (!target) return false;
    const acc = p.attrs.passAccuracy * (0.8 + p.stamina * 0.2);
    const d = dist(p.x, p.z, lx, lz);
    const tx = lx + rand(-1, 1) * (1 - acc) * d * 0.26;
    const tz = lz + rand(-1, 1) * (1 - acc) * d * 0.26;
    const dx = tx - p.x, dz = tz - p.z;
    const flat = Math.hypot(dx, dz) || 1;
    // Drive it hard enough to beat the covering defender but not so hard the
    // keeper always sweeps it -- ~1.35x a normal pass over the same distance.
    const speed = clamp(d * 1.55 + 8, 12, 30);
    const lofted = laneClearance(a, p.team, p.x, p.z, tx, tz) < 2.2;
    a.ball.owner = null;
    a.ball.x = p.x + (dx / flat) * 0.7;
    a.ball.z = p.z + (dz / flat) * 0.7;
    a.ball.y = BALL_R + 0.1;
    a.ball.vx = (dx / flat) * speed;
    a.ball.vz = (dz / flat) * speed;
    a.ball.vy = lofted ? 6.2 : 1.1;
    p.cooldown = 0.36;
    p.facing = Math.atan2(dx / flat, dz / flat);
    a.lastTouch = p;
    a.stat[p.team].passes++;
    // The whole point: the receiver now sprints onto it instead of holding
    // shape and letting the ball run away from them.
    target.chaseX = tx; target.chaseZ = tz;
    target.chaseUntil = a.t + clamp(d / 12 + 1.4, 1.6, 3.4);
    if (window.playKick) window.playKick();
    return true;
  }

  // Skill move. Two flavours off one button: with a defender on you it's a
  // feint that either beats them or costs you a beat; in space it's a knock
  // past your marker that turns the situation into a foot race. Both burn
  // stamina, and the knock leaves the ball further from your feet -- that is
  // the "costs a little control" part.
  function doSkill(a, p) {
    if (p.cooldown > 0 || p.stun > 0 || p.stamina < 0.12) return false;
    const opps = oppListFor(a, p.team);
    let near = null, nd = 1e9;
    for (let i = 0; i < opps.length; i++) {
      const d = dist2(opps[i].x, opps[i].z, p.x, p.z);
      if (d < nd) { nd = d; near = opps[i]; }
    }
    nd = Math.sqrt(nd);
    p.stamina = Math.max(0, p.stamina - 0.13);
    p.skill = 0.42;
    p.cooldown = 0.2;

    const aim = a.input.aimMag > 0.25;
    let ux = aim ? a.input.aimX : Math.sin(p.facing);
    let uz = aim ? a.input.aimZ : Math.cos(p.facing);

    if (near && nd < 3.4) {
      // Feint: your control against their tackling, nudged by how committed
      // they are (a lunging defender is much easier to leave for dead).
      const odds = clamp(p.attrs.control * (near.lunge > 0 ? 1.85 : 1.05)
        / (p.attrs.control + near.attrs.tackle), 0.2, 0.92);
      if (Math.random() < odds) {
        // Go round the side they are not on.
        const sx = p.x - near.x, sz = p.z - near.z;
        const sl = Math.hypot(sx, sz) || 1;
        ux = lerp(ux, sx / sl, 0.55); uz = lerp(uz, sz / sl, 0.55);
        const l = Math.hypot(ux, uz) || 1; ux /= l; uz /= l;
        near.stun = 0.42; near.cooldown = 0.35; near.lunge = 0;
        p.vx = ux * p.attrs.topSpeed * 1.35;
        p.vz = uz * p.attrs.topSpeed * 1.35;
        p.knock = 0.5;
        if (p.team === TEAM_MY) toast(a, "✨ " + lastName(p.name) + " goes past!", 900);
        if (window.playZoneWin && p.team === TEAM_MY) window.playZoneWin();
      } else {
        // Failed: you stall, the ball sits up, they get a free swing at it.
        p.cooldown = 0.5;
        p.vx *= 0.35; p.vz *= 0.35;
        p.knock = 0.9;
        if (p.team === TEAM_MY) toast(a, "Skill didn't come off", 800);
      }
    } else {
      // Knock-on into space: a genuine race, and the ball is loose while it
      // travels so a quicker defender can nip in.
      p.knock = 2.6;
      p.vx = ux * p.attrs.topSpeed * 1.3;
      p.vz = uz * p.attrs.topSpeed * 1.3;
      p.facing = Math.atan2(ux, uz);
      if (p.team === TEAM_MY) toast(a, "Knocked past!", 700);
    }
    return true;
  }

  // Commit a tackle. Locked-in for LUNGE_TIME with extra reach; if it misses
  // you are on the floor for half a second, which is what makes pressing a
  // decision instead of a button you mash.
  function startTackle(a, p) {
    if (p.lunge > 0 || p.stun > 0 || p.cooldown > 0 || p.stamina < 0.06) return false;
    const b = a.ball;
    const d = dist(p.x, p.z, b.x, b.z);
    if (d > LUNGE_REACH) return false;
    const ux = (b.x - p.x) / (d || 1), uz = (b.z - p.z) / (d || 1);
    p.lunge = LUNGE_TIME; p.lungeHit = false;
    p.lungeX = ux; p.lungeZ = uz;
    p.facing = Math.atan2(ux, uz);
    p.stamina = Math.max(0, p.stamina - 0.07);
    return true;
  }

  // Second-man press: when you are too far to tackle yourself, send the nearest
  // teammate at the carrier and keep your own shape. Defending stops being a
  // matter of chasing with one player.
  function callPressure(a) {
    const b = a.ball;
    const mates = a.teamMy;
    let best = null, bd = 1e9;
    for (let i = 0; i < mates.length; i++) {
      const q = mates[i];
      if (q.isGK || q === a.controlled || q.stun > 0) continue;
      const d = dist2(q.x, q.z, b.x, b.z);
      if (d < bd) { bd = d; best = q; }
    }
    if (!best) return false;
    a.pressMate = best; a.pressUntil = a.t + 3.4;
    a.tacticTimer = 0;
    toast(a, "📣 " + lastName(best.name) + " presses!", 900);
    return true;
  }

  // ------------------------------------------------------------ mentality use

  // The player's dial. Applied instantly -- no pause, no restart, and the next
  // shape tick is forced so the team visibly reacts inside a fifth of a second.
  function setMyMentality(a, idx, quiet) {
    if (!a) return false;
    idx = clamp(Math.round(idx) || 0, 0, MENTALITY.length - 1);
    if (a.mind.my === idx) return false;
    a.mind.my = idx;
    const m = MENTALITY[idx];
    if (HUD && HUD.setMentality) HUD.setMentality(a, idx);
    if (!quiet) toast(a, m.icon + " " + m.name + " — " + m.blurb, 1500);
    a.tacticTimer = 0;
    return true;
  }

  function setOppMentality(a, idx, quiet) {
    idx = clamp(Math.round(idx) || 0, 0, MENTALITY.length - 1);
    if (a.mind.opp === idx) return false;
    const prev = a.mind.opp;
    a.mind.opp = idx;
    if (HUD && HUD.setOppMentality) HUD.setOppMentality(a, idx);
    a.tacticTimer = 0;
    // Announce the big swings only, and never more than once every 12s -- the
    // toast lane is shared with commentary and a nagging manager is noise.
    if (!quiet && (idx === 0 || idx === 3) && a.t > a.oppMindToast) {
      a.oppMindToast = a.t + 12;
      const going = idx > prev;
      toast(a, going ? "🔥 " + a.oppName + " throw men forward!"
                     : "🧱 " + a.oppName + " shut up shop.", 1600);
    }
    return true;
  }

  // The opposition manager. Reads the scoreboard and the clock exactly like a
  // human would: protect a lead late, chase the game when behind, and commit
  // everything once there is nothing left to lose. `oppEdge` (the difficulty /
  // toughness scaler) decides how sharply they read it -- a strong side reacts
  // to the game state earlier, a weak one barely manages it at all.
  function updateOppMentality(a) {
    const lead = a.score.opp - a.score.my;
    const min = a.shownMinute < 0 ? 0 : a.shownMinute;
    const e = a.oppEdge;
    let idx = MENT_BAL;

    if (lead < 0) {
      // Behind. Early on there is time to play; from the second half onward
      // they get after it. Conceding in the third minute should not turn them
      // into a different team.
      idx = min > 20 ? 2 : MENT_BAL;
      if (min > 72 - e * 14 || (lead <= -2 && min > 55 - e * 12)) idx = 3;
    } else if (lead > 0) {
      if (min > 62 - e * 20 || (lead >= 2 && min > 42)) idx = 0; // see it out
    } else if (min > 74) {
      idx = e > 0.45 ? 2 : 0;      // level and late: good sides go for it
    }
    // A limited side never finds the nerve for the truly reckless one.
    if (e < 0.25 && idx === 3) idx = 2;
    setOppMentality(a, idx);
  }

  // ---------------------------------------------------------------- tactics

  // Runs ~7x/second, not per frame. Everything expensive lives here: role
  // assignment, marking, the defensive line, run targets. The per-frame path
  // only reads p.tgtX/p.tgtZ/p.urgency.
  function updateTactics(a) {
    const b = a.ball;
    const carrier = b.owner;
    // Marking flags are cleared for EVERYONE up front. Each team only ever
    // flags the other team's players, so the two passes below never collide --
    // but clearing them inside a pass would wipe the flags that pass just set.
    const all = a.players;
    for (let i = 0; i < all.length; i++) {
      all[i].marked = false;
      all[i]._bd = dist2(all[i].x, all[i].z, b.x, b.z);
    }
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? TEAM_MY : TEAM_OPP;
      const list = s === 0 ? a.teamMy : a.teamOpp;
      const hasBall = !!carrier && carrier.team === side;
      teamTactics(a, side, list, hasBall, carrier);
    }
  }

  function teamTactics(a, side, list, hasBall, carrier) {
    const b = a.ball;
    const dir = attackDirZ(side);
    const ownZ = ownGoalZFor(side);
    const edge = edgeFor(a, side);
    const ballDepth = (b.z - ownZ) * dir;
    const m = mentalityFor(a, side);

    // Defensive line as a DEPTH from our own goal. Squeezes up when we have it
    // (compact, high) and drops toward the box when they do -- the block stays
    // roughly 30m front to back either way. The mentality then slides the whole
    // block up or down the pitch and caps how high it may ever sit: a low block
    // camps on the edge of its own box, all-out attack shoves it past halfway.
    const base = hasBall
      ? clamp(ballDepth - 4, 26, 82)
      : clamp(ballDepth - 9 + edge * 5, 15, 64);
    const lineDepth = clamp(base + m.line, 12, m.lineMax);
    // Published for aiKeeper, which is a per-frame path and must not redo this.
    if (side === TEAM_MY) a.lineMy = lineDepth; else a.lineOpp = lineDepth;

    // Rank outfielders by distance to the ball into a reusable buffer. Ten-ish
    // elements, so an insertion sort on the pre-computed _bd beats allocating a
    // comparator closure seven times a second.
    const buf = side === TEAM_MY ? a._bufMy : a._bufOpp;
    buf.length = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.isGK) continue;
      let j = buf.length;
      buf.push(p);
      while (j > 0 && buf[j - 1]._bd > p._bd) { buf[j] = buf[j - 1]; j--; }
      buf[j] = p;
    }

    const restart = a.restart;
    const restartOurs = restart && restart.team === side;
    const restartTheirs = restart && restart.team !== side;

    for (let i = 0; i < buf.length; i++) {
      const p = buf[i];

      // A player chasing a through ball ignores shape until they get there --
      // that is what makes the pass worth playing.
      if (p.chaseUntil > a.t) {
        p.role = R_RUN; p.tgtX = p.chaseX; p.tgtZ = p.chaseZ; p.urgency = 1.12;
        continue;
      }
      if (restart && restart.taker === p) {
        p.role = R_TAKER;
        p.tgtX = restart.x - dir * 0.9; p.tgtZ = restart.z - dir * 0.9;
        p.urgency = 0.95;
        continue;
      }
      if (p === carrier) { p.role = R_HOLD; continue; }   // aiOnBall drives them

      if (restartTheirs) {
        // Ten yards. Back off the ball but stay between it and our goal.
        const dx = p.x - restart.x, dz = p.z - restart.z;
        const d = Math.hypot(dx, dz) || 1;
        if (d < 7.5) {
          p.role = R_HOLD; p.urgency = 0.8;
          p.tgtX = restart.x + (dx / d) * 8.5;
          p.tgtZ = restart.z + (dz / d) * 8.5 - dir * 2;
          continue;
        }
      }

      if (hasBall || restartOurs) attackRole(a, p, i, side, dir, ownZ, lineDepth, carrier, restart, m);
      else defendRole(a, p, i, side, dir, ownZ, lineDepth, carrier, edge, m);

      p.tgtX = clamp(p.tgtX, -PITCH_W / 2 + 1.5, PITCH_W / 2 - 1.5);
      p.tgtZ = clamp(p.tgtZ, -PITCH_L / 2 + 2.5, PITCH_L / 2 - 2.5);
    }
  }

  // In possession: one short option, the rest either run in behind or hold the
  // shape that stops a counter. Runners hunt for actual space rather than
  // charging the same channel as everyone else.
  function attackRole(a, p, rank, side, dir, ownZ, lineDepth, carrier, restart, m) {
    const b = a.ball;
    const homeDepth = (p.homeZ - ownZ) * dir;
    const cx = carrier ? carrier.x : b.x, cz = carrier ? carrier.z : b.z;

    if (restart && restart.kind === "corner" && rank < 4) {
      // Corners: get bodies in the box instead of standing on the halfway line.
      const gz = goalZFor(side);
      const spots = a._cornerSpots;
      p.role = R_RUN; p.urgency = 1.0;
      p.tgtX = spots[rank * 2] * (restart.x > 0 ? 1 : -1);
      p.tgtZ = gz - dir * spots[rank * 2 + 1];
      return;
    }

    if (rank === 0) {
      // Nearest man offers a safe angle, slightly behind the ball so there is
      // always somewhere to go backwards.
      const ax = p.x - cx, az = p.z - cz;
      const l = Math.hypot(ax, az) || 1;
      p.role = R_SUPPORT; p.urgency = 0.94;
      p.tgtX = cx + (ax / l) * 9 + (ax > 0 ? 2 : -2);
      p.tgtZ = cz + (az / l) * 7 - dir * 2.5;
      return;
    }

    // Who commits forward. `commit` lowers the bar for joining the attack, so a
    // low block leaves the front man alone up there and all-out attack drags
    // the centre-backs into the box with everyone else.
    if (homeDepth > lineDepth - 14 - m.commit) {
      // Forward players make runs. Three candidate lanes, pick the emptiest --
      // bounded work (3 x 11 distance checks) and it stops the whole front line
      // converging on the same blade of grass.
      const baseDepth = clamp(Math.max(ballDepthOf(b, ownZ, dir) + 10, lineDepth + 14) + rank * 3 + m.runBonus, 22, 98);
      const baseX = lerp(p.homeX * 1.05, b.x * 0.4, 0.35);
      let bestX = baseX, bestScore = -1e9;
      for (let k = -1; k <= 1; k++) {
        const tx = clamp(baseX + k * 7.5, -PITCH_W / 2 + 4, PITCH_W / 2 - 4);
        const tz = clamp(ownZ + dir * baseDepth, -PITCH_L / 2 + 4, PITCH_L / 2 - 4);
        const sc = nearestOppDist(a, side, tx, tz) * 2.4 - Math.abs(tx - p.homeX) * 0.35;
        if (sc > bestScore) { bestScore = sc; bestX = tx; }
      }
      p.role = R_RUN; p.urgency = 1.02 * m.urge;
      p.tgtX = bestX;
      p.tgtZ = clamp(ownZ + dir * baseDepth, -PITCH_L / 2 + 4, PITCH_L / 2 - 4);
      return;
    }

    // Everyone else holds the shape, pushed up to the line and shaded toward
    // the ball so we are not stretched if it breaks down. `support` is how much
    // of the gap to the line they actually close: a low block keeps a spare
    // man; all-out attack leaves nobody behind the ball at all.
    p.role = R_HOLD; p.urgency = 0.86 * m.urge;
    p.tgtX = lerp(p.homeX, clamp(b.x * 0.6, -PITCH_W / 2 + 3, PITCH_W / 2 - 3), 0.35);
    p.tgtZ = ownZ + dir * clamp(homeDepth + (lineDepth - homeDepth) * m.support, 8, 92);
  }

  function ballDepthOf(b, ownZ, dir) { return (b.z - ownZ) * dir; }

  // Out of possession: one presser, one cover, the rest mark goal-side of a
  // man each and hold the line. This is where "arcade" becomes "a match".
  function defendRole(a, p, rank, side, dir, ownZ, lineDepth, carrier, edge, m) {
    const b = a.ball;
    const called = a.pressMate === p && a.t < a.pressUntil;

    // How many bodies leave the shape to hunt the ball. One is the honest
    // default; attacking adds a second-wave presser behind the cover man and
    // all-out attack sends three and keeps nobody spare.
    const pressing = rank === 0 || called ||
      (rank === 1 && m.pressRanks >= 3) || (rank === 2 && m.pressRanks >= 2);

    if (pressing) {
      // Attack the ball, leading it slightly so you arrive where it is going.
      p.role = R_PRESS; p.urgency = (1.1 + edge * 0.1) * m.press;
      p.tgtX = b.x + b.vx * 0.18;
      p.tgtZ = b.z + b.vz * 0.18;
      // A low block contains rather than commits: stand off, goal-side, and
      // make them play through you instead of round you.
      if (m.standoff) {
        const gx = 0 - b.x, gz = ownZ - b.z;
        const l = Math.hypot(gx, gz) || 1;
        p.tgtX += (gx / l) * m.standoff;
        p.tgtZ += (gz / l) * m.standoff;
      }
      return;
    }

    if (rank === 1) {
      // Cover: sit goal-side of the ball so a beaten presser is not fatal.
      const gx = 0, gz = ownZ;
      let ux = gx - b.x, uz = gz - b.z;
      const l = Math.hypot(ux, uz) || 1; ux /= l; uz /= l;
      p.role = R_COVER; p.urgency = (1.02 + edge * 0.08) * m.press;
      p.tgtX = b.x + ux * 6.5;
      p.tgtZ = b.z + uz * 6.5;
      return;
    }

    // Recovery: caught upfield of our own line, how hard do we run back? This
    // is the difference between a side that swarms back behind the ball and one
    // that jogs while the counter goes past it.
    const behindLine = (p.z - ownZ) * dir - lineDepth;
    const hustle = behindLine > 6 ? m.recover : 1;

    // Man-marking, greedy nearest-unmarked. Threat is a mix of how advanced
    // they are and how close they are to the ball, so the dangerous runner
    // gets picked up before the one loitering on the touchline.
    const opps = oppListFor(a, side);
    let mark = null, bestScore = -1e9;
    for (let i = 0; i < opps.length; i++) {
      const o = opps[i];
      if (o.isGK || o.marked || o === carrier) continue;
      const d = dist(o.x, o.z, p.x, p.z);
      if (d > 30 * m.chase) continue;      // how far we'll travel to pick a man up
      const threat = 60 - (o.z - ownZ) * dir * 0.55 - dist(o.x, o.z, b.x, b.z) * 0.5 - d * 0.9;
      if (threat > bestScore) { bestScore = threat; mark = o; }
    }

    if (mark) {
      mark.marked = true;
      p.mark = mark;
      // Goal-side, and leaning into the lane from the ball so the pass has to
      // beat you rather than arrive at their feet.
      let ux = 0 - mark.x, uz = ownZ - mark.z;
      const l = Math.hypot(ux, uz) || 1; ux /= l; uz /= l;
      let tx = mark.x + ux * 2.1, tz = mark.z + uz * 2.1;
      let lx = b.x - mark.x, lz = b.z - mark.z;
      const ll = Math.hypot(lx, lz) || 1;
      tx += (lx / ll) * 1.6; tz += (lz / ll) * 1.6;
      // Never in front of the defensive line -- that is what keeps the block
      // compact instead of a string of individual duels.
      const depth = (tz - ownZ) * dir;
      const slack = lineDepth + 10 + m.markSlack;
      if (depth > slack) tz = ownZ + dir * slack;
      p.role = R_MARK; p.urgency = (0.98 + edge * 0.06) * hustle;
      p.tgtX = tx; p.tgtZ = tz;
      return;
    }

    p.mark = null;
    p.role = R_HOLD; p.urgency = 0.9 * hustle;
    const homeDepth = (p.homeZ - ownZ) * dir;
    p.tgtX = lerp(p.homeX, clamp(b.x * 0.55, -PITCH_W / 2 + 3, PITCH_W / 2 - 3), 0.4);
    p.tgtZ = ownZ + dir * clamp(Math.min(homeDepth, lineDepth + 16), 6, 92);
  }

  // ------------------------------------------------------------------ AI step

  // The AI carrying the ball. Scores every option on one comparable scale and
  // takes the best -- the old version rolled dice on "shoot?" then "pass?",
  // which is why it hit hopeful efforts from 35m with a free man alongside.
  function aiOnBall(a, p, dt) {
    if (p.isGK) { aiKeeperOnBall(a, p, dt); return; }

    const gz = goalZFor(p.team);
    const dir = attackDirZ(p.team);
    const dGoal = dist(p.x, p.z, 0, gz);
    const press = nearestOppDist(a, p.team, p.x, p.z);
    const edge = edgeFor(a, p.team);
    const poise = clamp(p.attrs.composure * (1 + edge * 0.35), 0, 1);
    const m = mentalityFor(a, p.team);
    const range = 34 + m.shootRange;

    p.think -= dt;
    if (p.think <= 0 && p.cooldown <= 0 && a.kickoffFreeze <= 0) {
      // Weaker/less composed players simply take longer to see it, and the
      // noise term below means they also see it less clearly.
      p.think = 0.12 + (1 - poise) * 0.26 - edge * 0.03;
      const noise = (1 - poise) * 30;

      let shootV = -1e9;
      if (dGoal < range) {
        const angle = clamp(1 - Math.abs(p.x) / 26, 0.12, 1);
        shootV = (range - dGoal) * 2.5 * angle * (0.55 + p.attrs.shotAccuracy * 0.95);
        shootV *= clamp(press / 3.0, 0.35, 1.15);
        if (laneClearance(a, p.team, p.x, p.z, 0, gz) < 1.6) shootV *= 0.45;
        const gk = a.gk[p.team === TEAM_MY ? TEAM_OPP : TEAM_MY];
        if (gk && Math.abs(gk.z - gz) > 5) shootV *= 1.3;   // keeper caught out
        shootV += rand(-noise, noise);
      }

      const pt = bestPassTarget(a, p, 0, 0, 0);
      let passV = pt ? a._score * (0.7 + p.attrs.passAccuracy * 0.55) : -1e9;
      if (pt && press < 3.2) passV *= 1.5;                 // move it or lose it
      if (pt) passV += rand(-noise, noise);

      const tt = bestThroughTarget(a, p, 0, 0, 0);
      const tx = a._thruX, tz = a._thruZ;
      let thruV = tt ? a._score * (0.55 + p.attrs.vision / 30) * m.thru : -1e9;
      if (tt) thruV += rand(-noise, noise);

      let dribV = 24 + clamp(press - 2.4, 0, 9) * 4.2 + p.attrs.control * 16
        + clamp(40 - dGoal, 0, 40) * 0.35;
      if (press < 2.1) dribV *= 0.5;
      dribV += rand(-noise * 0.6, noise * 0.6);

      if (shootV >= passV && shootV >= thruV && shootV >= dribV && shootV > 12) {
        shoot(a, p, rand(0.62, 1), clamp((3.5 - press) / 3.5, 0, 1), 0, 0, 0);
        return;
      }
      if (thruV >= passV && thruV >= dribV && tt && thruV > 30) { throughBall(a, p, tt, tx, tz); return; }
      if (passV >= dribV && pt && passV > 26) { pass(a, p, pt); return; }
    }

    // Drive at goal, veering away from the closest defender and steering for
    // the space rather than straight down the throat of the cover.
    let tx = clamp(p.x * 0.72, -PITCH_W / 2 + 4, PITCH_W / 2 - 4);
    let tz = p.z + dir * 14;
    const opps = oppListFor(a, p.team);
    let near = null, nd = 1e9;
    for (let i = 0; i < opps.length; i++) {
      const d = dist2(opps[i].x, opps[i].z, p.x, p.z);
      if (d < nd) { nd = d; near = opps[i]; }
    }
    if (near && nd < 30) {
      const away = p.x - near.x;
      tx += away > 0 ? 6 : -6;
      if (Math.abs(away) < 1.2) tx += rand(-1, 1) > 0 ? 6 : -6;
    }
    steer(p, tx, tz, dt, 0.98 + edge * 0.05);
  }

  // Last resort out-ball: nothing on, so put it long and wide. Counts as a
  // pass because it is one, just a bad one.
  function clearIt(a, p) {
    const dir = attackDirZ(p.team);
    const tx = clamp(p.x * 1.9 + rand(-8, 8), -PITCH_W / 2 + 4, PITCH_W / 2 - 4);
    const tz = p.z + dir * rand(28, 42);
    const dx = tx - p.x, dz = tz - p.z;
    const flat = Math.hypot(dx, dz) || 1;
    a.ball.owner = null;
    a.ball.x = p.x + (dx / flat) * 0.7;
    a.ball.z = p.z + (dz / flat) * 0.7;
    a.ball.y = BALL_R + 0.2;
    a.ball.vx = (dx / flat) * 22; a.ball.vz = (dz / flat) * 22; a.ball.vy = 8.5;
    p.cooldown = 0.45;
    a.lastTouch = p;
    a.stat[p.team].passes++;
    if (window.playKick) window.playKick();
  }

  // Keeper in possession. aiOnBall has always delegated here, but the function
  // itself was missing -- so every time a goalkeeper picked the ball up the
  // frame step threw, the rest of that frame (ball, possession, bounds) never
  // ran, and play froze in his hands until something else jolted it. It is the
  // reason matches could sit in one penalty area for a minute at a time.
  //
  // He does not dribble out of his own box: take the beat that possessionChange
  // already gave him (think = 0.7), find the free man, otherwise put it long.
  function aiKeeperOnBall(a, p, dt) {
    // Stand still while he looks up.
    p.vx *= Math.max(0, 1 - 6 * dt);
    p.vz *= Math.max(0, 1 - 6 * dt);
    p.think -= dt;
    if (p.think > 0 || p.cooldown > 0 || a.kickoffFreeze > 0) return;

    const pressed = nearestOppDist(a, p.team, p.x, p.z) < 6.5;
    const t = bestPassTarget(a, p, 0, 0, 0);
    // A keeper's bar for playing out is much higher than an outfielder's --
    // rolling it to a marked centre-back is how you concede a stupid goal --
    // and it rises again when somebody is closing him down. Mentality moves it:
    // a low block hoofs it clear, an all-out side builds from the back because
    // it wants the extra body in the move.
    const bar = (pressed ? 52 : 34) / mentalityFor(a, p.team).risk;
    if (t && a._score > bar) { pass(a, p, t); return; }
    clearIt(a, p);
  }

  // Keeper. Two jobs: stand on the bisector at the right depth so the angle is
  // narrow, and come and get anything loose you can reach first.
  function aiKeeper(a, p, dt) {
    const b = a.ball;
    const dir = attackDirZ(p.team);
    const gz = ownGoalZFor(p.team);
    const dx = b.x - 0, dz = b.z - gz;
    const d = Math.hypot(dx, dz) || 1;
    // Sweeper-keeper. He follows a fraction of his own defensive line rather
    // than the ball, which is what a real one does: when the back four are on
    // halfway he has to be on the edge of the D covering the space behind them,
    // and when they are camped in the box he is on his line. On ALL-OUT ATTACK
    // that fraction is high enough to leave him standing near the centre circle
    // with an empty net behind him -- the whole trade of the mentality.
    const m = mentalityFor(a, p.team);
    const line = (p.team === TEAM_MY ? a.lineMy : a.lineOpp) || 30;
    const push = clamp((line - 30) * m.gkLine, 0, m.gkPush);
    const pushFrac = m.gkPush > 0 ? push / m.gkPush : 1;

    // Predictive dive: if a shot is actually travelling toward the line, go to
    // where it will cross rather than where the ball is now.
    const towardUs = (gz < 0 ? b.vz < -6 : b.vz > 6) && !b.owner;
    if (towardUs) {
      const tToLine = (gz - b.z) / b.vz;
      if (tToLine > 0 && tToLine < 1.4) {
        const cx = clamp(b.x + b.vx * tToLine, -GOAL_W / 2 - 1.4, GOAL_W / 2 + 1.4);
        steer(p, cx, gz + (gz < 0 ? 0.6 : -0.6), dt, 1.35 + p.attrs.reflex * 0.35);
        p.facing = Math.atan2(b.x - p.x, b.z - p.z);
        return;
      }
    }

    // Sweep: loose ball near the box that we are clearly closest to.
    const boxDepth = Math.abs(b.z - gz);
    if (!b.owner && boxDepth < Math.max(8, 17 + m.gkSweep * pushFrac) && b.y < 2.4) {
      let rivalClose = false;
      const opps = oppListFor(a, p.team);
      for (let i = 0; i < opps.length; i++) {
        if (dist(opps[i].x, opps[i].z, b.x, b.z) < dist(p.x, p.z, b.x, b.z) - 1.5) { rivalClose = true; break; }
      }
      if (!rivalClose) {
        steer(p, b.x, b.z, dt, 1.25);
        p.facing = Math.atan2(b.x - p.x, b.z - p.z);
        return;
      }
    }

    // Otherwise: narrow the angle. Advance further when the ball is close and
    // when the keeper is good enough to trust himself off his line.
    const advance = clamp(d * 0.17, 0.5, 6.0) * (0.7 + p.attrs.reflex * 0.55);
    let tx = (dx / d) * advance;
    let tz = gz + dir * push + (dz / d) * advance;
    const wide = GOAL_W / 2 + 1.8 + push * 0.6;
    tx = clamp(tx, -wide, wide);
    steer(p, tx, tz, dt, 1.05 + (push > 4 ? 0.15 : 0));
    p.facing = Math.atan2(b.x - p.x, b.z - p.z);
  }

  // Per-frame off-ball movement: just walk toward whatever updateTactics()
  // decided, at the urgency it asked for. Deliberately trivial -- all of the
  // thinking already happened.
  function aiOffBall(a, p, dt) {
    if (p.isGK) { aiKeeper(a, p, dt); return; }
    let urgency = p.urgency;
    // AI sprints too, and pays for it: pressing on empty legs is slow.
    const wantSprint = urgency > 1.0 && p.stamina > 0.15;
    if (wantSprint) {
      urgency *= SPRINT_BOOST;
      p.stamina = Math.max(0, p.stamina - STAM_DRAIN * 0.55 * dt / p.attrs.endurance);
    }
    steer(p, p.tgtX, p.tgtZ, dt, urgency * staminaSpeed(p));
  }

  function staminaSpeed(p) { return p.stamina > 0.28 ? 1 : 0.82 + p.stamina * 0.64; }

  function steer(p, tx, tz, dt, speedScale) {
    const dx = tx - p.x, dz = tz - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) { p.vx *= 0.82; p.vz *= 0.82; return; }
    const want = p.attrs.topSpeed * (speedScale == null ? 1 : speedScale);
    const ux = dx / d, uz = dz / d;
    // Ease off as we arrive so players don't jitter around their anchor.
    const target = Math.min(want, d > 1.4 ? want : want * 0.35);
    const k = Math.min(1, p.attrs.accel * dt / Math.max(1, want));
    p.vx += (ux * target - p.vx) * k;
    p.vz += (uz * target - p.vz) * k;
  }

  // ------------------------------------------------------------- physics step

  function stepPlayers(a, dt) {
    const list = a.players;
    const live = ballLive(a);
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.cooldown = Math.max(0, p.cooldown - dt);
      p.stun = Math.max(0, p.stun - dt);
      p.skill = Math.max(0, p.skill - dt);
      p.knock = Math.max(0, p.knock - dt * 1.6);
      if (p.celebrate > 0) p.celebrate = Math.max(0, p.celebrate - dt);

      if (p.lunge > 0) {
        // Committed. No steering, and if the window closes without winning the
        // ball you are on the floor -- that is the cost of a wild press.
        p.lunge -= dt;
        const sp = p.attrs.topSpeed * 1.5;
        p.vx = p.lungeX * sp; p.vz = p.lungeZ * sp;
        if (p.lunge <= 0 && !p.lungeHit) { p.stun = 0.42; p.cooldown = 0.3; }
      } else if (p.stun > 0) {
        p.vx *= Math.max(0, 1 - 6 * dt); p.vz *= Math.max(0, 1 - 6 * dt);
      } else if (p === a.controlled && live) {
        humanControl(a, p, dt);
      } else if (a.celebrate > 0) {
        celebrateMove(a, p, dt);
      } else if (a.kickoffFreeze > 0) {
        p.vx *= 0.9; p.vz *= 0.9;
      } else if (a.ball.owner === p) {
        aiOnBall(a, p, dt);
      } else {
        aiOffBall(a, p, dt);
      }

      // Stamina. Recovery is slower than the drain, so a half of permanent
      // sprinting genuinely tells by the end.
      if (p !== a.controlled || !a.input.sprint) {
        const sp = Math.hypot(p.vx, p.vz);
        const rate = sp > p.attrs.topSpeed * 0.75 ? -STAM_JOG : STAM_REGEN * (sp < 1.5 ? 1.5 : 1);
        p.stamina = clamp(p.stamina + rate * dt * p.attrs.endurance, 0, 1);
      }

      p.x += p.vx * dt; p.z += p.vz * dt;
      // Keep everyone on (or just off) the field of play.
      p.x = clamp(p.x, -PITCH_W / 2 - 1.5, PITCH_W / 2 + 1.5);
      p.z = clamp(p.z, -PITCH_L / 2 - 3, PITCH_L / 2 + 3);

      const sp = Math.hypot(p.vx, p.vz);
      if (sp > 0.4 && p.lunge <= 0) p.facing = Math.atan2(p.vx, p.vz);

      // Position/orientation are the sim's business; the pose belongs to the
      // visuals module, which owns whatever rig it decided to build.
      p.mesh.position.x = p.x; p.mesh.position.z = p.z;
      p.mesh.rotation.y = p.facing;
      const st = a._st;
      st.speed = sp; st.facing = p.facing; st.t = a.t;
      st.kicking = p.cooldown > 0.28;
      st.stunned = p.stun > 0;
      st.hasBall = a.ball.owner === p;
      st.controlled = p === a.controlled;
      st.tackling = p.lunge > 0;
      st.celebrating = p.celebrate > 0;
      st.sprinting = sp > p.attrs.topSpeed * 0.95;
      st.stamina = p.stamina;
      st.team = p.team;
      VIS.animatePlayer(p.rig, st, dt);
    }
  }

  // Human movement. Screen-space stick maps into camera-relative world motion
  // (see stickWorld). Sprinting is faster but turns worse and eats stamina.
  function humanControl(a, p, dt) {
    const inp = a.input;
    const mag = Math.min(1, Math.hypot(inp.mx, inp.mz));
    const sprinting = inp.sprint && p.stamina > 0.02 && mag > 0.2;
    if (sprinting) {
      p.stamina = Math.max(0, p.stamina - STAM_DRAIN * dt / p.attrs.endurance);
    }
    const boost = sprinting ? 1 + (SPRINT_BOOST - 1) * clamp(p.stamina * 1.8, 0.3, 1) : 1;
    const want = p.attrs.topSpeed * boost * staminaSpeed(p);

    if (mag > 0.05 && p.stun <= 0) {
      const w = stickWorld(a, inp.mx, inp.mz);
      const tvx = w.x * want * mag, tvz = w.z * want * mag;
      // Turning authority: flat out you cannot pivot, which is the other half
      // of what makes RUN a choice rather than a permanent hold.
      const sp = Math.hypot(p.vx, p.vz);
      let turn = 1;
      if (sp > 1.5) {
        const align = (p.vx * w.x + p.vz * w.z) / sp;
        const agility = p.attrs.agility * (sprinting ? 0.62 : 1);
        turn = clamp(0.35 + (align + 1) * 0.5 * agility + (sprinting ? 0 : 0.25), 0.32, 1.25);
      }
      const k = Math.min(1, p.attrs.accel * 1.25 * turn * dt / Math.max(1, want));
      p.vx += (tvx - p.vx) * k;
      p.vz += (tvz - p.vz) * k;
    } else {
      p.vx *= Math.max(0, 1 - 7 * dt); p.vz *= Math.max(0, 1 - 7 * dt);
    }
  }

  // After a goal: scorer peels away, teammates chase them, the conceding side
  // trudges back. Costs nothing and stops goals feeling like a teleport.
  function celebrateMove(a, p, dt) {
    const hero = a.celebrateBy;
    if (!hero) { p.vx *= 0.9; p.vz *= 0.9; return; }
    if (p === hero) {
      steer(p, clamp(hero.x * 1.6, -PITCH_W / 2 + 6, PITCH_W / 2 - 6),
        hero.z + attackDirZ(p.team) * 4, dt, 0.9);
    } else if (p.team === hero.team) {
      steer(p, hero.x + (p.homeX > hero.x ? 3 : -3), hero.z - 2.5, dt, 0.85);
    } else {
      steer(p, p.homeX, p.homeZ, dt, 0.5);
    }
  }

  function stepBall(a, dt) {
    const b = a.ball;

    if (b.owner) {
      const o = b.owner;
      // Dribble: ball rides in front of the carrier, and FURTHER in front the
      // faster they are going or the harder they just knocked it. That gap is
      // what a defender is actually tackling.
      const sp = Math.hypot(o.vx, o.vz);
      const ahead = DRIBBLE_AHEAD + clamp(sp - 4.5, 0, 5.5) * 0.19 + o.knock * 1.1;
      const tx = o.x + Math.sin(o.facing) * ahead;
      const tz = o.z + Math.cos(o.facing) * ahead;
      b.x = lerp(b.x, tx, Math.min(1, 16 * dt));
      b.z = lerp(b.z, tz, Math.min(1, 16 * dt));
      b.y = BALL_R + Math.abs(Math.sin(a.t * 9)) * 0.07;
      b.vx = o.vx; b.vz = o.vz; b.vy = 0;
      // A big knock-on genuinely lets go of it -- race the defender for it.
      if (o.knock > 1.4 && dist(b.x, b.z, o.x, o.z) > 2.6) {
        b.owner = null;
        b.vx = Math.sin(o.facing) * (sp + 5); b.vz = Math.cos(o.facing) * (sp + 5);
        o.cooldown = 0.12; o.knock = 0;
      }
    } else {
      b.vy += GRAVITY * dt;
      const sp = Math.hypot(b.vx, b.vz);
      if (b.y <= BALL_R + 0.001 && sp > 0.01) {
        const f = Math.min(sp, GROUND_FRICTION * dt);
        b.vx -= (b.vx / sp) * f; b.vz -= (b.vz / sp) * f;
      }
      b.vx *= (1 - AIR_DRAG * dt); b.vz *= (1 - AIR_DRAG * dt);
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
      if (b.y < BALL_R) {
        b.y = BALL_R;
        if (b.vy < -1.2) { b.vy = -b.vy * BOUNCE; } else { b.vy = 0; }
      }
    }

    // Rolling spin, purely visual.
    a.ballMesh.position.set(b.x, b.y, b.z);
    a.ballMesh.rotation.x -= b.vz * dt / BALL_R;
    a.ballMesh.rotation.z += b.vx * dt / BALL_R;
    a.ballShadow.position.set(b.x, 0.03, b.z);
    const shScale = clamp(1 - (b.y - BALL_R) * 0.08, 0.45, 1);
    a.ballShadow.scale.setScalar(shScale);
  }

  function stepPossession(a, dt) {
    const b = a.ball;
    if (!ballLive(a)) return;

    if (b.owner) {
      // Tackling. Measured to the BALL, not the carrier, so a loose touch at
      // sprint is genuinely punishable. A committed lunge reaches further and
      // wins more, but only inside its window.
      const list = a.players;
      const owner = b.owner;
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (o.team === owner.team || o.stun > 0) continue;
        if (o.cooldown > 0 && o.lunge <= 0) continue;
        const lunging = o.lunge > 0;
        const r = lunging ? TACKLE_R + 1.1 : TACKLE_R;
        const d = Math.min(dist(o.x, o.z, b.x, b.z), dist(o.x, o.z, owner.x, owner.z) - 0.4);
        if (d > r) continue;
        const edge = edgeFor(a, o.team);
        let odds = (o.attrs.tackle * 1.15 * (lunging ? 1.75 : 1) * (1 + edge * 0.16))
          / (o.attrs.tackle * 1.15 + owner.attrs.control * (owner.skill > 0 ? 1.35 : 1));
        // Human-controlled players get a small break so it doesn't feel unfair.
        if (owner === a.controlled) odds *= 0.78;
        if (owner.knock > 0.4) odds *= 1.3;      // the ball is away from his feet
        if (Math.random() < odds * dt * 3.2) {
          owner.stun = 0.28; owner.cooldown = 0.4; owner.knock = 0;
          o.lungeHit = true; o.lunge = 0;
          possessionChange(a, o);
          a.lastTouch = o;
          if (o.team === TEAM_MY) {
            toast(a, "🦶 " + lastName(o.name) + " wins it back!");
            if (window.playZoneWin) window.playZoneWin();
          }
          return;
        }
      }
      return;
    }

    // Loose ball: closest eligible player inside the pickup radius takes it,
    // keepers get a bigger reach (that's their whole job).
    let best = null, bd = 1e9;
    const list = a.players;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.cooldown > 0 || p.stun > 0) continue;
      const r = p.isGK ? POSSESS_R + 1.4 + 1.6 * p.attrs.reflex : POSSESS_R + (p.lunge > 0 ? 0.7 : 0);
      if (b.y > 2.2 && !p.isGK) continue;            // can't collect a high ball
      const d = dist(p.x, p.z, b.x, b.z);
      if (d < r && d < bd) { bd = d; best = p; }
    }
    if (!best) return;

    const wasShot = Math.hypot(b.vx, b.vz) > 12;
    if (best.isGK && wasShot) {
      // Save: strong keepers hold it, weaker ones only get a hand to it.
      if (Math.random() < best.attrs.reflex) {
        possessionChange(a, best);
        toast(a, "🧤 Save by " + lastName(best.name) + "!");
        a.stat[best.team].saved++;   // credited to the keeper's own team
      } else if (Math.random() < 0.55) {
        // Tipped around the post. This is the main way corners happen in a
        // real match -- before this the ball only ever left over the goal line
        // off an attacker's wayward shot, which is a goal kick every time, so
        // corners were literally unreachable.
        //
        // The ball is displaced outside the post FIRST. Sending it goalwards
        // and hoping the sideways velocity clears the frame in time risks it
        // crossing between the posts on the next step and being scored as an
        // own goal.
        // Put it just PAST the line, not merely travelling towards it.
        // stepPossession (where we are now) runs before stepBounds in the same
        // frame, so a ball left short of the line gets collected by whoever is
        // standing there and the corner never happens -- which is exactly what
        // a full-match trace showed.
        const side = b.x >= 0 ? 1 : -1;
        const ownGoalZ = best.team === TEAM_MY ? MY_GOAL_Z : OPP_GOAL_Z;
        const behind = ownGoalZ < 0 ? -1 : 1;
        b.x = side * (GOAL_W / 2 + rand(0.8, 2.2));
        b.z = ownGoalZ + behind * 0.9;
        b.vx = side * rand(1, 3);
        b.vz = behind * rand(3, 6);
        b.vy = 1.6;
        best.cooldown = 0.4;
        a.lastTouch = best;      // defender's touch => corner, not a goal kick
        a.stat[best.team].saved++;
        toast(a, "🧤 " + lastName(best.name) + " tips it behind!");
      } else {
        b.vx *= -0.35; b.vz *= -0.35; b.vy = 3.2;
        best.cooldown = 0.4;
        a.lastTouch = best;
        toast(a, "🧤 Parried!");
      }
      return;
    }
    possessionChange(a, best);
  }

  // ----------------------------------------------------------------- restarts

  // Throw-ins, goal kicks and corners used to be an instant teleport. Now the
  // ball is placed dead, a taker walks to it, the other side backs off ten
  // yards and play restarts when someone actually reaches the ball. Costs
  // about a second and stops the match reading as a series of jump cuts.
  function beginRestart(a, kind, team, x, z) {
    const b = a.ball;
    b.owner = null; b.vx = b.vy = b.vz = 0;
    b.x = x; b.z = z; b.y = BALL_R;

    let taker = null, bd = 1e9;
    const list = a.players;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.team !== team) continue;
      if (kind === "goalkick") { if (p.isGK) taker = p; continue; }
      if (p.isGK) continue;
      const d = dist2(p.x, p.z, x, z);
      if (d < bd) { bd = d; taker = p; }
    }
    a.restart = { kind, team, x, z, taker, t: 0, wait: kind === "corner" ? 1.5 : 1.0 };
    a.tacticTimer = 0;
    if (taker && team === TEAM_MY) setControlled(a, taker);
    const label = kind === "corner" ? "Corner" : kind === "goalkick" ? "Goal kick" : "Throw-in";
    toast(a, (team === TEAM_MY ? "🟢 " : "🔴 ") + label, 1200);
  }

  function stepRestart(a, dt) {
    const r = a.restart;
    if (!r) return;
    r.t += dt;
    const b = a.ball;
    b.x = r.x; b.z = r.z; b.y = BALL_R;
    b.vx = b.vy = b.vz = 0;

    let taker = r.taker;
    if (!taker || taker.stun > 0) taker = null;
    const close = taker && dist(taker.x, taker.z, r.x, r.z) < 1.5;
    if ((close && r.t > 0.3) || r.t > r.wait + 2.6) {
      if (!taker || !close) {
        // Timed out (or the human wandered off) -- whoever is nearest takes it.
        let bd = 1e9;
        const list = a.players;
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
          if (p.team !== r.team) continue;
          const d = dist2(p.x, p.z, r.x, r.z);
          if (d < bd) { bd = d; taker = p; }
        }
      }
      a.restart = null;
      if (taker) {
        taker.x = lerp(taker.x, r.x, 0.5); taker.z = lerp(taker.z, r.z, 0.5);
        possessionChange(a, taker);
        a.lastTouch = taker;
      }
      a.tacticTimer = 0;
    }
  }

  function stepBounds(a) {
    const b = a.ball;
    if (!ballLive(a)) return;

    // Goal check first -- crossing the line inside the frame beats any
    // out-of-play handling. Deliberately also true for a carried ball: you can
    // dribble it over the line for a goal, exactly like the real thing.
    const inMouth = Math.abs(b.x) < GOAL_W / 2 && b.y < GOAL_H + 0.15;
    if (b.z > OPP_GOAL_Z && b.z < OPP_GOAL_Z + GOAL_DEPTH + 1 && inMouth) { onGoal(a, TEAM_MY); return; }
    if (b.z < MY_GOAL_Z && b.z > MY_GOAL_Z - GOAL_DEPTH - 1 && inMouth) { onGoal(a, TEAM_OPP); return; }

    const outSide = Math.abs(b.x) > PITCH_W / 2 + 0.4;
    const outEnd = Math.abs(b.z) > PITCH_L / 2 + 0.4;
    if (!outSide && !outEnd) return;

    // A ball that is being dribbled counts as out the moment it crosses the
    // line, and the carrier is the last touch. Without this a player could
    // simply run off the pitch with the ball and play would never stop --
    // possession was the only thing being checked before.
    let lastTeam;
    if (b.owner) {
      a.lastTouch = b.owner;
      lastTeam = b.owner.team;
      b.owner = null;
      b.vx = b.vy = b.vz = 0;
    } else {
      lastTeam = a.lastTouch ? a.lastTouch.team : TEAM_OPP;
    }
    const giveTo = lastTeam === TEAM_MY ? TEAM_OPP : TEAM_MY;
    // Throw-in: taken from the touchline at the point it went out, not from
    // somewhere out in the pitch. Only the length is pulled in, so a ball that
    // crosses right by the corner flag doesn't spawn the restart on top of it.
    let kind = "throw";
    let rx = (b.x > 0 ? 1 : -1) * (PITCH_W / 2 - 0.35);
    let rz = clamp(b.z, -PITCH_L / 2 + 4, PITCH_L / 2 - 4);
    // A ball that leaves over the goal line is never a throw-in, even if it
    // was drifting wide when it crossed -- check the end first.
    if (outEnd) {
      const conceding = b.z > 0 ? TEAM_OPP : TEAM_MY;
      if (giveTo === conceding) {
        kind = "goalkick";
        rx = clamp(b.x * 0.4, -8, 8);
        rz = b.z > 0 ? PITCH_L / 2 - 6 : -PITCH_L / 2 + 6;
      } else {
        kind = "corner";
        rx = b.x > 0 ? PITCH_W / 2 - 1.2 : -PITCH_W / 2 + 1.2;
        rz = b.z > 0 ? PITCH_L / 2 - 1.2 : -PITCH_L / 2 + 1.2;
      }
    }
    beginRestart(a, kind, giveTo, rx, rz);
  }

  function onGoal(a, team) {
    a.score[team]++;
    HUD.setScore(a, a.score.my, a.score.opp);
    const hero = a.lastTouch && a.lastTouch.team === team ? a.lastTouch : null;
    const scorer = hero ? lastName(hero.name) : null;
    if (team === TEAM_MY) {
      banner(a, "GOAL!", "#2FD180", 1700);
      toast(a, scorer ? "⚽ " + scorer + " scores!" : "⚽ GOAL!", 2200);
      if (window.playWin) window.playWin();
    } else {
      banner(a, "CONCEDED", "#FB5A5A", 1500);
      toast(a, scorer ? "😖 " + scorer + " scores for them." : "😖 They score.", 2200);
      if (window.playLose) window.playLose();
    }
    // Hold on the moment before the reset -- see celebrateMove().
    a.celebrate = 1.9;
    a.celebrateBy = hero;
    a.celebrateFor = team === TEAM_MY ? TEAM_OPP : TEAM_MY;
    if (hero) hero.celebrate = 1.9;
    a.ball.owner = null;
    a.ball.vx *= 0.2; a.ball.vz *= 0.2;
  }

  // -------------------------------------------------------------- camera step

  function stepCamera(a, dt) {
    const b = a.ball;
    // Broadcast-ish chase cam: sits behind the action relative to the direction
    // my team attacks, rising and pulling back as the ball speeds up.
    //
    // The tilt is deliberately steep (~40 degrees down rather than a flat
    // touchline angle). Phones are tall and narrow, so a shallow camera spends
    // the top half of the frame on empty sky and shrinks the players to specks;
    // looking down harder fills the screen with pitch and keeps the ball and
    // the nearby run of play readable at thumb distance.
    let fx = b.x, fz = b.z, fy = b.y;
    let speed = Math.hypot(b.vx, b.vz);
    if (a.celebrate > 0 && a.celebrateBy) {
      fx = a.celebrateBy.x; fz = a.celebrateBy.z; fy = 1.2; speed = 0;
    } else if (a.controlled) {
      // Nudge the frame toward the player you are driving so a manual switch to
      // a deep defender does not put them off-screen. Capped hard (6m) so the
      // ball stays the subject and the tuned framing survives.
      const dx = a.controlled.x - b.x, dz = a.controlled.z - b.z;
      const d = Math.hypot(dx, dz);
      if (d > 1) {
        const k = Math.min(6, d * 0.18) / d;
        fx += dx * k; fz += dz * k;
      }
    }

    const back = 24 + clamp(speed * 0.45, 0, 8);
    const high = 14.5 + clamp(speed * 0.3, 0, 6);
    const lookAhead = clamp(b.vz * 0.3, -7, 7);

    const tx = clamp(fx * 0.62, -PITCH_W / 2 + 8, PITCH_W / 2 - 8);
    const tz = fz - back;
    a.camPos.x = lerp(a.camPos.x, tx, Math.min(1, 3.4 * dt));
    a.camPos.y = lerp(a.camPos.y, high, Math.min(1, 2.6 * dt));
    a.camPos.z = lerp(a.camPos.z, tz, Math.min(1, 3.4 * dt));
    a.camera.position.set(a.camPos.x, a.camPos.y, a.camPos.z);

    a.camLook.x = lerp(a.camLook.x, fx * 0.75, Math.min(1, 5 * dt));
    a.camLook.y = lerp(a.camLook.y, Math.max(0.4, fy * 0.5), Math.min(1, 5 * dt));
    a.camLook.z = lerp(a.camLook.z, fz + lookAhead + 2.5, Math.min(1, 5 * dt));
    a.camera.lookAt(a.camLook.x, a.camLook.y, a.camLook.z);
  }

  // --------------------------------------------------------------- indicators

  // Aim arrow while charging a shot, plus a ring on whoever PASS would find.
  // Both are scene objects rather than HUD DOM because they have to sit on the
  // pitch in perspective -- an overlay cannot show you where you are aiming.
  function stepIndicators(a) {
    const c = a.controlled;
    const charging = a.input.shootHeld > 0 && c && a.ball.owner === c;
    if (a.aimArrow) {
      a.aimArrow.visible = !!charging;
      if (charging) {
        const w = stickWorld(a, a.input.mx, a.input.mz);
        let dx, dz;
        if (w.mag > 0.2) { dx = w.x; dz = w.z; }
        else {
          const gz = goalZFor(c.team);
          dx = 0 - c.x; dz = gz - c.z;
          const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        }
        a.aimArrow.position.set(c.x, 0.06, c.z);
        a.aimArrow.rotation.z = -Math.atan2(dz, dx);
        const f = a.input.shootHeld / 0.62;
        a.aimArrow.scale.set(0.6 + f * 0.9, 1, 1);
      }
    }
    if (a.tgtMarker) {
      const show = c && a.ball.owner === c && ballLive(a);
      let t = null;
      if (show) {
        const w = stickWorld(a, a.input.mx, a.input.mz);
        t = bestPassTarget(a, c, w.x, w.z, w.mag);
      }
      a.tgtMarker.visible = !!t;
      if (t) a.tgtMarker.position.set(t.x, 0.055, t.z);
    }
  }

  // ---------------------------------------------------------- control switch

  // You normally drive whoever is best placed -- the carrier if we have it,
  // otherwise the nearest outfielder to the ball, with hysteresis so control
  // doesn't flicker between two equidistant players. A manual SWITCH pins that
  // off until we win the ball back, because auto-switch fighting you is the
  // single most infuriating thing a football game can do.
  function updateControlled(a) {
    const b = a.ball;
    if (b.owner && b.owner.team === TEAM_MY) {
      a.manualHold = false;
      setControlled(a, b.owner);
      return;
    }
    if (a.restart && a.restart.team === TEAM_MY && a.restart.taker) {
      setControlled(a, a.restart.taker);
      return;
    }
    if (a.manualHold && a.controlled && a.t < a.manualUntil) return;
    a.manualHold = false;

    let best = null, bd = 1e9;
    const mine = a.teamMy;
    for (let i = 0; i < mine.length; i++) {
      const p = mine[i];
      if (p.isGK) continue;
      const d = dist2(p.x, p.z, b.x, b.z);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return;
    if (a.controlled && a.controlled !== best) {
      const cd = dist2(a.controlled.x, a.controlled.z, b.x, b.z);
      if (cd < bd * 1.55) return;   // keep current unless clearly worse
    }
    setControlled(a, best);
  }

  // Manual switch. With the stick pushed it picks the teammate best lined up
  // with that direction (so you can switch AT someone); centred it just cycles
  // outward by distance to the ball.
  function doSwitch(a) {
    const b = a.ball;
    const mine = a.teamMy;
    const cur = a.controlled;
    let best = null, bestScore = -1e9;
    const aimed = a.input.aimMag > 0.3;
    for (let i = 0; i < mine.length; i++) {
      const p = mine[i];
      if (p.isGK || p === cur) continue;
      let s;
      if (aimed && cur) {
        const dx = p.x - cur.x, dz = p.z - cur.z;
        const d = Math.hypot(dx, dz) || 1;
        const align = (dx / d) * a.input.aimX + (dz / d) * a.input.aimZ;
        if (align < 0.1) continue;
        s = align * 40 - d * 0.5;
      } else {
        // Cycle: prefer the next player further from the ball than the one you
        // are on, wrapping to the closest when you run out.
        const d = dist(p.x, p.z, b.x, b.z);
        const cd = cur ? dist(cur.x, cur.z, b.x, b.z) : 0;
        s = d > cd ? 100 - (d - cd) : 40 - d;
      }
      if (s > bestScore) { bestScore = s; best = p; }
    }
    if (!best) return false;
    setControlled(a, best);
    a.manualHold = true;
    a.manualUntil = a.t + 8;
    return true;
  }

  function setControlled(a, p) {
    if (a.controlled === p) return;
    if (a.marker && a.controlled) a.controlled.mesh.remove(a.marker);
    a.controlled = p;
    if (a.marker) p.mesh.add(a.marker);
    if (a.el.nameplate) {
      a.el.nameplate.innerHTML =
        '<span style="color:' + a.myColor + '">●</span> ' + p.name +
        ' <span style="opacity:.6">' + p.position + " " + p.attrs.power + "</span>";
    }
  }

  // ------------------------------------------------------------ human actions

  // One place where every button turns into something happening. Actions are
  // consumed once, on the frame after the press.
  function handleActions(a) {
    const c = a.controlled;
    const inp = a.input;
    if (!c) { clearWants(a); return; }

    if (inp.wantSwitch && a.celebrate <= 0) doSwitch(a);

    if (!ballLive(a) || c.stun > 0) { clearWants(a); return; }
    const onBall = a.ball.owner === c;

    if (onBall) {
      if (c.cooldown <= 0) {
        if (inp.wantShoot > 0) {
          const press = nearestOppDist(a, c.team, c.x, c.z);
          shoot(a, c, inp.wantShoot, clamp((3.5 - press) / 3.5, 0, 1),
            inp.aimX, inp.aimZ, inp.aimMag);
          toast(a, inp.aimMag > 0.25 ? "Aimed shot!" : "Shot!", 700);
        } else if (inp.wantThrough) {
          const t = bestThroughTarget(a, c, inp.aimX, inp.aimZ, inp.aimMag);
          if (t) {
            throughBall(a, c, t, a._thruX, a._thruZ);
            toast(a, "⇢ " + lastName(t.name) + " in behind!", 900);
          } else {
            const p2 = bestPassTarget(a, c, inp.aimX, inp.aimZ, inp.aimMag);
            if (p2) { pass(a, c, p2); toast(a, "→ " + lastName(p2.name), 800); }
          }
        } else if (inp.wantPass) {
          const t = bestPassTarget(a, c, inp.aimX, inp.aimZ, inp.aimMag);
          if (t) { pass(a, c, t); toast(a, "→ " + lastName(t.name), 800); }
        } else if (inp.wantSkill) {
          doSkill(a, c);
        }
      }
    } else {
      // Off the ball, TACKLE is press-or-call: lunge if you are close enough,
      // otherwise send the nearest teammate and keep your own position.
      if (inp.wantTackle) {
        if (!startTackle(a, c)) callPressure(a);
      }
      if (inp.wantSkill && c.stamina > 0.2) {
        // A burst to close ground -- cheap, but it does cost legs.
        const w = stickWorld(a, inp.mx, inp.mz);
        if (w.mag > 0.2) {
          c.vx = w.x * c.attrs.topSpeed * 1.3;
          c.vz = w.z * c.attrs.topSpeed * 1.3;
          c.stamina = Math.max(0, c.stamina - 0.1);
        }
      }
    }
    clearWants(a);
  }

  // ------------------------------------------------------------- clock / loop

  // The render call used to be the last statement of the step. That meant any
  // exception part-way through a frame skipped it -- and because the same
  // exception then recurred every frame, the picture stayed frozen on the last
  // good image while requestAnimationFrame carried on spinning. It looked
  // exactly like the game hanging at a random moment.
  //
  // Stepping and drawing are now separate: the step is allowed to fail, the
  // draw happens regardless, and a failing step tries to put the sim back into
  // a sane state instead of wedging.
  function frame(now) {
    if (!A) return;
    const a = A;
    a.raf = requestAnimationFrame(frame);

    try {
      stepFrame(a, now);
    } catch (err) {
      a.errCount = (a.errCount || 0) + 1;
      // Log the first few only; a per-frame error would otherwise flood the
      // console and make the page unusable in its own right.
      if (a.errCount <= 3) console.error("Match3D: frame step failed", err);
      recoverFrame(a);
    }

    // A step that ended the match tears the instance down, taking the renderer
    // with it -- don't try to draw a disposed context.
    if (A !== a || !a.renderer) return;
    try {
      a.renderer.render(a.scene, a.camera);
    } catch (e) {
      if ((a.errCount || 0) <= 3) console.error("Match3D: render failed", e);
    }
  }

  // Last-ditch repair. NaN is the usual culprit -- once a single position or
  // velocity goes non-finite it spreads through every steering calculation on
  // the next frame and the whole match silently stops moving.
  function recoverFrame(a) {
    const b = a.ball;
    if (b && (!isFinite(b.x) || !isFinite(b.y) || !isFinite(b.z) ||
              !isFinite(b.vx) || !isFinite(b.vy) || !isFinite(b.vz))) {
      b.x = 0; b.y = BALL_R; b.z = 0; b.vx = b.vy = b.vz = 0; b.owner = null;
    }
    const list = a.players || [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!isFinite(p.x) || !isFinite(p.z)) { p.x = p.homeX; p.z = p.homeZ; }
      if (!isFinite(p.vx) || !isFinite(p.vz)) { p.vx = 0; p.vz = 0; }
      if (!isFinite(p.facing)) p.facing = 0;
    }
  }

  function stepFrame(a, now) {
    let dt = (now - a.last) / 1000;
    a.last = now;
    if (a.paused) return;
    // Clamp so a backgrounded tab or a GC hitch can't teleport the sim.
    dt = Math.min(dt, 1 / 20);
    if (dt <= 0) return;
    a.t += dt;

    readKeyboard(a);
    if (a.input.shootHeld > 0) {
      a.input.shootHeld = Math.min(0.62, a.input.shootHeld + dt);
      const f = a.input.shootHeld / 0.62;
      if (a.el.powerRing) {
        a.el.powerRing.style.borderColor =
          f > 0.85 ? "#FB5A5A" : f > 0.5 ? "#FFB020" : "#2FD18066";
        a.el.powerRing.style.transform = "scale(" + (0.9 + f * 0.14) + ")";
      }
    }

    if (a.kickoffFreeze > 0) {
      a.kickoffFreeze -= dt;
      if (a.kickoffFreeze <= 0 && a.el.card) a.el.card.style.display = "none";
    }
    if (a.celebrate > 0) {
      a.celebrate -= dt;
      if (a.celebrate <= 0) resetKickoff(a, a.celebrateFor);
    }
    if (a.restart) stepRestart(a, dt);

    handleActions(a);

    // The opposition manager reads the game every couple of seconds. Cheap --
    // two integers and a clock -- but it is what makes a late lead feel like a
    // siege and a two-goal deficit feel like they are coming at you.
    a.aiMindTimer -= dt;
    if (a.aiMindTimer <= 0) { a.aiMindTimer = 2.0; updateOppMentality(a); }

    // Cadenced thinking -- see the header note. Everything O(n^2) is in here.
    a.tacticTimer -= dt;
    if (a.tacticTimer <= 0 && a.celebrate <= 0) {
      a.tacticTimer = 0.14;
      updateTactics(a);
    }

    stepPlayers(a, dt);
    stepBall(a, dt);
    stepPossession(a, dt);
    stepBounds(a);
    updateControlled(a);
    stepCamera(a, dt);
    stepIndicators(a);
    if (a.el.staminaFill) a.el.staminaFill.style.width =
      Math.round((a.controlled ? a.controlled.stamina : 1) * 100) + "%";

    // Match clock: each half runs halfSeconds of real time mapped to 45'.
    a.elapsed += dt;
    const minute = Math.min(45, Math.floor((a.elapsed / a.halfSeconds) * 45));
    const shown = (a.half === 1 ? 0 : 45) + minute;
    if (shown !== a.shownMinute) {
      a.shownMinute = shown;
      HUD.setClock(a, a.half, shown);
    }
    if (a.elapsed >= a.halfSeconds) { endHalf(a); return; }
  }

  function endHalf(a) {
    if (window.playWhistle) window.playWhistle();
    if (a.half === 1) {
      a.half = 2;
      a.running = false;
      cancelAnimationFrame(a.raf); a.raf = 0;
      titleCard(a, "HALF TIME", a.score.my + " - " + a.score.opp);
      hide(a);
      const cb = a.onHalfEnd;
      if (cb) cb(1, { my: a.score.my, opp: a.score.opp });
    } else {
      endMatch(a);
    }
  }

  function endMatch(a) {
    a.running = false;
    cancelAnimationFrame(a.raf); a.raf = 0;
    // Snapshot everything the caller needs BEFORE teardown() -- it nulls the
    // instance, so getScore()/getStats() are unavailable by the time the
    // callback runs.
    const score = {
      my: a.score.my, opp: a.score.opp,
      forfeited: a.forfeited,
      stat: { my: Object.assign({}, a.stat.my), opp: Object.assign({}, a.stat.opp) },
    };
    hide(a);
    const cb = a.onFullTime;
    teardown();
    if (cb) cb(score);
  }

  function hide(a) { if (a.root) a.root.style.display = "none"; }
  function show(a) { if (a.root) a.root.style.display = "block"; }

  // -------------------------------------------------------------- orientation

  // A football pitch is 105m long and 68m wide, so a portrait phone shows a
  // tall slice of a wide world -- you end up looking down a corridor. Landscape
  // is the right shape for the game.
  //
  // There is no single reliable way to force it on the web. Android Chrome will
  // honour an orientation lock, but ONLY while fullscreen, and iOS Safari does
  // not implement locking at all. So: ask for fullscreen, try to lock, and if
  // the device is still portrait afterwards, ask the player to turn the phone.
  // All three steps are best-effort -- none may throw into the match.
  function goLandscape(a) {
    const root = a.root;
    try {
      const req = root.requestFullscreen || root.webkitRequestFullscreen || root.webkitRequestFullScreen;
      if (req) {
        const p = req.call(root, { navigationUI: "hide" });
        if (p && p.then) p.then(lockOrientation, lockOrientation);
        else lockOrientation();
      } else {
        lockOrientation();
      }
    } catch (e) { lockOrientation(); }

    a.onOrient = () => { if (A === a) updateRotatePrompt(a); };
    window.addEventListener("resize", a.onOrient);
    window.addEventListener("orientationchange", a.onOrient);
    // Give the browser a moment to settle after a lock/fullscreen request
    // before judging the orientation, or we flash the prompt unnecessarily.
    setTimeout(() => { if (A === a) updateRotatePrompt(a); }, 450);
  }

  function lockOrientation() {
    try {
      const so = window.screen && window.screen.orientation;
      if (so && so.lock) {
        const p = so.lock("landscape");
        if (p && p.catch) p.catch(() => {});   // unsupported / rejected: fine
      }
    } catch (e) {}
  }

  function isPortrait() {
    return window.innerHeight > window.innerWidth;
  }

  // Shown only while the device is actually portrait. Deliberately does not
  // pause the match -- on a tablet or desktop, portrait is unusual but still
  // playable, and freezing the game behind an un-dismissable prompt would be
  // worse than a slightly awkward view.
  function updateRotatePrompt(a) {
    if (!a.root) return;
    const want = isPortrait();
    if (want && !a.rotateEl) {
      const el = document.createElement("div");
      el.setAttribute("style",
        "position:absolute;inset:0;z-index:8;display:flex;flex-direction:column;" +
        "align-items:center;justify-content:center;gap:14px;text-align:center;padding:24px;" +
        "background:rgba(6,10,18,.93);font-family:'Outfit',system-ui,sans-serif");
      el.innerHTML =
        '<div style="font-size:46px;line-height:1;animation:none">📱</div>' +
        '<div style="font-family:\'Teko\',sans-serif;font-size:34px;line-height:1;color:#fff">' +
        "ROTATE YOUR PHONE</div>" +
        '<div style="font-size:12.5px;color:#6C84A3;max-width:260px;line-height:1.5">' +
        "Turn the device sideways to play. The pitch is far too wide to fit " +
        "on an upright screen.</div>";
      a.root.appendChild(el);
      a.rotateEl = el;
    } else if (!want && a.rotateEl) {
      if (a.rotateEl.parentNode) a.rotateEl.parentNode.removeChild(a.rotateEl);
      a.rotateEl = null;
    }
  }

  // Only detaches this match's listeners. It deliberately does NOT unlock the
  // orientation or leave fullscreen any more: the whole app is landscape now,
  // and index.html applies that lock once on the first tap and never reapplies
  // it. Releasing here dropped the player back into portrait menus, in a
  // window, for the rest of the session after their first match.
  function exitLandscape(a) {
    try {
      window.removeEventListener("resize", a.onOrient);
      window.removeEventListener("orientationchange", a.onOrient);
    } catch (e) {}
  }

  // ------------------------------------------------------------------ public

  // Starts a fresh match and plays the first half. cfg:
  //   myLineup, oppLineup   {slotId: card}
  //   formationKey, oppFormationKey
  //   myName, myColor, oppName, oppColor
  //   halfSeconds           real seconds per half (default 75)
  //   toughness             optional 0..8, index.html's streak difficulty
  //   onHalfEnd(half, score), onFullTime(score)
  M.begin = function (cfg) {
    if (!M.available()) return false;
    THREE = window.THREE;
    VIS = window.Match3DVisuals;
    HUD = window.Match3DHud;
    teardown();

    const myColor = cfg.myColor || "#52D68A";
    const oppColor = cfg.oppColor || "#FF6B6B";

    const a = {
      t: 0, elapsed: 0, half: 1, shownMinute: -1,
      halfSeconds: cfg.halfSeconds || 75,
      score: { my: 0, opp: 0 },
      stat: { my: { shots: 0, passes: 0, saved: 0 }, opp: { shots: 0, passes: 0, saved: 0 } },
      myName: cfg.myName || "My Team", oppName: cfg.oppName || "Opponent",
      myColor: myColor, oppColor: oppColor,
      onHalfEnd: cfg.onHalfEnd, onFullTime: cfg.onFullTime,
      formationKey: cfg.formationKey, oppFormationKey: cfg.oppFormationKey,
      el: {}, paused: false, running: true, forfeited: false,
      camPos: { x: 0, y: 16, z: -30 }, camLook: { x: 0, y: 0, z: 0 },
      kickoffFreeze: 1.4, lastTouch: null, controlled: null,
      celebrate: 0, celebrateBy: null, celebrateFor: TEAM_OPP,
      restart: null, tacticTimer: 0,
      manualHold: false, manualUntil: -1,
      pressMate: null, pressUntil: -1,
      oppEdge: 0,
      // Team mentality, switchable mid-match. Indices into MENTALITY.
      mind: { my: MENT_BAL, opp: MENT_BAL },
      aiMindTimer: 6, oppMindToast: 0,
      lineMy: 40, lineOpp: 40,
      // Scratch objects reused every frame so the hot path never allocates.
      _sw: { x: 0, z: 0, mag: 0 },
      _st: {
        speed: 0, facing: 0, t: 0, kicking: false, stunned: false, hasBall: false,
        controlled: false, tackling: false, celebrating: false, sprinting: false,
        stamina: 1, team: TEAM_MY,
      },
      _bufMy: [], _bufOpp: [],
      _score: 0, _thruX: 0, _thruZ: 0,
      // near post / far post / penalty spot / edge-of-box, as (|x|, depth) pairs.
      _cornerSpots: [4.5, 5.5, 2.0, 11.0, 8.5, 13.0, 1.0, 18.0],
    };

    a.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    a.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    a.renderer.setSize(window.innerWidth, window.innerHeight, false);
    if (THREE.SRGBColorSpace) a.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // The visuals module owns the look but not the renderer, so this is the
    // only place shadow maps and tone mapping can actually be switched on.
    // Optional by contract -- older copies of that module won't have it.
    if (VIS.configureRenderer) VIS.configureRenderer(a.renderer);

    a.world = VIS.buildStadium(THREE, { shadows: a.quality !== "low" });
    a.scene = a.world.scene;
    // 46 degrees VERTICAL fov. three.js measures fov vertically, and phones are
    // tall -- the usual ~58 spans so much height that half the frame is sky and
    // the players shrink to specks. Narrower keeps them legible without having
    // to flatten the camera into a top-down view.
    a.camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.5, 400);

    a.shared = VIS.makeKitSet(THREE, myColor, oppColor);
    a.teamMy = buildTeam(TEAM_MY, cfg.myLineup, cfg.formationKey || "balanced", myColor, a.shared, a.scene);
    a.teamOpp = buildTeam(TEAM_OPP, cfg.oppLineup, cfg.oppFormationKey || "balanced", oppColor, a.shared, a.scene);
    a.players = a.teamMy.concat(a.teamOpp);
    a.gk = { my: null, opp: null };
    for (let i = 0; i < a.players.length; i++) if (a.players[i].isGK) a.gk[a.players[i].team] = a.players[i];

    // Difficulty. index.html scales the opponent SQUAD by `toughness`; if it
    // also passes the number we scale their PLAY -- reactions, pressing and
    // decision quality. With no number we infer it from the power gap so the
    // hook does something useful today either way.
    if (cfg.toughness != null) {
      a.oppEdge = clamp(cfg.toughness / 8, 0, 1) * 0.85;
    } else {
      a.oppEdge = clamp((avgPower(a.teamOpp) - avgPower(a.teamMy)) / 22, 0, 0.85);
    }

    // Ball + its shadow.
    a.ball = { x: 0, y: BALL_R, z: 0, vx: 0, vy: 0, vz: 0, owner: null };
    const ballParts = VIS.createBall(THREE);
    a.ballMesh = ballParts.mesh;
    a.ballShadow = ballParts.shadow;
    a.scene.add(a.ballMesh);
    a.scene.add(a.ballShadow);

    // Ring under the player you're driving.
    a.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.62, 0.82, 18),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(myColor), transparent: true, opacity: 0.9, side: THREE.DoubleSide })
    );
    a.marker.rotation.x = -Math.PI / 2;
    a.marker.position.y = 0.05;

    // Faint ring on whoever PASS would pick, so directional passing is
    // learnable instead of a lottery.
    a.tgtMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.66, 14),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(myColor), transparent: true, opacity: 0.42, side: THREE.DoubleSide })
    );
    a.tgtMarker.rotation.x = -Math.PI / 2;
    a.tgtMarker.visible = false;
    a.scene.add(a.tgtMarker);

    // Shot aim arrow: a flat wedge on the grass anchored at the player. Built
    // pointing down +X so rotation.z (after the -90 x-tilt) is a plain yaw.
    const aimGeo = new THREE.PlaneGeometry(5.2, 0.85);
    aimGeo.translate(2.9, 0, 0);
    a.aimArrow = new THREE.Mesh(aimGeo, new THREE.MeshBasicMaterial({
      color: new THREE.Color("#FFB020"), transparent: true, opacity: 0.42, side: THREE.DoubleSide,
    }));
    a.aimArrow.rotation.x = -Math.PI / 2;
    a.aimArrow.visible = false;
    a.scene.add(a.aimArrow);

    A = a;
    const built = HUD.build({
      canvas: a.renderer.domElement,
      myName: a.myName, myColor: a.myColor,
      oppName: a.oppName, oppColor: a.oppColor,
    });
    a.root = built.root; a.el = built.el;
    document.body.appendChild(a.root);
    bindControls(a);
    goLandscape(a);
    // Paint the tactics bar with the starting shape before the first frame, so
    // it is never briefly blank or showing the wrong chip.
    if (HUD.setMentality) HUD.setMentality(a, a.mind.my);
    if (HUD.setOppMentality) HUD.setOppMentality(a, a.mind.opp);

    resetKickoff(a, TEAM_MY);
    a.kickoffFreeze = 1.4;
    updateTactics(a);
    updateControlled(a);
    titleCard(a, "KICK OFF", a.myName + "  vs  " + a.oppName, 1400);
    if (window.ensureAudio) window.ensureAudio();
    if (window.playWhistle) window.playWhistle();

    a.last = performance.now();
    a.raf = requestAnimationFrame(frame);
    return true;
  };

  function avgPower(list) {
    if (!list.length) return 70;
    let s = 0;
    for (let i = 0; i < list.length; i++) s += list[i].attrs.power;
    return s / list.length;
  }

  // Resumes into the second half, optionally with a substituted lineup.
  M.resumeSecondHalf = function (newMyLineup) {
    const a = A;
    if (!a) return false;
    if (newMyLineup) {
      // Re-point existing my-team players at whatever card now occupies their
      // slot, so a halftime sub is reflected without rebuilding the scene.
      for (let i = 0; i < a.teamMy.length; i++) {
        const p = a.teamMy[i];
        const card = newMyLineup[p.slotId];
        if (!card) continue;
        if (p.card && card.id === p.card.id) continue;
        p.card = card; p.name = card.name;
        p.attrs = deriveAttrs(card, p.position);
      }
    }
    a.elapsed = 0; a.half = 2; a.shownMinute = -1;
    a.paused = false;
    if (a.el.pauseSheet) a.el.pauseSheet.style.display = "none";
    show(a);
    resetKickoff(a, TEAM_OPP);
    // Fresh legs after the break -- the interval is a real reset, and without
    // it a sprint-heavy first half would leave you walking through the second.
    for (let i = 0; i < a.players.length; i++) a.players[i].stamina = 1;
    a.manualHold = false;
    a.kickoffFreeze = 1.4;
    updateTactics(a);
    updateControlled(a);
    titleCard(a, "2ND HALF", a.score.my + " - " + a.score.opp, 1400);
    if (window.playWhistle) window.playWhistle();
    a.last = performance.now();
    a.running = true;
    a.raf = requestAnimationFrame(frame);
    return true;
  };

  // Optional extras -- purely additive, nothing in index.html has to call them.
  // Lets a caller drive the mentality from outside (a pre-match team-talk, a
  // keyboard shortcut, a tutorial) without reaching into the instance.
  M.setMentality = function (idx) { return A ? setMyMentality(A, idx) : false; };
  M.getMentality = function () {
    if (!A) return null;
    const m = MENTALITY[A.mind.my], o = MENTALITY[A.mind.opp];
    return { index: A.mind.my, key: m.key, name: m.name, oppIndex: A.mind.opp, oppKey: o.key };
  };

  M.getScore = function () { return A ? { my: A.score.my, opp: A.score.opp } : null; };
  M.getStats = function () { return A ? JSON.parse(JSON.stringify(A.stat)) : null; };

  // Lightweight positional snapshot for a HUD radar/minimap. Mutates a cached
  // structure in place -- this can legitimately be polled every frame, so it
  // must not allocate. Coordinates are world metres; `pitch` gives the extents
  // to normalise against.
  M.getRadar = function () {
    const a = A;
    if (!a) return null;
    const r = a._radar || (a._radar = {
      players: [], ball: { x: 0, z: 0, y: 0 }, pitch: { w: PITCH_W, l: PITCH_L },
      stamina: 1, name: "",
    });
    const list = a.players;
    while (r.players.length < list.length) {
      r.players.push({ x: 0, z: 0, team: TEAM_MY, controlled: false, gk: false, ball: false });
    }
    r.players.length = list.length;
    for (let i = 0; i < list.length; i++) {
      const p = list[i], o = r.players[i];
      o.x = p.x; o.z = p.z; o.team = p.team;
      o.controlled = p === a.controlled;
      o.gk = p.isGK;
      o.ball = a.ball.owner === p;
    }
    r.ball.x = a.ball.x; r.ball.z = a.ball.z; r.ball.y = a.ball.y;
    r.stamina = a.controlled ? a.controlled.stamina : 1;
    r.name = a.controlled ? a.controlled.name : "";
    return r;
  };

  // Full teardown -- disposes GL resources and removes every listener. Called
  // on full time, on abort, and defensively at the start of every begin().
  function teardown() {
    const a = A;
    if (!a) return;
    A = null;
    if (a.raf) cancelAnimationFrame(a.raf);
    clearTimeout(a.toastTimer); clearTimeout(a.bannerTimer); clearTimeout(a.cardTimer);
    // Hand the screen back before anything else -- leaving the app locked to
    // landscape and fullscreen after the whistle would strand the player in a
    // sideways menu.
    exitLandscape(a);
    try {
      window.removeEventListener("keydown", a.onKeyDown);
      window.removeEventListener("keyup", a.onKeyUp);
      window.removeEventListener("resize", a.onResize);
      window.removeEventListener("orientationchange", a.onResize);
      if (a.handlers) {
        window.removeEventListener("mousemove", a.handlers.onMove);
        window.removeEventListener("mouseup", a.handlers.onUp);
      }
    } catch (e) {}
    try {
      // The control marker lives parented to a player, so it is inside the
      // scene graph and gets disposed by the traverse below along with
      // everything else.
      a.scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
        }
      });
      if (a.marker && !a.marker.parent) {
        a.marker.geometry.dispose(); a.marker.material.dispose();
      }
      a.renderer.dispose();
      if (a.renderer.forceContextLoss) a.renderer.forceContextLoss();
    } catch (e) {}
    if (VIS && VIS.disposeShared) VIS.disposeShared(a.shared);
    if (a.root && a.root.parentNode) a.root.parentNode.removeChild(a.root);
  }

  M.stop = teardown;

  window.Match3D = M;
})();
