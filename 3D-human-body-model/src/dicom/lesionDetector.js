/**
 * Lung-lesion detection (visualization heuristic).
 *
 * A lesion (pulmonary nodule / ground-glass opacity / consolidation) is a
 * soft-tissue-density region surrounded by aerated lung. Normal aerated lung is
 * air (very low HU); the body wall / mediastinum is soft tissue but is one
 * LARGE connected component that we exclude by size.
 *
 * Algorithm:
 *   1. Flood-fill "outside air" from the six volume boundary faces.
 *   2. "Lung air" = air voxels (HU < airThreshold) that are NOT outside air.
 *   3. Connected-component labeling over "lesion candidate" voxels
 *      (HU in [lesionMin, lesionMax]).
 *   4. A component is a lesion if it touches lung air AND its size is at most
 *      maxLesionVoxels (the huge body/mediastinum component is rejected).
 *
 * Pure logic, no external dependencies, unit-testable in Node.
 *
 * Note: this is a HU-based heuristic for visualization, not a diagnostic tool.
 */

export function detectLungLesions(vol, params = {}) {
  const { data, dims } = vol;
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const sxy = nx * ny;

  const airThreshold = params.airThreshold ?? -400;
  const lesionMin = params.lesionMin ?? -400;
  const lesionMax = params.lesionMax ?? 200;
  const maxLesionVoxels =
    params.maxLesionVoxels ?? Math.max(1000, Math.round(n * (params.maxLesionFraction ?? 0.01)));

  const isAir = (i) => data[i] < airThreshold;
  const isCandidate = (i) => data[i] >= lesionMin && data[i] <= lesionMax;

  // 1) Flood-fill "outside" air from the six boundary faces (6-connected).
  const outside = new Uint8Array(n);
  const stack = [];
  const pushOutside = (i) => {
    if (outside[i] === 0 && isAir(i)) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let z = 0; z < nz; z++) {
    const zoff = z * sxy;
    for (let y = 0; y < ny; y++) {
      const i = zoff + y * nx;
      pushOutside(i);
      pushOutside(i + nx - 1);
    }
  }
  for (let z = 0; z < nz; z++) {
    const zoff = z * sxy;
    for (let x = 0; x < nx; x++) {
      pushOutside(zoff + x);
      pushOutside(zoff + (ny - 1) * nx + x);
    }
  }
  for (let y = 0; y < ny; y++) {
    const yoff = y * nx;
    for (let x = 0; x < nx; x++) {
      pushOutside(yoff + x);
      pushOutside((nz - 1) * sxy + yoff + x);
    }
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % nx;
    const y = (((i - x) / nx) | 0) % ny;
    if (x > 0) pushOutside(i - 1);
    if (x < nx - 1) pushOutside(i + 1);
    if (y > 0) pushOutside(i - nx);
    if (y < ny - 1) pushOutside(i + nx);
    if (i >= sxy) pushOutside(i - sxy);
    if (i < n - sxy) pushOutside(i + sxy);
  }

  let lungAirCount = 0;
  for (let i = 0; i < n; i++) if (isAir(i) && outside[i] === 0) lungAirCount++;

  // 2) Connected-component labeling over candidate voxels.
  const lesion = new Uint8Array(n);
  const visited = new Uint8Array(n);
  const queue = [];

  for (let z = 0; z < nz; z++) {
    const zoff = z * sxy;
    for (let y = 0; y < ny; y++) {
      const yoff = zoff + y * nx;
      for (let x = 0; x < nx; x++) {
        const i = yoff + x;
        if (visited[i] === 1 || !isCandidate(i)) continue;

        visited[i] = 1;
        queue.length = 0;
        queue.push(i);
        let head = 0;
        let size = 0;
        let touchesLungAir = false;
        let comp = [];

        while (head < queue.length) {
          const c = queue[head++];
          size++;
          if (comp) {
            if (comp.length < maxLesionVoxels) comp.push(c);
            else comp = null; // too large; stop storing
          }

          const cx = c % nx;
          const cy = (((c - cx) / nx) | 0) % ny;
          const nx0 = cx > 0 ? c - 1 : -1;
          const nx1 = cx < nx - 1 ? c + 1 : -1;
          const ny0 = cy > 0 ? c - nx : -1;
          const ny1 = cy < ny - 1 ? c + nx : -1;
          const nz0 = c >= sxy ? c - sxy : -1;
          const nz1 = c < n - sxy ? c + sxy : -1;

          const check = (j) => {
            if (j < 0) return;
            if (isAir(j)) {
              if (outside[j] === 0) touchesLungAir = true;
            } else if (visited[j] === 0 && isCandidate(j)) {
              visited[j] = 1;
              queue.push(j);
            }
          };
          check(nx0); check(nx1); check(ny0); check(ny1); check(nz0); check(nz1);
        }

        if (comp && touchesLungAir && size > 0) {
          for (let k = 0; k < comp.length; k++) lesion[comp[k]] = 1;
        }
      }
    }
  }

  let lesionCount = 0;
  for (let i = 0; i < n; i++) if (lesion[i]) lesionCount++;

  return { mask: lesion, lungAirCount, lesionCount };
}
