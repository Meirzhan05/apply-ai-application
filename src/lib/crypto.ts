import { createHash } from "node:crypto";

export function hashJson(value: unknown): string {
  const normalized = JSON.parse(JSON.stringify(value)) as unknown;
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === "object") return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(normalized))).digest("hex");
}

export function newId(): string {
  return crypto.randomUUID();
}
