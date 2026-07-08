# Task Plan — 2026-07-08 (approved scope, NOT yet executed)

Written by Claude at Maksim's request: "build task and don't run it."
Nothing below has been implemented yet.

---

## 1. Application audit (Android + iOS readiness, security)

### 1a. Platform readiness review
- **Android (native, Play Store)**: signed AAB/APK build pipeline works locally and
  in CI (`.github/workflows/android.yml` — CI secrets not yet confirmed added).
  Verify: Google Play Billing flow (`@capgo/native-purchases` + `verify-purchase`
  Edge Function) is written but has NEVER been tested with a real purchase token.
  Play policy blockers still open: no privacy policy page, no account-deletion flow,
  loot-box disclosure needed in content rating.
- **iOS (PWA via GitHub Pages)**: live at https://maksiva67.github.io/TGC-Manager/.
  Native iOS is paused (Codemagic yaml exists, never run). Audit what PWA users
  get vs Android native: payments go through Stripe on web/PWA (live, verified
  working) — confirm no Google-Play-only code path breaks on iOS Safari.

### 1b. Security review checklist
- RLS negative-test sweep re-run (last done 2026-07-04, schema has grown since:
  promo codes, iap_purchases, Phase H/I blocks).
- Confirm the Phase H / Phase I schema blocks were actually run against live
  Supabase (promo codes RPC, iap_purchases table, realtime publication) —
  memory says some were still pending.
- Edge Functions: verify `create-checkout-session` never trusts client price
  (already true by design), `smart-responder` (stripe-webhook) signature
  verification, `verify-purchase` idempotency via `iap_purchases`.
- Client: no secrets in the public repo (release.jks / keystore.properties
  gitignored — re-verify), Supabase anon key is public by design.
- Suggest upgrades where found (e.g. rate limiting on RPCs, webhook replay
  hardening, Capacitor/Gradle/plugin version bumps).

---

## 2. Gem pricing change (currency: **$**, new tiers)

New price table (replaces the current €5/€25/€50 for 100/500/1000):

| Product id  | Gems   | Price |
|-------------|--------|-------|
| gems_100    | 100    | $1    |
| gems_500    | 500    | $4    |
| gems_1000   | 1000   | $8    |
| gems_5000   | 5000   | $30   |  ← NEW
| gems_10000  | 10000  | $55   |  ← NEW

Prices must change **in every place that holds them, in sync** (product ids are
a three-way contract):
1. `server/index.html` — `GEM_PASSES` (line ~417): new prices + 2 new entries.
2. `mobile/supabase/functions/create-checkout-session/index.ts` — `PRODUCTS`
   map: this is what Stripe actually charges. **Currency switch EUR → USD**
   needs the Stripe session `currency` changed too, not just the numbers.
3. `mobile/supabase/functions/stripe-webhook/index.ts` — `PRODUCTS` grants map:
   add gems_5000 / gems_10000.
4. `mobile/supabase/functions/verify-purchase/index.ts` — Google Play PRODUCTS
   map: same two new ids.
5. Play Console in-app products (Maksim's manual step, once the listing exists):
   create gems_5000 / gems_10000 there too, and set all 5 to the $ prices.
6. Redeploy both Stripe Edge Functions after the change (remember:
   stripe-webhook lives under the function name `smart-responder`).
- Decide/confirm with Maksim: do exclusive card prices (currently €5) also
  become $ — and at what number?

---

## 3. Gameplay / UX corrections

### 3a. More precise notifications
- Current badges are counts only. Make each notification say **what and who**:
  e.g. "Trade offer from ⟨username⟩", "Challenge from ⟨username⟩",
  "⟨username⟩ accepted your friend request", message previews with sender name.
- **Trade offers must show the sender's username** (explicitly requested — today
  a received trade doesn't say who it's from). Requires joining
  `trades.from_user` → `profiles.username` when rendering, and including it in
  the realtime-event handling in `server/lib/social.js` (`subscribeToNotifications`).

### 3b. Admin panel changes apply instantly (no app restart)
- Today: admin edits (card catalog, gems, bans, promo codes) only show up for
  players after closing/reopening the app.
- Fix: subscribe clients to relevant changes and refresh state live.
  Options to weigh at implementation time: add `cards` (and `profiles` for
  gems/ban) to the `supabase_realtime` publication + a client subscription that
  re-fetches on change; or a lightweight periodic refresh on app-resume/focus.
  Ban should take effect immediately (kick to login on ban event).
- Also make the admin's own panel reflect saves immediately (optimistic update
  or re-fetch after each admin action).

### 3c. Harder objectives + more milestones
- Current `OBJECTIVES` (index.html ~line 418): only 4, all easy (win 3, own 10
  cards, pull an Epic, 3-streak). Add harder tiers, e.g. win 10/25 in a season,
  own 50/100/200 cards, own N Legendary+, open N packs, complete X trades,
  win Y challenge matches, reach Diamond/Legend rank — with scaled gem rewards.
- `ACHIEVEMENTS` (index.html ~line 399): extend similarly with longer-horizon
  milestones (100 wins, 10-streak, full exclusive set, seasons completed, etc.).

### 3d. Two more card packs
- Current `PACKS` (index.html ~line 347): Bronze 20 / Silver 45 / Gold 90 /
  Legendary 180 gems. Add two new tiers — suggested shape (tune at impl time):
  - **Mythic Pack** (~350 gems): guaranteed Ultra+, real Mythic/Icon odds.
  - **GOAT Pack** (~600 gems): guaranteed Legendary+, best Icon/GOAT odds in game.
- Needs: weights tables, gradient/glow styling, blurbs, a NEWS_ITEMS entry,
  and a check that the pack UI grid still fits 6 packs on a phone screen.

---

## Execution order (when approved)

1. Audit (item 1) first — output: findings + upgrade list, no code changes yet.
2. Pricing (item 2) — small, self-contained, needs Edge Function redeploys.
3. Gameplay batch (item 3) — code-only, testable via headless Chrome on the
   live flow with the two existing mailinator test accounts.
4. Commit locally; Maksim pushes via GitHub Desktop (standing pattern);
   rebuild signed AAB/APK after.
