import { createClient } from "@supabase/supabase-js";

export function adminSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    throw new Error(
      "Supabase URL and service key are required outside demo mode.",
    );
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
