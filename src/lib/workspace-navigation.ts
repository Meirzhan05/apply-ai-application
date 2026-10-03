export type WorkspaceSection = "matches" | "applications" | "profile" | "settings";
export type WorkspaceNavigation = {
  section: WorkspaceSection;
  applicationId: string | null;
  search: string;
  attentionOnly: boolean;
};
type SessionStore = Pick<Storage, "getItem" | "setItem">;
const key = (owner: string) => `apply-ai:navigation:${owner}`;

export function readWorkspaceNavigation(storage: SessionStore, owner: string, applicationIds: string[]): WorkspaceNavigation | null {
  try {
    const saved = JSON.parse(storage.getItem(key(owner)) ?? "null");
    if (!saved || saved.version !== 1 || !["matches", "applications", "profile", "settings"].includes(saved.section)) return null;
    return {
      section: saved.section,
      applicationId: typeof saved.applicationId === "string" && applicationIds.includes(saved.applicationId) ? saved.applicationId : null,
      search: typeof saved.search === "string" ? saved.search.slice(0, 200) : "",
      attentionOnly: saved.attentionOnly === true,
    };
  } catch { return null; }
}

export function writeWorkspaceNavigation(storage: SessionStore, owner: string, navigation: WorkspaceNavigation): void {
  try { storage.setItem(key(owner), JSON.stringify({ ...navigation, version: 1 })); }
  catch { /* Keep navigation usable when browser storage is unavailable. */ }
}
