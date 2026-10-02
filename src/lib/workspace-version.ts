import { readCatalogRevision } from "@/lib/catalog";
import { hashJson } from "@/lib/crypto";
import { isDemo } from "@/lib/demo-mode";
import { adminSupabase } from "@/lib/supabase-admin";

export async function workspaceVersion(userId: string): Promise<string | undefined> {
  if (isDemo()) return undefined;
  const [{ data, error }, catalogRevision] = await Promise.all([
    adminSupabase().from("app_states").select("revision").eq("user_id", userId).maybeSingle(),
    readCatalogRevision(),
  ]);
  if (error) throw error;
  // Scope the validator to its owner, including owners without saved state.
  return `"${hashJson({ userId, revision: data?.revision ?? null, catalogRevision })}"`;
}
