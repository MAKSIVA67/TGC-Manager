# Stripe / product id reference

Product and Price ids are **public identifiers** -- they appear in the checkout
URL and are safe to keep in this repo. Nothing starting `sk_` or `whsec_`
belongs in here, ever: those are secrets and live only in Supabase Edge
Function secrets and the Stripe dashboard.

## The three-way contract

A gem tier only works if the same `productId` string exists in all three
places. The client never sends a price -- it sends only the id, and the server
decides what that costs and what it grants. That is deliberate: a modified
client cannot buy 10,000 gems for $1.

| Where | What it holds | Lives in |
|---|---|---|
| `GEM_PASSES` in `server/index.html` | display name, gem count, display price | this repo |
| `PRODUCTS` in `create-checkout-session` | what Stripe actually charges | mobile repo / Supabase Edge Functions |
| `PRODUCTS` in `stripe-webhook` | what gets granted after payment | mobile repo / Supabase Edge Functions |

Gotcha: the stripe-webhook function is **deployed under the name
`smart-responder`** in the Supabase dashboard. Look for that name, not
"stripe-webhook".

Android (Play Billing) has a fourth place, `PRODUCTS` in `verify-purchase`,
plus the in-app products created in Play Console.

## Gem tiers

| productId | Gems | Price | Stripe Product | Stripe Price |
|---|---|---|---|---|
| `gems_100` | 100 | $1 | | |
| `gems_500` | 500 | $4 | | |
| `gems_1000` | 1000 | $8 | | |
| `gems_2500` | 2500 | $15 | `prod_V7XU7zRSSZDkwT` | `price_1U7IPHFjhBviqdy4kcDguTbL` |
| `gems_5000` | 5000 | $30 | | |
| `gems_10000` | 10000 | $55 | | |

`gems_100` and `gems_500` use the Play Store ids `gems100` / `gems500` -- see
`androidId` in `GEM_PASSES`. The others use the same id on both channels.

Blank cells above are ids that were created before this file existed. Fill them
in from Stripe Dashboard -> Product catalogue when you next have it open; not
knowing them costs nothing today, but it makes the next change slower.

## Status

`gems_2500` is live on the client and has a Stripe Price. It will not work
until both Edge Function maps carry the id -- until then the shop button
returns an error rather than charging anything, which is the safe direction to
fail.
