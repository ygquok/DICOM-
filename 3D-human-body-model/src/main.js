/**
 * Application entry point: UI wiring, DICOM loading pipeline, and
 * transfer-function controls.
 *
 * jszip is loaded as a UMD global (see index.html).
 */
const JSZip = globalThis.JSZip;
import { VolumeRenderer } from './render/volumeRenderer.js';
import {
  buildLUTFromParams,
  defaultTransferFunctionParams,
  hexToRGB,
  computeHuRange,
} from './render/transferFunction.js';
import { buildVolume, downsample } from './dicom/volumeBuilder.js';
import { loadSeriesFromFiles } from './dicom/dicomLoader.js';
import { generatePhantom } from './dicom/phantom.js';
import { detectLungLesions } from './dicom/lesionDetector.js';
import { SliceViews } from './render/sliceViews.js';

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  dropzone: $('dropzone'),
  fileInput: $('fileInput'),
  folderInput: $('folderInput'),
  btnPickFiles: $('btnPickFiles'),
  btnPickFolder: $('btnPickFolder'),
  btnDemo: $('btnDemo'),
  resSelect: $('resSelect'),
  boneThreshold: $('boneThreshold'),
  boneThresholdVal: $('boneThresholdVal'),
  organColor: $('organColor'),
  boneColor: $('boneColor'),
  organOpacity: $('organOpacity'),
  organOpacityVal: $('organOpacityVal'),
  boneOpacity: $('boneOpacity'),
  boneOpacityVal: $('boneOpacityVal'),
  alphaScale: $('alphaScale'),
  alphaScaleVal: $('alphaScaleVal'),
  shading: $('shading'),
  lesionEnabled: $('lesionEnabled'),
  lesionColor: $('lesionColor'),
  lesionOpacity: $('lesionOpacity'),
  lesionOpacityVal: $('lesionOpacityVal'),
  lesionMin: $('lesionMin'),
  lesionMinVal: $('lesionMinVal'),
  lesionMax: $('lesionMax'),
  lesionMaxVal: $('lesionMaxVal'),
  wwSlider: $('wwSlider'),
  wwVal: $('wwVal'),
  wlSlider: $('wlSlider'),
  wlVal: $('wlVal'),
  sliceZ: $('sliceZ'),
  sliceZSlider: $('sliceZSlider'),
  sliceZVal: $('sliceZVal'),
  sliceY: $('sliceY'),
  sliceYSlider: $('sliceYSlider'),
  sliceYVal: $('sliceYVal'),
  sliceX: $('sliceX'),
  sliceXSlider: $('sliceXSlider'),
  sliceXVal: $('sliceXVal'),
  sliceOblique: $('sliceOblique'),
  obliqueTheta: $('obliqueTheta'),
  obliqueThetaVal: $('obliqueThetaVal'),
  obliquePhi: $('obliquePhi'),
  obliquePhiVal: $('obliquePhiVal'),
  obliqueEnabled: $('obliqueEnabled'),
  obliqueBar: $('obliqueBar'),
  grid: $('grid'),
  btnReset: $('btnReset'),
  btnScreenshot: $('btnScreenshot'),
  info: $('info'),
  canvasWrap: $('canvasWrap'),
  gl: $('gl'),
  overlay: $('overlay'),
  overlayText: $('overlayText'),
};

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

let renderer = null;
let sliceViews = null;
let currentRaw = null; // undownsampled volume, for resolution changes
let currentDownsampled = null; // rendered (downsampled) volume, for lesion re-detection
let currentLabel = '当前模型';
let lastLesionCount = 0;
let currentLesionMask = null;
const params = defaultTransferFunctionParams();
const lesionParams = {
  enabled: true,
  color: [0.13, 0.59, 0.95], // 蓝色
  opacity: 1.0,
  min: -400,
  max: 200,
};

function setStatus(text, cls = '') {
  els.status.textContent = text;
  els.status.className = 'status ' + cls;
}

function showOverlay(show, text = '') {
  els.overlayText.textContent = text;
  els.overlay.classList.toggle('hidden', !show);
}

