export const LOD_TARGET_TILE_PIXELS = 220;

export function detailOrderForBasePixels(
  basePixels,
  manifest,
  maxOrder = manifest.maxOrder,
  targetTilePixels = LOD_TARGET_TILE_PIXELS
) {
  const minOrder = manifest.minOrder ?? manifest.tileShift;
  const cappedMaxOrder = clampOrder(maxOrder, minOrder, manifest.maxOrder);
  if (!Number.isFinite(basePixels) || basePixels <= 0) {
    return minOrder;
  }
  const levelDelta = Math.max(0, Math.ceil(Math.log2(basePixels / targetTilePixels)));
  return clampOrder(manifest.tileShift + levelDelta, minOrder, cappedMaxOrder);
}

export function clampOrder(order, minOrder, maxOrder) {
  return Math.min(maxOrder, Math.max(minOrder, Math.round(order)));
}
