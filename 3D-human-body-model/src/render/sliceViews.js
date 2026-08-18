/**
 * 三正交截面视图（MPR）+ 任意斜位（Oblique）重建。
 *
 * - 从体数据抽取轴位(⊥Z)、冠状(⊥Y)、矢状(⊥X)三个方向的 2D 切片；
 * - 叠加「病变（蓝）」「骨骼（象牙白）」彩色蒙版，其余按窗宽/窗位灰度显示；
 * - 支持在切片上用鼠标点击定位切面（更新其余两轴位置 + 十字线 + 3D 指示面）；
 * - 支持任意斜位重建（两个旋转角），用三线性插值采样；
 * - 通过位置/角度回调与 3D 视图联动。
 *
 * 纯逻辑的 `renderSliceRGBA` / `renderObliqueRGBA` / `sampleTrilinear` 独立导出，便于单元测试。
 */

export const AXES = ['x', 'y', 'z'];

const VIEW_AXES = {
  z: { h: 'x', v: 'y' }, // 轴位：水平 x，垂直 y
  y: { h: 'x', v: 'z' }, // 冠状：水平 x，垂直 z
  x: { h: 'y', v: 'z' }, // 矢状：水平 y，垂直 z
};

const AXIS_COLOR = {
  x: '#f97316', // 橙
  y: '#10b981', // 绿
  z: '#22d3ee', // 青（与病变蓝区分）
};

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** 将体素 HU 按窗宽/窗位映射为灰度。 */
function huGray(hu, ww, wl) {
  return clamp255(((hu - wl + ww / 2) / ww) * 255);
}

/** 在某个方向切片内做双线性插值采样（si/sj 为分数坐标）。 */
function sampleSliceBilinear(vol, axis, index, si, sj) {
  const [nx, ny, nz] = vol.dims;
  const data = vol.data;
  const i0 = Math.max(0, Math.min(Math.floor(si), (axis === 'x' ? ny : nx) - 1));
  const j0 = Math.max(0, Math.min(Math.floor(sj), (axis === 'z' ? ny : nz) - 1));
  const i1 = Math.min(i0 + 1, (axis === 'x' ? ny : nx) - 1);
  const j1 = Math.min(j0 + 1, (axis === 'z' ? ny : nz) - 1);
  const di = si - i0;
  const dj = sj - j0;

  let v00, v10, v01, v11;
  if (axis === 'z') {
    v00 = data[(index * ny + j0) * nx + i0];
    v10 = data[(index * ny + j0) * nx + i1];
    v01 = data[(index * ny + j1) * nx + i0];
    v11 = data[(index * ny + j1) * nx + i1];
  } else if (axis === 'y') {
    v00 = data[(j0 * ny + index) * nx + i0];
    v10 = data[(j0 * ny + index) * nx + i1];
    v01 = data[(j1 * ny + index) * nx + i0];
    v11 = data[(j1 * ny + index) * nx + i1];
  } else {
    v00 = data[(j0 * ny + i0) * nx + index];
    v10 = data[(j0 * ny + i1) * nx + index];
    v01 = data[(j1 * ny + i0) * nx + index];
    v11 = data[(j1 * ny + i1) * nx + index];
  }
  const v0 = v00 * (1 - di) + v10 * di;
  const v1 = v01 * (1 - di) + v11 * di;
  return v0 * (1 - dj) + v1 * dj;
}

/**
 * 抽取一个方向的切片并生成 RGBA（灰度 + 病变/骨骼彩色蒙版）。
 * vol = { data, dims:[nx,ny,nz] }
 * axis ∈ {'x','y','z'}；opts: { ww, wl, lesionMask, boneThreshold, lesionColor, boneColor, tw, th }
 * tw/th 为目标分辨率（默认切片原生尺寸），通过双线性插值重采样到目标尺寸，
 * 使冠状/矢状等低分辨率方向也能与轴位一样清晰。
 * 返回 { data: Uint8ClampedArray(tw*th*4), w: tw, h: th }
 */
