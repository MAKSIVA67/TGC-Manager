# Making the economy server-authoritative

Design note for the change that migration `sql/007_server_authoritative_economy.sql`
implements on the database side. Nothing in the client has been changed yet;
section 4 is the instruction sheet for whoever does that.

---

## 1. The problem, precisely

Every number in the game is decided by JavaScript running on the player's own
machine and then written to Postgres, which accepts it. The app's real code
performs exactly the writes an attacker would:

| What the app does | The same line, typed into the console |
| --- | --- |
| `commitPackOpen()` inserts a `user_cards` row | `sb.from("user_cards").insert({user_id: me, card_id: 204})` — any card, free |
| `trainCard()` updates `level`/`shards` | `sb.from("user_cards").update({level:10, shards:99999})` — 002 caps the *range* at 10, never the *cost* |
| `commitMatchResult()` writes `gems`, `wins`, `season_points` | `sb.from("profiles").update({gems: 999999999})` |

Row-level security answers "may you write **this row**". Every one of these is
the player's own row, so RLS says yes, correctly. There is no version of an RLS
policy that fixes this — the policy cannot see *why* the write is happening.

Migrations 003 and 004 fixed everything around the economy (privilege columns,
negative balances, who may settle a challenge). This is the piece they both
explicitly left open.

---

## 2. Architectures considered

### (a) SECURITY DEFINER RPCs per action — **recommended**

One Postgres function per economic action (`open_pack`, `train_card`,
`settle_match`, `cup_enter`, `cup_advance`, `claim_daily`, `claim_objective`,
`claim_starter_squad`). Each runs as the function's owner, so it bypasses RLS
and column grants; the client's *direct* INSERT/UPDATE on `user_cards`,
`matches`, `cup_runs` and the economy columns of `profiles` is then revoked.
The client's only remaining route to change a balance is to call a function
that decides for itself what the change should be.

- **Client change:** moderate. Roughly a dozen call sites; every one of them is
  already a single function in `game-data.js` or a single `case` in the event
  handler, so the edits are localised. See section 4.
- **Randomness:** the roll moves into `open_pack()`. The browser never sees a
  seed, a pool weighting it can edit, or an outcome it can retry. This is the
  only option in which the pack odds are actually the published odds.
- **Migration risk:** low. The functions are additive; the lock-down is a
  privilege change with a one-statement reversal. No player data is rewritten
  except merging duplicate `user_cards` rows, which are already corrupt.
- **Latency:** one PostgREST call on the connection the client already holds —
  the same cost as the `insert` it replaces. No new infrastructure.
- **Precedent:** the codebase already does this for `execute_trade`,
  `redeem_promo_code`, `admin_reset_player_progress` and (via 003)
  `admin_set_banned`. This is the house pattern, not a new one.

### (b) Ledger table with the balance derived by trigger — rejected as the mechanism, adopted as an audit trail

`gem_ledger(user_id, delta, reason)` append-only, with `profiles.gems`
maintained by a trigger or replaced by a view.

This does not solve the problem on its own, and that is the decisive point.
The question "who may write a `+999999` row into the ledger?" is exactly the
question we started with. It only becomes secure if ledger inserts are
themselves restricted to SECURITY DEFINER functions — at which point it is
option (a) with extra bookkeeping.

Deriving `profiles.gems` also has a wide blast radius: it is read by the
leaderboard, the admin panel, `execute_trade` and the purchase-crediting RPC,
and a derived or view-backed column puts all of them on a new code path for no
security gain. Hard to reverse once other things depend on the ledger's shape.

**What was taken from it:** 007 creates `gem_ledger` as a pure audit table,
written by every function, readable by its owner, writable by nobody.
`profiles.gems` stays the balance. That gives the ability to answer "how did
this account get 400,000 gems" and to reverse a bad day, at nearly zero cost
and with no coupling.

### (c) Supabase Edge Functions holding the logic — rejected for the economy, correct for payments

- **It does not reduce the work.** The revokes are identical; the client
  changes are identical. The logic just lives in Deno instead of plpgsql.
- **Atomicity has to come back to the database anyway.** "Read balance, roll,
  debit, insert card" over the network is four round trips with three windows
  in which a second tab can interleave. Making it safe means wrapping it in a
  database function — which is option (a), now with a proxy in front.
