/**
 * Volume construction: sort DICOM slices along the slice normal, resample onto
 * a uniform grid, and build a dense HU (Hounsfield units) volume.
 *
 * Pure logic, no external dependencies, unit-testable in Node.
 */

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Build a dense volume from a list of slices.
 *
 * Each slice: {
 *   rows, cols,
 *   hu: Float32Array (length rows*cols),
 *   pixelSpacing: [x, y] | undefined,
 *   sliceThickness: number | undefined,
 *   imagePosition: [x, y, z] | undefined,
 *   imageOrientation: [6 floats] | undefined,
 *   instanceNumber: number | undefined,
 * }
 *
 * Returns { data: Float32Array, dims: [nx, ny, nz], spacing: [sx, sy, sz] }.
 * dims are [cols, rows, nSlices]; the volume x axis is the DICOM row direction,
 * y is the column direction, z is the slice (superior->inferior) direction.
 */
export function buildVolume(slices) {
  if (!slices || slices.length === 0) {
    throw new Error('没有可用的 DICOM 切片');
  }
  const s0 = slices[0];
  const rows = s0.rows;
  const cols = s0.cols;

  // Slice normal from image orientation (row x column).
  const ori = s0.imageOrientation;
  let normal = null;
  if (ori && ori.length === 6) {
    normal = cross(ori.slice(0, 3), ori.slice(3, 6));
    if (Math.abs(dot(normal, normal) - 1) > 1e-3) {
      normal = null; // degenerate orientation, fall back to z
    }
  }

  const withZ = slices.map((s) => {
    let z;
    if (normal && s.imagePosition && s.imagePosition.length === 3) {
      z = dot(s.imagePosition, normal);
    } else if (s.imagePosition && s.imagePosition.length === 3) {
      z = s.imagePosition[2];
    } else {
      z = s.instanceNumber ?? 0;
    }
    return { s, z };
  });
  withZ.sort((a, b) => a.z - b.z);

  const zs = withZ.map((w) => w.z);
  let zStep;
  if (zs.length > 1) {
    const deltas = [];
    for (let i = 1; i < zs.length; i++) deltas.push(zs[i] - zs[i - 1]);
    const positive = deltas.filter((d) => d > 1e-6);
    zStep = positive.length ? median(positive) : 0;
    if (!zStep || zStep <= 0) zStep = s0.sliceThickness || 1;
  } else {
    zStep = s0.sliceThickness || 1;
  }

  const px = s0.pixelSpacing && s0.pixelSpacing[0] ? s0.pixelSpacing[0] : 1;
  const py = s0.pixelSpacing && s0.pixelSpacing[1] ? s0.pixelSpacing[1] : 1;

  const nz = withZ.length;
  const z0 = zs[0];
  const voxelCount = cols * rows;
  const data = new Float32Array(voxelCount * nz);

  for (let k = 0; k < nz; k++) {
    const zt = z0 + k * zStep;
    const [i, t] = findBracket(zs, zt);
    const A = withZ[i].s.hu;
    const B = withZ[Math.min(i + 1, nz - 1)].s.hu;
    const dst = data.subarray(k * voxelCount, (k + 1) * voxelCount);
    const len = Math.min(voxelCount, A.length, B.length);
    if (t < 1e-6) {
      dst.set(A.subarray(0, len));
    } else if (t > 1 - 1e-6) {
      dst.set(B.subarray(0, len));
    } else {
      for (let j = 0; j < len; j++) {
        dst[j] = A[j] + (B[j] - A[j]) * t;
      }
    }
  }

  return {
    data,
    dims: [cols, rows, nz],
    spacing: [px, py, zStep],
    z0,
    sliceNormal: normal,
  };
}

function findBracket(zs, zt) {
  if (zs.length === 1) return [0, 0];
  if (zt <= zs[0]) return [0, 0];
  const last = zs.length - 1;
  if (zt >= zs[last]) return [last - 1, 1];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (zs[mid] <= zt) lo = mid;
    else hi = mid;
  }
  const span = zs[lo + 1] - zs[lo];
  const t = span === 0 ? 0 : (zt - zs[lo]) / span;
  return [lo, t];
}

/**
 * Integer-factor box-average downsampling so that the largest dimension does
 * not exceed maxDim. Returns a new volume (or the original if already small).
 */
export function downsample(vol, maxDim) {
  const [nx, ny, nz] = vol.dims;
  const m = Math.max(nx, ny, nz);
  if (m <= maxDim) return vol;
  const f = Math.ceil(m / maxDim);
  const ox = Math.max(1, Math.floor(nx / f));
  const oy = Math.max(1, Math.floor(ny / f));
  const oz = Math.max(1, Math.floor(nz / f));
  const out = new Float32Array(ox * oy * oz);

  for (let k = 0; k < oz; k++) {
    for (let j = 0; j < oy; j++) {
      for (let i = 0; i < ox; i++) {
        let sum = 0;
        let cnt = 0;
        for (let kk = 0; kk < f; kk++) {
          const z = k * f + kk;
          if (z >= nz) continue;
          for (let jj = 0; jj < f; jj++) {
            const y = j * f + jj;
            if (y >= ny) continue;
            for (let ii = 0; ii < f; ii++) {
              const x = i * f + ii;
              if (x >= nx) continue;
              sum += vol.data[(z * ny + y) * nx + x];
              cnt++;
            }
          }
        }
        out[(k * oy + j) * ox + i] = cnt ? sum / cnt : 0;
      }
    }
  }

  return {
    data: out,
    dims: [ox, oy, oz],
    spacing: [
      vol.spacing[0] * f,
      vol.spacing[1] * f,
      vol.spacing[2] * f,
    ],
    z0: vol.z0,
    sliceNormal: vol.sliceNormal,
  };
}
