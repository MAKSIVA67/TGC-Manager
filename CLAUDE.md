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
2. **`server/index.html`** — the original vanilla JS/HTML/CSS web version.
   Still fully playable (via the desktop shortcut or the cloudflared tunnel,
   see below) and has more built out than the mobile app does right now
   (packs, formations, match sim, admin panel). Not being extended further —
   treat as a reference/backup, not where to add features, unless Maksim
   specifically says he means the web version.
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
- Keep persistent decisions and phase status in the memory system
  (`C:\Users\maho\.claude\projects\c--Users-maho-Documents-tgC\memory\`), not
  just in chat, since Maksim clears the conversation between sessions.
