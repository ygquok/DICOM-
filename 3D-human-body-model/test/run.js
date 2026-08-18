/**
 * Plain in-process test runner (avoids Node's child-process test isolation,
 * which is unavailable under the DSH file sandbox). Run with: node test/run.js
 */
import assert from 'node:assert/strict';

import { buildVolume, downsample } from '../src/dicom/volumeBuilder.js';
import {
  buildLUT,
  buildLUTFromParams,
  defaultTransferFunctionParams,
  hexToRGB,
  rgbToHex,
  HU_MIN,
  HU_MAX,
} from '../src/render/transferFunction.js';
import { generatePhantom } from '../src/dicom/phantom.js';
import { decodePixelData } from '../src/dicom/dicomLoader.js';
import { detectLungLesions } from '../src/dicom/lesionDetector.js';
import { renderSliceRGBA, sampleTrilinear, computeViewTargets } from '../src/render/sliceViews.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, e });
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
}

console.log('logic tests');

check('buildLUT maps endpoints across the HU window', () => {
  const lut = buildLUT([[0, 0, 0, 0, 0], [100, 1, 0, 0, 1]], 101);
  assert.equal(lut.length, 101 * 4);
  assert.equal(lut[3], 0);
  assert.equal(lut[100 * 4 + 3], 255);
});

check('buildLUTFromParams renders bone and organ with different colors', () => {
  const p = defaultTransferFunctionParams();
  const lut = buildLUTFromParams(p, 512);
  const idx = (hu) => Math.round(((hu - HU_MIN) / (HU_MAX - HU_MIN)) * (512 - 1));

  const oi = idx(40);
  assert.ok(lut[oi * 4 + 3] > 0, 'organ alpha should be positive');
  assert.ok(lut[oi * 4] > lut[oi * 4 + 2], 'organ should be reddish (r > b)');

  const bi = idx(800);
  assert.ok(lut[bi * 4 + 3] > 200, 'bone alpha should be high');
  assert.ok(lut[bi * 4] > 200 && lut[bi * 4 + 1] > 200, 'bone should be bright');

  const ai = idx(-1000);
  assert.equal(lut[ai * 4 + 3], 0);
});

check('hexToRGB / rgbToHex round-trip', () => {
  assert.deepEqual(hexToRGB('#ff0000'), [1, 0, 0]);
  assert.deepEqual(hexToRGB('#00ff00'), [0, 1, 0]);
  assert.equal(rgbToHex([1, 0, 0]), '#ff0000');
  assert.equal(rgbToHex([0.5, 0.5, 0.5]), '#808080');
});

check('buildVolume sorts slices and interpolates irregular spacing', () => {
  const mk = (hu, z) => ({
    rows: 1,
    cols: 1,
    hu: new Float32Array([hu]),
    pixelSpacing: [1, 1],
    sliceThickness: 10,
    imagePosition: [0, 0, z],
    imageOrientation: undefined,
    instanceNumber: undefined,
  });
  const slices = [mk(25, 10), mk(40, 25), mk(10, 0)];
  const vol = buildVolume(slices);

  assert.deepEqual(vol.dims, [1, 1, 3]);
  assert.equal(vol.spacing[2], 12.5);
  assert.equal(vol.data[0], 10);
  assert.ok(Math.abs(vol.data[1] - 27.5) < 1e-4, `got ${vol.data[1]}`);
  assert.equal(vol.data[2], 40);
});

check('buildVolume uses slice normal for sorting when orientation present', () => {
  const mk = (hu, pos, ori) => ({
    rows: 1,
    cols: 1,
    hu: new Float32Array([hu]),
    pixelSpacing: [1, 1],
    sliceThickness: 1,
    imagePosition: pos,
    imageOrientation: ori,
    instanceNumber: undefined,
  });
  // Orientation: row = +x, col = +y -> normal = +z. Positions along z.
  const ori = [1, 0, 0, 0, 1, 0];
  const slices = [mk(30, [0, 0, 3], ori), mk(10, [0, 0, 1], ori), mk(20, [0, 0, 2], ori)];
  const vol = buildVolume(slices);
  assert.deepEqual([vol.data[0], vol.data[1], vol.data[2]], [10, 20, 30]);
});

