// TCG Manager -- real-money purchases, split by channel:
//   - Android app: native Google Play Billing (@capgo/native-purchases).
//     Every purchase is verified server-side against Google's own Play
//     Developer API (verify-purchase Edge Function) before anything is
//     credited. UNTESTED: no Android device/simulator in this environment.
//   - Web / iOS "Add to Home Screen": Stripe Checkout (startWebCheckout
//     below). The Edge Function only creates the hosted checkout page --
//     the actual credit happens in the stripe-webhook Edge Function once
//     Stripe confirms the payment completed, after the browser has fully
//     navigated away to Stripe and back. UNTESTED end to end: no real
//     Stripe purchase has been run against this yet.
// Both channels write into the same iap_purchases table / call the same
// credit_verified_purchase RPC, deduped by whatever opaque token/session id
// that channel provides -- see schema.sql's "Phase I" block.
//
// Checklist to make Android live (all outside what code alone can do):
//   1. Create the real in-app products in Play Console (Monetize ->
//      Products -> In-app products): gems_100, gems_500, gems_1000,
//      exclusive_27, exclusive_28, exclusive_29 -- ids must match PRODUCTS
//      in mobile/supabase/functions/verify-purchase/index.ts exactly.
//   2. Play Console -> Setup -> API access -> create/link a Google Cloud
//      service account with Play Developer API access, download its JSON
//      key.
//   3. Deploy mobile/supabase/functions/verify-purchase (Supabase dashboard
//      -> Edge Functions, or the CLI), setting GOOGLE_SERVICE_ACCOUNT_EMAIL
//      and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY from that JSON as secrets.
//   4. Run the "Phase I" block in mobile/supabase/schema.sql if not done
//      already (iap_purchases table + credit_verified_purchase RPC).
//
// Checklist to make Stripe (web/iOS) live -- see the header comments in
// mobile/supabase/functions/create-checkout-session/index.ts and
// mobile/supabase/functions/stripe-webhook/index.ts for the full detail:
//   1. Deploy both of those Edge Functions. Turn OFF "Enforce JWT
//      Verification" for stripe-webhook specifically.
//   2. Set STRIPE_SECRET_KEY (Edge Function secret) from Stripe Dashboard ->
//      Developers -> API keys.
//   3. Stripe Dashboard -> Developers -> Webhooks -> Add endpoint, pointed
//      at the deployed stripe-webhook URL, events checkout.session.completed
//      + checkout.session.async_payment_succeeded. Set the whsec_... it
//      gives you as STRIPE_WEBHOOK_SECRET (Edge Function secret).
"use strict";

function isNativeApp() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

function nativePurchasesPlugin() {
  return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativePurchases;
}

// Nothing to configure -- unlike RevenueCat, Google Play Billing needs no
// API key or third-party account, so this is just an availability check.
function initIAP() {
  return Promise.resolve(isNativeApp() && !!nativePurchasesPlugin());
}

// productId must match a real "in-app product" configured in Play Console,
// and must exist in the PRODUCTS map in the verify-purchase Edge Function --
// the reward is only ever decided server-side from that map, never from
// anything the client reports about its own purchase.
function purchaseProduct(productId) {
  if (!isNativeApp()) return Promise.resolve({ error: "Native purchases are only available in the Android app." });
  const plugin = nativePurchasesPlugin();
  if (!plugin) return Promise.resolve({ error: "In-app purchases aren't available on this device." });
  return plugin.purchaseProduct({ productIdentifier: productId, productType: "inapp" })
    .then(result => {
      if (!result || !result.purchaseToken) return { error: "Purchase completed but no verification token was returned." };
      return verifyPurchaseOnServer(productId, result.purchaseToken);
    })
    .catch(err => ({ error: err.message || String(err) }));
}

// The only thing that actually grants the reward. Never trust a client-
// reported "purchase succeeded" alone -- a modified APK could call
// purchaseProduct's success path without ever actually paying.
function verifyPurchaseOnServer(productId, purchaseToken) {
  return sb.functions.invoke("verify-purchase", { body: { productId, purchaseToken } })
    .then(({ data, error }) => {
      if (error) return { error: error.message || String(error) };
      if (data && data.error) return { error: data.error };
      return { error: null };
    })
    .catch(err => ({ error: err.message || String(err) }));
}

// Web / iOS-PWA purchase path. Redirects the whole page to Stripe's hosted
// checkout, so unlike purchaseProduct() above there's no "success" callback
// on this same page load -- the credit happens server-side while the user
// is on Stripe's page, and handleStripeReturn() below picks up the result
// after Stripe redirects back.
function startWebCheckout(productId) {
  return sb.functions.invoke("create-checkout-session", {
    body: { productId, returnUrl: window.location.origin + window.location.pathname }
  }).then(({ data, error }) => {
    if (error) return { error: error.message || String(error) };
    if (data && data.error) return { error: data.error };
    if (!data || !data.url) return { error: "Checkout session did not return a URL." };
    window.location.href = data.url;
    return { error: null };
  }).catch(err => ({ error: err.message || String(err) }));
}

// Called once per app boot (after sign-in resolves) to notice a return trip
// from Stripe Checkout. The actual gems/card are credited by the
// stripe-webhook Edge Function, which may land slightly before or after
// this redirect -- refreshGameState() is called twice (immediately, then
// again after a short delay) to give that race a little room without
// polling indefinitely.
function handleStripeReturn() {
  const params = new URLSearchParams(window.location.search);
  const checkout = params.get("checkout");
  if (!checkout) return;

  history.replaceState(null, "", window.location.pathname);
  if (!window.state || !window.state.shop) return;

  window.state.shop.checkoutNotice = checkout === "success"
    ? "Payment received -- crediting your purchase now."
    : "Checkout cancelled -- no charge was made.";
  window.render();

  if (checkout === "success") {
    refreshGameState();
    setTimeout(refreshGameState, 2500);
  }
  setTimeout(() => {
    if (window.state && window.state.shop) { window.state.shop.checkoutNotice = null; window.render(); }
  }, 5000);
}