function initRenderer() {
  renderer = new VolumeRenderer(els.gl, {
    onError: (e) => setStatus('渲染错误：' + e.message, 'error'),
  });
  sliceViews = new SliceViews(
    {
      z: { canvas: els.sliceZ, slider: els.sliceZSlider, value: els.sliceZVal },
      y: { canvas: els.sliceY, slider: els.sliceYSlider, value: els.sliceYVal },
      x: { canvas: els.sliceX, slider: els.sliceXSlider, value: els.sliceXVal },
    },
    {
      ww: Number(els.wwSlider.value),
      wl: Number(els.wlSlider.value),
      oblique: {
        canvas: els.sliceOblique,
        thetaSlider: els.obliqueTheta,
        phiSlider: els.obliquePhi,
        thetaVal: els.obliqueThetaVal,
        phiVal: els.obliquePhiVal,
      },
      onChange: ({ x, y, z, oblique }) => {
        if (!renderer) return;
        renderer.setSliceIndicators(x, y, z);
        if (oblique) {
          renderer.setObliqueIndicator(
            els.obliqueEnabled.checked,
            oblique.theta,
            oblique.phi,
          );
        }
      },
    },
  );
  refreshLUT();
  onResize();
  window.addEventListener('resize', onResize);
  if (window.ResizeObserver) {
    new ResizeObserver(() => onResize()).observe(els.canvasWrap);
    // 切片网格尺寸变化时，按新尺寸重采样切片（防抖）。
    new ResizeObserver(() => scheduleSliceRefresh()).observe(els.grid);
  }
}

let sliceRefreshTimer = null;
function scheduleSliceRefresh() {
  if (sliceRefreshTimer) return;
  sliceRefreshTimer = setTimeout(() => {
    sliceRefreshTimer = null;
    if (sliceViews) sliceViews.refreshSizes();
  }, 150);
}

function onResize() {
  if (!renderer) return;
  renderer.resize(els.canvasWrap.clientWidth, els.canvasWrap.clientHeight);
}

function refreshLUT() {
  if (!renderer) return;
  params.organColor = hexToRGB(els.organColor.value);
  params.boneColor = hexToRGB(els.boneColor.value);
  params.boneThreshold = Number(els.boneThreshold.value);
  params.organOpacity = Number(els.organOpacity.value);
  params.boneOpacity = Number(els.boneOpacity.value);
  params.alphaScale = Number(els.alphaScale.value);
  params.shading = els.shading.checked;

  els.boneThresholdVal.textContent = params.boneThreshold;
  els.organOpacityVal.textContent = params.organOpacity.toFixed(2);
  els.boneOpacityVal.textContent = params.boneOpacity.toFixed(2);
  els.alphaScaleVal.textContent = params.alphaScale.toFixed(2);

  const lut = buildLUTFromParams(params, 512);
  renderer.setLUT(lut, 512);
  renderer.setUniforms({ shading: params.shading, alphaScale: params.alphaScale });
  syncSliceOverlay();
}

/** 将病变蒙版 / 骨骼阈值 / 颜色同步到截面视图。 */
function syncSliceOverlay() {
  if (!sliceViews) return;
  sliceViews.setOverlay({
    lesionMask: lesionParams.enabled ? currentLesionMask : null,
    boneThreshold: params.boneThreshold,
    lesionColor: lesionParams.color,
    boneColor: params.boneColor,
  });
}

function collectLesionParams() {
  lesionParams.enabled = els.lesionEnabled.checked;
  lesionParams.color = hexToRGB(els.lesionColor.value);
  lesionParams.opacity = Number(els.lesionOpacity.value);
  lesionParams.min = Number(els.lesionMin.value);
  lesionParams.max = Number(els.lesionMax.value);
  els.lesionOpacityVal.textContent = lesionParams.opacity.toFixed(2);
  els.lesionMinVal.textContent = lesionParams.min;
  els.lesionMaxVal.textContent = lesionParams.max;
}

function computeLesionMask(vol) {
  if (!lesionParams.enabled) return null;
  return detectLungLesions(vol, {
    airThreshold: -400,
    lesionMin: lesionParams.min,
    lesionMax: lesionParams.max,
    minAirNeighbors: 2,
    dilate: 3,
  });
}

