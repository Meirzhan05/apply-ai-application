import type { DiscoveryState } from "./types";

export function discoveryStatus(discovery: DiscoveryState | undefined, demo: boolean, now = Date.now()) {
  if (!discovery) return demo ? "Demo listings · no live source checks" : "Source check status is unavailable";
  const count = discovery.sources.length;
  const unavailable = discovery.sources.filter(source => source.status === "unavailable").length;
  const prefix = unavailable ? `${unavailable} of ${count} sources unavailable · ` : "";
  const checked = discovery.lastRefreshAt ? Date.parse(discovery.lastRefreshAt) : NaN;
  if (!Number.isFinite(checked)) return count
    ? `${prefix || `${count} sources available · `}Check time not reported`
    : "Waiting for the first source check";
  const age = checkAge(discovery.lastRefreshAt!, now);
  return `${prefix}${count === 0 ? "Availability not reported · " : ""}Sources last checked ${age}`;
}

export function checkAge(input: string, now = Date.now()) {
  if (!Number.isFinite(Date.parse(input))) return "time unavailable";
  const minutes = Math.max(0, Math.floor((now - Date.parse(input)) / 60000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`
    : hours < 24 ? `${hours} ${hours === 1 ? "hour" : "hours"} ago`
    : days === 1 ? "yesterday" : `${days} days ago`;
}
