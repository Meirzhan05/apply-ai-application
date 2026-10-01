"use client";

import { useEffect } from "react";
import { browserSupabase } from "@/lib/supabase-browser";

export function SessionRefresh() {
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) return;
    // Creating the shared browser client starts Supabase's visibility-aware
    // refresh timer. Previously it was created only on login or sign-out.
    browserSupabase();
  }, []);
  return null;
}