- **Latency is worse and less predictable.** A cold Edge Function invocation is
  measured in hundreds of milliseconds. Pack opening has a 2.9-second animation
  budget it must fit inside; an RPC fits with room to spare, a cold start might
  not, and "the reveal sometimes hangs" is a worse game.
- **Operationally worse for this project.** Maksim runs migrations by pasting
  SQL into a web editor. Edge Functions need the CLI or a dashboard deploy plus
  secrets management, and every economy tweak becomes a deployment.
- **Where Edge Functions are right:** anything needing an external secret or a
  non-Postgres dependency — i.e. exactly the Google Play and Stripe
  verification `lib/iap.js` already uses. That division stays as it is.

### (d) Server-authoritative match simulation — rejected, out of proportion

The only design in which a claimed win is actually *proven*. It means the 3D
arena runs headless on a server with the browser streaming inputs. That is a
rewrite of `match3d.js`, it breaks the friend-challenge design (which resolves
by running `computeZone` identically on both clients), and it turns a
single-player card game into a real-time multiplayer server. Months of work to
protect gems that have no cash-out value.

### (e) Signed result tickets (client asks for a nonce, returns an HMAC'd result) — rejected, security theatre

Anything the client can compute, a console can compute. The client holds no
secret the player does not also hold. This buys nothing over (a) and costs a
protocol.

### Recommendation

**(a), with (b)'s ledger as an audit table, keeping (c) for real money.**

The honest limit, stated plainly: pack odds, prices, training costs, the daily
ladder, objective completion and cup payouts all become facts the database
decides and the client cannot influence. A **match result** cannot be proven
without (d). `settle_match` therefore does the two things that are available —
it decides the reward itself instead of accepting the client's figure, and it
refuses to record results faster than a match can be played. The exploit goes
from *"set your balance to a billion instantly"* to *"grind fake wins at 20
gems each, no faster than real time, every one of them logged in
`gem_ledger`"*. That is a difference in kind, and it is the most that is
available at proportionate cost.

---

## 3. The two orderings, and the answer

There are two artefacts that deploy independently and in whatever order Maksim
gets to them: the **site** (new JavaScript) and the **migration** (SQL pasted
into Supabase). And there are stale clients.

**How stale can a client be?**

- No service worker is registered anywhere in `server/` — the only browser
  staleness is the ordinary HTTP cache. *Needs checking:* GitHub Pages'
  `Cache-Control` on `index.html` and `lib/*.js` (expected around ten minutes).
- `index.html` loads `lib/*.js` with **no version query string**. A visitor can
  therefore end up with a fresh `index.html` and a cached `lib/game-data.js` —
  a mixed pair that is broken in a way neither file is on its own. **Fix this
  in the same deploy**: append `?v=8` (or any bump) to the five `<script
  src="lib/...">` tags. One-line change, removes the whole hazard.
- **The real stale client is the Android app.** `capacitor-app/sync-web.mjs`
  copies `server/` into the APK, so a shipped build's JavaScript is frozen
  until the player installs an update. If any APK is in anyone's hands, phase 2
  breaks it permanently. *Needs checking before phase 2:* has an APK been
  distributed, and to whom?

**The answer: the migration is split into two phases, and both orderings are
safe for each phase.**

| | Old client | New client |
| --- | --- | --- |
| **Old database** (007 not run) | works — today's game | works — every new call is wrapped in the `rpcMissing()` fallback that `admin-api.js` already uses for 003, so it silently uses the old direct writes |
| **After phase 1** (file pasted) | works — phase 1 revokes nothing | works — uses the RPCs |
| **After phase 2** (`economy_lock_down()`) | **broken** — cannot open packs, train, record a match, or receive a starter squad on signup | works |

So:

1. **Deploy the site and paste `007` in either order, at any time.** Neither
   can break the other. Phase 1 only adds.
2. **Then, deliberately and later, run `select public.economy_lock_down();`**
   once the new site is live, the Android situation is understood, and the new
   client has been played against phase 1 for a day or two.
3. If anything goes wrong: `select public.economy_unlock();` restores the
   grants exactly as 003 left them, immediately, with no data loss.

Phase 2 lives inside a function rather than at the bottom of the file
specifically so that it *cannot* happen by accident from a copy-paste, and so
that reversing it is one line rather than a hand-written re-grant under
pressure.