async function applyVolume(vol, label) {
  currentRaw = vol;
  currentLabel = label;
  const maxDim = Number(els.resSelect.value);
  const v = downsample(vol, maxDim);
  currentDownsampled = v;

  let result = null;
  if (lesionParams.enabled) {
    showOverlay(true, '检测肺部病变…');
    await nextFrame();
    result = computeLesionMask(v);
    showOverlay(false);
  }
  lastLesionCount = result ? result.lesionCount : 0;
  currentLesionMask = result ? result.mask : null;

  renderer.setVolume(v, result ? result.mask : null);
  renderer.setLesionParams({
    enabled: lesionParams.enabled,
    color: lesionParams.color,
    opacity: lesionParams.opacity,
  });
  sliceViews.setVolume(v);
  syncSliceOverlay();
  updateInfo(v, label);
  setStatus('已加载：' + label);
}

async function refreshLesionMask() {
  if (!currentDownsampled || !renderer) return;
  let result = null;
  if (lesionParams.enabled) {
    showOverlay(true, '检测肺部病变…');
    await nextFrame();
    result = computeLesionMask(currentDownsampled);
    showOverlay(false);
  }
  lastLesionCount = result ? result.lesionCount : 0;
  currentLesionMask = result ? result.mask : null;
  renderer.setLesionMask(result ? result.mask : null);
  renderer.setLesionParams({
    enabled: lesionParams.enabled,
    color: lesionParams.color,
    opacity: lesionParams.opacity,
  });
  syncSliceOverlay();
  updateInfo(currentDownsampled, currentLabel);
}

function updateInfo(vol, label) {
  const [nx, ny, nz] = vol.dims;
  const [sx, sy, sz] = vol.spacing;
  const [huMin, huMax] = computeHuRange(vol.data);
  els.info.innerHTML = `
    <p><strong>${escapeHtml(label || '未命名')}</strong></p>
    <div class="kv"><span class="k">体素尺寸</span><span class="v">${nx} × ${ny} × ${nz}</span></div>
    <div class="kv"><span class="k">层间距 (x/y/z)</span><span class="v">${fmt(sx)} / ${fmt(sy)} / ${fmt(sz)} mm</span></div>
    <div class="kv"><span class="k">物理尺寸</span><span class="v">${fmt(nx * sx)} × ${fmt(ny * sy)} × ${fmt(nz * sz)} mm</span></div>
    <div class="kv"><span class="k">HU 范围</span><span class="v">${huMin.toFixed(0)} ~ ${huMax.toFixed(0)}</span></div>
    <div class="kv"><span class="k">肺部病变体素</span><span class="v">${lastLesionCount}</span></div>
    <div class="kv"><span class="k">纹理精度</span><span class="v">8-bit RG（密度+病变掩膜）</span></div>
  `;
}

function fmt(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

async function filesToBuffers(files) {
  const buffers = [];
  const list = Array.from(files);
  if (list.length === 1 && /\.zip$/i.test(list[0].name)) {
    setStatus('解压 ZIP…', 'busy');
    const zip = await JSZip.loadAsync(await list[0].arrayBuffer());
    const entries = Object.values(zip.files).filter(
      (f) => !f.dir && !/\/$/.test(f.name) && !/(^|\/)__MACOSX\//.test(f.name) && !/\.DS_Store$/.test(f.name),
    );
    for (let i = 0; i < entries.length; i++) {
      buffers.push(await entries[i].async('arraybuffer'));
    }
    return buffers;
  }
  for (const f of list) {
    if (/(^|\/)__MACOSX\//.test(f.webkitRelativePath || f.name)) continue;
    buffers.push(await f.arrayBuffer());
  }
  return buffers;
}

async function loadFiles(files, label) {
  if (!files || files.length === 0) return;
  showOverlay(true, '读取文件…');
  setStatus('读取文件…', 'busy');
  try {
    const buffers = await filesToBuffers(files);
    if (!buffers.length) throw new Error('未找到有效文件');

    showOverlay(true, '解析 DICOM 序列…');
    await nextFrame();
    const { slices, modality, warnings } = await loadSeriesFromFiles(buffers, (done, total) => {
      showOverlay(true, `解析 DICOM… ${done}/${total}`);
    });

    showOverlay(true, '构建三维体数据…');
    await nextFrame();
    const vol = buildVolume(slices);
    await nextFrame();

    await applyVolume(vol, label || `${slices.length} 层 · ${modality || 'DICOM'}`);
    if (warnings && warnings.length) {
      console.warn('加载警告', warnings);
    }
  } catch (e) {
    console.error(e);
    setStatus('错误：' + e.message, 'error');
  } finally {
    showOverlay(false);
  }
}

async function loadDemo() {
  showOverlay(true, '生成演示人体模型…');
  setStatus('生成演示模型…', 'busy');
  try {
    await nextFrame();
    const side = 224;
    const vol = generatePhantom([side, side, side]);
    await nextFrame();
    await applyVolume(vol, '演示人体模型（合成数据）');
  } catch (e) {
    console.error(e);
    setStatus('错误：' + e.message, 'error');
  } finally {
    showOverlay(false);
  }
}

/* ---------- event wiring ---------- */

els.btnPickFiles.addEventListener('click', () => els.fileInput.click());
els.btnPickFolder.addEventListener('click', () => els.folderInput.click());
els.btnDemo.addEventListener('click', loadDemo);

els.fileInput.addEventListener('change', () => loadFiles(els.fileInput.files));
els.folderInput.addEventListener('change', () => loadFiles(els.folderInput.files));

els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') els.fileInput.click();
});

