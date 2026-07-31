// TCG Manager -- 3D match: everything you SEE.
//
// Owns the stadium, the player models and their animation, the ball, and the
// materials/lighting. Deliberately split out of match3d.js so the look of the
// game can be worked on without touching simulation or input code.
//
// Hard constraints, do not design around wishing them away:
//  * The repo ships ZERO 3D assets (no .glb/.gltf/.fbx anywhere) and there is
//    no build step or bundler. Every mesh and texture here is generated
//    procedurally at runtime from three.js primitives and <canvas>.
//  * This runs in a phone browser as a PWA. 22 articulated players plus the
//    stadium have to hold a steady framerate on mid-range hardware, so all
//    geometry/materials are built once in makeKitSet and shared across every
//    player, and animatePlayer allocates nothing (pure number maths on
//    pre-built joint Groups -- no Vector3/Euler/Quaternion construction).
//  * three.js is pinned to r155 (the last UMD build exposing a global THREE).
//    Anything newer than r155's API surface is unavailable.
//
// Architecture:
//   Players are nested Groups, one per joint, so a pose is a handful of
//   rotation.x writes:
//     group -> root -> hips -> torso -> shoulder -> elbow
//                          \-> thigh -> knee -> ankle   (x2)
//   `group` is the sim's: it writes position.x/z and rotation.y and nothing
//   else. group.position.y is deliberately pinned at 0 so the control marker
//   ring match3d.js parents to it never sinks through the pitch; the run-cycle
//   bob lives on `root` instead.
//
// Shadows: the renderer is constructed in match3d.js, so shadowMap can't be
// switched on from buildStadium. V.configureRenderer(renderer) is exported for
// the integrator to call, and as a belt-and-braces fallback scene.onBeforeRender
// configures the renderer it is handed on the first frame. The same hook slides
// the directional light's shadow frustum onto whatever patch of grass the
// camera is looking at, which is the only way to get a 50m ortho box (and
// therefore crisp shadows) out of a 105m pitch.
//
// Contract used by match3d.js -- keep these signatures stable:
//   V.buildStadium(THREE, opts)            -> { scene, tick(t, dt) }
//   V.makeKitSet(THREE, myHex, oppHex)     -> shared kit/material bundle
//   V.createPlayer(THREE, shared, teamHex, isGK, number) -> rig
//   V.animatePlayer(rig, st)               -> per-frame pose update
//   V.createBall(THREE)                    -> { mesh, shadow }
//   V.disposeShared(shared)
//   V.configureRenderer(renderer)          -> optional, additive
// `rig` must expose `.group` (added to the scene, positioned by the sim).
// `st` is { speed, facing, t, kicking, stunned, hasBall, controlled }.
"use strict";

