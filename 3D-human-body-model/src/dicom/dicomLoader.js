/**
 * DICOM series loading: parse individual DICOM files and return slice
 * descriptors for volume construction.
 *
 * dicom-parser is loaded as a UMD global (see index.html) so this module has
 * no build-time dependency.
 */
const dicomParser = globalThis.dicomParser;

function parseFloats(str) {
  if (str == null) return undefined;
  return str
    .split('\\')
    .map((s) => parseFloat(s))
    .filter((v) => !Number.isNaN(v));
}

function readMeta(ds) {
  const rows = ds.uint16('x00280010');
  const cols = ds.uint16('x00280011');
  if (!rows || !cols) return null;

  return {
    rows,
    cols,
    bitsAllocated: ds.uint16('x00280100'),
    bitsStored: ds.uint16('x00280101'),
    highBit: ds.uint16('x00280102'),
    pixelRepresentation: ds.uint16('x00280103'),
    rescaleSlope: ds.floatString('x00281053') ?? 1,
    rescaleIntercept: ds.floatString('x00281052') ?? 0,
    numberOfFrames: ds.uint16('x00280008') ?? 1,
    pixelSpacing: parseFloats(ds.string('x00280030')),
    sliceThickness: ds.floatString('x00180050'),
    imagePosition: parseFloats(ds.string('x00200032')),
    imageOrientation: parseFloats(ds.string('x00200037')),
    seriesUID: ds.string('x0020000e') || '',
    studyUID: ds.string('x0020000d') || '',
    instanceNumber: ds.intString('x00200013'),
    modality: ds.string('x00080060') || 'CT',
    transferSyntaxUID: ds.string('x00020010') || '',
    windowCenter: ds.floatString('x00281050'),
    windowWidth: ds.floatString('x00281051'),
  };
}

/** Uncompressed transfer syntax UIDs we can decode directly. */
export const UNCOMPRESSED_TRANSFER_SYNTAXES = new Set([
  '1.2.840.10008.1.2', // Implicit VR Little Endian
  '1.2.840.10008.1.2.1', // Explicit VR Little Endian
  '1.2.840.10008.1.2.2', // Explicit VR Big Endian
  '1.2.840.10008.1.2.1.99', // Deflated Explicit VR Little Endian
]);

export function isCompressedTransferSyntax(ts) {
  const t = ts || '';
  return t !== '' && !UNCOMPRESSED_TRANSFER_SYNTAXES.has(t);
}

/** Decode pixel data into one or more HU Float32Array frames. */
export function decodePixelData(ds, meta) {
  const el = ds.elements.x7fe00010;
  if (!el) return [];
  const bytes = ds.byteArray;
  const ba = bytes.slice(el.dataOffset, el.dataOffset + el.length);

  const { bitsAllocated, bitsStored, highBit, pixelRepresentation } = meta;
  const rescaleSlope = meta.rescaleSlope;
  const rescaleIntercept = meta.rescaleIntercept;
  const count = meta.rows * meta.cols;

  if (bitsAllocated !== 8 && bitsAllocated !== 16) return [];
  if (!count || count <= 0) return [];

  const ts = meta.transferSyntaxUID || '1.2.840.10008.1.2';
  if (isCompressedTransferSyntax(ts)) return [];

  const isBigEndian = ts === '1.2.840.10008.1.2.2';
  const shift = bitsStored ? highBit - bitsStored + 1 : 0;
  if (shift < 0) return [];

  const bytesPerSample = bitsAllocated / 8; // 1 or 2
  const frameBytes = count * bytesPerSample;
  if (frameBytes <= 0) return [];

  // Derive how many complete frames actually fit in the raw bytes, then clamp
  // the declared frame count so we never read past the end of the buffer
  // (handles truncated data and wrong/missing NumberOfFrames values).
  const framesByData = Math.floor(ba.length / frameBytes);
  let frames = meta.numberOfFrames > 0 ? meta.numberOfFrames : 1;
  if (framesByData > 0 && framesByData < frames) frames = framesByData;
  if (frames < 1) frames = framesByData > 0 ? framesByData : 1;

  const result = [];
  for (let f = 0; f < frames; f++) {
    const start = f * frameBytes;
    if (start >= ba.length) break;
    const end = Math.min(start + frameBytes, ba.length);
    const view = new DataView(ba.buffer, ba.byteOffset + start, end - start);
    const readable = Math.floor(view.byteLength / bytesPerSample);
    const hu = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let v = 0;
      if (i < readable) {
        if (bitsAllocated === 16) {
          v = pixelRepresentation === 1
            ? view.getInt16(i * 2, !isBigEndian)
            : view.getUint16(i * 2, !isBigEndian);
        } else {
          v = pixelRepresentation === 1 ? view.getInt8(i) : view.getUint8(i);
        }
        if (shift > 0) v = v >> shift;
      }
      hu[i] = v * rescaleSlope + rescaleIntercept;
    }
    result.push(hu);
  }
  return result;
}

