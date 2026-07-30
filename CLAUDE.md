# TCG Manager

A football/soccer trading-card manager game. Originally "Legend XI," renamed to
"TGC Manager" then corrected to **TCG Manager** (Trading Card Game). Address
the user as **Maksim**.

## Project layout — three implementations, different status

1. **`mobile/`** — **the active development target.** React Native + Expo,
   full native rewrite (not a wrapper around the web version), backed by
   Supabase (auth + Postgres). This is where new game features get built
   going forward. See `mobile/README.md` for setup and
   `mobile/supabase/schema.sql` for the DB schema.
2. **`server/`** — the vanilla JS/HTML/CSS web version, live as a PWA at
   https://maksiva67.github.io/TGC-Manager/. Has more built out than the
   mobile app (packs, formations, match sim, admin panel, and the live 3D
   match arena below).

   **As of 2026-07-30 this is being actively extended again**, at Maksim's
   explicit direction ("web version now and later for mobile"). It is no
   longer a frozen reference. New work still needs him to confirm he means
   the web version, but don't refuse on the grounds that this file is
   legacy — that guidance is out of date.

   The match engine lives in four files and is split by concern:
   - `server/lib/match3d.js` — simulation, AI, input, orchestration.
   - `server/lib/match3d-visuals.js` — stadium, player models, animation.
   - `server/lib/match3d-hud.js` — the overlay DOM and on-screen controls.
   - `server/index.html` — everything else (menus, shop, squad, admin).

   Two constraints that are easy to break:
   - **three.js is pinned to r155** via CDN because that is the last release
     shipping a UMD build exposing a global `THREE`. There is no bundler, so
     bumping it to a version with only ES modules breaks the arena outright.
   - **The arena mounts in a fixed overlay appended to `document.body`, not
     inside `#stage`.** `render()` does `stage.innerHTML = appHTML()` on every
     state change and would destroy the WebGL context. Anything that must
     survive a re-render has to live outside `#stage` the same way.
3. **`legend_xi_app.jsx`** and **`roblox/TGCManagerData.lua`** — frozen
   reference implementations from earlier in the project. Don't extend
   these unless explicitly asked.

## Mobile app (current focus)

- Stack: React Native + Expo, Supabase (Postgres + Auth), native IAP planned
  for payments (Apple/Google require their own purchase system for in-app
  currency — Stripe is not used inside the mobile app).
- Phase plan (all phases are in scope before first store submission — Maksim
  explicitly rejected an MVP-first approach): 1) accounts, 2) core game
  rebuilt native, 3) admin dashboard, 4) friends + chat, 5) trading,
  6) payments, 7) compliance + store submission.
- Current phase status lives in memory (`tcg-manager-mobile-launch` project
  memory) — check there for what's actually done vs. still pending before
  assuming.
- **Verification limitation**: no iOS/Android simulator or physical device in
  this environment. `npx tsc --noEmit` catches type errors; `npx expo start
  --web` + headless Chrome (see below) is the closest thing to a real check.
  Never claim something "works" based only on code existing — actually run
  the type-check and the web preview first.

## How to test/verify changes

- **Web version** (`server/index.html`): served locally via
  `server/serve.ps1` (binds `localhost:8080`) and a `server/admin-server.ps1`
  (local-only admin API on port 8081, never tunneled). Test through the real
  HTTP server, not `file://` — encoding/CSP issues only show up over real
  HTTP. Use headless Chrome + the Chrome DevTools Protocol for automated
  screenshot/interaction testing (see the `headless-chrome-cdp-recipe`
  memory for the working PowerShell pattern) — **always look at an actual
  screenshot**, don't rely solely on DOM/text checks, and don't check
  `document.body.textContent`/`innerHTML` for "is X visible" (it includes
  raw `<script>` source text and will false-positive).
- **Mobile app**: `npx tsc --noEmit` for type errors, `npx expo start --web`
  for a renderable preview. Clean up dev-server/headless-Chrome processes
  after testing.
- **3D match arena**: it needs no Supabase login to test. Point a page at
  three.js + the three `match3d*.js` modules, stub `window.buildSlots` and the
  `play*()` audio helpers, then call `Match3D.begin({...})` directly with
  synthetic lineups. Drive it with **puppeteer-core** against an installed
  Chrome (a hand-rolled CDP WebSocket client was tried and hung — don't).
  Headless Chrome needs `--use-gl=angle --use-angle=swiftshader
  --enable-unsafe-swiftshader` for WebGL. Assert the match reaches half time
  and full time via its callbacks and that teardown leaves zero canvases and
  zero overlay divs behind — then **look at the screenshot**, because camera
  and layout problems are invisible to DOM assertions.

## Working style

- Maksim is new to a lot of the tooling involved (Supabase dashboard, dev
  tools generally). Give literal, numbered, dummy-proof instructions —
  name the exact sidebar icon/button, don't assume familiarity with terms
  like "Settings > API" without more guidance.
- Prefer asking a scoping question (via structured options) before starting
  large, ambiguous, or expensive-to-redo work (e.g. picking a mobile
  framework, a payments approach, backend architecture) — several of these
  decisions were made via explicit interview and are recorded in memory;
  don't re-litigate them.
- Keep persistent decisions and phase status in the memory system, not just in
  chat, since Maksim clears the conversation between sessions. Note the memory
  path is per-machine: the original was
  `C:\Users\maho\.claude\projects\c--Users-maho-Documents-tgC\memory\`, but the
  project has since been worked on from a different machine with its own store.
  Don't assume prior session context carries over — check what's actually
  there.
- Maksim pushes via the GitHub Desktop GUI. Command-line `git push` does not
  work for him: Git Credential Manager needs an interactive browser prompt, and
  GitHub Desktop's stored credential lives under a different target name so it
  does not bridge to plain `git`. Commit locally and let him push.