---

## 4. Client implementation plan

**Do not apply this by hand while other branches are open on the same files.**
Everything below is additive-then-swap; each numbered item is independently
testable.

Throughout, one rule matters more than any other:

> **Applying an RPC's returned balance.** `applyProfileRow()` in `auth.js`
> merges rather than overwrites: it computes `server + (local − baseline)`, and
> `noteProfileWrite()` moves the baseline. So an RPC result must be applied the
> way `updateProfile()` applies a write — set the state **and** move the
> baseline:
>
> ```js
> function applyServerEconomy(d) {          // new, lib/game-data.js
>   if (!d) return;
>   const fields = {};
>   if (d.gems != null) { window.state.gems = d.gems; fields.gems = d.gems; }
>   if (d.wins != null) { /* ...stats, season... */ }
>   noteProfileWrite(fields);
> }
> ```
>
> Optimistically decrementing `state.gems` at tap time and *not* calling
> `noteProfileWrite` until the RPC returns is correct and is what produces an
> instant-feeling UI — during the in-flight window the merge evaluates to the
> optimistic value, which is what we want on screen. Getting this wrong is how
> the "free packs" bug in commit `5ab7f72` happened; re-read that commit
> message before touching it.

Every new `sb.rpc(...)` call should follow `admin-api.js`'s existing
`rpcMissing(error)` pattern and fall back to the current direct-write code when
the function is absent. That is what makes the new client safe against a
database where 007 has not been pasted yet. `rpcMissing` currently lives in
`admin-api.js`; move it to `supabase-client.js` or duplicate it.

### `server/lib/game-data.js`

| Function | Becomes |
| --- | --- |
| `commitPackOpen(cardId)` | **Deleted.** Replaced by `openPackRemote(packId)` → `sb.rpc("open_pack", {p_pack_id: packId})`, resolving `{card, duplicate, shards_gained, level, shards, gems, error}`. It must also update the matching entry in `window.state.players` in place: `owned = true`, `level`, `shards`, and `power = basePower + level`. Never write `power` from the server's value — the RPC returns the **printed** power and the client adds the level, which is what keeps the `basePower`/`power` invariant intact. |
| `commitPackRefund()` | **Deleted.** The refund branch existed for "you own every card"; packs have rolled the whole pool since, and `open_pack` raises (charging nothing) if no card can be drawn. The client's `!pick` branch becomes an error toast. |
| `grantShards(cardId, n)` | **Deleted.** Duplicate handling is inside `open_pack`, which is where the "never a second `user_cards` row" guarantee now comes from — an `ON CONFLICT (user_id, card_id)` clause backed by a real unique index, rather than a client-side `if (wasOwned)`. |
| `trainCard(cardId)` | Body replaced by `sb.rpc("train_card", {p_card_id: cardId})`. **Keep the resolved shape exactly as it is** (`{error, level}`) so the `do-train` handler in `index.html` needs no change. Drop the optimistic mutation and the rollback block — with a single atomic call there is nothing to roll back. Keep `shardsForLevel()`/`gemsForLevel()`: they still render the price on the training panel, they just no longer *charge* it. Add a comment saying they must match the curve in `007`. |
| `initializeNewAccountIfNeeded(userId)` | Body replaced by `sb.rpc("claim_starter_squad")` then `loadCatalogAndOwnership(userId)`. **The whole `legacySave` branch is deleted** — it reads a JSON blob out of `localStorage` and inserts whatever card ids and gem balance it names, which is a free-cards-and-gems hole that needs no developer console at all. `LEGACY_SAVE_KEY`/`LEGACY_SAVE_IMPORTED_KEY` and their `localStorage` reads go with it. *This is a product decision for Maksim*: anyone still holding a pre-Supabase local save on the same browser loses the import path. |
| `commitMatchResult(outcome, season, matchday, opponent, isChallenge)` | Rewritten as `settleMatchRemote(kind, res)` → `sb.rpc("settle_match", {p_result, p_kind, p_zones_won, p_my_power, p_opp_power, p_opponent_name, p_formation})`. It no longer sends gems, stats or season fields — the server computes all of them and the `matches` row. On resolve it calls `applyServerEconomy()` with the returned `gems / wins / losses / draws / win_streak / best_streak / season_*`, then `window.render()`. `kind` is `'cup'`, `'challenge'` or `'league'`. |
| `createCupRun(bracket)` | → `sb.rpc("cup_enter", {p_bracket: bracket})`, which charges the 150 and creates the run in one transaction. This deletes the entire class of bug the `cup-enter` handler currently guards by hand. Returns `{run, gems}`. |
| `saveCupRun(fields)` | **Split in two.** `cupAdvanceRemote(won)` → `sb.rpc("cup_advance", {p_won: won})` and `cupForfeitRemote()` → `sb.rpc("cup_forfeit")`. The generic field-patching version has no remaining caller once `resolveCupResult` and `cup-forfeit` are converted, and `cup_runs` loses its direct UPDATE grant in phase 2. |
| `loadCatalogAndOwnership(userId)` | Unchanged, except: add `sb.from("pack_defs").select("id,cost,active")` to the `Promise.all` and merge `cost` onto the client's `PACKS` entries, so the shop's affordability check reads the same price the server will charge. Tolerate the table being absent (same `.catch` shape `loadCupRun()` uses for 002). |
| `refreshGameState()` | Unchanged. |
| `redeemPromoCode()` | Unchanged — already an RPC. |