(function () {
  const V = {};

  // Pitch dimensions are mirrored from match3d.js -- kept in sync by hand
  // because neither module should have to load the other to draw a line.
  const PITCH_W = 68, PITCH_L = 105;
  const GOAL_W = 7.32, GOAL_H = 2.44, GOAL_DEPTH = 2.0;
  const BALL_R = 0.36;

  const TAU = Math.PI * 2;

  // Skeleton measurements, metres, feet at y=0. Roughly a 1.80m footballer.
  const HIP_Y = 0.92;
  const THIGH_L = 0.42, SHIN_L = 0.40;
  const SHOULDER_Y = 0.48;            // relative to the hip pivot
  const UPPER_ARM_L = 0.26, FOREARM_L = 0.25;
  const HEAD_Y = 0.71;                // relative to the hip pivot

  // Deterministic per-player variation. Picked by shirt number so a player
  // looks the same on every frame and across halves.
  const SKINS = ["#F2CBA6", "#E3AC7F", "#C98C60", "#A46B44", "#77482B"];
  const HAIRS = ["#17110C", "#38291B", "#0D0B0A", "#5C3D24", "#8B6B3C"];

  // Module-scope state. buildStadium always runs before makeKitSet in
  // match3d.js, so the shadow decision made there is visible to everything.
  let _T = null;                 // the THREE namespace we were handed
  let _shadowsOn = false;
  let _stadiumOwned = [];        // geometries/materials/textures to dispose

  // ------------------------------------------------------------ small helpers

  function canvasOf(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }

  function makeTex(THREE, cv, srgb, repX, repY) {
    const t = new THREE.CanvasTexture(cv);
    if (srgb !== false && THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
    if (repX || repY) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repX || 1, repY || 1);
    }
    t.anisotropy = 8;   // three clamps this to the device max at upload time
    return t;
  }

  // Fixed-seed LCG. Texture "noise" has to be identical every run or the pitch
  // wear and crowd would shimmer between page loads for no reason.
  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  function parseHex(hex) {
    let h = String(hex == null ? "#888888" : hex).replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    if (!isFinite(n)) return [136, 136, 136];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function toCss(c) { return "rgb(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + ")"; }
  function cl255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
  function mulRgb(c, f) { return [cl255(c[0] * f), cl255(c[1] * f), cl255(c[2] * f)]; }
  function mixRgb(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  function lum(c) { return (c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114) / 255; }

  function rgbToHsl(c) {
    const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 0) {
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (mx === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    const l = (mx + mn) / 2;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    return [h, s, l];
  }
  function hslToRgb(h, s, l) {
    h = ((h % 1) + 1) % 1;
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h * 6) % 2) - 1)), m = l - c / 2;
    let r = 0, g = 0, b = 0;
    const i = Math.floor(h * 6);
    if (i === 0) { r = c; g = x; } else if (i === 1) { r = x; g = c; }
    else if (i === 2) { g = c; b = x; } else if (i === 3) { g = x; b = c; }
    else if (i === 4) { r = x; b = c; } else { r = c; b = x; }
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }

  // Stable 32-bit-ish hash so per-player variation never drifts frame to frame.
  function hash(n) {
    let x = ((n | 0) * 374761393 + 668265263) | 0;
    x = (x ^ (x >>> 13)) * 1274126177;
    return (x ^ (x >>> 16)) >>> 0;
  }

  function own(list, o) { if (o) list.push(o); return o; }

  // ------------------------------------------------------------ pitch texture

  // The full marking set is drawn into one canvas rather than built from line
  // geometry: it is cheaper (one draw call), sharper under anisotropic
  // filtering, and the mow stripes/wear/noise come along for free.
  // 18 px per metre keeps the 12cm markings ~2px wide -- enough to stay crisp
  // at the camera's grazing angle without a 15MB texture on a phone.
  function makePitchTexture(THREE) {
    const px = 18;
    const cw = Math.round(PITCH_W * px), ch = Math.round(PITCH_L * px);
    const cv = canvasOf(cw, ch);
    const g = cv.getContext("2d");
    const rnd = rng(20260730);

    // Mow bands across the width, each with its own slight tone so the pitch
    // does not look like a repeating two-colour ramp.
    const stripes = 16, sh = ch / stripes;
    for (let i = 0; i < stripes; i++) {
      const dark = i % 2 === 0;
      const base = dark ? [26, 96, 55] : [37, 121, 70];
      const jit = 1 + (rnd() - 0.5) * 0.06;
      const gr = g.createLinearGradient(0, i * sh, 0, (i + 1) * sh);
      gr.addColorStop(0, toCss(mulRgb(base, jit * 0.94)));
      gr.addColorStop(0.5, toCss(mulRgb(base, jit)));
      gr.addColorStop(1, toCss(mulRgb(base, jit * 0.94)));
      g.fillStyle = gr;
      g.fillRect(0, i * sh, cw, sh + 1);
      // Mower wheel line at each band edge -- the detail that reads as "real
      // groundskeeping" rather than a two-tone checkerboard.
      g.fillStyle = dark ? "rgba(255,255,255,0.045)" : "rgba(0,0,0,0.055)";
      g.fillRect(0, i * sh, cw, Math.max(1, px * 0.09));
    }

    // Fine directional grain: short horizontal strokes, following the mow.
    g.globalAlpha = 0.05;
    for (let i = 0; i < 26000; i++) {
      const x = rnd() * cw, y = rnd() * ch;
      g.fillStyle = rnd() > 0.5 ? "#8FE0AC" : "#0B3A20";
      g.fillRect(x, y, 1 + rnd() * 5, 1);
    }
    g.globalAlpha = 1;

    // Wear: goalmouths, penalty spots, centre circle, touchline traffic.
    const wear = (x, y, rx, ry, a) => {
      const wg = g.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry));
      wg.addColorStop(0, "rgba(150,132,86," + a + ")");
      wg.addColorStop(1, "rgba(150,132,86,0)");
      g.save();
      g.translate(x, y); g.scale(1, ry / Math.max(rx, ry)); g.translate(-x, -y);
      g.fillStyle = wg; g.beginPath(); g.arc(x, y, Math.max(rx, ry), 0, TAU); g.fill();
      g.restore();
    };
    wear(cw / 2, px * 3.5, px * 11, px * 5, 0.20);
    wear(cw / 2, ch - px * 3.5, px * 11, px * 5, 0.20);
    wear(cw / 2, px * 11, px * 3, px * 3, 0.16);
    wear(cw / 2, ch - px * 11, px * 3, px * 3, 0.16);
    wear(cw / 2, ch / 2, px * 7, px * 7, 0.10);

    const vg = g.createRadialGradient(cw / 2, ch / 2, ch * 0.14, cw / 2, ch / 2, ch * 0.70);
    vg.addColorStop(0, "rgba(255,255,255,0.055)");
    vg.addColorStop(1, "rgba(0,0,0,0.26)");
    g.fillStyle = vg; g.fillRect(0, 0, cw, ch);

    // ------- markings. Geometry here is real-world accurate; do not "tidy" it.
    const m = (v) => v * px;
    const LW = Math.max(2, 0.12 * px);

    // A soft dark pass under the lines fakes the paint sitting proud of the
    // grass and stops them looking like decals stuck on top.
    const paint = (fn) => {
      g.save();
      g.strokeStyle = "rgba(0,0,0,0.28)"; g.fillStyle = "rgba(0,0,0,0.28)";
      g.lineWidth = LW + 1.6; g.translate(0, 1.2); fn(); g.restore();
      g.strokeStyle = "rgba(248,252,255,0.95)"; g.fillStyle = "rgba(248,252,255,0.95)";
      g.lineWidth = LW; fn();
    };

    g.lineCap = "butt";
    const pad = m(0.4);
    paint(() => {
      g.strokeRect(pad, pad, cw - pad * 2, ch - pad * 2);
      g.beginPath(); g.moveTo(pad, ch / 2); g.lineTo(cw - pad, ch / 2); g.stroke();
      g.beginPath(); g.arc(cw / 2, ch / 2, m(9.15), 0, TAU); g.stroke();
    });
    paint(() => { g.beginPath(); g.arc(cw / 2, ch / 2, m(0.35), 0, TAU); g.fill(); });

    [0, 1].forEach((end) => {
      const dir = end === 0 ? 1 : -1;
      const gl = end === 0 ? pad : ch - pad;
      const boxD = m(16.5), boxW = m(40.32);
      const sixD = m(5.5), sixW = m(18.32);
      const spotY = gl + m(11) * dir;
      paint(() => {
        g.strokeRect(cw / 2 - boxW / 2, gl, boxW, boxD * dir);
        g.strokeRect(cw / 2 - sixW / 2, gl, sixW, sixD * dir);
        g.beginPath();
        g.arc(cw / 2, spotY, m(9.15),
          end === 0 ? 0.30 : Math.PI + 0.30,
          end === 0 ? Math.PI - 0.30 : Math.PI * 2 - 0.30);
        g.stroke();
      });
      paint(() => { g.beginPath(); g.arc(cw / 2, spotY, m(0.35), 0, TAU); g.fill(); });
    });

    // Corner arcs -- 1m radius, quarter circle into the field of play.
    [[pad, pad, 0], [cw - pad, pad, Math.PI / 2], [cw - pad, ch - pad, Math.PI], [pad, ch - pad, -Math.PI / 2]]
      .forEach(([x, y, a]) => {
        paint(() => { g.beginPath(); g.arc(x, y, m(1), a, a + Math.PI / 2); g.stroke(); });
      });

    return makeTex(THREE, cv);
  }

  // Surrounding grass: same family of greens but flatter and darker so the
  // field of play still pops as the brightest thing on screen.
  function makeApronTexture(THREE) {
    const cv = canvasOf(128, 128);
    const g = cv.getContext("2d");
    const rnd = rng(4242);
    g.fillStyle = "#12401F"; g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 2600; i++) {
      g.fillStyle = rnd() > 0.5 ? "rgba(140,200,150,0.10)" : "rgba(4,26,12,0.16)";
      g.fillRect(rnd() * 128, rnd() * 128, 1 + rnd() * 3, 1);
    }
    return makeTex(THREE, cv, true, 26, 26);
  }

  // --------------------------------------------------------- stadium textures

  // Raked seating deck: rows of seats with a sparse, dark crowd sat in them.
  // Deliberately murky -- the stands are backdrop. A brighter version turned
  // into a flat wall across the top of the frame every time the camera swung
  // behind a goal.
  function makeSeatTexture(THREE, repX, repY) {
    const cv = canvasOf(256, 128);
    const g = cv.getContext("2d");
    const rnd = rng(90210);
    g.fillStyle = "#0A1220"; g.fillRect(0, 0, 256, 128);

    const rows = 8, rh = 128 / rows;
    for (let r = 0; r < rows; r++) {
      const y = r * rh;
      g.fillStyle = r % 2 ? "#16233A" : "#131E31";
      g.fillRect(0, y, 256, rh - 1.5);
      g.fillStyle = "rgba(0,0,0,0.55)";
      g.fillRect(0, y + rh - 2.5, 256, 2.5);
      // Seat backs.
      for (let x = 0; x < 256; x += 8) {
        g.fillStyle = "rgba(120,150,200,0.06)";
        g.fillRect(x + 1, y + 1.5, 5.5, rh * 0.35);
      }
      // Spectators: torso blob plus a head, ~55% occupancy.
      for (let x = 0; x < 256; x += 8) {
        if (rnd() > 0.55) continue;
        const t = rnd();
        const shirt = t < 0.30 ? [46, 62, 92] : t < 0.55 ? [70, 78, 96]
          : t < 0.75 ? [92, 70, 62] : t < 0.9 ? [40, 48, 60] : [110, 106, 96];
        const k = 0.55 + rnd() * 0.5;
        g.fillStyle = toCss(mulRgb(shirt, k));
        g.fillRect(x + 1.5, y + 2.5, 5, rh * 0.55);
        g.fillStyle = toCss(mulRgb(mixRgb([210, 170, 130], [90, 60, 40], rnd()), k * 0.8));
        g.fillRect(x + 2.6, y + 1, 2.8, 2.6);
      }
    }
    // A handful of camera flashes so the crowd is not perfectly uniform.
    for (let i = 0; i < 26; i++) {
      const x = rnd() * 256, y = rnd() * 128;
      const fg = g.createRadialGradient(x, y, 0, x, y, 5);
      fg.addColorStop(0, "rgba(255,250,225,0.55)");
      fg.addColorStop(1, "rgba(255,250,225,0)");
      g.fillStyle = fg; g.beginPath(); g.arc(x, y, 5, 0, TAU); g.fill();
    }
    return makeTex(THREE, cv, true, repX, repY);
  }

  // Perimeter advertising hoardings. Muted on purpose -- these ring the whole
  // pitch at eye level and would scream if they were saturated.
  function makeBoardTexture(THREE, repX) {
    const cv = canvasOf(512, 48);
    const g = cv.getContext("2d");
    const rnd = rng(1357);
    g.fillStyle = "#0D1522"; g.fillRect(0, 0, 512, 48);
    const tint = [[36, 62, 96], [70, 46, 40], [34, 74, 58], [58, 52, 84], [80, 68, 36]];
    let x = 0;
    while (x < 512) {
      const w = 60 + rnd() * 70;
      const c = tint[(rnd() * tint.length) | 0];
      const gr = g.createLinearGradient(x, 0, x, 48);
      gr.addColorStop(0, toCss(mulRgb(c, 1.15)));
      gr.addColorStop(1, toCss(mulRgb(c, 0.55)));
      g.fillStyle = gr; g.fillRect(x + 1, 3, w - 3, 42);
      // Abstract "logo" marks: legible as branding, unreadable as text.
      g.fillStyle = "rgba(232,240,255,0.30)";
      const bw = 8 + rnd() * 26;
      g.fillRect(x + 10, 18, bw, 5);
      g.fillRect(x + 10, 27, bw * 0.6, 4);
      g.fillStyle = "rgba(232,240,255,0.16)";
      g.fillRect(x + 10, 10, bw * 0.35, 4);
      x += w;
    }
    g.fillStyle = "rgba(0,0,0,0.45)"; g.fillRect(0, 44, 512, 4);
    return makeTex(THREE, cv, true, repX || 1, 1);
  }

  // Real goal netting: a grid with genuine transparency between the cords.
  // A flat translucent panel reads as glass; this reads as a net.
  function makeNetCanvas() {
    const cv = canvasOf(128, 128);
    const g = cv.getContext("2d");
    g.clearRect(0, 0, 128, 128);
    g.strokeStyle = "rgba(236,244,255,0.92)";
    g.lineWidth = 1.6;
    const n = 8, s = 128 / n;
    g.beginPath();
    for (let i = 0; i <= n; i++) {
      g.moveTo(i * s, 0); g.lineTo(i * s, 128);
      g.moveTo(0, i * s); g.lineTo(128, i * s);
    }
    g.stroke();
    // Knots where the cords cross.
    g.fillStyle = "rgba(236,244,255,0.95)";
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) g.fillRect(i * s - 1.4, j * s - 1.4, 2.8, 2.8);
    }
    return cv;
  }

  // ------------------------------------------------------------------ stadium

  V.buildStadium = function (THREE, opts) {
    opts = opts || {};
    _T = THREE;
    _shadowsOn = !!opts.shadows;
    _stadiumOwned = [];
    const O = _stadiumOwned;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05080F);
    // Fog does the heavy lifting on the stands: they dissolve into the night
    // instead of forming a hard silhouette against the sky.
    scene.fog = new THREE.Fog(0x0A1524, 78, 235);

    // ---- sky. Without it anything above the stands reads as a flat black void.
    const skyCv = canvasOf(4, 160);
    const sg = skyCv.getContext("2d");
    const grad = sg.createLinearGradient(0, 0, 0, 160);
    grad.addColorStop(0, "#03060C");
    grad.addColorStop(0.42, "#07101D");
    grad.addColorStop(0.74, "#102338");
    grad.addColorStop(0.92, "#1B3B57");
    grad.addColorStop(1, "#27506E");
    sg.fillStyle = grad; sg.fillRect(0, 0, 4, 160);
    const skyGeo = own(O, new THREE.SphereGeometry(300, 16, 12));
    const skyMat = own(O, new THREE.MeshBasicMaterial({
      map: own(O, makeTex(THREE, skyCv)), side: THREE.BackSide, fog: false, depthWrite: false,
    }));
    scene.add(new THREE.Mesh(skyGeo, skyMat));

    // ---- playing surface
    const groundGeo = own(O, new THREE.PlaneGeometry(PITCH_W, PITCH_L));
    const groundMat = own(O, new THREE.MeshLambertMaterial({ map: own(O, makePitchTexture(THREE)) }));
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const apronGeo = own(O, new THREE.PlaneGeometry(PITCH_W + 40, PITCH_L + 40));
    const apronMat = own(O, new THREE.MeshLambertMaterial({ map: own(O, makeApronTexture(THREE)) }));
    const apron = new THREE.Mesh(apronGeo, apronMat);
    apron.rotation.x = -Math.PI / 2; apron.position.y = -0.03;
    apron.receiveShadow = true;
    scene.add(apron);

    // ---- stands. Built once as a local-space template: local -Z is "away from
    // the pitch", so each of the four sides is the same code with a rotation.
    // Kept low (7.4m deck, 8.8m roof) and very dark on purpose.
    const boardTex = own(O, makeBoardTexture(THREE, 14));
    const boardGeo = own(O, new THREE.BoxGeometry(1, 1, 0.3));
    const boardMat = own(O, new THREE.MeshLambertMaterial({ map: boardTex }));
    const deckGeo = own(O, new THREE.PlaneGeometry(1, 1));
    const darkMat = own(O, new THREE.MeshLambertMaterial({ color: 0x0A1120 }));
    const roofMat = own(O, new THREE.MeshBasicMaterial({ color: 0x070C16 }));
    const boxGeo = own(O, new THREE.BoxGeometry(1, 1, 1));

    const DECK_D = 15, FRONT_Y = 1.5, BACK_Y = 7.4;
    const slant = Math.hypot(DECK_D, BACK_Y - FRONT_Y);
    const deckAngle = -Math.atan2(DECK_D, BACK_Y - FRONT_Y);

    function addStand(w, x, z, rotY, deckMat) {
      const gp = new THREE.Group();

      const board = new THREE.Mesh(boardGeo, boardMat);
      board.scale.set(w, 1.15, 1);
      board.position.set(0, 0.575, 0.9);
      gp.add(board);

      const deck = new THREE.Mesh(deckGeo, deckMat);
      deck.scale.set(w, slant, 1);
      deck.rotation.x = deckAngle;
      deck.position.set(0, (FRONT_Y + BACK_Y) / 2, -DECK_D / 2);
      gp.add(deck);

      // Filler under the deck and a back wall, so no sky leaks through.
      const under = new THREE.Mesh(boxGeo, darkMat);
      under.scale.set(w, FRONT_Y + 0.2, DECK_D);
      under.position.set(0, (FRONT_Y + 0.2) / 2 - 0.1, -DECK_D / 2);
      gp.add(under);

      const back = new THREE.Mesh(boxGeo, darkMat);
      back.scale.set(w, BACK_Y + 1.4, 1.2);
      back.position.set(0, (BACK_Y + 1.4) / 2, -DECK_D - 0.6);
      gp.add(back);

      const roof = new THREE.Mesh(boxGeo, roofMat);
      roof.scale.set(w, 0.5, DECK_D * 0.62);
      roof.position.set(0, 8.8, -DECK_D * 0.68);
      gp.add(roof);

      gp.position.set(x, 0, z);
      gp.rotation.y = rotY;
      scene.add(gp);
    }

    // Separate deck textures per axis: one shared texture would stretch the
    // seats on the 135m touchline stands relative to the 98m end stands.
    const endW = PITCH_W + 30, sideW = PITCH_L + 30;
    const endDeckMat = own(O, new THREE.MeshLambertMaterial({
      map: own(O, makeSeatTexture(THREE, endW / 7, slant / 3)),
    }));
    const sideDeckMat = own(O, new THREE.MeshLambertMaterial({
      map: own(O, makeSeatTexture(THREE, sideW / 7, slant / 3)),
    }));

    addStand(endW, 0, -(PITCH_L / 2 + 8), 0, endDeckMat);
    addStand(endW, 0, (PITCH_L / 2 + 8), Math.PI, endDeckMat);
    addStand(sideW, -(PITCH_W / 2 + 8), 0, Math.PI / 2, sideDeckMat);
    addStand(sideW, (PITCH_W / 2 + 8), 0, -Math.PI / 2, sideDeckMat);

    // Corner infill so the four stands read as one bowl.
    [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([sx, sz]) => {
      const c = new THREE.Mesh(boxGeo, darkMat);
      c.scale.set(20, 8.2, 20);
      c.position.set(sx * (PITCH_W / 2 + 14), 4.1, sz * (PITCH_L / 2 + 14));
      c.rotation.y = Math.PI / 4;
      scene.add(c);
    });

    // ---- floodlight pylons: thin, so they never become a wall.
    const mastGeo = own(O, new THREE.CylinderGeometry(0.28, 0.5, 26, 6));
    const mastMat = own(O, new THREE.MeshLambertMaterial({ color: 0x1A2434 }));
    const rigGeo = own(O, new THREE.BoxGeometry(6.5, 3.2, 0.6));
    const rigMat = own(O, new THREE.MeshBasicMaterial({ color: 0xF3F7FF }));
    const glowCv = canvasOf(64, 64);
    const gg = glowCv.getContext("2d");
    const grd = gg.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, "rgba(214,232,255,0.95)");
    grd.addColorStop(0.35, "rgba(160,196,255,0.35)");
    grd.addColorStop(1, "rgba(120,160,255,0)");
    gg.fillStyle = grd; gg.fillRect(0, 0, 64, 64);
    const glowTex = own(O, makeTex(THREE, glowCv));
    const glowMat = own(O, new THREE.SpriteMaterial({
      map: glowTex, transparent: true, opacity: 0.75, depthWrite: false, fog: false,
      blending: THREE.AdditiveBlending,
    }));
    const glows = [];
    [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([sx, sz]) => {
      const px = sx * (PITCH_W / 2 + 22), pz = sz * (PITCH_L / 2 + 22);
      const mast = new THREE.Mesh(mastGeo, mastMat);
      mast.position.set(px, 13, pz);
      scene.add(mast);
      const rigm = new THREE.Mesh(rigGeo, rigMat);
      rigm.position.set(px, 26.5, pz);
      rigm.lookAt(0, 0, 0);
      scene.add(rigm);
      const gl = new THREE.Sprite(glowMat);
      gl.position.set(px, 26.5, pz);
      gl.scale.set(22, 22, 1);
      scene.add(gl);
      glows.push(gl);
    });

    // ---- lighting. Warm key from one corner, cool fill from the other, plus a
    // hemisphere so the grass bounces green into the players' undersides -- the
    // single cheapest thing that stops lit capsules looking like plastic toys.
    scene.add(new THREE.HemisphereLight(0x9FC0F0, 0x1E4A2A, 0.85));
    scene.add(new THREE.AmbientLight(0xB8CCE8, 0.35));

    const key = new THREE.DirectionalLight(0xFFF2DC, 1.35);
    key.position.set(20, 40, -18);
    scene.add(key);
    scene.add(key.target);

    if (_shadowsOn) {
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.bias = -0.0009;
      if ("normalBias" in key.shadow) key.shadow.normalBias = 0.02;
      const c = key.shadow.camera;
      // A 52m box, slid onto the camera's focus every frame (see below). A
      // frustum big enough for the whole 105m pitch would put ~10cm per texel
      // on the map and turn every player's shadow into a grey smudge.
      c.left = -26; c.right = 26; c.top = 26; c.bottom = -26;
      c.near = 6; c.far = 100;
      c.updateProjectionMatrix();
    }

    const fill = new THREE.DirectionalLight(0x93B6F0, 0.55);
    fill.position.set(-34, 26, 30);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xBFD6FF, 0.32);
    rim.position.set(6, 12, 60);
    scene.add(rim);

    // ---- goals
    const postGeo = own(O, new THREE.CylinderGeometry(0.075, 0.075, GOAL_H, 8));
    const barGeo = own(O, new THREE.CylinderGeometry(0.075, 0.075, GOAL_W + 0.15, 8));
    const strutGeo = own(O, new THREE.CylinderGeometry(0.05, 0.05, 1, 6));
    const postMat = own(O, new THREE.MeshPhongMaterial({
      color: 0xF6F9FF, shininess: 40, specular: 0x555a66,
    }));
    const netCv = makeNetCanvas();
    const netMatFor = (rx, ry) => own(O, new THREE.MeshBasicMaterial({
      map: own(O, makeTex(THREE, netCv, true, rx, ry)),
      transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false,
    }));
    const backNetMat = netMatFor(GOAL_W / 0.95, GOAL_H / 0.95);
    const sideNetMat = netMatFor(GOAL_DEPTH / 0.95, GOAL_H / 0.95);
    const topNetMat = netMatFor(GOAL_W / 0.95, GOAL_DEPTH / 0.95);
    const backGeo = own(O, new THREE.PlaneGeometry(GOAL_W, GOAL_H));
    const sideGeo = own(O, new THREE.PlaneGeometry(GOAL_DEPTH, GOAL_H));
    const topGeo = own(O, new THREE.PlaneGeometry(GOAL_W, GOAL_DEPTH));

    [-PITCH_L / 2, PITCH_L / 2].forEach((gz) => {
      const inward = gz < 0 ? 1 : -1;   // +1 means the net sits at -z of the line
      const gp = new THREE.Group();
      [-1, 1].forEach((s) => {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(s * GOAL_W / 2, GOAL_H / 2, 0);
        post.castShadow = _shadowsOn;
        gp.add(post);
        // Back stanchion + diagonal strut: the shapes that make a goal read as
        // a goal from behind rather than as a floating rectangle.
        const stan = new THREE.Mesh(strutGeo, postMat);
        stan.scale.y = GOAL_H * 0.55;
        stan.position.set(s * GOAL_W / 2, GOAL_H * 0.275, -inward * GOAL_DEPTH);
        gp.add(stan);
        const diag = new THREE.Mesh(strutGeo, postMat);
        diag.scale.y = Math.hypot(GOAL_DEPTH, GOAL_H * 0.45);
        diag.position.set(s * GOAL_W / 2, GOAL_H * 0.775, -inward * GOAL_DEPTH / 2);
        diag.rotation.x = inward * Math.atan2(GOAL_DEPTH, GOAL_H * 0.45);
        gp.add(diag);
      });
      const bar = new THREE.Mesh(barGeo, postMat);
      bar.rotation.z = Math.PI / 2; bar.position.y = GOAL_H;
      bar.castShadow = _shadowsOn;
      gp.add(bar);

      const back = new THREE.Mesh(backGeo, backNetMat);
      back.position.set(0, GOAL_H / 2, -inward * GOAL_DEPTH);
      gp.add(back);
      const top = new THREE.Mesh(topGeo, topNetMat);
      top.rotation.x = -Math.PI / 2;
      top.position.set(0, GOAL_H, -inward * GOAL_DEPTH / 2);
      gp.add(top);
      [-1, 1].forEach((s) => {
        const side = new THREE.Mesh(sideGeo, sideNetMat);
        side.rotation.y = Math.PI / 2;
        side.position.set(s * GOAL_W / 2, GOAL_H / 2, -inward * GOAL_DEPTH / 2);
        gp.add(side);
      });
      gp.position.z = gz;
      scene.add(gp);
    });

    // ---- corner flags
    const flagPoleGeo = own(O, new THREE.CylinderGeometry(0.028, 0.028, 1.5, 5));
    const flagPoleMat = own(O, new THREE.MeshLambertMaterial({ color: 0xE8EDF5 }));
    const flagGeo = own(O, new THREE.PlaneGeometry(0.34, 0.24));
    const flagMat = own(O, new THREE.MeshLambertMaterial({
      color: 0xFFC93C, side: THREE.DoubleSide,
    }));
    const flags = [];
    [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([sx, sz]) => {
      const g2 = new THREE.Group();
      const pole = new THREE.Mesh(flagPoleGeo, flagPoleMat);
      pole.position.y = 0.75;
      g2.add(pole);
      const fl = new THREE.Mesh(flagGeo, flagMat);
      fl.position.set(0.17, 1.34, 0);
      g2.add(fl);
      g2.position.set(sx * (PITCH_W / 2 - 0.1), 0, sz * (PITCH_L / 2 - 0.1));
      scene.add(g2);
      flags.push(fl);
    });

    // ---- renderer plumbing + shadow focus.
    //
    // scene.onBeforeRender is called by WebGLRenderer before the shadow pass
    // and hands us the renderer, which is otherwise unreachable from here
    // (match3d.js constructs it). Two jobs:
    //  1. Switch shadowMap on the first time we see the renderer, so shadows
    //     work even if the integrator never wires up V.configureRenderer.
    //  2. Slide the shadow frustum onto the patch of pitch the camera is
    //     actually looking at, and only refresh the shadow map every other
    //     frame -- 30Hz shadows are invisible and halve the extra draw calls.
    let fwd = null, focus = null, frameNo = 0;
    scene.onBeforeRender = function (renderer, sc, camera) {
      V.configureRenderer(renderer);
      if (!_shadowsOn || !renderer.shadowMap || !renderer.shadowMap.enabled) return;
      if (!fwd) { fwd = new THREE.Vector3(); focus = new THREE.Vector3(); }

      fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
      let gx = camera.position.x, gz = camera.position.z;
      if (fwd.y < -0.05) {
        const k = Math.min(90, -camera.position.y / fwd.y);
        gx += fwd.x * k; gz += fwd.z * k;
      }
      focus.set(gx, 0, gz);
      key.target.position.copy(focus);
      key.position.set(gx + 20, 40, gz - 18);
      // onBeforeRender runs after scene.updateMatrixWorld, so these two have to
      // be refreshed by hand or the shadow camera lags a frame behind.
      key.updateMatrixWorld(true);
      key.target.updateMatrixWorld(true);

      frameNo++;
      renderer.shadowMap.needsUpdate = (frameNo & 1) === 0;
    };

    return {
      scene,
      tick: function (t) {
        // Cheap life: floodlights breathe, corner flags stir.
        const p = 0.72 + Math.sin(t * 0.9) * 0.05;
        glowMat.opacity = p;
        for (let i = 0; i < flags.length; i++) {
          flags[i].rotation.y = Math.sin(t * 2.1 + i) * 0.35;
        }
      },
    };
  };

  // Optional, additive export. match3d.js owns the WebGLRenderer, so this is
  // the only way to turn shadows/tone mapping on from the visuals module.
  // Safe to call more than once and safe never to call at all.
  V.configureRenderer = function (renderer) {
    if (!renderer || renderer.__m3dCfg) return;
    renderer.__m3dCfg = true;
    const THREE = _T || window.THREE;
    try {
      if (THREE && THREE.ACESFilmicToneMapping) {
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.25;
      }
      if (_shadowsOn && renderer.shadowMap) {
        renderer.shadowMap.enabled = true;
        if (THREE && THREE.PCFSoftShadowMap) renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        // We drive needsUpdate ourselves from scene.onBeforeRender.
        renderer.shadowMap.autoUpdate = false;
        renderer.shadowMap.needsUpdate = true;
      }
    } catch (e) { /* never let a look-and-feel tweak break the match */ }
  };

  // ------------------------------------------------------------ kit factories

  // Shirt wrap. Capsule UVs run u around the body and v bottom-to-top, so this
  // canvas is literally the jersey unrolled: collar at the top, hem at the
  // bottom, and vertical bars in the canvas become vertical stripes on the mesh.
  function makeShirtTexture(THREE, base, accent, pattern) {
    const cv = canvasOf(128, 96);
    const g = cv.getContext("2d");
    g.fillStyle = toCss(base); g.fillRect(0, 0, 128, 96);

    if (pattern === 1) {              // vertical stripes
      g.fillStyle = toCss(accent);
      for (let x = 0; x < 128; x += 16) g.fillRect(x, 0, 8, 96);
    } else if (pattern === 2) {       // sash
      g.save();
      g.fillStyle = toCss(accent);
      g.beginPath();
      g.moveTo(0, 20); g.lineTo(128, 62); g.lineTo(128, 82); g.lineTo(0, 40);
      g.closePath(); g.fill();
      g.restore();
    } else if (pattern === 3) {       // hoop across the chest
      g.fillStyle = toCss(accent);
      g.fillRect(0, 34, 128, 18);
    } else {                          // solid with a subtle tonal panel
      g.fillStyle = toCss(mulRgb(base, 1.14));
      g.fillRect(0, 0, 128, 30);
    }

    // Collar band and shoulder trim.
    g.fillStyle = toCss(accent);
    g.fillRect(0, 0, 128, 7);
    g.fillStyle = "rgba(0,0,0,0.30)";
    g.fillRect(0, 7, 128, 2);
    // Hem shadow -- reads as the shirt tucking into the shorts.
    const hg = g.createLinearGradient(0, 78, 0, 96);
    hg.addColorStop(0, "rgba(0,0,0,0)");
    hg.addColorStop(1, "rgba(0,0,0,0.42)");
    g.fillStyle = hg; g.fillRect(0, 78, 128, 18);
    return makeTex(THREE, cv);
  }

  // Two-tone limb strip. v runs along the limb, so "top 40% is fabric, rest is
  // skin" gives a sleeve, a shorts hem or a sock in exactly one mesh.
  function makeLimbTexture(THREE, topCol, botCol, split, cuff) {
    const cv = canvasOf(8, 64);
    const g = cv.getContext("2d");
    const yTop = 0, yCut = Math.round(64 * (1 - split));
    g.fillStyle = toCss(topCol); g.fillRect(0, yTop, 8, yCut);
    g.fillStyle = toCss(botCol); g.fillRect(0, yCut, 8, 64 - yCut);
    if (cuff) {
      g.fillStyle = toCss(mulRgb(topCol, 0.6));
      g.fillRect(0, Math.max(0, yCut - 3), 8, 3);
    }
    g.fillStyle = "rgba(0,0,0,0.22)";
    g.fillRect(0, 60, 8, 4);
    return makeTex(THREE, cv);
  }

  // Head: sphere UVs put v=1 at the crown, so a hair cap is just a band across
  // the top of the canvas. Cheaper than a second mesh and it silhouettes fine
  // at the ~9px a head occupies from the match camera.
  function makeHeadTexture(THREE, skin, hair) {
    const cv = canvasOf(64, 64);
    const g = cv.getContext("2d");
    g.fillStyle = toCss(skin); g.fillRect(0, 0, 64, 64);
    g.fillStyle = toCss(hair);
    g.fillRect(0, 0, 64, 18);
    // Wavy hairline so the cap edge is not a machined ring.
    g.beginPath();
    g.moveTo(0, 18);
    for (let x = 0; x <= 64; x += 4) g.lineTo(x, 18 + Math.sin(x * 0.55) * 2.4 + 1.5);
    g.lineTo(64, 18); g.closePath(); g.fill();
    // Jaw/neck shading, and a hint of brow.
    const sgr = g.createLinearGradient(0, 40, 0, 64);
    sgr.addColorStop(0, "rgba(0,0,0,0)");
    sgr.addColorStop(1, "rgba(0,0,0,0.42)");
    g.fillStyle = sgr; g.fillRect(0, 40, 64, 24);
    g.fillStyle = "rgba(0,0,0,0.10)"; g.fillRect(0, 22, 64, 3);
    return makeTex(THREE, cv);
  }

  // 4x4 atlas of shirt numbers. One texture and one material for the whole
  // squad; each player's plane just gets its UVs rewritten to point at a cell.
  function makeNumberAtlas(THREE) {
    const cv = canvasOf(256, 256);
    const g = cv.getContext("2d");
    g.clearRect(0, 0, 256, 256);
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (let i = 0; i < 16; i++) {
      const cx = (i % 4) * 64 + 32, cy = ((i / 4) | 0) * 64 + 32;
      const label = String(i + 1);
      g.font = "bold " + (label.length > 1 ? 42 : 50) + 'px "Arial Narrow", Arial, sans-serif';
      g.lineWidth = 7;
      g.strokeStyle = "rgba(6,10,18,0.85)";
      g.strokeText(label, cx, cy);
      g.fillStyle = "#F7FAFF";
      g.fillText(label, cx, cy);
    }
    return makeTex(THREE, cv);
  }

  // A kit is derived entirely from the one hex the sim hands us. Shorts and
  // socks are pulled off the shirt colour rather than picked at random so the
  // three parts always look like they belong to the same club.
  function buildKit(THREE, hex, isGK, O) {
    let base = parseHex(hex);
    if (isGK) {
      // Keepers must not be confusable with either outfield kit. A big hue
      // rotation off the team colour plus forced saturation does that without
      // needing to know what the other team is wearing.
      const hsl = rgbToHsl(base);
      base = hslToRgb(hsl[0] + 0.42, Math.max(0.62, hsl[1]), 0.50);
    }
    const bright = lum(base);
    const accent = bright > 0.52 ? mulRgb(base, 0.42) : [238, 242, 250];
    const shorts = isGK ? [22, 26, 34] : (bright > 0.55 ? mulRgb(base, 0.35) : mixRgb(base, [244, 247, 252], 0.82));
    const socks = isGK ? mulRgb(base, 0.82) : mulRgb(base, 0.86);
    const pattern = isGK ? 0 : (hash(base[0] * 65536 + base[1] * 256 + base[2]) % 4);

    const shirtTex = own(O, makeShirtTexture(THREE, base, accent, pattern));
    const kit = {
      base, accent, shorts, socks,
      shirtMat: own(O, new THREE.MeshPhongMaterial({
        map: shirtTex, shininess: 26, specular: 0x24282e,
      })),
      shortsMat: own(O, new THREE.MeshPhongMaterial({
        color: new THREE.Color(shorts[0] / 255, shorts[1] / 255, shorts[2] / 255),
        shininess: 18, specular: 0x1c1f24,
      })),
      gloveMat: isGK ? own(O, new THREE.MeshPhongMaterial({
        color: 0xEDF2FA, shininess: 30, specular: 0x333333,
      })) : null,
      isGK,
      limbs: {},     // lazily filled per skin tone
    };
    return kit;
  }

  function kitLimbs(THREE, kit, skinIdx, O) {
    let L = kit.limbs[skinIdx];
    if (L) return L;
    const skin = parseHex(SKINS[skinIdx % SKINS.length]);
    const P = (map) => own(O, new THREE.MeshPhongMaterial({ map, shininess: 12, specular: 0x1a1a1a }));
    L = {
      // sleeve down to mid-bicep, then skin
      arm: P(own(O, makeLimbTexture(THREE, kit.base, skin, 0.46, true))),
      // shorts hem at the very top of the thigh, then skin
      thigh: P(own(O, makeLimbTexture(THREE, kit.shorts, skin, 0.26, false))),
      // skin down to mid-calf, then sock
      shin: P(own(O, makeLimbTexture(THREE, skin, kit.socks, 0.42, false))),
      fore: kit.isGK ? kit.gloveMat
        : own(O, new THREE.MeshPhongMaterial({
            color: new THREE.Color(skin[0] / 255, skin[1] / 255, skin[2] / 255),
            shininess: 12, specular: 0x1a1a1a,
          })),
    };
    kit.limbs[skinIdx] = L;
    return L;
  }

  // ------------------------------------------------------------ player models

  V.makeKitSet = function (THREE, myHex, oppHex) {
    _T = THREE;
    const O = [];
    const cap = (r, len, capSeg, radSeg) => THREE.CapsuleGeometry
      ? new THREE.CapsuleGeometry(r, len, capSeg, radSeg)
      : new THREE.CylinderGeometry(r, r, len + r * 2, radSeg);

    const shared = {
      geo: {
        torso: own(O, cap(0.155, 0.28, 3, 12)),
        hips: own(O, cap(0.135, 0.07, 3, 10)),
        head: own(O, new THREE.SphereGeometry(0.115, 12, 10)),
        thigh: own(O, cap(0.072, THIGH_L - 0.144, 2, 8)),
        shin: own(O, cap(0.058, SHIN_L - 0.116, 2, 8)),
        upper: own(O, cap(0.052, UPPER_ARM_L - 0.104, 2, 7)),
        fore: own(O, cap(0.045, FOREARM_L - 0.09, 2, 7)),
        boot: own(O, new THREE.BoxGeometry(0.1, 0.09, 0.25)),
        blob: own(O, new THREE.CircleGeometry(0.46, 14)),
      },
      kits: {},
      gkKits: {},
      heads: {},
      numTex: null, numMat: null,
      bootMat: own(O, new THREE.MeshPhongMaterial({
        color: 0x14161C, shininess: 60, specular: 0x555a63,
      })),
      _owned: O,
    };

    shared.kits[myHex] = buildKit(THREE, myHex, false, O);
    shared.gkKits[myHex] = buildKit(THREE, myHex, true, O);
    if (oppHex !== myHex) {
      shared.kits[oppHex] = buildKit(THREE, oppHex, false, O);
      shared.gkKits[oppHex] = buildKit(THREE, oppHex, true, O);
    }

    shared.numTex = own(O, makeNumberAtlas(THREE));
    shared.numMat = own(O, new THREE.MeshLambertMaterial({
      map: shared.numTex, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide,
    }));

    // Soft contact shadow. Kept even when real shadow maps are on: it doubles
    // as ambient occlusion at the feet and it is the only ground contact cue
    // if the integrator never calls configureRenderer.
    const bcv = canvasOf(64, 64);
    const bg = bcv.getContext("2d");
    const bgr = bg.createRadialGradient(32, 32, 0, 32, 32, 32);
    bgr.addColorStop(0, "rgba(0,0,0,0.55)");
    bgr.addColorStop(0.55, "rgba(0,0,0,0.26)");
    bgr.addColorStop(1, "rgba(0,0,0,0)");
    bg.fillStyle = bgr; bg.fillRect(0, 0, 64, 64);
    shared.blobMat = own(O, new THREE.MeshBasicMaterial({
      map: own(O, makeTex(THREE, bcv)), transparent: true, depthWrite: false, opacity: 0.8,
    }));

    return shared;
  };

  V.createPlayer = function (THREE, shared, teamHex, isGK, number) {
    const O = shared._owned;
    const kits = isGK ? shared.gkKits : shared.kits;
    const kit = kits[teamHex] || buildKit(THREE, teamHex, isGK, O);
    if (!kits[teamHex]) kits[teamHex] = kit;

    const n = number || 1;
    const h = hash(n * 7 + (isGK ? 91 : 3));
    const skinIdx = h % SKINS.length;
    const hairIdx = (h >> 4) % HAIRS.length;
    const L = kitLimbs(THREE, kit, skinIdx, O);

    const headKey = skinIdx + "_" + hairIdx;
    let headMat = shared.heads[headKey];
    if (!headMat) {
      headMat = own(O, new THREE.MeshPhongMaterial({
        map: own(O, makeHeadTexture(THREE, parseHex(SKINS[skinIdx]), parseHex(HAIRS[hairIdx]))),
        shininess: 8, specular: 0x141414,
      }));
      shared.heads[headKey] = headMat;
    }

    const G = shared.geo;
    const group = new THREE.Group();
    const root = new THREE.Group();
    group.add(root);

    // Slight per-player height variation. Applied on `root` so the blob shadow
    // and the sim's control marker stay at true ground scale.
    const sc = 0.965 + ((h >> 9) % 8) * 0.009;
    root.scale.setScalar(sc);

    const hips = new THREE.Group();
    hips.position.y = HIP_Y;
    root.add(hips);

    const shortsMesh = new THREE.Mesh(G.hips, kit.shortsMat);
    shortsMesh.position.y = -0.03;
    shortsMesh.scale.set(1.3, 1.0, 0.95);
    hips.add(shortsMesh);

    const torso = new THREE.Group();
    hips.add(torso);
    const torsoMesh = new THREE.Mesh(G.torso, kit.shirtMat);
    torsoMesh.position.y = 0.30;
    torsoMesh.scale.set(1.44, 1.0, 0.82);
    torso.add(torsoMesh);

    // Shirt number on the back. Its own 4-vertex geometry (UVs rewritten to
    // this player's cell of the shared atlas) so all 22 share one material.
    const numGeo = own(O, new THREE.PlaneGeometry(0.24, 0.26));
    const cell = (n - 1) % 16;
    const cx = cell % 4, cy = (cell / 4) | 0;
    const u0 = cx / 4, u1 = (cx + 1) / 4;
    const v1 = 1 - cy / 4, v0 = 1 - (cy + 1) / 4;
    const uv = numGeo.attributes.uv;
    uv.setXY(0, u0, v1); uv.setXY(1, u1, v1);
    uv.setXY(2, u0, v0); uv.setXY(3, u1, v0);
    uv.needsUpdate = true;
    const numMesh = new THREE.Mesh(numGeo, shared.numMat);
    numMesh.position.set(0, 0.34, -0.16);
    numMesh.rotation.y = Math.PI;
    torso.add(numMesh);

    const head = new THREE.Mesh(G.head, headMat);
    head.position.set(0, HEAD_Y, 0.008);
    head.scale.set(1, 1.1, 1.02);
    torso.add(head);

    const legs = [], arms = [];
    for (let i = 0; i < 2; i++) {
      const side = i ? -1 : 1;

      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.208, SHOULDER_Y, 0);
      torso.add(shoulder);
      const upper = new THREE.Mesh(G.upper, L.arm);
      upper.position.y = -UPPER_ARM_L / 2;
      shoulder.add(upper);
      const elbow = new THREE.Group();
      elbow.position.y = -UPPER_ARM_L;
      shoulder.add(elbow);
      const fore = new THREE.Mesh(G.fore, L.fore);
      fore.position.y = -FOREARM_L / 2;
      elbow.add(fore);
      arms.push({ sh: shoulder, el: elbow, side });

      const hip = new THREE.Group();
      hip.position.set(side * 0.088, 0, 0);
      hips.add(hip);
      const thigh = new THREE.Mesh(G.thigh, L.thigh);
      thigh.position.y = -THIGH_L / 2;
      thigh.castShadow = _shadowsOn;
      hip.add(thigh);
      const knee = new THREE.Group();
      knee.position.y = -THIGH_L;
      hip.add(knee);
      const shin = new THREE.Mesh(G.shin, L.shin);
      shin.position.y = -SHIN_L / 2;
      shin.castShadow = _shadowsOn;
      knee.add(shin);
      const ankle = new THREE.Group();
      ankle.position.y = -SHIN_L;
      knee.add(ankle);
      const boot = new THREE.Mesh(G.boot, shared.bootMat);
      boot.position.set(0, -0.048, 0.046);
      ankle.add(boot);
      legs.push({ hip, knee, ankle, side });
    }

    // Only the torso and thighs cast: a shadow pass over all 14 meshes of all
    // 22 players triples the frame's draw calls for detail nobody can see at
    // 28m. Torso + legs is enough for the silhouette to read as a running man.
    torsoMesh.castShadow = _shadowsOn;

    const blob = new THREE.Mesh(G.blob, shared.blobMat);
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.015;
    group.add(blob);   // on `group`, not `root`, so the bob never lifts it

    return {
      group, root, hips, torso, head, legs, arms, blob,
      isGK: !!isGK, number: n,
      // Animation state, pre-seeded so nothing is created per frame.
      phase: (h % 1000) / 1000 * TAU,
      kickLeg: (h % 5 === 0) ? 0 : 1,
      cyc: 0, run: 0, sn: 0, kickT: 0, stunB: 0, gkB: isGK ? 1 : 0,
      _t: 0, _wasKick: false,
    };
  };

  // ------------------------------------------------------------- animation

  function approach(cur, tgt, k, dt) { return cur + (tgt - cur) * Math.min(1, k * dt); }
  function ss(x) { return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x); }

  // Wind up, strike through, follow through, settle. Returns the striking
  // thigh's forward angle: 0 -> -1 (back) -> +1.15 (through) -> 0.
  function kickCurve(u) {
    if (u < 0.30) return -Math.sin((u / 0.30) * Math.PI * 0.5);
    if (u < 0.62) return -1 + 2.15 * ss((u - 0.30) / 0.32);
    return 1.15 * (1 - ss((u - 0.62) / 0.38));
  }

  // Per-frame pose. Everything below is scalar arithmetic on Groups that were
  // built in createPlayer -- no allocation, no lookups by name, no Vector3.
  V.animatePlayer = function (rig, st) {
    const t = st.t || 0;
    let dt = t - rig._t;
    rig._t = t;
    if (!(dt > 0.0001) || dt > 0.2) dt = 1 / 60;

    const sp = st.speed || 0;
    rig.run = approach(rig.run, sp > 0.45 ? 1 : 0, 9, dt);
    rig.sn = approach(rig.sn, Math.min(1, sp / 6.2), 6, dt);
    rig.stunB = approach(rig.stunB, st.stunned ? 1 : 0, 9, dt);
    const run = rig.run, sn = rig.sn, idle = 1 - run;

    // Integrate the cycle rather than using t*freq: when the frequency changes
    // (accelerating out of a turn) t*freq jumps the phase and the legs snap.
    const freq = 0.95 + 2.0 * sn;
    rig.cyc += freq * dt * (0.3 + 0.7 * run);
    if (rig.cyc > 1e6) rig.cyc -= 1e6;
    const th = rig.cyc * TAU + rig.phase;

    // Kick is edge-triggered: st.kicking is only true for a fraction of a
    // second, far too short to read, so it starts a 0.45s envelope instead.
    if (st.kicking && !rig._wasKick) rig.kickT = 1;
    rig._wasKick = !!st.kicking;
    if (rig.kickT > 0) rig.kickT = Math.max(0, rig.kickT - dt / 0.45);
    const ku = 1 - rig.kickT;
    const kw = rig.kickT > 0 ? Math.sin(Math.PI * ku) : 0;
    const kSwing = rig.kickT > 0 ? kickCurve(ku) : 0;

    const stun = rig.stunB;
    const gk = rig.gkB;
    const breathe = Math.sin(t * 1.55 + rig.phase);
    const sway = Math.sin(t * 0.7 + rig.phase * 1.3);

    // Hip swing grows with speed: a jog is a shuffle, a sprint is a stride.
    const amp = 0.30 + 0.66 * sn;
    const kneeAmp = 0.18 + 1.25 * sn;

    for (let i = 0; i < 2; i++) {
      const leg = rig.legs[i];
      const ph = th + (i ? Math.PI : 0);
      const s = Math.sin(ph);

      let hipX = -amp * s * run;
      // Knee flexion peaks shortly after the foot leaves the ground.
      let kneeX = 0.06 + kneeAmp * Math.max(0, -Math.sin(ph + 0.75)) * run;

      // Idle: weight settled, knees just off locked, subtle breathing.
      hipX += idle * (0.02 + breathe * 0.012);
      kneeX += idle * (0.10 + gk * 0.30 + Math.abs(sway) * 0.03);

      if (kw > 0) {
        if (i === rig.kickLeg) {
          hipX = hipX * (1 - kw) + (-kSwing) * kw;
          kneeX = kneeX * (1 - kw) + (0.10 + 0.95 * Math.max(0, -kSwing)) * kw;
        } else {
          // Plant leg: braced, knee soft.
          hipX = hipX * (1 - kw) + 0.12 * kw;
          kneeX = kneeX * (1 - kw) + 0.30 * kw;
        }
      }
      if (stun > 0) {
        hipX = hipX * (1 - stun) + 0.22 * stun;
        kneeX = kneeX * (1 - stun) + 0.75 * stun;
      }

      leg.hip.rotation.x = hipX;
      leg.hip.rotation.z = leg.side * (0.03 + gk * 0.09 + idle * 0.02);
      leg.knee.rotation.x = kneeX;
      // Keep the sole roughly parallel to the pitch instead of pointing at it.
      leg.ankle.rotation.x = -(hipX + kneeX) * 0.62 + 0.10 * run;
    }

    const armAmp = (0.22 + 0.78 * sn) * run;
    const splay = 0.10 + 0.10 * run + gk * 0.62 + (st.hasBall ? 0.06 : 0);
    for (let i = 0; i < 2; i++) {
      const arm = rig.arms[i];
      const ph = th + (i ? Math.PI : 0);
      // Arms counter-swing: same phase as the OPPOSITE leg.
      let shX = armAmp * Math.sin(ph) + idle * (0.06 + breathe * 0.02);
      let elX = -(0.32 + 0.55 * sn * run) - gk * 0.55;
      let shZ = arm.side * splay;

      if (kw > 0) {
        // Opposite arm flies up for balance through the strike.
        const opp = (i === rig.kickLeg) ? -1 : 1;
        shX = shX * (1 - kw) + (opp * 0.85 * kSwing * -1) * kw;
        shZ = shZ * (1 - kw) + arm.side * (0.32 + 0.30 * kw) * kw;
      }
      if (stun > 0) {
        shX = shX * (1 - stun) + (-0.5) * stun;
        shZ = shZ * (1 - stun) + arm.side * 0.55 * stun;
      }

      arm.sh.rotation.x = shX;
      arm.sh.rotation.z = shZ;
      arm.el.rotation.x = elX;
    }

    // Torso: forward lean with speed, counter-twist against the arms, a little
    // side sway, and a backwards recoil through the kick.
    const sTh = Math.sin(th);
    let lean = -(0.04 + 0.30 * sn * run) - gk * 0.12 * idle;
    lean += idle * breathe * 0.012;
    if (kw > 0) lean = lean * (1 - kw) + (0.16 - 0.28 * kSwing) * kw;
    if (stun > 0) lean = lean * (1 - stun) + 0.42 * stun;
    rig.torso.rotation.x = lean;
    rig.torso.rotation.y = -0.22 * sn * run * sTh + (kw > 0 ? kw * 0.30 * (rig.kickLeg ? -1 : 1) : 0);
    rig.torso.rotation.z = 0.055 * sn * run * sTh + idle * sway * 0.02;

    rig.hips.rotation.y = 0.14 * sn * run * sTh;
    rig.hips.rotation.z = idle * sway * 0.035 * (1 - gk);

    // Vertical: the hips drop as the stance leg angles away from vertical, so
    // the bob is a consequence of the stride rather than a sine bolted on top.
    const drop = -(0.018 + 0.062 * sn) * run * (0.5 - 0.5 * Math.cos(2 * th));
    rig.root.position.y = drop + idle * breathe * 0.008 - stun * 0.10;
    // The head is steadier than the hips; damping it sells the run cycle.
    rig.head.position.y = HEAD_Y - drop * 0.35;
  };

  // ---------------------------------------------------------------- the ball

  // Truncated-icosahedron look, approximated in equirectangular UV space: the
  // 12 icosahedron vertices become the black pentagons. It distorts near the
  // poles, which is invisible on a ball that is ~25px across and spinning.
  function makeBallTexture(THREE) {
    const W = 256, H = 128;
    const cv = canvasOf(W, H);
    const g = cv.getContext("2d");
    g.fillStyle = "#F4F6F8"; g.fillRect(0, 0, W, H);

    // Faint hex lattice for the seams between the white panels.
    g.strokeStyle = "rgba(120,132,148,0.30)";
    g.lineWidth = 1.4;
    for (let row = -1; row < 7; row++) {
      for (let col = -1; col < 11; col++) {
        const cx = col * 26 + (row % 2 ? 13 : 0), cy = row * 22;
        g.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = k * Math.PI / 3 + Math.PI / 6;
          const px = cx + Math.cos(a) * 15, py = cy + Math.sin(a) * 13;
          if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.closePath(); g.stroke();
      }
    }

    const gr = (1 + Math.sqrt(5)) / 2;
    const verts = [
      [-1, gr, 0], [1, gr, 0], [-1, -gr, 0], [1, -gr, 0],
      [0, -1, gr], [0, 1, gr], [0, -1, -gr], [0, 1, -gr],
      [gr, 0, -1], [gr, 0, 1], [-gr, 0, -1], [-gr, 0, 1],
    ];
    g.fillStyle = "#1A1E26";
    verts.forEach((v) => {
      const len = Math.hypot(v[0], v[1], v[2]);
      const x = v[0] / len, y = v[1] / len, z = v[2] / len;
      const theta = Math.acos(Math.max(-1, Math.min(1, y)));
      const u = ((Math.atan2(z, -x) / TAU) + 1) % 1;
      const px = u * W, py = (theta / Math.PI) * H;
      const ry = 0.115 * H;
      const rx = Math.min(0.34 * W, 0.115 * W / Math.max(0.28, Math.sin(theta)));
      for (let rep = -1; rep <= 1; rep++) {
        g.save();
        g.translate(px + rep * W, py);
        g.scale(rx, ry);
        g.beginPath();
        for (let k = 0; k < 5; k++) {
          const a = -Math.PI / 2 + k * TAU / 5;
          const ax = Math.cos(a), ay = Math.sin(a);
          if (k === 0) g.moveTo(ax, ay); else g.lineTo(ax, ay);
        }
        g.closePath();
        g.restore();
        g.fill();
      }
    });
    return makeTex(THREE, cv);
  }

  V.createBall = function (THREE) {
    _T = _T || THREE;
    // BALL_R (0.36) is oversized versus a real 0.11m ball -- that is the sim's
    // legibility call and the physics depend on it, so the mesh matches it.
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 18, 14),
      new THREE.MeshPhongMaterial({
        map: makeBallTexture(THREE), shininess: 55, specular: 0x5a606b,
        emissive: 0x0d1016,
      })
    );
    mesh.castShadow = _shadowsOn;

    const scv = canvasOf(64, 64);
    const sg = scv.getContext("2d");
    const sgr = sg.createRadialGradient(32, 32, 0, 32, 32, 32);
    sgr.addColorStop(0, "rgba(0,0,0,0.62)");
    sgr.addColorStop(0.5, "rgba(0,0,0,0.30)");
    sgr.addColorStop(1, "rgba(0,0,0,0)");
    sg.fillStyle = sgr; sg.fillRect(0, 0, 64, 64);
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(BALL_R * 1.5, 14),
      new THREE.MeshBasicMaterial({
        map: makeTex(THREE, scv), transparent: true, depthWrite: false, opacity: 0.85,
      })
    );
    shadow.rotation.x = -Math.PI / 2;
    return { mesh, shadow };
  };

  // ------------------------------------------------------------------ dispose

  function disposeList(list) {
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o && typeof o.dispose === "function") {
        try { o.dispose(); } catch (e) { /* already gone */ }
      }
    }
    list.length = 0;
  }

  V.disposeShared = function (shared) {
    if (shared && shared._owned) disposeList(shared._owned);
    disposeList(_stadiumOwned);
    _shadowsOn = false;
  };

  window.Match3DVisuals = V;
})();