export function renderSliceRGBA(vol, axis, index, opts = {}) {
  const [nx, ny, nz] = vol.dims;
  const data = vol.data;
  const {
    ww = 1600,
    wl = -500,
    lesionMask = null,
    boneThreshold = 300,
    lesionColor = [0.13, 0.59, 0.95],
    boneColor = [0.98, 0.92, 0.78],
  } = opts;
  const lr = Math.round(lesionColor[0] * 255);
  const lg = Math.round(lesionColor[1] * 255);
  const lb = Math.round(lesionColor[2] * 255);
  const br = Math.round(boneColor[0] * 255);
  const bg = Math.round(boneColor[1] * 255);
  const bb = Math.round(boneColor[2] * 255);

  let w, h;
  if (axis === 'z') { w = nx; h = ny; }
  else if (axis === 'y') { w = nx; h = nz; }
  else { w = ny; h = nz; }

  const tw = opts.tw ?? w;
  const th = opts.th ?? h;
  const sx = tw > 1 ? (w - 1) / (tw - 1) : 0;
  const sy = th > 1 ? (h - 1) / (th - 1) : 0;

  const out = new Uint8ClampedArray(tw * th * 4);
  let p = 0;
  for (let tj = 0; tj < th; tj++) {
    const sj = tj * sy;
    const jr = Math.round(sj);
    for (let ti = 0; ti < tw; ti++, p += 4) {
      const si = ti * sx;
      const ir = Math.round(si);
      const hu = sampleSliceBilinear(vol, axis, index, si, sj);

      // 病变/骨骼蒙版用最近邻采样
      let idx;
      if (axis === 'z') idx = (index * ny + jr) * nx + ir;
      else if (axis === 'y') idx = (jr * ny + index) * nx + ir;
      else idx = (jr * ny + ir) * nx + index;

      if (lesionMask && lesionMask[idx]) {
        out[p] = lr; out[p + 1] = lg; out[p + 2] = lb;
      } else if (hu >= boneThreshold) {
        out[p] = br; out[p + 1] = bg; out[p + 2] = bb;
      } else {
        const g = huGray(hu, ww, wl);
        out[p] = g; out[p + 1] = g; out[p + 2] = g;
      }
      out[p + 3] = 255;
    }
  }
  return { data: out, w: tw, h: th };
}

/** 三线性插值采样（x/y/z 须在 [0, dim-1] 内）。 */
export function sampleTrilinear(data, dims, x, y, z) {
  const [nx, ny, nz] = dims;
  const x0 = Math.floor(x); const x1 = Math.min(x0 + 1, nx - 1);
  const y0 = Math.floor(y); const y1 = Math.min(y0 + 1, ny - 1);
  const z0 = Math.floor(z); const z1 = Math.min(z0 + 1, nz - 1);
  const dx = x - x0, dy = y - y0, dz = z - z0;

  const v000 = data[(z0 * ny + y0) * nx + x0];
  const v100 = data[(z0 * ny + y0) * nx + x1];
  const v010 = data[(z0 * ny + y1) * nx + x0];
  const v110 = data[(z0 * ny + y1) * nx + x1];
  const v001 = data[(z1 * ny + y0) * nx + x0];
  const v101 = data[(z1 * ny + y0) * nx + x1];
  const v011 = data[(z1 * ny + y1) * nx + x0];
  const v111 = data[(z1 * ny + y1) * nx + x1];

  const v00 = v000 * (1 - dx) + v100 * dx;
  const v01 = v001 * (1 - dx) + v101 * dx;
  const v10 = v010 * (1 - dx) + v110 * dx;
  const v11 = v011 * (1 - dx) + v111 * dx;
  const v0 = v00 * (1 - dy) + v10 * dy;
  const v1 = v01 * (1 - dy) + v11 * dy;
  return v0 * (1 - dz) + v1 * dz;
}

/**
 * 任意斜位重建：以体中心为原点、法向量由 θ(方位角)/φ(极角) 确定，
 * 三线性采样 size×size 网格。
 * θ∈[0,360)°，φ∈[0,90]°（φ=0 为轴位，φ=90 为斜冠状/矢状）。
 */
