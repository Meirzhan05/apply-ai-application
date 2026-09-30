import { NextResponse } from "next/server";
import { demoJobs } from "@/lib/demo-data";
import { isDemo } from "@/lib/repository";
import { sameOrigin } from "@/lib/request-security";

export async function POST(request: Request) {
  if (!isDemo()) return new Response("Demo form disabled", { status: 404 });
  if (!sameOrigin(request))
    return new Response("Cross-origin request rejected", { status: 403 });
  const data = await request.formData();
  const slug = String(data.get("slug") ?? "");
  if (!demoJobs.some((job) => job.sourceId === slug))
    return new Response("Unknown role", { status: 404 });
  const required = ["firstName", "lastName", "email"];
  if (required.some((key) => !String(data.get(key) ?? "").trim()))
    return new Response("Required fields are missing", { status: 400 });
  const resume = data.get("resume");
  if (!(resume instanceof File) || resume.size === 0)
    return new Response("Resume is required", { status: 400 });
  if (slug === "ux-researcher") {
    const coverLetter = data.get("coverLetter");
    if (!(coverLetter instanceof File) || coverLetter.size === 0)
      return new Response("Cover letter is required", { status: 400 });
  }
  return NextResponse.redirect(
    new URL(`/demo/confirmation/${slug}`, request.url),
    303,
  );
}
