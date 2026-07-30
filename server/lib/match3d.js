// TCG Manager -- live 3D match arena.
//
// Replaces the old "watch four zone comparisons resolve on a timer" match with
// a real, playable game: you control one outfield player, everyone else is AI,
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
//    keeper reflex -- so a stronger squad genuinely plays better instead of
//    just winning a dice roll.
// 4. If three.js or WebGL is unavailable, available() returns false and
//    index.html silently falls back to the legacy timed zone reveal. The old
//    path is kept intact for exactly this reason -- never assume the 3D mode
//    can run.
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

  const TEAM_MY = "my", TEAM_OPP = "opp";

  // Per-position tuning applied on top of the power-derived baseline.
  const ROLE_MOD = {
    GK:  { speed: -0.12, shot: -0.25, pass: 0.00, tackle: 0.00, reflex: 0.35 },
    DEF: { speed: -0.04, shot: -0.12, pass: 0.02, tackle: 0.22, reflex: 0.00 },
    MID: { speed:  0.02, shot:  0.00, pass: 0.18, tackle: 0.06, reflex: 0.00 },
    FWD: { speed:  0.10, shot:  0.20, pass: 0.00, tackle: -0.06, reflex: 0.00 },
  };

  // ------------------------------------------------------------------- module

  const M = {};
  let THREE = null;

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
      shotPower: (17 + n * 13) * (1 + mod.shot),
      shotAccuracy: clamp(0.42 + n * 0.46 + mod.shot * 0.3, 0.15, 0.96),
      passAccuracy: clamp(0.5 + n * 0.42 + mod.pass, 0.2, 0.98),
      control: 0.45 + n * 0.45,          // resists being tackled
      tackle: clamp(0.35 + n * 0.45 + mod.tackle, 0.1, 0.95),
      reflex: clamp(0.4 + n * 0.45 + mod.reflex, 0.2, 0.98),
      vision: 12 + n * 16,               // how far the AI looks for a pass
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
    if (!hasWebGL()) return false;
    return true;
  };

  M.isRunning = function () { return !!A; };

  // ------------------------------------------------------------ pitch texture

  // Draws the full pitch marking set into a canvas once, used as the ground
  // texture. Cheaper and sharper than building line geometry, and it means the
  // mow-stripe pattern, circles and boxes all come for free.
  function makePitchTexture() {
    const px = 16;                                  // pixels per metre
    const cw = Math.round(PITCH_W * px), ch = Math.round(PITCH_L * px);
    const cv = document.createElement("canvas");
    cv.width = cw; cv.height = ch;
    const g = cv.getContext("2d");

    // Mow stripes down the length of the pitch.
    const stripes = 14, sh = ch / stripes;
    for (let i = 0; i < stripes; i++) {
      g.fillStyle = i % 2 ? "#1F7A46" : "#1B6C3E";
      g.fillRect(0, i * sh, cw, sh + 1);
    }
    // Subtle wear/vignette so flat green doesn't read as plastic.
    const vg = g.createRadialGradient(cw / 2, ch / 2, ch * 0.15, cw / 2, ch / 2, ch * 0.72);
    vg.addColorStop(0, "rgba(255,255,255,0.05)");
    vg.addColorStop(1, "rgba(0,0,0,0.22)");
    g.fillStyle = vg; g.fillRect(0, 0, cw, ch);

    const m = (v) => v * px;
    g.strokeStyle = "rgba(255,255,255,0.82)";
    g.lineWidth = Math.max(2, 0.12 * px);
    g.lineCap = "butt";

    // Touchlines / goal lines, inset a touch so the paint isn't on the edge.
    const pad = m(0.4);
    g.strokeRect(pad, pad, cw - pad * 2, ch - pad * 2);
    // Halfway line + centre circle + spot.
    g.beginPath(); g.moveTo(pad, ch / 2); g.lineTo(cw - pad, ch / 2); g.stroke();
    g.beginPath(); g.arc(cw / 2, ch / 2, m(9.15), 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(cw / 2, ch / 2, m(0.35), 0, Math.PI * 2); g.fillStyle = "rgba(255,255,255,0.85)"; g.fill();

    // Both ends: penalty box, six-yard box, penalty spot, D-arc.
    [0, 1].forEach((end) => {
      const dir = end === 0 ? 1 : -1;
      const gl = end === 0 ? pad : ch - pad;                  // goal line y
      const boxD = m(16.5), boxW = m(40.32);
      const sixD = m(5.5), sixW = m(18.32);
      g.strokeRect(cw / 2 - boxW / 2, gl, boxW, boxD * dir);
      g.strokeRect(cw / 2 - sixW / 2, gl, sixW, sixD * dir);
      const spotY = gl + m(11) * dir;
      g.beginPath(); g.arc(cw / 2, spotY, m(0.35), 0, Math.PI * 2); g.fill();
      g.beginPath();
      g.arc(cw / 2, spotY, m(9.15),
        end === 0 ? 0.30 : Math.PI + 0.30,
        end === 0 ? Math.PI - 0.30 : Math.PI * 2 - 0.30);
      g.stroke();
    });

    const tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 4;
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // ------------------------------------------------------------- scene build

  function buildScene(myColor, oppColor) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x060A12);
    scene.fog = new THREE.Fog(0x0A1424, 95, 240);

    // Night sky: a big inward-facing sphere with a vertical gradient. Without
    // this, anything above the stands reads as a flat black void and the
    // horizon line looks like a rendering bug rather than a stadium at night.
    const skyCv = document.createElement("canvas");
    skyCv.width = 4; skyCv.height = 128;
    const sg = skyCv.getContext("2d");
    const grad = sg.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, "#050A13");
    grad.addColorStop(0.5, "#0B1727");
    grad.addColorStop(0.82, "#152A42");
    grad.addColorStop(1, "#1E3A57");
    sg.fillStyle = grad; sg.fillRect(0, 0, 4, 128);
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(300, 16, 12),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(skyCv), side: THREE.BackSide, fog: false })
    );
    scene.add(sky);

    // Grass.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(PITCH_W, PITCH_L),
      new THREE.MeshBasicMaterial({ map: makePitchTexture() })
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // Surrounding dark apron so the pitch doesn't float in space.
    const apron = new THREE.Mesh(
      new THREE.PlaneGeometry(PITCH_W + 26, PITCH_L + 26),
      new THREE.MeshBasicMaterial({ color: 0x0B2216 })
    );
    apron.rotation.x = -Math.PI / 2; apron.position.y = -0.02;
    scene.add(apron);

    // Stands: four tiered slabs, plus a speckled "crowd" band on each so the
    // stadium reads as occupied without any real geometry or textures.
    // Kept deliberately dark and low. Anything brighter or taller turns into a
    // flat wall across the top of the frame when the camera swings behind a
    // goal -- the stands are backdrop, not scenery to look at.
    const standMat = new THREE.MeshBasicMaterial({ color: 0x121D2E });
    const addStand = (w, d, x, z, rotY) => {
      const gp = new THREE.Group();
      for (let t = 0; t < 3; t++) {
        const h = 2.2 + t * 1.7;
        const slab = new THREE.Mesh(new THREE.BoxGeometry(w, h, d / 3), standMat);
        slab.position.set(0, h / 2, -(d / 3) * t - d / 6);
        gp.add(slab);
        const crowd = new THREE.Mesh(
          new THREE.PlaneGeometry(w * 0.98, h * 0.5),
          new THREE.MeshBasicMaterial({ map: crowdTexture(), transparent: true })
        );
        crowd.position.set(0, h * 0.72, -(d / 3) * t - d / 6 + d / 6.4);
        gp.add(crowd);
      }
      gp.position.set(x, 0, z); gp.rotation.y = rotY;
      scene.add(gp);
    };
    addStand(PITCH_W + 24, 22, 0, -(PITCH_L / 2 + 17), 0);
    addStand(PITCH_W + 24, 22, 0, (PITCH_L / 2 + 17), Math.PI);
    addStand(PITCH_L + 24, 22, -(PITCH_W / 2 + 16), 0, Math.PI / 2);
    addStand(PITCH_L + 24, 22, (PITCH_W / 2 + 16), 0, -Math.PI / 2);

    // Floodlight glows in the corners -- cheap sprites, purely atmospheric.
    [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([sx, sz]) => {
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(2.4, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xBFD8FF, transparent: true, opacity: 0.5 })
      );
      glow.position.set(sx * (PITCH_W / 2 + 14), 22, sz * (PITCH_L / 2 + 14));
      scene.add(glow);
    });

    // Floodlighting. Players and the ball use Lambert materials so they pick
    // up real shading -- unlit flat colour reads as a board game rather than a
    // stadium. Ambient stays high so nothing on the far side goes to mud.
    scene.add(new THREE.AmbientLight(0xC8D8F0, 1.55));
    const key = new THREE.DirectionalLight(0xFFF4E0, 1.5);
    key.position.set(28, 46, -18);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x9FC4FF, 0.75);
    fill.position.set(-30, 30, 26);
    scene.add(fill);

    // Goals: posts, crossbar and a translucent net panel at each end.
    const postMat = new THREE.MeshLambertMaterial({ color: 0xF2F6FC });
    const netMat = new THREE.MeshBasicMaterial({
      color: 0xDCE6F5, transparent: true, opacity: 0.16, side: THREE.DoubleSide,
    });
    [MY_GOAL_Z, OPP_GOAL_Z].forEach((gz) => {
      const inward = gz < 0 ? 1 : -1;
      const gp = new THREE.Group();
      [-1, 1].forEach((s) => {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, GOAL_H, 6), postMat);
        post.position.set(s * GOAL_W / 2, GOAL_H / 2, 0);
        gp.add(post);
      });
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, GOAL_W, 6), postMat);
      bar.rotation.z = Math.PI / 2; bar.position.y = GOAL_H;
      gp.add(bar);
      const net = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_W, GOAL_H), netMat);
      net.position.set(0, GOAL_H / 2, -inward * GOAL_DEPTH);
      gp.add(net);
      [-1, 1].forEach((s) => {
        const side = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_DEPTH, GOAL_H), netMat);
        side.rotation.y = Math.PI / 2;
        side.position.set(s * GOAL_W / 2, GOAL_H / 2, -inward * GOAL_DEPTH / 2);
        gp.add(side);
      });
      gp.position.z = gz;
      scene.add(gp);
    });

    return scene;
  }

  // Tiny noise texture reused for every crowd band.
  let _crowdTex = null;
  function crowdTexture() {
    if (_crowdTex) return _crowdTex;
    const cv = document.createElement("canvas");
    cv.width = 128; cv.height = 32;
    const g = cv.getContext("2d");
    g.fillStyle = "rgba(8,14,24,0.9)"; g.fillRect(0, 0, 128, 32);
    const tones = ["#33425E", "#425474", "#2A3752", "#4E6084", "#222E47"];
    for (let i = 0; i < 900; i++) {
      g.fillStyle = tones[(Math.random() * tones.length) | 0];
      g.fillRect(Math.random() * 128, Math.random() * 32, 1.6, 1.6);
    }
    _crowdTex = new THREE.CanvasTexture(cv);
    return _crowdTex;
  }

  // Player avatar: capsule torso + head + a flat shadow ellipse. Built from
  // shared geometry, one material per team, so 22 of these stay cheap.
  function makePlayerMesh(shared, teamColorHex, isGK) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(shared.body, isGK ? shared.gkMat[teamColorHex] : shared.bodyMat[teamColorHex]);
    body.position.y = 0.86;
    g.add(body);
    const head = new THREE.Mesh(shared.head, shared.skinMat);
    head.position.y = 1.62;
    g.add(head);
    const shadow = new THREE.Mesh(shared.shadow, shared.shadowMat);
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.02;
    g.add(shadow);
    return g;
  }

  function makeShared(myColor, oppColor) {
    const bodyGeo = THREE.CapsuleGeometry
      ? new THREE.CapsuleGeometry(0.36, 0.78, 4, 8)
      : new THREE.CylinderGeometry(0.36, 0.36, 1.5, 8);
    const mk = (hex) => new THREE.MeshLambertMaterial({ color: new THREE.Color(hex) });
    const dim = (hex) => {
      const c = new THREE.Color(hex); c.multiplyScalar(0.55);
      return new THREE.MeshLambertMaterial({ color: c });
    };
    return {
      body: bodyGeo,
      head: new THREE.SphereGeometry(0.24, 10, 8),
      shadow: new THREE.CircleGeometry(0.5, 12),
      shadowMat: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32 }),
      skinMat: new THREE.MeshLambertMaterial({ color: 0xE8B48C }),
      bodyMat: { [myColor]: mk(myColor), [oppColor]: mk(oppColor) },
      gkMat: { [myColor]: dim(myColor), [oppColor]: dim(oppColor) },
    };
  }

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
      const mesh = makePlayerMesh(shared, colorHex, slot.position === "GK");
      mesh.position.set(hx, 0, hz);
      scene.add(mesh);
      out.push({
        team, slotId: slot.id, position: slot.position,
        card: card || { name: "Reserve", power: 62, rarity: "Common" },
        name: card ? card.name : "Reserve",
        attrs, mesh,
        homeX: hx, homeZ: hz,
        x: hx, z: hz, vx: 0, vz: 0,
        facing: team === TEAM_MY ? 0 : Math.PI,
        isGK: slot.position === "GK",
        cooldown: 0,      // blocks instant re-tackle / re-shoot
        stun: 0,
      });
    });
    return out;
  }

  // ---------------------------------------------------------------- HUD / DOM

  function h(tag, style, html) {
    const e = document.createElement(tag);
    if (style) e.setAttribute("style", style);
    if (html != null) e.innerHTML = html;
    return e;
  }

  function buildOverlay(a) {
    const root = h("div",
      "position:fixed;inset:0;z-index:9000;background:#060A12;" +
      "touch-action:none;-webkit-user-select:none;user-select:none;overflow:hidden;" +
      "font-family:'Outfit',system-ui,sans-serif");

    root.appendChild(a.renderer.domElement);
    a.renderer.domElement.setAttribute("style", "position:absolute;inset:0;width:100%;height:100%;display:block");

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
    bar.appendChild(chip(a.myColor, a.myName));
    a.el.score = h("div",
      "font-family:'Teko',sans-serif;font-size:30px;line-height:1;font-weight:700;color:#fff;" +
      "letter-spacing:.04em;padding:0 4px;text-shadow:0 2px 10px rgba(0,0,0,.6)", "0 - 0");
    bar.appendChild(a.el.score);
    bar.appendChild(chip(a.oppColor, a.oppName));
    root.appendChild(bar);

    a.el.clock = h("div",
      "position:absolute;top:calc(env(safe-area-inset-top,0px) + 44px);left:50%;transform:translateX(-50%);" +
      "font-size:11px;font-weight:800;letter-spacing:.14em;color:#FFB020;pointer-events:none;" +
      "text-shadow:0 1px 6px rgba(0,0,0,.8)", "1ST HALF &middot; 0'");
    root.appendChild(a.el.clock);

    // --- commentary / event toast
    a.el.toast = h("div",
      "position:absolute;top:calc(env(safe-area-inset-top,0px) + 68px);left:50%;transform:translateX(-50%);" +
      "max-width:86vw;text-align:center;font-size:13px;font-weight:800;color:#F3F6FA;pointer-events:none;" +
      "opacity:0;transition:opacity .25s ease;text-shadow:0 2px 8px rgba(0,0,0,.9)");
    root.appendChild(a.el.toast);

    // --- big goal banner
    a.el.banner = h("div",
      "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
      "pointer-events:none;opacity:0;transition:opacity .2s ease");
    a.el.bannerText = h("div",
      "font-family:'Teko',sans-serif;font-size:14vw;font-weight:700;letter-spacing:.06em;color:#fff;" +
      "text-shadow:0 6px 30px rgba(0,0,0,.8)");
    a.el.banner.appendChild(a.el.bannerText);
    root.appendChild(a.el.banner);

    // --- controlled-player nameplate
    a.el.nameplate = h("div",
      "position:absolute;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 148px);" +
      "transform:translateX(-50%);pointer-events:none;font-size:11px;font-weight:800;color:#F3F6FA;" +
      "background:rgba(6,10,18,.55);border:1px solid rgba(255,255,255,.14);border-radius:999px;" +
      "padding:3px 10px;white-space:nowrap");
    root.appendChild(a.el.nameplate);

    // --- joystick (left thumb). Base is fixed; the knob tracks the drag.
    a.el.stickBase = h("div",
      "position:absolute;left:22px;bottom:calc(env(safe-area-inset-bottom,0px) + 26px);" +
      "width:124px;height:124px;border-radius:50%;background:rgba(255,255,255,.07);" +
      "border:1px solid rgba(255,255,255,.16);pointer-events:none");
    a.el.stickKnob = h("div",
      "position:absolute;left:50%;top:50%;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;" +
      "background:rgba(243,246,250,.34);border:1px solid rgba(255,255,255,.4);" +
      "transition:transform .04s linear");
    a.el.stickBase.appendChild(a.el.stickKnob);
    root.appendChild(a.el.stickBase);

    // --- action buttons (right thumb)
    const mkBtn = (label, sub, color, bottom, right, size) => {
      const b = h("div",
        "position:absolute;right:" + right + "px;bottom:calc(env(safe-area-inset-bottom,0px) + " + bottom + "px);" +
        "width:" + size + "px;height:" + size + "px;border-radius:50%;display:flex;flex-direction:column;" +
        "align-items:center;justify-content:center;gap:1px;background:" + color + "33;border:2px solid " + color + ";" +
        "color:" + color + ";font-weight:900;font-size:" + (size > 74 ? 15 : 13) + "px;letter-spacing:.06em;" +
        "box-shadow:0 4px 18px rgba(0,0,0,.45);cursor:pointer",
        label + (sub ? '<span style="font-size:8px;opacity:.75;font-weight:800">' + sub + "</span>" : ""));
      return b;
    };
    a.el.btnShoot = mkBtn("SHOOT", "hold=power", "#FB5A5A", 96, 22, 86);
    a.el.btnPass = mkBtn("PASS", "", "#2FD180", 30, 118, 70);
    a.el.btnSprint = mkBtn("RUN", "", "#FFB020", 34, 26, 62);
    root.appendChild(a.el.btnShoot);
    root.appendChild(a.el.btnPass);
    root.appendChild(a.el.btnSprint);

    // Shot power meter wraps the shoot button while it's held.
    a.el.powerRing = h("div",
      "position:absolute;right:14px;bottom:calc(env(safe-area-inset-bottom,0px) + 88px);" +
      "width:102px;height:102px;border-radius:50%;pointer-events:none;opacity:0;transition:opacity .12s ease;" +
      "border:3px solid transparent");
    root.appendChild(a.el.powerRing);

    // --- pause / bail-out
    a.el.pause = h("div",
      "position:absolute;top:calc(env(safe-area-inset-top,0px) + 8px);right:10px;width:34px;height:34px;" +
      "border-radius:10px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);" +
      "display:flex;align-items:center;justify-content:center;color:#F3F6FA;font-size:13px;font-weight:900;" +
      "cursor:pointer;z-index:2", "II");
    root.appendChild(a.el.pause);

    a.el.pauseSheet = h("div",
      "position:absolute;inset:0;background:rgba(6,10,18,.86);display:none;flex-direction:column;" +
      "align-items:center;justify-content:center;gap:12px;z-index:3;padding:24px;text-align:center");
    a.el.pauseSheet.appendChild(h("div",
      "font-family:'Teko',sans-serif;font-size:44px;color:#fff;line-height:1", "PAUSED"));
    a.el.pauseHint = h("div", "font-size:12px;color:#6C84A3;max-width:280px;line-height:1.5",
      "Left thumb steers. PASS finds a teammate, hold SHOOT for power. " +
      "You always control the player nearest the ball.");
    a.el.pauseSheet.appendChild(a.el.pauseHint);
    const resume = h("div",
      "margin-top:6px;padding:12px 30px;border-radius:14px;background:#2FD180;color:#080F1A;" +
      "font-weight:900;font-size:15px;cursor:pointer", "RESUME");
    const quit = h("div",
      "padding:9px 22px;border-radius:12px;border:1px solid #FB5A5A66;color:#FB5A5A;" +
      "font-weight:800;font-size:12px;cursor:pointer", "FORFEIT MATCH");
    a.el.pauseSheet.appendChild(resume);
    a.el.pauseSheet.appendChild(quit);
    root.appendChild(a.el.pauseSheet);

    a.el.resumeBtn = resume;
    a.el.quitBtn = quit;

    // --- kickoff countdown / half title card
    a.el.card = h("div",
      "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;" +
      "background:rgba(6,10,18,.72);pointer-events:none;gap:6px;z-index:2");
    a.el.cardTitle = h("div",
      "font-family:'Teko',sans-serif;font-size:12vw;line-height:1;color:#fff", "");
    a.el.cardSub = h("div", "font-size:12px;font-weight:800;letter-spacing:.14em;color:#FFB020", "");
    a.el.card.appendChild(a.el.cardTitle);
    a.el.card.appendChild(a.el.cardSub);
    root.appendChild(a.el.card);

    return root;
  }

  function toast(a, msg, ms) {
    a.el.toast.innerHTML = msg;
    a.el.toast.style.opacity = "1";
    clearTimeout(a.toastTimer);
    a.toastTimer = setTimeout(() => { a.el.toast.style.opacity = "0"; }, ms || 1900);
  }

  function banner(a, text, color, ms) {
    a.el.bannerText.textContent = text;
    a.el.bannerText.style.color = color || "#fff";
    a.el.banner.style.opacity = "1";
    clearTimeout(a.bannerTimer);
    a.bannerTimer = setTimeout(() => { a.el.banner.style.opacity = "0"; }, ms || 1400);
  }

  function titleCard(a, title, sub, ms) {
    a.el.cardTitle.textContent = title;
    a.el.cardSub.textContent = sub || "";
    a.el.card.style.display = "flex";
    clearTimeout(a.cardTimer);
    if (ms) a.cardTimer = setTimeout(() => { a.el.card.style.display = "none"; }, ms);
  }

  // ----------------------------------------------------------------- controls

  function bindControls(a) {
    const stick = { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0 };
    a.input = { mx: 0, mz: 0, sprint: false, shootHeld: 0, wantPass: false, wantShoot: 0 };

    const R = 56; // joystick travel in px

    function setKnob(dx, dy) {
      a.el.stickKnob.style.transform = "translate(" + dx + "px," + dy + "px)";
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
        a.el.stickBase.style.left = (t.clientX - 62) + "px";
        a.el.stickBase.style.bottom = "auto";
        a.el.stickBase.style.top = (t.clientY - 62) + "px";
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
          stick.dx = dx; stick.dy = dy;
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
          stick.active = false; stick.dx = stick.dy = 0;
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

    // Buttons. Shoot charges while held; releasing fires with that power.
    const press = (el, down, up) => {
      const d = (e) => { e.preventDefault(); e.stopPropagation(); down(); };
      const u = (e) => { e.preventDefault(); e.stopPropagation(); if (up) up(); };
      el.addEventListener("touchstart", d, { passive: false });
      el.addEventListener("touchend", u, { passive: false });
      el.addEventListener("mousedown", d);
      el.addEventListener("mouseup", u);
    };
    press(a.el.btnPass, () => { a.input.wantPass = true; });
    press(a.el.btnSprint, () => { a.input.sprint = true; }, () => { a.input.sprint = false; });
    press(a.el.btnShoot,
      () => { a.input.shootHeld = 0.0001; a.el.powerRing.style.opacity = "1"; },
      () => {
        a.input.wantShoot = clamp(a.input.shootHeld / 0.62, 0.35, 1);
        a.input.shootHeld = 0;
        a.el.powerRing.style.opacity = "0";
      });

    // Keyboard for desktop play/testing.
    const keys = a.keys = {};
    a.onKeyDown = (e) => {
      if (!A) return;
      const k = e.key.toLowerCase();
      keys[k] = true;
      if (k === " " && !a.spaceDown) { a.spaceDown = true; a.input.shootHeld = 0.0001; a.el.powerRing.style.opacity = "1"; }
      if (k === "x" || k === "e") a.input.wantPass = true;
      if (k === "escape" || k === "p") togglePause(a);
      if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].indexOf(k) >= 0) e.preventDefault();
    };
    a.onKeyUp = (e) => {
      if (!A) return;
      const k = e.key.toLowerCase();
      keys[k] = false;
      if (k === " ") {
        a.spaceDown = false;
        a.input.wantShoot = clamp(a.input.shootHeld / 0.62, 0.35, 1);
        a.input.shootHeld = 0;
        a.el.powerRing.style.opacity = "0";
      }
    };
    window.addEventListener("keydown", a.onKeyDown);
    window.addEventListener("keyup", a.onKeyUp);

    a.el.pause.addEventListener("click", (e) => { e.stopPropagation(); togglePause(a); });
    a.el.resumeBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePause(a, false); });
    a.el.quitBtn.addEventListener("click", (e) => { e.stopPropagation(); forfeit(a); });

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

  // Merge keyboard into the same movement vector the stick writes.
  function readKeyboard(a) {
    const k = a.keys;
    if (!k) return;
    let kx = 0, kz = 0;
    if (k["a"] || k["arrowleft"]) kx -= 1;
    if (k["d"] || k["arrowright"]) kx += 1;
    if (k["w"] || k["arrowup"]) kz -= 1;
    if (k["s"] || k["arrowdown"]) kz += 1;
    if (kx || kz) {
      const l = Math.hypot(kx, kz);
      a.input.mx = kx / l; a.input.mz = kz / l;
    }
    a.input.sprint = a.input.sprint || !!(k["shift"] || k["shiftkey"]);
  }

  function togglePause(a, force) {
    const want = force === undefined ? !a.paused : force;
    a.paused = want;
    a.el.pauseSheet.style.display = want ? "flex" : "none";
    if (!want) a.last = performance.now();
  }

  function forfeit(a) {
    // Treated as a normal full-time with whatever the score is -- the result
    // still commits, so quitting can't be used to dodge a loss.
    a.forfeited = true;
    endMatch(a);
  }

  // -------------------------------------------------------------- ball & play

  function resetKickoff(a, towardTeam) {
    a.ball.x = 0; a.ball.y = BALL_R; a.ball.z = 0;
    a.ball.vx = 0; a.ball.vy = 0; a.ball.vz = 0;
    a.ball.owner = null;
    a.players.forEach((p) => {
      p.x = p.homeX; p.z = p.homeZ; p.vx = 0; p.vz = 0; p.stun = 0; p.cooldown = 0;
    });
    // The conceding side restarts, so nudge one of their midfielders onto it.
    const starters = a.players.filter((p) => p.team === towardTeam && p.position === "MID");
    if (starters.length) {
      const s = starters[0];
      s.x = -0.6; s.z = towardTeam === TEAM_MY ? -1.2 : 1.2;
      a.ball.owner = s;
    }
    a.kickoffFreeze = 0.9;
  }

  function possessionChange(a, p) {
    a.ball.owner = p;
    a.ball.vx = a.ball.vy = a.ball.vz = 0;
    p.cooldown = 0.25;
  }

  function attackDirZ(team) { return team === TEAM_MY ? 1 : -1; }
  function goalZFor(team) { return team === TEAM_MY ? OPP_GOAL_Z : MY_GOAL_Z; }

  // Shot: aim at the goal mouth, with spray scaled by accuracy, distance and
  // whether the shooter was under pressure.
  function shoot(a, p, powerFrac, pressure) {
    const gz = goalZFor(p.team);
    const d = dist(p.x, p.z, 0, gz);
    const acc = p.attrs.shotAccuracy * (1 - clamp(pressure, 0, 0.55)) * clamp(1.25 - d / 46, 0.35, 1.1);
    // Pick a target inside the goal, biased away from the keeper.
    const gk = a.players.find((q) => q.team !== p.team && q.isGK);
    let aimX = rand(-GOAL_W / 2 + 0.5, GOAL_W / 2 - 0.5);
    if (gk) aimX = gk.x > 0 ? rand(-GOAL_W / 2 + 0.4, -0.3) : rand(0.3, GOAL_W / 2 - 0.4);
    const spray = (1 - acc) * 7.5;
    aimX += rand(-spray, spray);
    const aimY = clamp(rand(0.35, GOAL_H - 0.35) + rand(-spray, spray) * 0.35, 0.15, GOAL_H + 1.6);

    const dx = aimX - p.x, dz = gz - p.z;
    const flat = Math.hypot(dx, dz) || 1;
    const speed = p.attrs.shotPower * (0.55 + powerFrac * 0.6);
    a.ball.owner = null;
    a.ball.x = p.x + (dx / flat) * 0.7;
    a.ball.z = p.z + (dz / flat) * 0.7;
    a.ball.y = BALL_R + 0.15;
    a.ball.vx = (dx / flat) * speed;
    a.ball.vz = (dz / flat) * speed;
    // Loft proportional to distance so long-range efforts arc.
    a.ball.vy = clamp(aimY / Math.max(1, d) * speed * 0.55 + d * 0.045, 0.4, 9);
    p.cooldown = 0.5;
    a.lastTouch = p;
    a.stat[p.team].shots++;
    if (window.playKick) window.playKick();
  }

  // Pass: choose the best forward option in vision range, weight by openness.
  function bestPassTarget(a, p) {
    const mates = a.players.filter((q) => q !== p && q.team === p.team && !q.isGK);
    const dir = attackDirZ(p.team);
    let best = null, bestScore = -1e9;
    mates.forEach((q) => {
      const d = dist(p.x, p.z, q.x, q.z);
      if (d < 3 || d > p.attrs.vision + 8) return;
      // Nearest opponent to the receiver -- don't pass into trouble.
      let press = 99;
      a.players.forEach((o) => {
        if (o.team === p.team) return;
        press = Math.min(press, dist(o.x, o.z, q.x, q.z));
      });
      const forward = (q.z - p.z) * dir;
      const score = forward * 1.5 + press * 1.2 - d * 0.35 + q.attrs.power * 0.04;
      if (score > bestScore) { bestScore = score; best = q; }
    });
    return best;
  }

  function pass(a, p, target) {
    if (!target) return false;
    const acc = p.attrs.passAccuracy;
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
    a.ball.vy = d > 18 ? 3.4 : 0.5;
    p.cooldown = 0.32;
    a.lastTouch = p;
    a.stat[p.team].passes++;
    if (window.playTap) window.playTap();
    return true;
  }

  // ------------------------------------------------------------------ AI step

  function aiControlled(a, p, dt) {
    // The AI carrying the ball: shoot if it's on, otherwise pass or drive.
    const gz = goalZFor(p.team);
    const dGoal = dist(p.x, p.z, 0, gz);
    let press = 99;
    a.players.forEach((o) => { if (o.team !== p.team) press = Math.min(press, dist(o.x, o.z, p.x, p.z)); });

    if (p.cooldown <= 0) {
      const shootRange = 15 + p.attrs.shotPower * 0.6;
      if (dGoal < shootRange && Math.random() < 0.035 + (1 - dGoal / shootRange) * 0.09) {
        shoot(a, p, rand(0.6, 1), clamp((3.5 - press) / 3.5, 0, 1));
        return;
      }
      // Under pressure, or occasionally by choice, move it on.
      const wantsOut = press < 3.2 ? 0.14 : 0.022;
      if (Math.random() < wantsOut) {
        const t = bestPassTarget(a, p);
        if (t && pass(a, p, t)) return;
      }
    }
    // Drive at goal, veering away from the closest defender.
    const dir = attackDirZ(p.team);
    let tx = clamp(p.x * 0.7, -PITCH_W / 2 + 4, PITCH_W / 2 - 4);
    let tz = p.z + dir * 14;
    let near = null, nd = 99;
    a.players.forEach((o) => {
      if (o.team === p.team) return;
      const d = dist(o.x, o.z, p.x, p.z);
      if (d < nd) { nd = d; near = o; }
    });
    if (near && nd < 5) tx += (p.x - near.x) > 0 ? 5 : -5;
    steer(p, tx, tz, dt, 1);
  }

  function aiOffBall(a, p, dt) {
    const b = a.ball;
    const owner = b.owner;
    const myTeamHasIt = owner && owner.team === p.team;
    const dir = attackDirZ(p.team);

    if (p.isGK) {
      // Keeper hugs the line, shading toward the ball's side; comes a little
      // off the line when the ball is close.
      const gz = p.team === TEAM_MY ? MY_GOAL_Z : OPP_GOAL_Z;
      const ballSide = clamp(b.x * 0.55, -GOAL_W / 2 - 1.2, GOAL_W / 2 + 1.2);
      const dBall = dist(b.x, b.z, p.x, gz);
      const off = dBall < 18 ? clamp((18 - dBall) * 0.22, 0, 4.5) : 0;
      steer(p, ballSide, gz - (p.team === TEAM_MY ? -off : off), dt, 1.05);
      return;
    }

    // Formation anchor slides with the ball so shape stays coherent.
    const shift = clamp((b.z - 0) * 0.32, -14, 14);
    const push = myTeamHasIt ? dir * 7 : -dir * 3;
    let tx = lerp(p.homeX, clamp(b.x * 0.55, -PITCH_W / 2 + 3, PITCH_W / 2 - 3), 0.35);
    let tz = clamp(p.homeZ + shift + push, -PITCH_L / 2 + 3, PITCH_L / 2 - 3);

    const dBall = dist(p.x, p.z, b.x, b.z);
    if (!myTeamHasIt) {
      // Closest one or two defenders actually attack the ball.
      const mates = a.players.filter((q) => q.team === p.team && !q.isGK);
      const sorted = mates.slice().sort((q, r) => dist2(q.x, q.z, b.x, b.z) - dist2(r.x, r.z, b.x, b.z));
      const rank = sorted.indexOf(p);
      if (rank === 0) { tx = b.x; tz = b.z; }
      else if (rank === 1 && dBall < 24) { tx = lerp(tx, b.x, 0.6); tz = lerp(tz, b.z, 0.6); }
    } else if (dBall < 9) {
      // Give the carrier room rather than clustering on top of them.
      const ax = p.x - b.x, az = p.z - b.z;
      const l = Math.hypot(ax, az) || 1;
      tx = b.x + (ax / l) * 9; tz = b.z + (az / l) * 9 + dir * 3;
    }
    steer(p, tx, tz, dt, myTeamHasIt ? 0.86 : 0.97);
  }

  function steer(p, tx, tz, dt, speedScale) {
    const dx = tx - p.x, dz = tz - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) { p.vx *= 0.82; p.vz *= 0.82; return; }
    const want = p.attrs.topSpeed * (speedScale == null ? 1 : speedScale);
    const ux = dx / d, uz = dz / d;
    // Ease off as we arrive so players don't jitter around their anchor.
    const target = Math.min(want, d > 1.4 ? want : want * 0.35);
    p.vx += (ux * target - p.vx) * Math.min(1, p.attrs.accel * dt / Math.max(1, want));
    p.vz += (uz * target - p.vz) * Math.min(1, p.attrs.accel * dt / Math.max(1, want));
  }

  // ------------------------------------------------------------- physics step

  function stepPlayers(a, dt) {
    a.players.forEach((p) => {
      p.cooldown = Math.max(0, p.cooldown - dt);
      p.stun = Math.max(0, p.stun - dt);

      if (p === a.controlled && !a.kickoffFreeze) {
        // Human input. Screen-space stick maps into camera-relative movement
        // so "up" is always "toward the goal you're attacking".
        const inp = a.input;
        const sprint = inp.sprint ? 1.16 : 1;
        const want = p.attrs.topSpeed * sprint;
        const mag = Math.hypot(inp.mx, inp.mz);
        if (mag > 0.05 && p.stun <= 0) {
          // Camera looks down +Z for my team, so stick-up (-y) = +Z.
          const fx = inp.mx, fz = inp.mz;
          const l = Math.hypot(fx, fz) || 1;
          const tvx = (fx / l) * want * Math.min(1, mag);
          const tvz = (fz / l) * want * Math.min(1, mag);
          p.vx += (tvx - p.vx) * Math.min(1, p.attrs.accel * 1.25 * dt / Math.max(1, want));
          p.vz += (tvz - p.vz) * Math.min(1, p.attrs.accel * 1.25 * dt / Math.max(1, want));
        } else {
          p.vx *= Math.max(0, 1 - 7 * dt); p.vz *= Math.max(0, 1 - 7 * dt);
        }
      } else if (p.stun > 0) {
        p.vx *= Math.max(0, 1 - 6 * dt); p.vz *= Math.max(0, 1 - 6 * dt);
      } else if (a.kickoffFreeze > 0) {
        p.vx *= 0.9; p.vz *= 0.9;
      } else if (a.ball.owner === p) {
        aiControlled(a, p, dt);
      } else {
        aiOffBall(a, p, dt);
      }

      p.x += p.vx * dt; p.z += p.vz * dt;
      // Keep everyone on (or just off) the field of play.
      p.x = clamp(p.x, -PITCH_W / 2 - 1.5, PITCH_W / 2 + 1.5);
      p.z = clamp(p.z, -PITCH_L / 2 - 3, PITCH_L / 2 + 3);

      const sp = Math.hypot(p.vx, p.vz);
      if (sp > 0.4) p.facing = Math.atan2(p.vx, p.vz);

      // Mesh transform + a small run bob so movement reads as movement.
      p.mesh.position.x = p.x; p.mesh.position.z = p.z;
      p.mesh.rotation.y = p.facing;
      const bob = sp > 0.6 ? Math.sin(a.t * 11 + p.homeX) * 0.07 * Math.min(1, sp / 6) : 0;
      p.mesh.position.y = bob;
      p.mesh.children[0].rotation.x = sp > 0.6 ? Math.sin(a.t * 11 + p.homeX) * 0.09 : 0;
    });
  }

  function stepBall(a, dt) {
    const b = a.ball;

    if (b.owner) {
      const o = b.owner;
      // Dribble: ball rides just ahead of the carrier's facing.
      const tx = o.x + Math.sin(o.facing) * DRIBBLE_AHEAD;
      const tz = o.z + Math.cos(o.facing) * DRIBBLE_AHEAD;
      b.x = lerp(b.x, tx, Math.min(1, 16 * dt));
      b.z = lerp(b.z, tz, Math.min(1, 16 * dt));
      b.y = BALL_R + Math.abs(Math.sin(a.t * 9)) * 0.07;
      b.vx = o.vx; b.vz = o.vz; b.vy = 0;
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
    if (a.kickoffFreeze > 0) return;

    if (b.owner) {
      // Tackling: any nearby opponent can win it, weighted control vs tackle.
      a.players.forEach((o) => {
        if (o.team === b.owner.team || o.cooldown > 0 || o.stun > 0) return;
        const d = dist(o.x, o.z, b.owner.x, b.owner.z);
        if (d > TACKLE_R) return;
        const odds = (o.attrs.tackle * 1.15) / (o.attrs.tackle * 1.15 + b.owner.attrs.control);
        // Human-controlled players get a small break so it doesn't feel unfair.
        const bias = b.owner === a.controlled ? 0.78 : 1;
        if (Math.random() < odds * bias * dt * 3.2) {
          const beaten = b.owner;
          beaten.stun = 0.28; beaten.cooldown = 0.4;
          possessionChange(a, o);
          a.lastTouch = o;
          if (o.team === TEAM_MY) toast(a, "🦶 " + lastName(o.name) + " wins it back!");
          if (window.playZoneWin && o.team === TEAM_MY) window.playZoneWin();
        }
      });
      return;
    }

    // Loose ball: closest eligible player inside the pickup radius takes it,
    // keepers get a bigger reach (that's their whole job).
    let best = null, bd = 1e9;
    a.players.forEach((p) => {
      if (p.cooldown > 0 || p.stun > 0) return;
      const r = p.isGK ? POSSESS_R + 1.5 * p.attrs.reflex : POSSESS_R;
      if (b.y > 2.2 && !p.isGK) return;            // can't collect a high ball
      const d = dist(p.x, p.z, b.x, b.z);
      if (d < r && d < bd) { bd = d; best = p; }
    });
    if (best) {
      const wasShot = Math.hypot(b.vx, b.vz) > 12;
      if (best.isGK && wasShot) {
        // Save: strong keepers hold it, weaker ones parry.
        if (Math.random() < best.attrs.reflex) {
          possessionChange(a, best);
          toast(a, "🧤 Save by " + lastName(best.name) + "!");
          a.stat[best.team].saved++;   // credited to the keeper's own team
        } else {
          b.vx *= -0.35; b.vz *= -0.35; b.vy = 3.2;
          best.cooldown = 0.4;
          toast(a, "🧤 Parried!");
        }
        return;
      }
      possessionChange(a, best);
    }
  }

  function stepBounds(a) {
    const b = a.ball;
    if (b.owner) return;

    // Goal check first -- crossing the line inside the frame beats any
    // out-of-play handling.
    const inMouth = Math.abs(b.x) < GOAL_W / 2 && b.y < GOAL_H + 0.15;
    if (b.z > OPP_GOAL_Z && b.z < OPP_GOAL_Z + GOAL_DEPTH + 1 && inMouth) { onGoal(a, TEAM_MY); return; }
    if (b.z < MY_GOAL_Z && b.z > MY_GOAL_Z - GOAL_DEPTH - 1 && inMouth) { onGoal(a, TEAM_OPP); return; }

    // Out of play. Kept deliberately simple/arcade: hand it to the team that
    // didn't touch it last, near where it left, and play on. No throw-in
    // animation, no stoppage -- a phone match can't afford dead time.
    const outSide = Math.abs(b.x) > PITCH_W / 2 + 0.4;
    const outEnd = Math.abs(b.z) > PITCH_L / 2 + 0.4;
    if (!outSide && !outEnd) return;

    const lastTeam = a.lastTouch ? a.lastTouch.team : TEAM_OPP;
    const giveTo = lastTeam === TEAM_MY ? TEAM_OPP : TEAM_MY;
    let rx = clamp(b.x, -PITCH_W / 2 + 1.5, PITCH_W / 2 - 1.5);
    let rz = clamp(b.z, -PITCH_L / 2 + 3, PITCH_L / 2 - 3);
    if (outEnd) {
      // Goal kick for the defending side / corner-ish restart otherwise.
      const conceding = b.z > 0 ? TEAM_OPP : TEAM_MY;
      if (giveTo === conceding) { rx = 0; rz = (b.z > 0 ? PITCH_L / 2 - 8 : -PITCH_L / 2 + 8); }
      else { rx = b.x > 0 ? PITCH_W / 2 - 2 : -PITCH_W / 2 + 2; }
    }
    b.x = rx; b.z = rz; b.y = BALL_R;
    b.vx = b.vy = b.vz = 0;
    // Nearest player from the receiving side picks it up.
    let cand = null, cd = 1e9;
    a.players.forEach((p) => {
      if (p.team !== giveTo || p.isGK) return;
      const d = dist(p.x, p.z, rx, rz);
      if (d < cd) { cd = d; cand = p; }
    });
    if (cand) { cand.x = rx - 0.8; cand.z = rz; possessionChange(a, cand); }
    toast(a, giveTo === TEAM_MY ? "Ball to you" : "Their throw", 1100);
  }

  function onGoal(a, team) {
    a.score[team]++;
    a.el.score.textContent = a.score.my + " - " + a.score.opp;
    const scorer = a.lastTouch && a.lastTouch.team === team ? lastName(a.lastTouch.name) : null;
    if (team === TEAM_MY) {
      banner(a, "GOAL!", "#2FD180", 1700);
      toast(a, scorer ? "⚽ " + scorer + " scores!" : "⚽ GOAL!", 2200);
      if (window.playWin) window.playWin();
    } else {
      banner(a, "CONCEDED", "#FB5A5A", 1500);
      toast(a, scorer ? "😖 " + scorer + " scores for them." : "😖 They score.", 2200);
      if (window.playLose) window.playLose();
    }
    resetKickoff(a, team === TEAM_MY ? TEAM_OPP : TEAM_MY);
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
    const speed = Math.hypot(b.vx, b.vz);
    const back = 24 + clamp(speed * 0.45, 0, 8);
    const high = 14.5 + clamp(speed * 0.3, 0, 6);
    const lookAhead = clamp(b.vz * 0.3, -7, 7);

    const tx = clamp(b.x * 0.62, -PITCH_W / 2 + 8, PITCH_W / 2 - 8);
    const tz = b.z - back;
    a.camPos.x = lerp(a.camPos.x, tx, Math.min(1, 3.4 * dt));
    a.camPos.y = lerp(a.camPos.y, high, Math.min(1, 2.6 * dt));
    a.camPos.z = lerp(a.camPos.z, tz, Math.min(1, 3.4 * dt));
    a.camera.position.set(a.camPos.x, a.camPos.y, a.camPos.z);

    a.camLook.x = lerp(a.camLook.x, b.x * 0.75, Math.min(1, 5 * dt));
    a.camLook.y = lerp(a.camLook.y, Math.max(0.4, b.y * 0.5), Math.min(1, 5 * dt));
    a.camLook.z = lerp(a.camLook.z, b.z + lookAhead + 2.5, Math.min(1, 5 * dt));
    a.camera.lookAt(a.camLook.x, a.camLook.y, a.camLook.z);
  }

  // ---------------------------------------------------------- control switch

  // You always drive whoever is best placed: nearest my-team outfielder to the
  // ball, or the carrier if we have it. Switching is sticky (a small hysteresis
  // margin) so control doesn't flicker between two equidistant players.
  function updateControlled(a) {
    const b = a.ball;
    if (b.owner && b.owner.team === TEAM_MY) {
      setControlled(a, b.owner);
      return;
    }
    let best = null, bd = 1e9;
    a.players.forEach((p) => {
      if (p.team !== TEAM_MY || p.isGK) return;
      const d = dist2(p.x, p.z, b.x, b.z);
      if (d < bd) { bd = d; best = p; }
    });
    if (!best) return;
    if (a.controlled && a.controlled !== best) {
      const cd = dist2(a.controlled.x, a.controlled.z, b.x, b.z);
      if (cd < bd * 1.55) return;   // keep current unless clearly worse
    }
    setControlled(a, best);
  }

  function setControlled(a, p) {
    if (a.controlled === p) return;
    if (a.marker && a.controlled) a.controlled.mesh.remove(a.marker);
    a.controlled = p;
    if (a.marker) p.mesh.add(a.marker);
    a.el.nameplate.innerHTML =
      '<span style="color:' + a.myColor + '">●</span> ' + p.name +
      ' <span style="opacity:.6">' + p.position + " " + p.attrs.power + "</span>";
  }

  // ------------------------------------------------------------- clock / loop

  function frame(now) {
    if (!A) return;
    const a = A;
    a.raf = requestAnimationFrame(frame);

    let dt = (now - a.last) / 1000;
    a.last = now;
    if (a.paused) { a.renderer.render(a.scene, a.camera); return; }
    // Clamp so a backgrounded tab or a GC hitch can't teleport the sim.
    dt = Math.min(dt, 1 / 20);
    if (dt <= 0) return;
    a.t += dt;

    readKeyboard(a);
    if (a.input.shootHeld > 0) {
      a.input.shootHeld = Math.min(0.62, a.input.shootHeld + dt);
      const f = a.input.shootHeld / 0.62;
      a.el.powerRing.style.borderColor =
        f > 0.85 ? "#FB5A5A" : f > 0.5 ? "#FFB020" : "#2FD18066";
      a.el.powerRing.style.transform = "scale(" + (0.9 + f * 0.14) + ")";
    }

    if (a.kickoffFreeze > 0) {
      a.kickoffFreeze -= dt;
      if (a.kickoffFreeze <= 0) a.el.card.style.display = "none";
    }

    // Human actions are consumed once, on the frame after the button fires.
    const c = a.controlled;
    if (c && a.ball.owner === c && c.cooldown <= 0 && a.kickoffFreeze <= 0) {
      if (a.input.wantShoot > 0) {
        let press = 99;
        a.players.forEach((o) => { if (o.team !== c.team) press = Math.min(press, dist(o.x, o.z, c.x, c.z)); });
        shoot(a, c, a.input.wantShoot, clamp((3.5 - press) / 3.5, 0, 1));
        toast(a, "Shot!", 700);
      } else if (a.input.wantPass) {
        const t = bestPassTarget(a, c);
        if (t) { pass(a, c, t); toast(a, "→ " + lastName(t.name), 800); }
      }
    }
    a.input.wantShoot = 0; a.input.wantPass = false;

    stepPlayers(a, dt);
    stepBall(a, dt);
    stepPossession(a, dt);
    stepBounds(a);
    updateControlled(a);
    stepCamera(a, dt);

    // Match clock: each half runs halfSeconds of real time mapped to 45'.
    a.elapsed += dt;
    const minute = Math.min(45, Math.floor((a.elapsed / a.halfSeconds) * 45));
    const shown = (a.half === 1 ? 0 : 45) + minute;
    if (shown !== a.shownMinute) {
      a.shownMinute = shown;
      a.el.clock.innerHTML = (a.half === 1 ? "1ST HALF" : "2ND HALF") + " &middot; " + shown + "'";
    }
    if (a.elapsed >= a.halfSeconds) { endHalf(a); return; }

    a.renderer.render(a.scene, a.camera);
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

  // ------------------------------------------------------------------ public

  // Starts a fresh match and plays the first half. cfg:
  //   myLineup, oppLineup   {slotId: card}
  //   formationKey, oppFormationKey
  //   myName, myColor, oppName, oppColor
  //   halfSeconds           real seconds per half (default 75)
  //   onHalfEnd(half, score), onFullTime(score)
  M.begin = function (cfg) {
    if (!M.available()) return false;
    THREE = window.THREE;
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
    };

    a.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    a.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    a.renderer.setSize(window.innerWidth, window.innerHeight, false);
    if (THREE.SRGBColorSpace) a.renderer.outputColorSpace = THREE.SRGBColorSpace;

    a.scene = buildScene(myColor, oppColor);
    // 46 degrees VERTICAL fov. three.js measures fov vertically, and phones are
    // tall -- the usual ~58 spans so much height that half the frame is sky and
    // the players shrink to specks. Narrower keeps them legible without having
    // to flatten the camera into a top-down view.
    a.camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.5, 400);

    a.shared = makeShared(myColor, oppColor);
    a.players = []
      .concat(buildTeam(TEAM_MY, cfg.myLineup, cfg.formationKey || "balanced", myColor, a.shared, a.scene))
      .concat(buildTeam(TEAM_OPP, cfg.oppLineup, cfg.oppFormationKey || "balanced", oppColor, a.shared, a.scene));

    // Ball + its shadow.
    a.ball = { x: 0, y: BALL_R, z: 0, vx: 0, vy: 0, vz: 0, owner: null };
    a.ballMesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 14, 12),
      new THREE.MeshLambertMaterial({ color: 0xFFFFFF, emissive: 0x222630 })
    );
    a.scene.add(a.ballMesh);
    a.ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(BALL_R * 1.15, 10),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.36 })
    );
    a.ballShadow.rotation.x = -Math.PI / 2;
    a.scene.add(a.ballShadow);

    // Ring under the player you're driving.
    a.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.62, 0.82, 18),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(myColor), transparent: true, opacity: 0.9, side: THREE.DoubleSide })
    );
    a.marker.rotation.x = -Math.PI / 2;
    a.marker.position.y = 0.05;

    A = a;
    a.root = buildOverlay(a);
    document.body.appendChild(a.root);
    bindControls(a);

    resetKickoff(a, TEAM_MY);
    a.kickoffFreeze = 1.4;
    updateControlled(a);
    titleCard(a, "KICK OFF", a.myName + "  vs  " + a.oppName, 1400);
    if (window.ensureAudio) window.ensureAudio();
    if (window.playWhistle) window.playWhistle();

    a.last = performance.now();
    a.raf = requestAnimationFrame(frame);
    return true;
  };

  // Resumes into the second half, optionally with a substituted lineup.
  M.resumeSecondHalf = function (newMyLineup) {
    const a = A;
    if (!a) return false;
    if (newMyLineup) {
      // Re-point existing my-team players at whatever card now occupies their
      // slot, so a halftime sub is reflected without rebuilding the scene.
      a.players.forEach((p) => {
        if (p.team !== TEAM_MY) return;
        const card = newMyLineup[p.slotId];
        if (!card) return;
        if (p.card && card.id === p.card.id) return;
        p.card = card; p.name = card.name;
        p.attrs = deriveAttrs(card, p.position);
      });
    }
    a.elapsed = 0; a.half = 2; a.shownMinute = -1;
    a.paused = false;
    a.el.pauseSheet.style.display = "none";
    show(a);
    resetKickoff(a, TEAM_OPP);
    a.kickoffFreeze = 1.4;
    updateControlled(a);
    titleCard(a, "2ND HALF", a.score.my + " - " + a.score.opp, 1400);
    if (window.playWhistle) window.playWhistle();
    a.last = performance.now();
    a.running = true;
    a.raf = requestAnimationFrame(frame);
    return true;
  };

  M.getScore = function () { return A ? { my: A.score.my, opp: A.score.opp } : null; };
  M.getStats = function () { return A ? JSON.parse(JSON.stringify(A.stat)) : null; };

  // Full teardown -- disposes GL resources and removes every listener. Called
  // on full time, on abort, and defensively at the start of every begin().
  function teardown() {
    const a = A;
    if (!a) return;
    A = null;
    if (a.raf) cancelAnimationFrame(a.raf);
    clearTimeout(a.toastTimer); clearTimeout(a.bannerTimer); clearTimeout(a.cardTimer);
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
      a.scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
        }
      });
      a.renderer.dispose();
      if (a.renderer.forceContextLoss) a.renderer.forceContextLoss();
    } catch (e) {}
    _crowdTex = null;
    if (a.root && a.root.parentNode) a.root.parentNode.removeChild(a.root);
  }

  M.stop = teardown;

  window.Match3D = M;
})();
