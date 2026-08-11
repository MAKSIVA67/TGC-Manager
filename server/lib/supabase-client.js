// TCG Manager -- Supabase client (shared with the mobile app's backend).
// Loaded after the supabase-js CDN <script> tag, before every other lib/*.js.
"use strict";

const SUPABASE_URL = "https://tzktsffcirwgbkwxsyrx.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_wzTSAGVTh1SONsZzSwj_GQ_KFtvPvuM";

// Named `sb`, not `supabase` -- `window.supabase` is the library namespace
// from the CDN UMD bundle, and shadowing it would break anything loaded
// after this file that still needs `window.supabase.createClient`.
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: window.localStorage,
    autoRefreshToken: true,
    persistSession: true,
    // Unlike the mobile app (no URL-based redirects at all), the web
    // version's email-confirmation link redirects back here with the new
    // session in a URL fragment -- this must be true to actually pick it up.
    detectSessionInUrl: true,
  },
});

// "This database has not had that migration run yet." Migrations land by hand,
// separately from deploying the site, so every RPC the client learns to call
// has to survive the window in which the function does not exist -- and a
// cached copy of the JavaScript can outlive a rollback too. Postgres reports
// 42883 (no such function) and PostgREST reports PGRST202 (not in its schema
// cache); the message test catches wordings neither code covers.
//
// Lives here, in the first script loaded, because game-data.js, admin-api.js
// and the game IIFE in index.html all need it. It used to be declared in
// admin-api.js, which loads AFTER game-data.js -- that worked only because
// nothing called it during load, which is not a property worth relying on.
function rpcMissing(error) {
  return !!error && (error.code === "42883" || error.code === "PGRST202" ||
                     /(function|schema cache).*(does not exist|not find)/i.test(error.message || ""));
}
