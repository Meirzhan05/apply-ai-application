import type { Job, JobSource } from "@/lib/types";
import { isIP } from "node:net";

export interface BoardConfig {
  source: Exclude<JobSource, "demo" | "imported">;
  slug: string;
  region?: "eu";
}

function validJobUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value));
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !isIP(url.hostname.replace(/^\[|\]$/g, "")) &&
      !url.hostname.endsWith(".local") &&
      !url.hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

function decodedMarkup(html: string): string {
  // Greenhouse content can be an entity-escaped HTML fragment. Decode before
  // removing tags, so escaped scripts and markup cannot enter the job text.
  return html.replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#(?:39|x27);/gi, "'");
}

function plain(html: string): string {
  return decodedMarkup(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
}

function requirements(raw: string): string[] {
  const html = decodedMarkup(raw);
  const qualification = /^(?:(?:basic|minimum|required|preferred|desired|essential|your)\s+)?(?:qualifications?|requirements?|skills(?:\s+and\s+experience)?|experience)\b|^what\s+(?:we(?:'re| are)?\s+(?:looking for|look for|need)|you(?:'ll| will)?\s+(?:bring|need))\b|^about you\b|^nice to have\b|^even better\b/i;
  const headings = [...html.matchAll(/<(h[1-6]|p)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .filter((match) => {
      const previousListTag = [...html.slice(0, match.index).matchAll(/<\/?li\b[^>]*>/gi)].at(-1)?.[0] ?? "";
      return !/^<li\b/i.test(previousListTag);
    })
    .filter((match) => /^h/i.test(match[1]) ||
      /^\s*<(?:strong|b)\b[^>]*>[\s\S]*<\/(?:strong|b)>\s*$/i.test(match[2]))
    .map((match) => ({ tag: match[1], start: match.index!, end: match.index! + match[0].length,
      label: plain(match[2]).replace(/[’‘]/g, "'").trim() }))
    // Standalone bold paragraphs are sometimes bullets. Only treat short
    // section labels as boundaries, leaving their actual evidence intact.
    .filter((heading) => /^h/i.test(heading.tag) || (heading.label.length <= 100 &&
      (qualification.test(heading.label) || /^(?:what (?:we offer|you(?:'ll| will)? do)|responsibilities|duties|benefits|perks|compensation|salary|our values|about (?:us|the role|the company)|location|example projects)\b/i.test(heading.label))));
  const sections = headings.length ? headings.flatMap((heading, index) =>
    qualification.test(heading.label) ? [html.slice(heading.end, headings[index + 1]?.start ?? html.length)] : []) : [html];
  const content = sections.join(" ");
  const listItems = [...content.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(
    (match) => plain(match[1]),
  );
  const lines = listItems.length
    ? listItems
    : plain(content)
        .split(/(?<=[.!?])\s+/)
        .filter((line) =>
          /require|qualification|experience with|proficien|familiar with|knowledge of|ability to|degree in/i.test(
            line,
          ),
        );
  return [
    ...new Set(
      lines
        .map((line) => line.replace(/^[•\-\s]+/, "").slice(0, 250))
        .filter((line) => line.length >= 3 && line.length <= 250),
    ),
  ].slice(0, 12);
}

function id(source: JobSource, slug: string, sourceId: string): string {
  return `${source}:${slug}:${sourceId}`;
}

function ashbyLocations(item: Record<string, unknown>): string {
  const secondary = Array.isArray(item.secondaryLocations) ? item.secondaryLocations : [];
  const locations = [item.location, ...secondary.map((entry) =>
    entry && typeof entry === "object" ? entry.location : undefined)]
    .filter((location): location is string => typeof location === "string" && Boolean(location.trim()))
    .map((location) => location.trim());
  // All explicitly offered locations must reach hard-rule checks; retaining
  // only the primary city can incorrectly exclude an eligible applicant.
  return [...new Set(locations)].join("; ") || "Location not listed";
}

export function configuredBoards(
  raw = process.env.JOB_BOARDS ?? "",
): BoardConfig[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [source, slug] = entry.split(":");
      if (
        !(
          ["greenhouse", "lever", "ashby"].includes(source) &&
          /^[a-zA-Z0-9_-]{2,80}$/.test(slug || "") &&
          slug !== "example"
        )
      )
        return null;
      return { source: source as BoardConfig["source"], slug };
    })
    .filter((board): board is BoardConfig => Boolean(board));
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "ApplyAI/0.1 (+job catalog)",
    },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok)
    throw new Error(`Source request failed (${response.status}).`);
  return response.json();
}

async function greenhouse(slug: string, strict = false): Promise<Job[]> {
  const data = (await getJson(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
  )) as { jobs?: Array<Record<string, unknown>>; meta?: { total?: number } };
  if (!Array.isArray(data.jobs)) throw new Error("Greenhouse returned an invalid catalog.");
  if (strict && data.jobs.some((item) => !item?.id || !validJobUrl(item.absolute_url) || !item.title))
    throw new Error("Greenhouse returned an incomplete catalog.");
  if (strict && typeof data.meta?.total === "number" && data.meta.total !== data.jobs.length)
    throw new Error("Greenhouse returned an incomplete catalog.");
  const now = new Date().toISOString();
  return (data.jobs ?? [])
    .filter((item) => item.id && validJobUrl(item.absolute_url))
    .map((item) => ({
      id: id("greenhouse", slug, String(item.id)),
      source: "greenhouse",
      sourceId: String(item.id),
      sourceLabel: "Greenhouse",
      company: slug.replace(/[-_]/g, " "),
      title: String(item.title ?? "Untitled role"),
      location: String(
        (item.location as { name?: string } | undefined)?.name ??
          "Location not listed",
      ),
      remote: null,
      employmentType: "Not listed",
      description: plain(String(item.content ?? "")),
      requirements: requirements(String(item.content ?? "")),
      url: normalizePostingUrl(String(item.absolute_url)),
      applyUrl: normalizePostingUrl(String(item.absolute_url)),
      postedAt:
        typeof item.created_at === "string" ? item.created_at : undefined,
      active: true,
      discoveredAt: now,
    }));
}

async function lever(slug: string, strict = false, region?: "eu"): Promise<Job[]> {
  const data = (await getJson(
    `https://${region === "eu" ? "api.eu.lever.co" : "api.lever.co"}/v0/postings/${encodeURIComponent(slug)}?mode=json`,
  )) as Array<Record<string, unknown>>;
  if (!Array.isArray(data)) throw new Error("Lever returned an invalid catalog.");
  if (strict && data.some((item) => !item?.id || !validJobUrl(item.hostedUrl) || !item.text))
    throw new Error("Lever returned an incomplete catalog.");
  const now = new Date().toISOString();
  return data
    .filter((item) => item.id && validJobUrl(item.hostedUrl))
    .map((item) => {
      const categories = item.categories as
        | { location?: string; commitment?: string }
        | undefined;
      const lists = Array.isArray(item.lists) ? item.lists.map((list) => {
        const label = plain(String(list.text ?? ""));
        return `${label ? `<h3>${label}</h3>` : ""}${String(list.content ?? "")}`;
      }).join(" ") : "";
      return {
        id: id("lever", slug, String(item.id)),
        source: "lever" as const,
        sourceId: String(item.id),
        sourceLabel: "Lever",
        company: slug.replace(/[-_]/g, " "),
        title: String(item.text ?? "Untitled role"),
        location: categories?.location ?? "Location not listed",
        remote:
          item.workplaceType === "remote"
            ? true
            : item.workplaceType === "on-site"
              ? false
              : null,
        employmentType: categories?.commitment ?? "Not listed",
        description: plain(
          `${String(item.descriptionPlain ?? item.description ?? "")} ${lists} ${String(item.additionalPlain ?? "")}`,
        ),
        requirements: requirements(
          `${String(item.description ?? item.descriptionPlain ?? "")} ${lists}`,
        ),
        url: String(item.hostedUrl),
        applyUrl: validJobUrl(item.applyUrl)
          ? String(item.applyUrl)
          : String(item.hostedUrl),
        active: true,
        postedAt: typeof item.createdAt === "number" ? new Date(item.createdAt).toISOString() : undefined,
        discoveredAt: now,
      };
    });
}

async function ashby(slug: string, includeUnlisted = false, strict = false): Promise<Job[]> {
  const data = (await getJson(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
  )) as { jobs?: Array<Record<string, unknown>> };
  if (!Array.isArray(data.jobs)) throw new Error("Ashby returned an invalid catalog.");
  if (strict && data.jobs.some((item) => !validJobUrl(item?.jobUrl) || !item.title))
    throw new Error("Ashby returned an incomplete catalog.");
  const now = new Date().toISOString();
  return (data.jobs ?? [])
    .filter((item) => (includeUnlisted || item.isListed !== false) && validJobUrl(item.jobUrl))
    .map((item) => ({
      id: id("ashby", slug, String(item.id ?? item.jobUrl)),
      source: "ashby" as const,
      sourceId: String(item.id ?? item.jobUrl),
      sourceLabel: "Ashby",
      company: slug.replace(/[-_]/g, " "),
      title: String(item.title ?? "Untitled role"),
      location: ashbyLocations(item),
      remote: typeof item.isRemote === "boolean" ? item.isRemote : null,
      employmentType: String(item.employmentType ?? "Not listed"),
      description: plain(
        String(item.descriptionPlain ?? item.descriptionHtml ?? ""),
      ),
      requirements: requirements(
        String(item.descriptionHtml ?? item.descriptionPlain ?? ""),
      ),
      url: String(item.jobUrl),
      applyUrl: validJobUrl(item.applyUrl)
        ? String(item.applyUrl)
        : String(item.jobUrl),
      active: true,
      postedAt: typeof item.publishedAt === "string" ? item.publishedAt : undefined,
      discoveredAt: now,
    }));
}

export async function fetchBoard(board: BoardConfig, options?: { includeUnlisted?: boolean; strictCatalog?: boolean }): Promise<Job[]> {
  if (board.source === "greenhouse") return greenhouse(board.slug, options?.strictCatalog);
  if (board.source === "lever") return lever(board.slug, options?.strictCatalog, board.region);
  return ashby(board.slug, options?.includeUnlisted, options?.strictCatalog);
}

export function dedupeJobs(jobs: Job[]): Job[] {
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  return [...jobs.filter((job) => job.active), ...jobs.filter((job) => !job.active)].filter((job) => {
    const url = canonicalJobUrl(job.url);
    if (seenIds.has(job.id) || seenUrls.has(url)) return false;
    seenIds.add(job.id);
    seenUrls.add(url);
    return true;
  });
}

export function canonicalJobUrl(raw: string): string {
  try {
    const url = new URL(normalizePostingUrl(raw));
    if (["jobs.lever.co", "jobs.eu.lever.co", "jobs.ashbyhq.com"].includes(url.hostname))
      url.pathname = url.pathname.replace(/\/(apply|application)\/?$/, "");
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || ["gh_src", "lever-source"].includes(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    if (url.hash === "#app" && /(^|\.)greenhouse\.io$/i.test(url.hostname)) url.hash = "";
    return url.toString();
  } catch { return raw.trim(); }
}

export function normalizePostingUrl(raw: string): string {
  const url = new URL(raw);
  // Greenhouse's legacy hosted job URLs redirect to this host. Show the
  // destination before approval so the browser can retain its host restriction.
  // Custom employer URLs and non-posting paths must remain untouched.
  if (url.protocol === "https:" && url.hostname === "boards.greenhouse.io" &&
    /^\/[^/]+\/jobs\/\d+\/?$/.test(url.pathname)) {
    url.hostname = "job-boards.greenhouse.io";
  }
  return url.toString();
}

export function closeMissingJobs(
  jobs: Job[],
  fetchedBoards: BoardConfig[],
  seenIds: Set<string>,
): { jobs: Job[]; closed: number } {
  let closed = 0;
  const updated = jobs.map((job) => {
    if (
      job.active &&
      fetchedBoards.some((board) =>
        job.id.startsWith(`${board.source}:${board.slug}:`),
      ) &&
      !seenIds.has(job.id)
    ) {
      closed++;
      return { ...job, active: false };
    }
    return job;
  });
  return { jobs: updated, closed };
}

export function classifyImport(raw: string): {
  source: JobSource;
  url: string;
} {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Use an HTTPS job link.");
  if (url.username || url.password)
    throw new Error("Links containing credentials are not accepted.");
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".localhost") ||
    isIP(hostname.replace(/^\[|\]$/g, ""))
  )
    throw new Error("Private addresses cannot be imported.");
  if (
    hostname === "linkedin.com" ||
    hostname.endsWith(".linkedin.com") ||
    hostname === "indeed.com" ||
    hostname.endsWith(".indeed.com")
  ) {
    return { source: "imported", url: url.toString() };
  }
  if (
    hostname === "boards.greenhouse.io" ||
    hostname === "job-boards.greenhouse.io"
  )
    return { source: "greenhouse", url: normalizePostingUrl(url.toString()) };
  if (["jobs.lever.co", "jobs.eu.lever.co"].includes(hostname))
    return { source: "lever", url: url.toString() };
  if (hostname === "jobs.ashbyhq.com")
    return { source: "ashby", url: url.toString() };
  return { source: "imported", url: url.toString() };
}