export function renderObliqueRGBA(vol, thetaDeg, phiDeg, size, opts = {}) {
  const [nx, ny, nz] = vol.dims;
  const data = vol.data;
  const {
    ww = 1600,
    wl = -500,
    lesionMask = null,
    boneThreshold = 300,
    lesionColor = [0.13, 0.59, 0.95],
    boneColor = [0.98, 0.92, 0.78],
  } = opts;
  const lr = Math.round(lesionColor[0] * 255);
  const lg = Math.round(lesionColor[1] * 255);
  const lb = Math.round(lesionColor[2] * 255);
  const br = Math.round(boneColor[0] * 255);
  const bg = Math.round(boneColor[1] * 255);
  const bb = Math.round(boneColor[2] * 255);

  const th = (thetaDeg * Math.PI) / 180;
  const ph = (phiDeg * Math.PI) / 180;
  const N = [Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph)];

  // 构造平面基向量 U、V（均与 N 正交）
  const ref = Math.abs(N[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const U = [
    N[1] * ref[2] - N[2] * ref[1],
    N[2] * ref[0] - N[0] * ref[2],
    N[0] * ref[1] - N[1] * ref[0],
  ];
  const ulen = Math.hypot(U[0], U[1], U[2]) || 1;
  U[0] /= ulen; U[1] /= ulen; U[2] /= ulen;
  const V = [
    N[1] * U[2] - N[2] * U[1],
    N[2] * U[0] - N[0] * U[2],
    N[0] * U[1] - N[1] * U[0],
  ];

  const cx = (nx - 1) / 2, cy = (ny - 1) / 2, cz = (nz - 1) / 2;
  const halfDiag = Math.sqrt(cx * cx + cy * cy + cz * cz);
  const half = (size - 1) / 2;

  const out = new Uint8ClampedArray(size * size * 4);
  let p = 0;
  for (let j = 0; j < size; j++) {
    const sv = ((j - half) / half) * halfDiag;
    for (let i = 0; i < size; i++, p += 4) {
      const su = ((i - half) / half) * halfDiag;
      const x = cx + U[0] * su + V[0] * sv;
      const y = cy + U[1] * su + V[1] * sv;
      const z = cz + U[2] * su + V[2] * sv;

      let hu = -1000;
      let inBounds = false;
      let mi = -1;
      if (x >= 0 && x <= nx - 1 && y >= 0 && y <= ny - 1 && z >= 0 && z <= nz - 1) {
        inBounds = true;
        hu = sampleTrilinear(data, [nx, ny, nz], x, y, z);
        const xi = Math.round(x), yi = Math.round(y), zi = Math.round(z);
        mi = (zi * ny + yi) * nx + xi;
      }

      if (inBounds && lesionMask && lesionMask[mi]) {
        out[p] = lr; out[p + 1] = lg; out[p + 2] = lb;
      } else if (hu >= boneThreshold) {
        out[p] = br; out[p + 1] = bg; out[p + 2] = bb;
      } else {
        const g = huGray(hu, ww, wl);
        out[p] = g; out[p + 1] = g; out[p + 2] = g;
      }
      out[p + 3] = 255;
    }
  }
  return { data: out, w: size, h: size };
}

/**
 * 依据体数据物理间距计算各正交视图的目标像素尺寸（保证正常比例）。
 * 返回 { target: {x:{w,h}, y:{w,h}, z:{w,h}}, oblique }。
 */
export function computeViewTargets(dims, spacing, base = 512, cap = 1536) {
  const [nx, ny, nz] = dims;
  const [sx, sy, sz] = spacing;
  const physX = nx * (sx || 1);
  const physY = ny * (sy || 1);
  const physZ = nz * (sz || 1);

  const minInPlane = Math.min(physX, physY) || 1;
  const scale = base / minInPlane;
  const physical = {
    z: { w: physX, h: physY }, // 轴位：x × y
    y: { w: physX, h: physZ }, // 冠状：x × z
    x: { w: physY, h: physZ }, // 矢状：y × z
  };

  const target = {};
  for (const k of AXES) {
    let tw = Math.round(physical[k].w * scale);
    let th = Math.round(physical[k].h * scale);
    const m = Math.max(tw, th);
    if (m > cap) {
      tw = Math.max(1, Math.round((tw * cap) / m));
      th = Math.max(1, Math.round((th * cap) / m));
    }
    target[k] = { w: tw, h: th };
  }
  const oblique = Math.min(cap, Math.max(base, Math.round(Math.hypot(physX, physY, physZ) * scale)));
  return { target, oblique };
}

export class SliceViews {
  /**
   * views: { z:{canvas,slider,value}, y:{...}, x:{...} }
   * oblique: { canvas, thetaSlider, phiSlider, thetaVal, phiVal } 或 null
   * opts: { ww, wl, onChange }
   */
  constructor(views, opts = {}) {
    this.views = views;
    this.oblique = opts.oblique || null;
    this.onChange = opts.onChange || null;
    this.ww = opts.ww ?? 1600;
    this.wl = opts.wl ?? -500;
    this.vol = null;
    this.pos = { x: 0, y: 0, z: 0 };
    this._cache = {};
    this._overlay = {
      lesionMask: null,
      boneThreshold: 300,
      lesionColor: [0.13, 0.59, 0.95],
      boneColor: [0.98, 0.92, 0.78],
    };
    this._oblique = { theta: 0, phi: 0 };

    for (const [axis, v] of Object.entries(this.views)) {
      v.axis = axis;
      v.slider.addEventListener('input', () => {
        this.setPosition(axis, parseInt(v.slider.value, 10));
      });
      v.canvas.addEventListener('click', (e) => this._onClick(axis, e));
      v.canvas.style.cursor = 'crosshair';
    }

    if (this.oblique) {
      this.oblique.thetaSlider.addEventListener('input', () => {
        this._oblique.theta = Number(this.oblique.thetaSlider.value);
        this.oblique.thetaVal.textContent = String(this._oblique.theta);
        this.renderOblique();
        this._emit();
      });
      this.oblique.phiSlider.addEventListener('input', () => {
        this._oblique.phi = Number(this.oblique.phiSlider.value);
        this.oblique.phiVal.textContent = String(this._oblique.phi);
        this.renderOblique();
        this._emit();
      });
    }
  }

  setVolume(vol) {
    this.vol = vol;
    if (!vol) return;
    const [nx, ny, nz] = vol.dims;
    this.pos.x = (nx - 1) >> 1;
    this.pos.y = (ny - 1) >> 1;
    this.pos.z = (nz - 1) >> 1;

    // 按物理间距计算各视图的宽高比例，保证冠状/矢状显示为正常比例。
    const { target, oblique } = computeViewTargets(vol.dims, vol.spacing || [1, 1, 1]);
    this._target = target;
    this._obliqueSize = oblique;

    this.views.z.slider.max = String(nz - 1);
    this.views.y.slider.max = String(ny - 1);
    this.views.x.slider.max = String(nx - 1);
    this._syncSliders();
    this._updateValueLabels();

    this.renderAll();
    this.renderOblique();
    this._emit();
  }

  setWindowLevel(ww, wl) {
    this.ww = ww;
    this.wl = wl;
    this.renderAll();
    this.renderOblique();
  }

  /** 更新叠加蒙版与骨骼阈值/颜色（用于切片着色）。 */
  setOverlay({ lesionMask = null, boneThreshold = 300, lesionColor, boneColor } = {}) {
    if (lesionColor) this._overlay.lesionColor = lesionColor;
    if (boneColor) this._overlay.boneColor = boneColor;
    this._overlay.lesionMask = lesionMask;
    this._overlay.boneThreshold = boneThreshold;
    this.renderAll();
    this.renderOblique();
  }

  setPosition(axis, index) {
    if (!this.vol) return;
    const [nx, ny, nz] = this.vol.dims;
    const max = axis === 'x' ? nx - 1 : axis === 'y' ? ny - 1 : nz - 1;
    index = Math.max(0, Math.min(max, index));
    this.pos[axis] = index;
    this.views[axis].slider.value = String(index);
    this.views[axis].value.textContent = String(index);

    this.renderSlice(axis);
    for (const k of AXES) if (k !== axis) this.renderSlice(k, { crosshairOnly: true });
    this._emit();
  }

  renderAll() {
    for (const k of AXES) this.renderSlice(k);
  }

  /** 视口尺寸变化后，按当前显示尺寸重新渲染（自适应分辨率）。 */
  refreshSizes() {
    if (!this.vol) return;
    this.renderAll();
    this.renderOblique();
  }

  /** 依据画布当前显示尺寸计算渲染分辨率（≥显示像素，避免放大模糊）。 */
  _fitRenderSize(canvas, baseW, baseH) {
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (!cw || !ch) return { w: baseW, h: baseH };
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(cw / baseW, ch / baseH);
    let w = Math.max(1, Math.round(baseW * scale * dpr));
    let h = Math.max(1, Math.round(baseH * scale * dpr));
    const cap = 1600;
    const m = Math.max(w, h);
    if (m > cap) {
      w = Math.max(1, Math.round((w * cap) / m));
      h = Math.max(1, Math.round((h * cap) / m));
    }
    return { w, h };
  }

  renderSlice(axis, { crosshairOnly = false } = {}) {
    if (!this.vol) return;
    const v = this.views[axis];
    const canvas = v.canvas;
    const ctx = canvas.getContext('2d');
    const base = this._target[axis];
    const size = this._fitRenderSize(canvas, base.w, base.h);

    if (crosshairOnly) {
      const img = this._cache[axis];
      if (img && img.width === size.w && img.height === size.h) {
        if (canvas.width !== img.width) canvas.width = img.width;
        if (canvas.height !== img.height) canvas.height = img.height;
        ctx.putImageData(img, 0, 0);
        this._drawCrosshair(axis, ctx, canvas.width, canvas.height);
        return;
      }
    }

    const { data: rgba } = renderSliceRGBA(this.vol, axis, this.pos[axis], {
      ww: this.ww,
      wl: this.wl,
      lesionMask: this._overlay.lesionMask,
      boneThreshold: this._overlay.boneThreshold,
      lesionColor: this._overlay.lesionColor,
      boneColor: this._overlay.boneColor,
      tw: size.w,
      th: size.h,
    });
    canvas.width = size.w;
    canvas.height = size.h;
    const img = new ImageData(rgba, size.w, size.h);
    ctx.putImageData(img, 0, 0);
    this._cache[axis] = img;

    this._drawCrosshair(axis, ctx, canvas.width, canvas.height);
  }

  renderOblique() {
    if (!this.vol || !this.oblique) return;
    const canvas = this.oblique.canvas;
    const ctx = canvas.getContext('2d');
    const baseSize = this._obliqueSize || Math.max(...this.vol.dims);
    const size = this._fitRenderSize(canvas, baseSize, baseSize);
    const { data: rgba, w, h } = renderObliqueRGBA(
      this.vol, this._oblique.theta, this._oblique.phi, size.w,
      {
        ww: this.ww,
        wl: this.wl,
        lesionMask: this._overlay.lesionMask,
        boneThreshold: this._overlay.boneThreshold,
        lesionColor: this._overlay.lesionColor,
        boneColor: this._overlay.boneColor,
      },
    );
    canvas.width = w;
    canvas.height = h;
    ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
  }

  /** 点击切片：把点击位置映射为当前视图两个轴的索引。 */
  _onClick(axis, e) {
    if (!this.vol) return;
    const canvas = this.views[axis].canvas;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const cw = canvas.width, ch = canvas.height;
    if (!cw || !ch) return;

    // object-fit: contain 的缩放与留白换算
    const scale = Math.min(rect.width / cw, rect.height / ch);
    const offX = (rect.width - cw * scale) / 2;
    const offY = (rect.height - ch * scale) / 2;
    const ix = Math.round((e.clientX - rect.left - offX) / scale);
    const iy = Math.round((e.clientY - rect.top - offY) / scale);
    const cx = Math.max(0, Math.min(cw - 1, ix));
    const cy = Math.max(0, Math.min(ch - 1, iy));

    const { h: hAxis, v: vAxis } = VIEW_AXES[axis];
    const [nx, ny, nz] = this.vol.dims;
    const dims = { x: nx, y: ny, z: nz };
    const hi = Math.round((cx / (cw - 1)) * (dims[hAxis] - 1));
    const vi = Math.round((cy / (ch - 1)) * (dims[vAxis] - 1));

    this.pos[hAxis] = hi;
    this.pos[vAxis] = vi;
    this._syncSliders();
    this._updateValueLabels();
    this.renderAll();
    this._emit();
  }

  _syncSliders() {
    this.views.x.slider.value = String(this.pos.x);
    this.views.y.slider.value = String(this.pos.y);
    this.views.z.slider.value = String(this.pos.z);
  }

  _updateValueLabels() {
    this.views.x.value.textContent = String(this.pos.x);
    this.views.y.value.textContent = String(this.pos.y);
    this.views.z.value.textContent = String(this.pos.z);
  }

  _drawCrosshair(axis, ctx, w, h) {
    const [nx, ny, nz] = this.vol.dims;
    const dims = { x: nx, y: ny, z: nz };
    const { h: hAxis, v: vAxis } = VIEW_AXES[axis];
    const hx = (this.pos[hAxis] / (dims[hAxis] - 1)) * (w - 1);
    const vy = (this.pos[vAxis] / (dims[vAxis] - 1)) * (h - 1);

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = AXIS_COLOR[hAxis];
    ctx.beginPath();
    ctx.moveTo(hx, 0);
    ctx.lineTo(hx, h);
    ctx.stroke();

    ctx.strokeStyle = AXIS_COLOR[vAxis];
    ctx.beginPath();
    ctx.moveTo(0, vy);
    ctx.lineTo(w, vy);
    ctx.stroke();
  }

  _emit() {
    if (!this.onChange || !this.vol) return;
    const [nx, ny, nz] = this.vol.dims;
    this.onChange({
      x: this.pos.x / (nx - 1),
      y: this.pos.y / (ny - 1),
      z: this.pos.z / (nz - 1),
      oblique: this.oblique ? { theta: this._oblique.theta, phi: this._oblique.phi } : null,
    });
  }
}
