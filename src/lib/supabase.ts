import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

function publicConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key)
    throw new Error(
      "Supabase URL and publishable key are required outside demo mode.",
    );
  return { url, key };
}

export async function serverSupabase() {
  const { url, key } = publicConfig();
  const cookieStore = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(items) {
        try {
          items.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          /* Server components cannot set cookies; route handlers can. */
        }
      },
    },
  });
}
