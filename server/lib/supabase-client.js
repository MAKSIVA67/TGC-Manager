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