### `server/index.html`

| Function / handler | Becomes |
| --- | --- |
| `pickWeighted(lockedPool, weights)` | **Deleted.** Its only caller is the `open-pack` handler. The reel *filler* uses a plain uniform pick from `spinPool` and is untouched. |
| `PACKS` array | Keep — it carries `name`, `icon`, `blurb`, `grad`, `glow` and the displayed `cost`. **Delete the `weights` key**; leaving a second copy of the odds in the client is a drift trap that will eventually make the shop lie about the odds. |
| `shardsForDuplicate(rarity)` | **Deleted.** `open_pack` returns `shards_gained`. |
| `case "open-pack"` | The important one. New shape: (1) guard on `phase !== "list"` and affordability as today; (2) `state.gems -= pack.cost` optimistically, **no** `noteProfileWrite`; (3) build the reel with a **placeholder** at `spinFinalIndex`, set `s.phase = "spinning"`, `render()`, `startSpinAnimation()` — all synchronous, so the reel starts on the same frame as the tap, exactly as today; (4) **in parallel**, `openPackRemote(pack.id)`; on resolve set `s.pendingPick` from the returned card and `s.dupeShards` from `shards_gained`, call `applyServerEconomy()`, and write the card's markup into the landing cell *in place* (`document.getElementById("spinTrack").children[insertAt].innerHTML = ...`) — **not** via `render()`, which replaces `#stage` wholesale and would destroy the animating node (see the existing comment above `startSpinAnimation`'s `transitionend` handler); (5) on error, restore `state.gems`, set `s.phase = "list"`, show the message. |
| `startSpinAnimation()` / `landPack()` | `landPack()` gains a guard: if `s.pendingPick` has not arrived yet, do nothing and set a flag so the RPC's own resolve calls `landPack()` when it lands. The existing 3.4s belt-and-braces timer stays. Add a hard ceiling (~12s) after which the shop shows "couldn't reach the server" and calls `refreshGameState()` — safe, because `open_pack` is atomic: either it charged and granted, or neither. |
| `finalizeMatch(res)` | Stops being the place rewards are decided. Delete the local `gemsEarned` calculation, the `state.stats = {...}` block, `state.gems += gemsEarned`, the season/matchday/rollover block and the `bonus` line. It still does all the *presentation* — commentary, sounds, `pl.finalResult`, confetti, `checkRankUp()` — then calls `settleMatchRemote()`, and on resolve applies the server's numbers and re-renders. `pl.seasonSummary` is built from the RPC's `season_rollover` / `season_bonus` instead of computed locally. The `WIN_GEMS`/`DRAW_GEMS`/`LOSS_GEMS` constants stay for display but must be commented as mirroring `007`. |
| `resolveCupResult(won)` | → `cupAdvanceRemote(won)`. The RPC pays the reward and advances the round atomically, so the "credit only after the save succeeded" dance and the `saveFailed` branch collapse into a plain error case. `state.cup` is refreshed from `loadCupRun()` on resolve. |
| `case "cup-enter"` | → `createCupRun(bracket)` (now `cup_enter`). Delete the re-check-and-withdraw block: the fee and the run are one transaction now, so the window it guards no longer exists. Keep the `state.cupEntering` double-tap guard. |
| `case "cup-forfeit"` | → `cupForfeitRemote()`. |
| `case "claim-daily"` | → `sb.rpc("claim_daily")`. Delete the local `reward` lookup and the `state.gems += reward` / `updateProfile(...)` pair. On resolve apply `{reward, streak, last_claim, gems}` to `state.home` and `state.gems` via `applyServerEconomy` + `noteProfileWrite({daily_last_claim, daily_streak})`. `DAILY_REWARDS` and `activeDailyStreak()` stay — the home panel still needs to *draw* the ladder. |
| `case "claim-objective"` | → `sb.rpc("claim_objective", {p_objective_id: id})`. Delete `state.gems += reward`. The `OBJECTIVES` array stays for rendering labels and progress bars; its `reward`/`target` values must match `objective_defs` in `007`. The server re-measures progress, so the button can no longer pay out an objective that is not actually complete. |
| `case "admin-self-gems"` | → `sb.rpc("admin_set_gems", {target_id: <me>, new_gems: state.gems + amount})`, with the `rpcMissing` fallback. |
| `computeZone(zoneKey, myLU, oppLU)` | **Unchanged, and must stay unchanged.** It is a pure function of two lineups and is run independently on both clients to resolve a friend challenge; nothing in this design gives it a database dependency, and chemistry stays outside it for exactly that reason. |

