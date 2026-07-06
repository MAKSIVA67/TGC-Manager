// TCG Manager -- native in-app purchases via direct Google Play Billing
// (@capgo/native-purchases), for the Capacitor Android wrapper only -- the
// plain web version keeps its existing "demo" purchase buttons untouched.
// No third-party purchase account/dashboard involved -- Google Play
// Console is the only place products are defined, and every purchase is
// verified server-side (the verify-purchase Edge Function, which checks
// the token against Google's own Play Developer API) before anything is
// credited. RevenueCat was dropped in favor of this once the project
// became Android-only -- see the checklist below for what's still needed.
// UNTESTED: there is no Android device/simulator in this environment, so
// none of the calls below have ever actually run. Verify on a real device
// before trusting this.
//
// Checklist to make this live (all outside what code alone can do):
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