check('downsample box-averages and halves dimensions', () => {
  const vol = {
    data: new Float32Array(4 * 4 * 4).fill(8),
    dims: [4, 4, 4],
    spacing: [1, 2, 3],
  };
  const out = downsample(vol, 2);
  assert.deepEqual(out.dims, [2, 2, 2]);
  assert.deepEqual(out.spacing, [2, 4, 6]);
  for (const v of out.data) assert.equal(v, 8);
});

check('downsample leaves already-small volumes unchanged', () => {
  const vol = {
    data: new Float32Array([1, 2, 3]),
    dims: [3, 1, 1],
    spacing: [1, 1, 1],
  };
  assert.equal(downsample(vol, 256), vol);
});

check('phantom contains bone, organ and air classes', () => {
  const vol = generatePhantom([80, 80, 80]);
  assert.deepEqual(vol.dims, [80, 80, 80]);
  assert.equal(vol.data.length, 80 * 80 * 80);

  let bone = 0;
  let organ = 0;
  let air = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < vol.data.length; i++) {
    const v = vol.data[i];
    if (v >= 400) bone++;
    else if (v >= 20 && v <= 70) organ++;
    else if (v <= -500) air++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  assert.ok(bone > 0, 'should contain bone voxels');
  assert.ok(organ > 0, 'should contain organ/soft-tissue voxels');
  assert.ok(air > 0, 'should contain air/lung voxels');
  assert.equal(min, -1000);
  assert.ok(max <= 950 && max >= 700, `max HU should be bone-like, got ${max}`);
});

check('decodePixelData handles odd byte offset (16-bit, little-endian)', () => {
  // Pixel data placed at an ODD offset inside the byteArray; the old
  // Uint16Array(buffer, offset) code would throw a "start offset ... multiple
  // of 2" RangeError. DataView must handle it regardless of alignment.
  const meta = {
    rows: 2,
    cols: 2,
    bitsAllocated: 16,
    bitsStored: 16,
    highBit: 15,
    pixelRepresentation: 1,
    rescaleSlope: 1,
    rescaleIntercept: -1000,
    numberOfFrames: 1,
    transferSyntaxUID: '1.2.840.10008.1.2',
  };
  const values = [1000, 200, 300, 400];
  const buf = new Uint8Array(1 + values.length * 2);
  buf[0] = 0xaa; // padding so the data starts at offset 1 (odd)
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    buf[1 + i * 2] = v & 0xff;
    buf[1 + i * 2 + 1] = (v >> 8) & 0xff;
  }
  const fakeDs = {
    byteArray: buf,
    elements: { x7fe00010: { dataOffset: 1, length: values.length * 2 } },
  };
  const frames = decodePixelData(fakeDs, meta);
  assert.equal(frames.length, 1);
  assert.deepEqual(Array.from(frames[0]), [0, -800, -700, -600]);
});

check('decodePixelData handles unsigned 8-bit data', () => {
  const meta = {
    rows: 2,
    cols: 2,
    bitsAllocated: 8,
    bitsStored: 8,
    highBit: 7,
    pixelRepresentation: 0,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    numberOfFrames: 1,
    transferSyntaxUID: '1.2.840.10008.1.2',
  };
  const fakeDs = {
    byteArray: new Uint8Array([10, 20, 30, 40]),
    elements: { x7fe00010: { dataOffset: 0, length: 4 } },
  };
  const frames = decodePixelData(fakeDs, meta);
  assert.deepEqual(Array.from(frames[0]), [10, 20, 30, 40]);
});

