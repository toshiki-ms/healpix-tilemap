import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

export const MCP_ROOT = path.resolve(here, "..");
export const VIEWER_ROOT = path.resolve(process.env.HPX_VIEWER_ROOT ?? path.join(MCP_ROOT, ".."));
export const DATASET_INDEX_PATH = path.join(VIEWER_ROOT, "public", "datasets", "index.json");
export const DEFAULT_VIEWER_BASE_URL = process.env.HPX_VIEWER_URL ?? "http://127.0.0.1:4181/";

export function resolveViewerPath(...parts) {
  return path.resolve(VIEWER_ROOT, ...parts);
}

export function requireInsideViewerRoot(candidate) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(VIEWER_ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is outside viewer root: ${candidate}`);
  }
  return resolved;
}
