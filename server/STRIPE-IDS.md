# Stripe / product id reference

Product and Price ids are **public identifiers** -- they appear in the checkout
URL and are safe to keep in this repo. Nothing starting `sk_` or `whsec_`
belongs in here, ever: those are secrets and live only in Supabase Edge
Function secrets and the Stripe dashboard.

## Currency: EUR

The whole game prices in **euro**. Stripe charges EUR and the exclusive-card
column is `price_eur`.

Until commit `786d935`+1 the gem passes displayed a dollar sign while Stripe
charged euro, so a player tapping "15" with a dollar sign in front of it was
billed €15 -- about $17. Do not reintroduce a dollar sign anywhere a
real-money price is shown.

Amounts in the Edge Functions are in **cents**: €15 is `1500`, and the
session currency must stay `"eur"`.

## The three-way contract

A gem tier only works if the same `productId` string exists in all three
places. The client never sends a price -- it sends only the id, and the server
decides what that costs and what it grants. That is deliberate: a modified
client cannot buy 10,000 gems for €1.

| Where | What it holds | Lives in |
|---|---|---|
| `GEM_PASSES` in `server/index.html` | gem count + the price shown to the player | this repo |
| `PRODUCTS` in `create-checkout-session` | what Stripe actually charges | mobile repo / Supabase Edge Functions |
| `PRODUCTS` in `stripe-webhook` | what gets granted after payment | mobile repo / Supabase Edge Functions |

Gotcha: the stripe-webhook function is **deployed under the name
`smart-responder`** in the Supabase dashboard. Look for that name, not
"stripe-webhook".

Android (Play Billing) has a fourth place, `PRODUCTS` in `verify-purchase`,
plus the in-app products created in Play Console.

## Gem tiers

| productId | Gems | Price | Cents | Stripe Product | Stripe Price |
|---|---|---|---|---|---|
| `gems_100` | 100 | €1 | 100 | | |
| `gems_500` | 500 | €4 | 400 | | |
| `gems_1000` | 1000 | €8 | 800 | | |
| `gems_2500` | 2500 | €15 | 1500 | `prod_V7XU7zRSSZDkwT` | `price_1U7IPHFjhBviqdy4kcDguTbL` |
| `gems_5000` | 5000 | €30 | 3000 | | |
| `gems_10000` | 10000 | €55 | 5500 | | |

`gems_100` and `gems_500` use the Play Store ids `gems100` / `gems500` -- see
`androidId` in `GEM_PASSES`. The others use the same id on both channels.

Blank cells are ids created before this file existed. Fill them in from Stripe
Dashboard -> Product catalogue next time it is open; not knowing them costs
nothing today, but it makes the next change slower.

## Exclusive cards

Ids are `exclusive_<card id>` -- `exclusive_27`, `exclusive_28`,
`exclusive_29` -- priced from the `price_eur` column, currently €5 each.

## Status

`gems_2500` is live on the client and has a Stripe Price. It will not work
until both Edge Function maps carry the id -- until then the shop button
returns an error rather than charging anything, which is the safe direction
to fail.
