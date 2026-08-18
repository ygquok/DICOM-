/**
 * Synthetic human-body phantom: generates a HU volume so the tool can be
 * demonstrated without real DICOM data. Shapes approximate a skull, spine,
 * ribcage, pelvis, femurs (bone) and heart/liver/kidneys/spleen/stomach/lungs
 * (organs + air) inside a soft-tissue body.
 *
 * Pure logic, no external dependencies, unit-testable in Node.
 *
 * Coordinates are normalized [0,1]^3: x = left-right, y = anterior-posterior,
 * z = inferior-superior (z=0 feet, z=1 head).
 */

function insideEllipsoid(x, y, z, cx, cy, cz, rx, ry, rz) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  const dz = (z - cz) / rz;
  return dx * dx + dy * dy + dz * dz <= 1;
}

function ringDistance(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return Math.abs(Math.sqrt(dx * dx + dy * dy) - 1);
}

/**
 * Sample the phantom at a normalized point, highest-priority shape wins.
 * Bone structures are drawn on top of soft tissue / organs.
 */
function samplePhantom(x, y, z) {
  // Femurs (cylinders along z)
  for (const cx of [0.42, 0.58]) {
    if (z >= 0.04 && z <= 0.34) {
      const d = (x - cx) * (x - cx) + (y - 0.5) * (y - 0.5);
      if (d <= 0.035 * 0.035) return 820;
    }
  }
  // Pelvis (two ilium ellipsoids + sacrum)
  if (insideEllipsoid(x, y, z, 0.42, 0.5, 0.12, 0.07, 0.06, 0.05)) return 800;
  if (insideEllipsoid(x, y, z, 0.58, 0.5, 0.12, 0.07, 0.06, 0.05)) return 800;
  if (insideEllipsoid(x, y, z, 0.5, 0.28, 0.14, 0.05, 0.05, 0.045)) return 800;
  // Skull shell (bone), brain stays soft tissue
  const skullOuter = insideEllipsoid(x, y, z, 0.5, 0.5, 0.86, 0.155, 0.15, 0.115);
  const skullInner = insideEllipsoid(x, y, z, 0.5, 0.5, 0.87, 0.12, 0.115, 0.085);
  if (skullOuter && !skullInner) return 950;
  // Spine (stacked vertebrae, posterior)
  const vz = Math.round((z - 0.1) / 0.035) * 0.035 + 0.1;
  if (z >= 0.08 && z <= 0.82) {
    const dz = (z - vz) / 0.03;
    if (dz * dz <= 1) {
      const dx = (x - 0.5) / 0.055;
      const dy = (y - 0.28) / 0.05;
      if (dx * dx + dy * dy <= 1) return 850;
    }
  }
  // Ribs (elliptical rings around the chest)
  const ribLevels = [0.48, 0.53, 0.58, 0.63, 0.68, 0.73];
  for (const rz of ribLevels) {
    const dz = (z - rz) / 0.012;
    if (dz * dz <= 1 && ringDistance(x, y, 0.5, 0.44, 0.19, 0.15) < 0.05) {
      return 720;
    }
  }
  // Organs
  if (insideEllipsoid(x, y, z, 0.6, 0.5, 0.48, 0.085, 0.075, 0.1)) return 62; // 肝脏
  if (insideEllipsoid(x, y, z, 0.43, 0.5, 0.4, 0.06, 0.07, 0.06)) return 30; // 胃
  if (insideEllipsoid(x, y, z, 0.4, 0.46, 0.45, 0.05, 0.05, 0.06)) return 50; // 脾
  if (insideEllipsoid(x, y, z, 0.44, 0.3, 0.36, 0.045, 0.05, 0.04)) return 45; // 左肾
  if (insideEllipsoid(x, y, z, 0.56, 0.3, 0.36, 0.045, 0.05, 0.04)) return 45; // 右肾
  if (insideEllipsoid(x, y, z, 0.5, 0.46, 0.6, 0.055, 0.06, 0.07)) return 55; // 心脏
  // Lungs (air)
  if (insideEllipsoid(x, y, z, 0.42, 0.46, 0.62, 0.11, 0.12, 0.14)) return -800;
  if (insideEllipsoid(x, y, z, 0.58, 0.46, 0.62, 0.11, 0.12, 0.14)) return -800;
  // 肺部病变（演示：实性结节 / 磨玻璃影 / 实变），位于肺野内、被空气包围
  if (insideEllipsoid(x, y, z, 0.60, 0.46, 0.60, 0.03, 0.03, 0.03)) return 60; // 实性结节
  if (insideEllipsoid(x, y, z, 0.40, 0.46, 0.66, 0.045, 0.04, 0.035)) return -350; // 磨玻璃影
  if (insideEllipsoid(x, y, z, 0.58, 0.44, 0.54, 0.035, 0.035, 0.03)) return 40; // 实变
  // Body (soft tissue / muscle)
  if (insideEllipsoid(x, y, z, 0.5, 0.5, 0.5, 0.3, 0.26, 0.46)) return 35;
  return -1000; // 空气
}

/**
 * Generate the phantom volume.
 * dims: [nx, ny, nz] (default 224^3). Returns a volume in the same shape as
 * buildVolume: { data, dims, spacing }.
 */
export function generatePhantom(dims = [224, 224, 224]) {
  const [nx, ny, nz] = dims;
  const data = new Float32Array(nx * ny * nz);
  let i = 0;
  for (let k = 0; k < nz; k++) {
    const z = (k + 0.5) / nz;
    for (let j = 0; j < ny; j++) {
      const y = (j + 0.5) / ny;
      for (let ix = 0; ix < nx; ix++) {
        const x = (ix + 0.5) / nx;
        data[i++] = samplePhantom(x, y, z);
      }
    }
  }
  return {
    data,
    dims: [nx, ny, nz],
    spacing: [1, 1, 1],
    label: '演示人体模型（合成数据）',
  };
}
