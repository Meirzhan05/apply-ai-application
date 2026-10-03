import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_BUILD_DIR || ".next",
  serverExternalPackages: ["pdf-parse", "mammoth", "@napi-rs/canvas"],
  outputFileTracingIncludes: {
    "/*": ["./src/assets/fonts/*"],
    // pdfjs loads its optional native polyfills dynamically. Static tracing
    // omitted them on Vercel, crashing the resume route before authentication.
    "/api/resume": ["./node_modules/@napi-rs/canvas*/**", "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/api/actions": ["./node_modules/@napi-rs/canvas*/**", "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/api/applications/*": ["./node_modules/@napi-rs/canvas*/**", "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/api/pilot/evidence/*": ["./node_modules/@napi-rs/canvas*/**", "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
  devIndicators: false,
};

export default nextConfig;
