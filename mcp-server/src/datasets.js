import fs from "node:fs/promises";
import path from "node:path";
import { DATASET_INDEX_PATH, VIEWER_ROOT, requireInsideViewerRoot, resolveViewerPath } from "./paths.js";

export async function readDatasetIndex(indexPath = DATASET_INDEX_PATH) {
  let raw = null;
  try {
    raw = await fs.readFile(indexPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { default: null, datasets: [] };
    }
    throw error;
  }
  const catalog = JSON.parse(raw);
  if (!Array.isArray(catalog.datasets)) {
    throw new Error(`Dataset index must contain a datasets array: ${indexPath}`);
  }
  return catalog;
}

export async function writeDatasetIndex(catalog, indexPath = DATASET_INDEX_PATH) {
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
}

export async function listDatasets() {
  const catalog = await readDatasetIndex();
  const datasets = await Promise.all(
    catalog.datasets.map(async (entry) => ({
      ...entry,
      manifestPath: manifestPathForEntry(entry),
      manifest: await readManifest(entry)
    }))
  );
  return {
    default: catalog.default ?? null,
    datasets
  };
}

export async function summarizeDataset(datasetId) {
  const catalog = await readDatasetIndex();
  const entry = catalog.datasets.find((item) => item.id === datasetId);
  if (!entry) {
    throw new Error(`Unknown dataset: ${datasetId}`);
  }
  const manifest = await readManifest(entry);
  return {
    id: entry.id,
    title: entry.title ?? entry.id,
    manifest: entry.manifest,
    name: manifest.name,
    description: manifest.description ?? "",
    nside: manifest.nside,
    minOrder: manifest.minOrder,
    maxOrder: manifest.maxOrder,
    tileSize: manifest.tileSize,
    tileShift: manifest.tileShift,
    defaultView: manifest.defaultView ?? null,
    layers: manifest.layers.map((layer) => ({
      id: layer.id,
      title: layer.title ?? layer.id,
      kind: layer.kind,
      dtype: layer.dtype,
      unit: layer.unit ?? "",
      stats: layer.stats ?? null,
      quantization: layer.quantization ?? null,
      source: layer.source ?? null
    })),
    sources: manifest.sources ?? []
  };
}

export async function registerDataset({ id, title, manifest, makeDefault = false }) {
  if (!id || !manifest) {
    throw new Error("register_dataset requires id and manifest.");
  }
  const manifestPath = requireInsideViewerRoot(resolveViewerPath("public", "datasets", manifest));
  await fs.access(manifestPath);
  const catalog = await readDatasetIndex();
  const entry = { id, title: title || id, manifest };
  catalog.datasets = [...catalog.datasets.filter((item) => item.id !== id), entry];
  if (makeDefault || !catalog.default) {
    catalog.default = id;
  }
  await writeDatasetIndex(catalog);
  return { indexPath: DATASET_INDEX_PATH, entry, default: catalog.default };
}

export async function readManifest(entry) {
  const raw = await fs.readFile(manifestPathForEntry(entry), "utf8");
  return JSON.parse(raw);
}

export function manifestPathForEntry(entry) {
  return path.join(VIEWER_ROOT, "public", "datasets", entry.manifest);
}
