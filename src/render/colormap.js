import { clamp } from "../core/projection.js";

const VIRIDIS = [
  [0.0, [68, 1, 84]],
  [0.13, [71, 44, 122]],
  [0.25, [59, 82, 139]],
  [0.38, [44, 113, 142]],
  [0.5, [33, 145, 140]],
  [0.63, [39, 173, 129]],
  [0.75, [92, 200, 99]],
  [0.88, [170, 220, 50]],
  [1.0, [253, 231, 37]]
];

const MAGMA = [
  [0.0, [0, 0, 4]],
  [0.14, [31, 17, 81]],
  [0.28, [81, 18, 124]],
  [0.42, [130, 37, 129]],
  [0.56, [181, 54, 122]],
  [0.7, [229, 80, 100]],
  [0.84, [252, 137, 97]],
  [1.0, [252, 253, 191]]
];

const BALANCE = [
  [0.0, [49, 54, 149]],
  [0.18, [69, 117, 180]],
  [0.36, [171, 217, 233]],
  [0.5, [246, 246, 238]],
  [0.64, [253, 174, 97]],
  [0.82, [215, 48, 39]],
  [1.0, [120, 20, 36]]
];

export function colorForValue(value, state) {
  if (!Number.isFinite(value)) {
    return [41, 43, 45, 0];
  }
  const t = normalizeValue(value, state);
  return [...sampleColormap(state.colormap, t), 255];
}

export function normalizeValue(value, state) {
  const min = Number(state.min);
  const max = Number(state.max);
  if (!(max > min)) {
    return 0.5;
  }
  if (state.scale === "log") {
    const safeMin = Math.max(min, Number.EPSILON);
    const safeValue = Math.max(value, safeMin);
    return clamp((Math.log(safeValue) - Math.log(safeMin)) / (Math.log(max) - Math.log(safeMin)), 0, 1);
  }
  if (state.scale === "symlog") {
    const lin = Number(state.symlogConstant ?? 0.03);
    const transform = (x) => Math.sign(x) * Math.log1p(Math.abs(x) / lin);
    const lo = transform(min);
    const hi = transform(max);
    return clamp((transform(value) - lo) / (hi - lo), 0, 1);
  }
  return clamp((value - min) / (max - min), 0, 1);
}

export function sampleColormap(name, t) {
  if (name === "turbo") {
    return turbo(t);
  }
  const stops = name === "magma" ? MAGMA : name === "balance" ? BALANCE : VIRIDIS;
  return interpolateStops(stops, clamp(t, 0, 1));
}

export function interpolateStops(stops, t) {
  for (let i = 1; i < stops.length; i += 1) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (t - t0) / (t1 - t0 || 1);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f)
      ];
    }
  }
  return stops[stops.length - 1][1];
}

export function turbo(t) {
  const x = clamp(t, 0, 1);
  const r = 34.61 + x * (1172.33 + x * (-10793.56 + x * (33300.12 + x * (-38394.49 + x * 14825.05))));
  const g = 23.31 + x * (557.33 + x * (1225.33 + x * (-3574.96 + x * (1073.77 + x * 707.56))));
  const b = 27.2 + x * (3211.1 + x * (-15327.97 + x * (27814 + x * (-22569.18 + x * 6838.66))));
  return [clamp(Math.round(r), 0, 255), clamp(Math.round(g), 0, 255), clamp(Math.round(b), 0, 255)];
}

export function colorbarCss(name) {
  const samples = [];
  for (let i = 0; i <= 12; i += 1) {
    const t = i / 12;
    const [r, g, b] = sampleColormap(name, t);
    samples.push(`rgb(${r} ${g} ${b}) ${Math.round(t * 100)}%`);
  }
  return `linear-gradient(90deg, ${samples.join(", ")})`;
}