check('decodePixelData clamps frame count to available data (no over-read)', () => {
  // Declares 3 frames but only 1 frame of bytes is present. The old code would
  // throw "Start offset ... is outside the bounds of the buffer".
  const meta = {
    rows: 2,
    cols: 2,
    bitsAllocated: 16,
    bitsStored: 16,
    highBit: 15,
    pixelRepresentation: 0,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    numberOfFrames: 3,
    transferSyntaxUID: '1.2.840.10008.1.2',
  };
  const buf = new Uint8Array([10, 0, 20, 0, 30, 0, 40, 0]); // [10,20,30,40] LE uint16
  const fakeDs = {
    byteArray: buf,
    elements: { x7fe00010: { dataOffset: 0, length: 8 } },
  };
  const frames = decodePixelData(fakeDs, meta);
  assert.equal(frames.length, 1, 'should decode only the one available frame');
  assert.deepEqual(Array.from(frames[0]), [10, 20, 30, 40]);
});

check('decodePixelData rejects compressed transfer syntax', () => {
  const meta = {
    rows: 2,
    cols: 2,
    bitsAllocated: 16,
    bitsStored: 16,
    highBit: 15,
    pixelRepresentation: 0,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    numberOfFrames: 1,
    transferSyntaxUID: '1.2.840.10008.1.2.4.70', // JPEG Lossless
  };
  const fakeDs = {
    byteArray: new Uint8Array(8),
    elements: { x7fe00010: { dataOffset: 0, length: 8 } },
  };
  assert.deepEqual(decodePixelData(fakeDs, meta), []);
});

check('detectLungLesions flags a nodule in lung but not the body wall', () => {
  const N = 10;
  const data = new Float32Array(N * N * N).fill(-1000);
  const idx = (x, y, z) => (z * N + y) * N + x;
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (x >= 3 && x <= 6 && y >= 3 && y <= 6 && z >= 3 && z <= 6) {
          data[idx(x, y, z)] = -800; // lung air (interior cavity)
        } else if (x >= 2 && x <= 7 && y >= 2 && y <= 7 && z >= 2 && z <= 7) {
          data[idx(x, y, z)] = 40; // body soft tissue
        }
      }
    }
  }
  data[idx(4, 4, 4)] = 60; // solid nodule inside the lung

  const { mask, lesionCount } = detectLungLesions(
    { data, dims: [N, N, N] },
    { airThreshold: -400, lesionMin: -400, lesionMax: 200, maxLesionVoxels: 50 },
  );
  assert.equal(mask[idx(4, 4, 4)], 1, 'nodule should be flagged as lesion');
  assert.ok(lesionCount >= 1);
  assert.equal(mask[idx(2, 4, 4)], 0, 'flat chest wall should NOT be flagged');
  assert.equal(mask[idx(2, 2, 2)], 0, 'body interior should NOT be flagged');
});

check('phantom contains detectable lung lesions and lung air', () => {
  const vol = generatePhantom([80, 80, 80]);
  const { lesionCount, lungAirCount } = detectLungLesions(vol, {
    airThreshold: -400,
    lesionMin: -400,
    lesionMax: 200,
  });
  assert.ok(lesionCount > 50, `expected lung lesions in phantom, got ${lesionCount}`);
  assert.ok(lungAirCount > 0, 'expected lung air in phantom');
});

