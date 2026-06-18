export const TAU = Math.PI * 2;

export const FACE_RING_ANCHORS = Object.freeze([2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4]);
export const FACE_PHI_ANCHORS = Object.freeze([1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7]);

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function wrapTau(value) {
  return ((value % TAU) + TAU) % TAU;
}

export function heightFromRingNorm(ringNorm) {
  if (ringNorm <= 1) {
    return 1 - (ringNorm * ringNorm) / 3;
  }
  if (ringNorm <= 3) {
    return ((2 - ringNorm) * 2) / 3;
  }
  const mirror = 4 - ringNorm;
  return -1 + (mirror * mirror) / 3;
}

export function phiRawFromGridNorm(rawNorm, ringNorm) {
  if (ringNorm <= 0.000001 || ringNorm >= 3.999999) {
    return nearestPolarAnchorNorm(rawNorm);
  }
  if (ringNorm < 1) {
    const anchor = nearestPolarAnchorNorm(rawNorm);
    return anchor + (rawNorm - anchor) / Math.max(ringNorm, 0.000001);
  }
  if (ringNorm > 3) {
    const anchor = nearestPolarAnchorNorm(rawNorm);
    return anchor + (rawNorm - anchor) / Math.max(4 - ringNorm, 0.000001);
  }
  return rawNorm;
}

export function nearestPolarAnchorNorm(rawNorm) {
  const anchors = [1, 3, 5, 7];
  let best = anchors[0];
  let bestDistance = Infinity;
  for (const anchor of anchors) {
    const wrapped = anchor + Math.round((rawNorm - anchor) / 8) * 8;
    const distance = Math.abs(rawNorm - wrapped);
    if (distance < bestDistance) {
      best = wrapped;
      bestDistance = distance;
    }
  }
  return best;
}

export function faceUvToVector(face, u, v, radius = 1) {
  const safeU = clamp(u, 0, 1);
  const safeV = clamp(v, 0, 1);
  const ringNorm = clamp(FACE_RING_ANCHORS[face] - safeU - safeV, 0, 4);
  const rawNorm = FACE_PHI_ANCHORS[face] - safeU + safeV;
  const phi = wrapTau((phiRawFromGridNorm(rawNorm, ringNorm) * Math.PI) / 4);
  const y = heightFromRingNorm(ringNorm);
  const horizontal = Math.sqrt(Math.max(0, 1 - y * y));
  return [
    Math.cos(phi) * horizontal * radius,
    y * radius,
    Math.sin(phi) * horizontal * radius
  ];
}

export function healpixVectorToDisplayVector(vector) {
  return [vector[0], vector[2], vector[1]];
}

export function lonLatToVector(lon, lat, radius = 1) {
  const phi = (Number(lon) * Math.PI) / 180;
  const theta = (Number(lat) * Math.PI) / 180;
  const horizontal = Math.cos(theta);
  return [
    Math.cos(phi) * horizontal * radius,
    Math.sin(theta) * radius,
    Math.sin(phi) * horizontal * radius
  ];
}

export function cellCenterVector(order, face, ix, iy, radius = 1) {
  const nside = 2 ** order;
  return faceUvToVector(face, (ix + 0.5) / nside, (iy + 0.5) / nside, radius);
}

export function vectorToLonLat(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  const x = vector[0] / length;
  const y = vector[1] / length;
  const z = vector[2] / length;
  return {
    lon: (Math.atan2(z, x) * 180) / Math.PI,
    lat: (Math.asin(clamp(y, -1, 1)) * 180) / Math.PI
  };
}

export function faceUvToNet(face, u, v) {
  return {
    x: FACE_PHI_ANCHORS[face] - u + v,
    y: FACE_RING_ANCHORS[face] - u - v
  };
}

export function netToFaceUv(x, y) {
  for (let face = 0; face < 12; face += 1) {
    const phi = FACE_PHI_ANCHORS[face];
    const ring = FACE_RING_ANCHORS[face];
    const u = (ring - y - x + phi) / 2;
    const v = (ring - y + x - phi) / 2;
    if (u >= -1e-6 && u <= 1 + 1e-6 && v >= -1e-6 && v <= 1 + 1e-6) {
      return { face, u: clamp(u, 0, 1), v: clamp(v, 0, 1) };
    }
  }
  return null;
}
