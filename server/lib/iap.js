// TCG Manager -- native in-app purchases (RevenueCat), for the Capacitor
// iOS/Android wrapper only -- the plain web version keeps its existing
// "demo" purchase buttons untouched. UNTESTED: there is no iOS/Android
// simulator or device in this environment, so none of the calls below have
// ever actually run. Verify on a real device/simulator before trusting this.
//
// Checklist to make this live (all outside what code alone can do):
//   1. Create a RevenueCat account (revenuecat.com), add an iOS + Android app.
//   2. Enroll in the Apple Developer Program ($99/yr) and Google Play Console
//      ($25 one-time) -- needs your own identity/payment, not something I can do.
//   3. In App Store Connect / Play Console, create the actual in-app-purchase
//      products (e.g. gems_100/gems_500/gems_1000, exclusive_27/28/29) and
//      wire them into RevenueCat's dashboard as an "Offering".
//   4. Paste the RevenueCat public API key below.
"use strict";

const REVENUECAT_API_KEY = null; // TODO: set once step 1-3 above are done

function isNativeApp() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

let iapReady = false;

function initIAP() {
  if (!isNativeApp() || !REVENUECAT_API_KEY) return Promise.resolve(false);
  const Purchases = window.Capacitor.Plugins.Purchases;
  if (!Purchases) { console.warn("RevenueCat Purchases plugin not found on this platform."); return Promise.resolve(false); }
  return Purchases.configure({ apiKey: REVENUECAT_API_KEY })
    .then(() => { iapReady = true; return true; })
    .catch(err => { console.error("RevenueCat init failed:", err); return false; });
}

// productId should match whatever's configured in App Store Connect/Play
// Console + RevenueCat's dashboard (see checklist above).
function purchaseProduct(productId) {
  if (!isNativeApp()) return Promise.resolve({ error: "Native purchases are only available in the iOS/Android app." });
  if (!iapReady) return Promise.resolve({ error: "In-app purchases aren't set up yet." });
  const Purchases = window.Capacitor.Plugins.Purchases;
  return Purchases.getOfferings().then(offerings => {
    const pkg = offerings.current && offerings.current.availablePackages.find(p => p.product.identifier === productId);
    if (!pkg) return { error: `Product ${productId} not found in RevenueCat offerings.` };
    return Purchases.purchasePackage({ aPackage: pkg }).then(({ customerInfo }) => ({ data: customerInfo, error: null }));
  }).catch(err => ({ error: err.message || String(err) }));
}