['dragenter', 'dragover'].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.add('dragover');
  }),
);
['dragleave', 'drop'].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('dragover');
  }),
);
els.dropzone.addEventListener('drop', (e) => {
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) loadFiles(files);
});

els.boneThreshold.addEventListener('input', refreshLUT);
els.organColor.addEventListener('input', refreshLUT);
els.boneColor.addEventListener('input', refreshLUT);
els.organOpacity.addEventListener('input', refreshLUT);
els.boneOpacity.addEventListener('input', refreshLUT);
els.alphaScale.addEventListener('input', refreshLUT);
els.shading.addEventListener('change', refreshLUT);
els.resSelect.addEventListener('change', async () => {
  if (renderer && currentRaw) {
    await applyVolume(currentRaw, currentLabel);
  }
});

/* 肺部病变高亮 */
els.lesionEnabled.addEventListener('change', () => {
  collectLesionParams();
  refreshLesionMask();
});
els.lesionMin.addEventListener('input', () => {
  els.lesionMinVal.textContent = els.lesionMin.value;
});
els.lesionMin.addEventListener('change', () => {
  collectLesionParams();
  refreshLesionMask();
});
els.lesionMax.addEventListener('input', () => {
  els.lesionMaxVal.textContent = els.lesionMax.value;
});
els.lesionMax.addEventListener('change', () => {
  collectLesionParams();
  refreshLesionMask();
});
els.lesionColor.addEventListener('input', () => {
  collectLesionParams();
  if (renderer) renderer.setLesionParams({ color: lesionParams.color });
  syncSliceOverlay();
});
els.lesionOpacity.addEventListener('input', () => {
  collectLesionParams();
  if (renderer) renderer.setLesionParams({ opacity: lesionParams.opacity });
});

/* 截面窗宽窗位 */
els.wwSlider.addEventListener('input', () => {
  els.wwVal.textContent = els.wwSlider.value;
  if (sliceViews) sliceViews.setWindowLevel(Number(els.wwSlider.value), Number(els.wlSlider.value));
});
els.wlSlider.addEventListener('input', () => {
  els.wlVal.textContent = els.wlSlider.value;
  if (sliceViews) sliceViews.setWindowLevel(Number(els.wwSlider.value), Number(els.wlSlider.value));
});

/* 斜位重建 */
els.obliqueEnabled.addEventListener('change', () => {
  const on = els.obliqueEnabled.checked;
  els.obliqueBar.classList.toggle('hidden', !on);
  if (on && sliceViews) sliceViews.renderOblique();
  if (renderer) {
    renderer.setObliqueIndicator(
      on,
      Number(els.obliqueTheta.value),
      Number(els.obliquePhi.value),
    );
  }
});

els.btnReset.addEventListener('click', () => renderer && renderer.resetCamera());
els.btnScreenshot.addEventListener('click', () => {
  if (!renderer) return;
  const url = renderer.screenshot();
  const a = document.createElement('a');
  a.href = url;
  a.download = 'dicom-3d-model.png';
  a.click();
});

/* ---------- init ---------- */

try {
  initRenderer();
  setStatus('就绪 — 拖入 DICOM 序列或点击「加载演示模型」');
} catch (e) {
  console.error(e);
  setStatus('初始化 WebGL 失败：' + e.message, 'error');
  showOverlay(true, '浏览器不支持 WebGL，无法渲染三维模型');
}
