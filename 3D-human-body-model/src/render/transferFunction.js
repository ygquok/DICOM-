/**
 * Transfer function: maps CT Hounsfield units (HU) to RGBA color.
 *
 * Pure logic, no external dependencies, unit-testable in Node.
 *
 * The volume is normalized to [0,1] over the HU window [HU_MIN, HU_MAX].
 * The 1D LUT is sampled by the raymarching shader: index = density * (size-1).
 */

export const HU_MIN = -1024;
export const HU_MAX = 3071;

/** Normalize a HU value into [0,1] over the fixed window. */
export function huToNorm(hu, huMin = HU_MIN, huMax = HU_MAX) {
  return (hu - huMin) / (huMax - huMin);
}

/** Inverse of huToNorm. */
export function normToHu(n, huMin = HU_MIN, huMax = HU_MAX) {
  return huMin + n * (huMax - huMin);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * Build an RGBA LUT (Uint8Array of length size*4).
 * points: array of [hu, r, g, b, a] with r/g/b in 0..1 and a in 0..1.
 * Control points are linearly interpolated across the HU axis.
 */
export function buildLUT(points, size = 512) {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const lut = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const n = size <= 1 ? 0 : i / (size - 1);
    const hu = normToHu(n);
    const c = samplePoints(sorted, hu);
    lut[i * 4] = clamp255(c[1] * 255);
    lut[i * 4 + 1] = clamp255(c[2] * 255);
    lut[i * 4 + 2] = clamp255(c[3] * 255);
    lut[i * 4 + 3] = clamp255(c[4] * 255);
  }
  return lut;
}

function samplePoints(points, hu) {
  if (hu <= points[0][0]) return points[0];
  const last = points[points.length - 1];
  if (hu >= last[0]) return last;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (hu >= a[0] && hu <= b[0]) {
      const span = b[0] - a[0];
      const t = span === 0 ? 0 : (hu - a[0]) / span;
      return [
        hu,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
        a[3] + (b[3] - a[3]) * t,
        a[4] + (b[4] - a[4]) * t,
      ];
    }
  }
  return last;
}

/** High-level user-facing transfer function parameters. */
export function defaultTransferFunctionParams() {
  return {
    organColor: [0.94, 0.44, 0.33], // 器官 / 软组织 — 暖红
    boneColor: [0.98, 0.92, 0.78], // 骨骼 — 象牙白
    boneThreshold: 300, // HU，高于此值视为骨骼
    organOpacity: 0.20,
    boneOpacity: 1.0,
    alphaScale: 1.0,
    shading: true,
  };
}

/** Hex string (e.g. "#ff8866") -> [r,g,b] in 0..1. */
export function hexToRGB(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [1, 1, 1];
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function rgbToHex(rgb) {
  const c = (v) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

/**
 * Build a transfer-function LUT from high-level params.
 * Bone (HU >= boneThreshold) and organs/soft tissue (below threshold) get
 * different colors, with a short alpha ramp at the bone boundary.
 */
export function buildLUTFromParams(p, size = 512) {
  const oc = p.organColor;
  const bc = p.boneColor;
  const bt = p.boneThreshold;
  const softTop = Math.min(bt - 40, 260);
  const points = [
    [HU_MIN, 0, 0, 0, 0],
    [-80, oc[0], oc[1], oc[2], 0.0],
    [0, oc[0], oc[1], oc[2], p.organOpacity * 0.55],
    [softTop, oc[0], oc[1], oc[2], p.organOpacity],
    [bt, bc[0], bc[1], bc[2], 0.0],
    [bt + 150, bc[0], bc[1], bc[2], p.boneOpacity],
    [HU_MAX, bc[0], bc[1], bc[2], p.boneOpacity],
  ];
  return buildLUT(points, size);
}

/** Compute min/max HU of a Float32Array (for the info panel). */
export function computeHuRange(data) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!isFinite(min)) return [0, 0];
  return [min, max];
}

export function clamp01Value(v) {
  return clamp01(v);
}
