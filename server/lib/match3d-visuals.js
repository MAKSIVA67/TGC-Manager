// TCG Manager -- 3D match: everything you SEE.
//
// Owns the stadium, the player models and their animation, the ball, and the
// materials/lighting. Deliberately split out of match3d.js so the look of the
// game can be worked on without touching simulation or input code.
//
// Hard constraints, do not design around wishing them away:
//  * The repo ships ZERO 3D assets (no .glb/.gltf/.fbx anywhere) and there is
//    no build step or bundler. Every mesh and texture here must be generated
//    procedurally at runtime from three.js primitives and <canvas>.
//  * This runs in a phone browser as a PWA. 22 animated players plus the
//    stadium have to hold a steady framerate on mid-range hardware, so share
//    geometry/materials aggressively and keep per-frame allocation at zero.
//  * three.js is pinned to r155 (the last UMD build exposing a global THREE).
//    Anything newer than r155's API surface is unavailable.
//
// Contract used by match3d.js -- keep these signatures stable:
//   V.buildStadium(THREE, opts)            -> { scene, tick(t, dt) }
//   V.makeKitSet(THREE, myHex, oppHex)     -> shared kit/material bundle
//   V.createPlayer(THREE, shared, teamHex, isGK, number) -> rig
//   V.animatePlayer(rig, st, dt)           -> per-frame pose update
//   V.createBall(THREE)                    -> { mesh, shadow }
//   V.disposeShared(shared)
// `rig` must expose `.group` (added to the scene, positioned by the sim).
// `st` is { speed, facing, kicking, tackling, celebrating, t }.
"use strict";

