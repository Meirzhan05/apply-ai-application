import { getDocument as loadPdfDocument, GlobalWorkerOptions, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function workerPath() {
  const configuredPath = process.env.PDFJS_WORKER_PATH;
  if (configuredPath) {
    if (isAbsolute(configuredPath)) return configuredPath;
    // Keep relative runtime overrides without making Turbopack trace the entire project.
    return resolve(/*turbopackIgnore: true*/ process.cwd(), configuredPath);
  }
  // Turbopack rewrites createRequire().resolve(asset) to its numeric module id,
  // which is not a filesystem path. Next traces the worker at this package path.
  return resolve(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs");
}

export function getDocument(parameters: Parameters<typeof loadPdfDocument>[0]) {
  GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath()).href;
  return loadPdfDocument(parameters);
}

export { OPS };