### `server/lib/iap.js`

**No changes required** — and that is the point worth confirming rather than
assuming. `purchaseProduct()` → `verifyPurchaseOnServer()` → the
`verify-purchase` Edge Function → `credit_verified_purchase` RPC; and the web
path credits from `stripe-webhook` while the browser is on Stripe's page.
Neither ever credits from a client-reported success, and both write through a
server-side RPC that is unaffected by the phase-2 revokes.

**Two things to verify before running phase 2** (they live in
`mobile/supabase/schema.sql`, which is not in this worktree, so this is
unverified):

1. `credit_verified_purchase` must be `SECURITY DEFINER`. If it is not, it runs
   as `authenticated` and phase 2 stops all gem purchases dead — the worst
   possible failure, since it is the one path with real money attached.
2. The exclusive-card purchase path inserts into `user_cards`. Confirm that
   insert happens inside `credit_verified_purchase` (or another definer
   function) and not from the webhook using an `authenticated`-role client.

Same check applies to `execute_trade` and `admin_reset_player_progress`, both
called from `social.js` / `admin-api.js`. The comments in the codebase say both
are SECURITY DEFINER; confirm it rather than trusting the comment.

A worthwhile follow-up, not required: have `credit_verified_purchase` write a
`gem_ledger` row too, so the audit trail covers paid gems as well as earned
ones.

### `server/lib/admin-api.js`

| Function | Becomes |
| --- | --- |
| `setGems(targetId, newGems)` | → `sb.rpc("admin_set_gems", {target_id, new_gems})` with the existing `rpcMissing` fallback to the current direct update. Copy the shape of `setBanned()` immediately below it. |
| `resetPlayerProgress(targetId)` | Unchanged (already an RPC). Worth noting for later: it takes `starter_card_ids` **from the client**, so an admin can grant any cards through it. Admin-only, so low priority, but it should eventually compute the split server-side the way `claim_starter_squad()` now does. |
| `updateProfileInfo(targetId, fields)` | Unchanged, provided it is only ever called with display/identity fields. If any caller passes `gems`, it breaks at phase 2 — grep before shipping. |

### Roughly how much work is this?

Four files. About a dozen functions, of which two (`case "open-pack"` and
`finalizeMatch`) are genuinely fiddly and the rest are mechanical
"replace-the-body" swaps. Call it **one focused day to write and one to test**,
plus the testing pass in section 5. Nothing here changes how the game looks or
plays; if it is done right, no player notices anything except that the cup
entry fee stops occasionally going wrong.

---

## 5. Risks

### What this could break

