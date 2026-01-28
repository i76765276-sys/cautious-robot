"use strict";

const { createClient } = require("@supabase/supabase-js");
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = require("./envConfig");

function createServerSupabase() {
  const url = String(SUPABASE_URL).trim();
  const key = String(SUPABASE_SERVICE_ROLE_KEY).trim();

  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }

  // Server-side client. Service role bypasses RLS; never expose this key to the browser.
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

module.exports = { createServerSupabase };
