import type { MatchCollection, MatchFilter } from "./match-view";

export type BrowseView = { collection: MatchCollection; filter: MatchFilter; search: string; sort: "relevant" | "newest" };
export type ImportDraft = { url: string; company: string; title: string; location: string };
export const emptyImport: ImportDraft = { url: "", company: "", title: "", location: "" };
type MatchesSession = { view: BrowseView; draft: ImportDraft; importOpen: boolean };
type SessionStore = Pick<Storage, "getItem" | "setItem">;

const key = (owner: string) => `apply-ai:matches:${owner}`;
const text = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : "";

export function readMatchesSession(storage: SessionStore, owner: string): MatchesSession | null {
  try {
    const stored = JSON.parse(storage.getItem(key(owner)) ?? "null");
    if (!stored || stored.version !== 1) return null;
    const view = stored.view ?? {};
    const draft = stored.draft ?? {};
    const fields = { url: text(draft.url, 2048), company: text(draft.company, 120), title: text(draft.title, 160), location: text(draft.location, 160) };
    return {
      view: {
        collection: ["all", "saved", "dismissed"].includes(view.collection) ? view.collection : "all",
        filter: ["all", "strong", "possible", "uncertain"].includes(view.filter) ? view.filter : "all",
        sort: view.sort === "newest" ? "newest" : "relevant",
        search: text(view.search, 512),
      },
      draft: fields,
      importOpen: stored.importOpen === true && Object.values(fields).some(value => value.trim()),
    };
  } catch { return null; }
}

export function writeMatchesSession(storage: SessionStore, owner: string, session: MatchesSession): void {
  try {
    const hasDraft = Object.values(session.draft).some(value => value.trim());
    storage.setItem(key(owner), JSON.stringify({ version: 1, view: session.view, ...(hasDraft ? { draft: session.draft, importOpen: session.importOpen } : {}) }));
  } catch { /* The interface remains usable when session storage is unavailable. */ }
}