(function () {
  const V = {};

  // Pitch dimensions are mirrored from match3d.js -- kept in sync by hand
  // because neither module should have to load the other to draw a line.
  const PITCH_W = 68, PITCH_L = 105;
  const GOAL_W = 7.32, GOAL_H = 2.44, GOAL_DEPTH = 2.0;
  const BALL_R = 0.36;

  // ------------------------------------------------------------ pitch texture

  // Draws the full marking set into a canvas once and uses it as the ground
  // texture. Cheaper and sharper than line geometry, and the mow stripes,
  // circles and boxes all come for free.
  function makePitchTexture(THREE) {
    const px = 16;
    const cw = Math.round(PITCH_W * px), ch = Math.round(PITCH_L * px);
    const cv = document.createElement("canvas");
    cv.width = cw; cv.height = ch;
    const g = cv.getContext("2d");

    const stripes = 14, sh = ch / stripes;
    for (let i = 0; i < stripes; i++) {
      g.fillStyle = i % 2 ? "#1F7A46" : "#1B6C3E";
      g.fillRect(0, i * sh, cw, sh + 1);
    }
    const vg = g.createRadialGradient(cw / 2, ch / 2, ch * 0.15, cw / 2, ch / 2, ch * 0.72);
    vg.addColorStop(0, "rgba(255,255,255,0.05)");
    vg.addColorStop(1, "rgba(0,0,0,0.22)");
    g.fillStyle = vg; g.fillRect(0, 0, cw, ch);

    const m = (v) => v * px;
    g.strokeStyle = "rgba(255,255,255,0.82)";
    g.lineWidth = Math.max(2, 0.12 * px);
    g.lineCap = "butt";

    const pad = m(0.4);
    g.strokeRect(pad, pad, cw - pad * 2, ch - pad * 2);
    g.beginPath(); g.moveTo(pad, ch / 2); g.lineTo(cw - pad, ch / 2); g.stroke();
    g.beginPath(); g.arc(cw / 2, ch / 2, m(9.15), 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(cw / 2, ch / 2, m(0.35), 0, Math.PI * 2);
    g.fillStyle = "rgba(255,255,255,0.85)"; g.fill();

    [0, 1].forEach((end) => {
      const dir = end === 0 ? 1 : -1;
      const gl = end === 0 ? pad : ch - pad;
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

  let _crowdTex = null;
  function crowdTexture(THREE) {
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

  // ------------------------------------------------------------------ stadium

  V.buildStadium = function (THREE, opts) {
    opts = opts || {};
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x060A12);
    scene.fog = new THREE.Fog(0x0A1424, 95, 240);

    // Night sky. Without it anything above the stands reads as a flat black
    // void and the horizon looks like a rendering bug.
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

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(PITCH_W, PITCH_L),
      new THREE.MeshLambertMaterial({ map: makePitchTexture(THREE) })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const apron = new THREE.Mesh(
      new THREE.PlaneGeometry(PITCH_W + 30, PITCH_L + 30),
      new THREE.MeshBasicMaterial({ color: 0x0B2216 })
    );
    apron.rotation.x = -Math.PI / 2; apron.position.y = -0.02;
    scene.add(apron);

    // Stands: kept dark and low on purpose. Brighter or taller and they become
    // a flat wall across the top of the frame every time the camera swings
    // behind a goal -- they are backdrop, not scenery.
    const standMat = new THREE.MeshBasicMaterial({ color: 0x121D2E });
    const addStand = (w, d, x, z, rotY) => {
      const gp = new THREE.Group();
      for (let t = 0; t < 3; t++) {
        const hgt = 2.2 + t * 1.7;
        const slab = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, d / 3), standMat);
        slab.position.set(0, hgt / 2, -(d / 3) * t - d / 6);
        gp.add(slab);
        const crowd = new THREE.Mesh(
          new THREE.PlaneGeometry(w * 0.98, hgt * 0.5),
          new THREE.MeshBasicMaterial({ map: crowdTexture(THREE), transparent: true })
        );
        crowd.position.set(0, hgt * 0.72, -(d / 3) * t - d / 6 + d / 6.4);
        gp.add(crowd);
      }
      gp.position.set(x, 0, z); gp.rotation.y = rotY;
      scene.add(gp);
    };
    addStand(PITCH_W + 24, 22, 0, -(PITCH_L / 2 + 17), 0);
    addStand(PITCH_W + 24, 22, 0, (PITCH_L / 2 + 17), Math.PI);
    addStand(PITCH_L + 24, 22, -(PITCH_W / 2 + 16), 0, Math.PI / 2);
    addStand(PITCH_L + 24, 22, (PITCH_W / 2 + 16), 0, -Math.PI / 2);

    [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([sx, sz]) => {
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(2.4, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xBFD8FF, transparent: true, opacity: 0.5 })
      );
      glow.position.set(sx * (PITCH_W / 2 + 16), 24, sz * (PITCH_L / 2 + 16));
      scene.add(glow);
    });

    // Floodlighting. Players use lit materials so they read as solid volumes;
    // ambient stays high so the far side never drops into mud.
    scene.add(new THREE.AmbientLight(0xC8D8F0, 1.35));
    const key = new THREE.DirectionalLight(0xFFF4E0, 1.5);
    key.position.set(28, 60, -18);
    key.castShadow = !!opts.shadows;
    if (opts.shadows) {
      key.shadow.mapSize.set(1024, 1024);
      const c = key.shadow.camera;
      c.left = -60; c.right = 60; c.top = 80; c.bottom = -80; c.near = 5; c.far = 160;
    }
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x9FC4FF, 0.7);
    fill.position.set(-30, 34, 26);
    scene.add(fill);

    const postMat = new THREE.MeshLambertMaterial({ color: 0xF2F6FC });
    const netMat = new THREE.MeshBasicMaterial({
      color: 0xDCE6F5, transparent: true, opacity: 0.16, side: THREE.DoubleSide,
    });
    [-PITCH_L / 2, PITCH_L / 2].forEach((gz) => {
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

    return { scene, tick: function () {} };
  };

  // ------------------------------------------------------------ player models

  V.makeKitSet = function (THREE, myHex, oppHex) {
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
      bodyMat: { [myHex]: mk(myHex), [oppHex]: mk(oppHex) },
      gkMat: { [myHex]: dim(myHex), [oppHex]: dim(oppHex) },
      _owned: [],
    };
  };

  V.createPlayer = function (THREE, shared, teamHex, isGK, number) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(shared.body, isGK ? shared.gkMat[teamHex] : shared.bodyMat[teamHex]);
    body.position.y = 0.86;
    g.add(body);
    const head = new THREE.Mesh(shared.head, shared.skinMat);
    head.position.y = 1.62;
    g.add(head);
    const shadow = new THREE.Mesh(shared.shadow, shared.shadowMat);
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.02;
    g.add(shadow);
    return { group: g, body, head, shadow, isGK, number };
  };

  // Per-frame pose. st = { speed, facing, kicking, t }.
  V.animatePlayer = function (rig, st) {
    const sp = st.speed || 0;
    const bob = sp > 0.6 ? Math.sin(st.t * 11 + (rig.phase || 0)) * 0.07 * Math.min(1, sp / 6) : 0;
    rig.group.position.y = bob;
    rig.body.rotation.x = sp > 0.6 ? Math.sin(st.t * 11 + (rig.phase || 0)) * 0.09 : 0;
  };

  V.createBall = function (THREE) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 14, 12),
      new THREE.MeshLambertMaterial({ color: 0xFFFFFF, emissive: 0x222630 })
    );
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(BALL_R * 1.15, 10),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.36 })
    );
    shadow.rotation.x = -Math.PI / 2;
    return { mesh, shadow };
  };

  V.disposeShared = function () { _crowdTex = null; };

  window.Match3DVisuals = V;
})();