1. **New signups get no starter squad.** The single worst failure mode. If
   phase 2 runs while any client still uses the old
   `initializeNewAccountIfNeeded`, `user_cards.insert` is denied and a new
   player lands in an empty game with no way out. Mitigated entirely by
   ordering (phase 2 last), and reversible in one statement — but it is the
   reason phase 2 is not in the paste.
2. **A shipped Android APK is a permanently stale client.**
   `capacitor-app/sync-web.mjs` bakes `server/` into the bundle. Phase 2 breaks
   any build already installed, and unlike the website there is no way to push
   a fix to it. **Establish whether an APK is in anyone's hands before running
   phase 2.**
3. **Mixed-version JavaScript.** `index.html` loads `lib/*.js` with no cache
   buster, so a fresh `index.html` can pair with a cached `game-data.js`. Add
   `?v=` to the script tags in the same deploy.
4. **Real-money purchases**, if `credit_verified_purchase` turns out not to be
   SECURITY DEFINER. See section 4. Verify first, not after.
5. **Column drift on `profiles`.** `economy_lock_down()` excludes a *named*
   list of economy columns and grants everything else, so a column added later
   is writable by default. That is the right trade-off for a 46-column table
   this file cannot see, but a future economy column must be added to the list
   by hand. The function returns the columns it left writable — read that
   output.
6. **`objectives_claimed` column type.** `claim_objective` handles both `text[]`
   and `jsonb` at runtime, but that path is untested against the live schema.
7. **The 15-second match throttle** could reject a legitimately fast match. The
   legacy timed match is roughly forty seconds end to end, so there should be
   ample headroom — but this has not been measured against a real quick loss.
   It is one number in one function and trivially raised.
8. **Objective and reward constants now exist twice**, in `index.html` and in
   `007`. They agree today. If someone changes one, the shop or the objectives
   panel will advertise a number the server does not honour. The client should
   eventually read `pack_defs` and `objective_defs` rather than keep its own
   copies; `pack_defs` is already wired for that in section 4.

### What is hard to reverse

- **The `user_cards` deduplication.** Merging duplicate rows sums shards and
  keeps the highest level, then deletes the extras. If those duplicates encoded
  something meaningful, it is gone. They do not — every ownership check in the
  app is a set-membership test, so a second row was always a corrupt state —
  but the delete is real. **Run the duplicate-count query in the verification
  block before pasting**, and if it returns rows, look at them first.
- **Deleting the legacy-save import.** Nothing is destroyed (the `localStorage`
  blob stays on whatever browser holds it), but the code path to use it goes.
- Everything else is reversible: `economy_unlock()` restores the grants, and
  the functions are inert when nothing calls them.

### What I would verify first, in order

1. `select user_id, card_id, count(*) from public.user_cards group by 1,2
   having count(*) > 1;` — **before** pasting 007. Expect no rows.
2. That `credit_verified_purchase`, `execute_trade` and
   `admin_reset_player_progress` are all `SECURITY DEFINER`:
   `select proname, prosecdef from pg_proc where proname in (...)`.
3. The exact column list and types of `public.profiles` — specifically whether
   `objectives_claimed` is `text[]` or `jsonb`, and whether `daily_last_claim`
   is `date` or `text`. Both are handled defensively; confirming removes the
   doubt.
4. That every function in 007 actually creates. It references `cards.active`,
   `cards.exclusive`, `cards.image_thumb_url`, `cards.league`, `cards.region`,
   `matches.formation` and `matches.zones_won` — all read or written by the
   live client, so all should exist, but a `create function` fails loudly if
   one does not.
5. Phase 1 against the *old* client: play normally for a while and confirm
   nothing changed. That is the whole promise of phase 1.
6. Phase 1 against the *new* client: open a pack (watch the reveal timing on a
   slow connection — throttle to "Slow 3G" in DevTools), open one you already
   own, train a card, play a league match through a season rollover, run a cup,
   claim a daily and an objective, sign up a brand-new account.
7. Only then phase 2, followed immediately by pasting the three console
   one-liners from the top of this document and confirming all three are
   denied.

### What is deliberately *not* fixed

- A claimed match result is still unverifiable. See section 2(d).
- The cup bracket is still generated by the client. It is decoration on top of
  a result the database already cannot verify; the fee, the round number and
  the payout are all server-side, which is where the value is.
- `admin_reset_player_progress` still accepts client-supplied card ids.
  Admin-only.