check('renderSliceRGBA extracts correct orthogonal slices', () => {
  const [nx, ny, nz] = [2, 3, 4];
  const data = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        data[(z * ny + y) * nx + x] = 100 * x + 10 * y + z;
      }
    }
  }
  const vol = { data, dims: [nx, ny, nz] };
  const opts = { ww: 10000, wl: 0, boneThreshold: 999999 };
  const gray = (hu) => Math.round(((hu + 5000) / 10000) * 255);

  const ax = renderSliceRGBA(vol, 'z', 2, opts);
  assert.equal(ax.w, 2);
  assert.equal(ax.h, 3);
  assert.equal(ax.data[(2 * 2 + 1) * 4], gray(100 * 1 + 10 * 2 + 2)); // R 通道
  assert.equal(ax.data[(2 * 2 + 1) * 4 + 3], 255);

  const co = renderSliceRGBA(vol, 'y', 1, opts);
  assert.equal(co.w, 2);
  assert.equal(co.h, 4);
  assert.equal(co.data[(2 * 2 + 1) * 4], gray(100 * 1 + 10 * 1 + 2));

  const sa = renderSliceRGBA(vol, 'x', 0, opts);
  assert.equal(sa.w, 3);
  assert.equal(sa.h, 4);
  assert.equal(sa.data[(2 * 3 + 1) * 4], gray(100 * 0 + 10 * 1 + 2));
});

check('renderSliceRGBA overlays lesion (blue) and bone (ivory)', () => {
  const data = new Float32Array([10, 500, 20, 30]);
  const mask = new Uint8Array([0, 0, 1, 0]);
  const vol = { data, dims: [2, 2, 1] };
  const out = renderSliceRGBA(vol, 'z', 0, {
    ww: 4000,
    wl: 0,
    boneThreshold: 300,
    lesionMask: mask,
    lesionColor: [0, 0, 1], // 蓝
    boneColor: [1, 1, 0], // 黄（便于断言）
  });

  // 像素顺序：(0,0)=10 灰度, (1,0)=500 骨骼, (0,1)=20 病变, (1,1)=30 灰度
  assert.deepEqual(Array.from(out.data.slice(0, 4)), [128, 128, 128, 255]); // 灰度 10
  assert.deepEqual(Array.from(out.data.slice(4, 8)), [255, 255, 0, 255]); // 骨骼
  assert.deepEqual(Array.from(out.data.slice(8, 12)), [0, 0, 255, 255]); // 病变蓝
  assert.deepEqual(Array.from(out.data.slice(12, 16)), [129, 129, 129, 255]); // 灰度 30
});

check('sampleTrilinear interpolates correctly', () => {
  const [nx, ny, nz] = [2, 2, 2];
  const data = new Float32Array(8);
  for (let z = 0; z < 2; z++) {
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        data[(z * ny + y) * nx + x] = x + 2 * y + 4 * z;
      }
    }
  }
  assert.equal(sampleTrilinear(data, [nx, ny, nz], 0.5, 0.5, 0.5), 3.5);
  assert.equal(sampleTrilinear(data, [nx, ny, nz], 0, 0, 0), 0);
  assert.equal(sampleTrilinear(data, [nx, ny, nz], 1, 1, 1), 7);
});

check('computeViewTargets preserves physical aspect ratio', () => {
  // 各向异性：面内 256×256、间距 1mm；层厚 5mm、64 层 → 冠状/矢状应更“高”。
  const aniso = computeViewTargets([256, 256, 64], [1, 1, 5]);
  assert.deepEqual(aniso.target.z, { w: 512, h: 512 }); // 轴位 256×256mm
  assert.equal(aniso.target.y.w, 512); // 冠状宽 = x 方向
  assert.equal(aniso.target.y.h, 640); // 冠状高 = z 方向（64×5=320mm → 640px）
  assert.deepEqual(aniso.target.x, { w: 512, h: 640 }); // 矢状同冠状
  assert.ok(aniso.target.y.h > aniso.target.y.w, 'coronal should be taller than wide');

  // 各向同性：224³ 间距 1mm → 三个视图都应是正方形。
  const iso = computeViewTargets([224, 224, 224], [1, 1, 1]);
  assert.deepEqual(iso.target.z, { w: 512, h: 512 });
  assert.deepEqual(iso.target.y, { w: 512, h: 512 });
  assert.deepEqual(iso.target.x, { w: 512, h: 512 });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.error('FAILURES:');
  for (const f of failures) console.error(`  - ${f.name}: ${f.e.message}`);
  process.exit(1);
}