/**
 * Parse an ArrayBuffer of one DICOM file into an array of slices
 * (one per frame). Returns [] for non-image or unsupported files.
 */
export function parseDicomFile(arrayBuffer) {
  let ds;
  try {
    ds = dicomParser.parseDicom(new Uint8Array(arrayBuffer));
  } catch (e) {
    return { error: '无法解析 DICOM 文件: ' + e.message, slices: [] };
  }
  const meta = readMeta(ds);
  if (!meta) return { slices: [] };
  if (isCompressedTransferSyntax(meta.transferSyntaxUID)) {
    return {
      slices: [],
      warning: `不支持的压缩传输语法 (${meta.transferSyntaxUID})，已跳过该文件`,
    };
  }
  let frames;
  try {
    frames = decodePixelData(ds, meta);
  } catch (e) {
    return { slices: [], warning: '像素解码失败: ' + e.message };
  }
  if (!frames.length) return { slices: [] };

  const slices = frames.map((hu, frameIndex) => ({
    rows: meta.rows,
    cols: meta.cols,
    hu,
    pixelSpacing: meta.pixelSpacing,
    sliceThickness: meta.sliceThickness,
    imagePosition: meta.imagePosition,
    imageOrientation: meta.imageOrientation,
    seriesUID: meta.seriesUID,
    instanceNumber: meta.instanceNumber != null ? meta.instanceNumber + frameIndex : frameIndex,
    modality: meta.modality,
    windowCenter: meta.windowCenter,
    windowWidth: meta.windowWidth,
    frameIndex,
  }));
  return { slices, seriesUID: meta.seriesUID, modality: meta.modality };
}

/**
 * Parse an array of File/ArrayBuffer objects, group slices by series, and
 * return the series with the most slices (plus metadata).
 */
export async function loadSeriesFromFiles(entries, onProgress) {
  const seriesMap = new Map();
  let total = entries.length;
  let done = 0;
  const warnings = [];

  for (const entry of entries) {
    let buf;
    try {
      buf = entry instanceof ArrayBuffer ? entry : await entry.arrayBuffer();
    } catch (e) {
      warnings.push('读取文件失败: ' + e.message);
      done++;
      continue;
    }
    const { slices, seriesUID, modality, warning } = parseDicomFile(buf);
    if (warning) warnings.push(warning);
    if (slices && slices.length) {
      const key = seriesUID || 'default';
      if (!seriesMap.has(key)) seriesMap.set(key, { key, modality, slices: [] });
      const g = seriesMap.get(key);
      g.modality = modality || g.modality;
      for (const s of slices) g.slices.push(s);
    }
    done++;
    if (onProgress) onProgress(done, total);
  }

  let best = null;
  for (const g of seriesMap.values()) {
    if (!best || g.slices.length > best.slices.length) best = g;
  }
  if (!best || best.slices.length === 0) {
    throw new Error('未找到可用的影像切片（请确认是 CT/MR DICOM 序列）');
  }
  return {
    slices: best.slices,
    seriesCount: seriesMap.size,
    modality: best.modality,
    warnings,
  };
}
