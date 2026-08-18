/**
 * Three.js GPU volume raymarcher with an editable 1D transfer function.
 * Renders the HU volume as a colored, semi-transparent 3D model.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { HU_MIN, HU_MAX } from './transferFunction.js';

const VS = /* glsl */ `
varying vec3 vLocalPos;
void main() {
  vLocalPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FS = /* glsl */ `
precision highp float;
precision mediump sampler3D;

uniform sampler3D uVolume;
uniform sampler2D uLUT;
uniform vec3 uCamLocal;
uniform mat3 uNormalMatrix;
uniform vec3 uGradStep;
uniform float uSteps;
uniform float uShading;
uniform float uAlphaScale;
uniform vec3 uLightDir;
uniform float uLesionEnabled;
uniform vec3 uLesionColor;
uniform float uLesionOpacity;

varying vec3 vLocalPos;

vec2 intersectBox(vec3 ro, vec3 rd) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (-0.5 - ro) * inv;
  vec3 t1 = ( 0.5 - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tnear = max(max(tmin.x, tmin.y), tmin.z);
  float tfar  = min(min(tmax.x, tmax.y), tmax.z);
  return vec2(tnear, tfar);
}

void main() {
  vec3 ro = vLocalPos;
  vec3 rd = normalize(vLocalPos - uCamLocal);
  vec2 tt = intersectBox(ro, rd);
  float t = max(tt.x, 0.0);
  float tEnd = tt.y;
  if (tEnd <= t) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float stepLen = (tEnd - t) / uSteps;
  vec3 p = ro + rd * t;
  vec4 col = vec4(0.0);
  bool doShade = uShading > 0.5;

  for (int i = 0; i < 1024; i++) {
    if (float(i) >= uSteps) break;
    vec3 tc = p + 0.5;
    if (any(lessThan(tc, vec3(0.0))) || any(greaterThan(tc, vec3(1.0)))) break;

    vec4 texel = texture(uVolume, tc);
    float dens = texel.r;
    vec4 lut = texture(uLUT, vec2(dens, 0.5));

    vec3 rgb;
    float a;
    if (uLesionEnabled > 0.5 && texel.g > 0.5) {
      rgb = uLesionColor;
      a = uLesionOpacity;
    } else {
      rgb = lut.rgb;
      a = lut.a;
    }
    a *= uAlphaScale;

    if (a > 0.002) {
      if (doShade) {
        vec3 g;
        g.x = texture(uVolume, tc + vec3(uGradStep.x, 0.0, 0.0)).r
            - texture(uVolume, tc - vec3(uGradStep.x, 0.0, 0.0)).r;
        g.y = texture(uVolume, tc + vec3(0.0, uGradStep.y, 0.0)).r
            - texture(uVolume, tc - vec3(0.0, uGradStep.y, 0.0)).r;
        g.z = texture(uVolume, tc + vec3(0.0, 0.0, uGradStep.z)).r
            - texture(uVolume, tc - vec3(0.0, 0.0, uGradStep.z)).r;
        vec3 n = -normalize(g + vec3(1e-5));
        vec3 wn = normalize(uNormalMatrix * n);
        float diff = max(dot(wn, normalize(uLightDir)), 0.0);
        float shade = 0.42 + 0.58 * diff;
        rgb *= shade;
      }
      rgb *= a; // premultiply
      col.rgb += (1.0 - col.a) * rgb;
      col.a += (1.0 - col.a) * a;
      if (col.a > 0.97) break;
    }

    p += rd * stepLen;
    t += stepLen;
    if (t > tEnd) break;
  }

  gl_FragColor = col;
}
`;

export class VolumeRenderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.onError = opts.onError || null;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    // 8-bit RG volume texture (R = density, G = lesion mask): always
    // linear-filterable on WebGL2, matching the official three.js volume
    // raycasting example. Avoids half-float 3D texture driver pitfalls.
    this.texMode = 'byte';

    if (this.renderer.debug) {
      this.renderer.debug.onShaderError = (gl, program, vs, fs) => {
        const log = [
          gl.getProgramInfoLog(program),
          gl.getShaderInfoLog(vs),
          gl.getShaderInfoLog(fs),
        ]
          .filter(Boolean)
          .join('\n');
        const msg = '着色器编译错误: ' + (log || '未知错误');
        console.error(msg);
        if (this.onError) this.onError(new Error(msg));
      };
    }

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0c0f16);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    this.camera.position.set(1.7, 0.7, 2.0);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.target.set(0, 0, 0);

    this.mesh = null;
    this.volume = null;
    this.lutTexture = null;
    this._dims = null;
    this._huU8 = null;
    this._lesionMask = null;
    this._nm = new THREE.Matrix3();
    this._disposed = false;
    this._renderErrorReported = false;

    this.animate();
  }

  createMesh() {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: FS,
      uniforms: {
        uVolume: { value: null },
        uLUT: { value: null },
        uCamLocal: { value: new THREE.Vector3() },
        uNormalMatrix: { value: new THREE.Matrix3() },
        uGradStep: { value: new THREE.Vector3(1 / 256, 1 / 256, 1 / 256) },
        uSteps: { value: 512 },
        uShading: { value: 1.0 },
        uAlphaScale: { value: 1.0 },
        uLightDir: { value: new THREE.Vector3(0.35, 0.8, 0.45).normalize() },
        uLesionEnabled: { value: 0.0 },
        uLesionColor: { value: new THREE.Color(0x2196f3) },
        uLesionOpacity: { value: 1.0 },
      },
      side: THREE.FrontSide,
      depthWrite: false,
      depthTest: false,
      transparent: true,
      // The shader outputs premultiplied-alpha color; blend accordingly.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    // Local +z (inferior->superior) maps to world +y (up).
    this.mesh.rotation.x = -Math.PI / 2;
    this.scene.add(this.mesh);

    // 三个截面指示面（轴位/冠状/矢状），作为体网格子对象以继承其缩放与旋转。
    const planeGeo = new THREE.PlaneGeometry(1, 1);
    const makePlane = (color) =>
      new THREE.Mesh(
        planeGeo,
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.16,
          side: THREE.DoubleSide,
          depthWrite: false,
          depthTest: false,
        }),
      );
    const pz = makePlane(0x22d3ee); // 轴位（⊥局部 z）
    pz.renderOrder = 1;
    const py = makePlane(0x10b981); // 冠状（⊥局部 y）
    py.rotation.x = -Math.PI / 2;
    py.renderOrder = 1;
    const px = makePlane(0xf97316); // 矢状（⊥局部 x）
    px.rotation.y = Math.PI / 2;
    px.renderOrder = 1;

    // 斜位重建指示面（法向量可任意旋转）
    const pob = makePlane(0xe11d48);
    pob.scale.setScalar(1.8);
    pob.renderOrder = 1;
    pob.visible = false;
    this.mesh.add(pz, py, px, pob);
    this.planes = { x: px, y: py, z: pz, oblique: pob };

    return this.mesh;
  }

  /** 移动三个截面指示面（入参为归一化 0..1 的位置）。 */
  setSliceIndicators(xn, yn, zn) {
    if (!this.planes) return;
    this.planes.x.position.x = xn - 0.5;
    this.planes.y.position.y = yn - 0.5;
    this.planes.z.position.z = zn - 0.5;
  }

  /** 更新斜位指示面（θ 方位角 / φ 极角，单位度）。enabled=false 时隐藏。 */
  setObliqueIndicator(enabled, thetaDeg, phiDeg) {
    if (!this.planes || !this.planes.oblique) return;
    const p = this.planes.oblique;
    p.visible = !!enabled;
    if (!enabled) return;
    const th = (thetaDeg * Math.PI) / 180;
    const ph = (phiDeg * Math.PI) / 180;
    const n = new THREE.Vector3(
      Math.sin(ph) * Math.cos(th),
      Math.sin(ph) * Math.sin(th),
      Math.cos(ph),
    );
    p.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  }

  /** Set/refresh the volume. volume = { data: Float32Array(HU), dims:[nx,ny,nz], spacing:[sx,sy,sz] }. */
  setVolume(volume, lesionMask = null) {
    this.volume = volume;
    if (this.volume.tex) this.volume.tex.dispose();
    this._dims = volume.dims;
    this._spacing = volume.spacing;

    const [nx, ny, nz] = volume.dims;
    const n = nx * ny * nz;

    // Normalize HU to [0,1] into an 8-bit channel.
    const range = HU_MAX - HU_MIN;
    const hu8 = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let v = (volume.data[i] - HU_MIN) / range;
      if (v < 0) v = 0;
      else if (v > 1) v = 1;
      hu8[i] = Math.round(v * 255);
    }
    this._huU8 = hu8;
    this._lesionMask = lesionMask || new Uint8Array(n);

    this._buildTexture();

    if (!this.mesh) this.createMesh();
    const mat = this.mesh.material;
    mat.uniforms.uVolume.value = this.volume.tex;
    mat.uniforms.uLUT.value = this.lutTexture;
    mat.uniforms.uGradStep.value.set(1 / nx, 1 / ny, 1 / nz);
    mat.uniforms.uSteps.value = Math.min(
      1024,
      Math.max(180, Math.round(Math.max(nx, ny, nz) * 1.6)),
    );

    // Physical scale (volume z = superior-inferior becomes world up).
    const phys = [
      nx * volume.spacing[0],
      ny * volume.spacing[1],
      nz * volume.spacing[2],
    ];
    const m = Math.max(phys[0], phys[1], phys[2]) || 1;
    this.mesh.scale.set(phys[0] / m, phys[1] / m, phys[2] / m);

    this.resetCamera();
  }

  /** Rebuild the RG 3D texture (R = density, G = lesion mask). */
  _buildTexture() {
    const [nx, ny, nz] = this._dims;
    const n = nx * ny * nz;
    const interleaved = new Uint8Array(n * 2);
    const hu = this._huU8;
    const mask = this._lesionMask;
    for (let i = 0; i < n; i++) {
      interleaved[2 * i] = hu[i];
      interleaved[2 * i + 1] = mask[i] ? 255 : 0;
    }
    if (this.volume.tex) this.volume.tex.dispose();
    const tex = new THREE.Data3DTexture(interleaved, nx, ny, nz);
    tex.format = THREE.RGFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    this.volume.tex = tex;
    if (this.mesh) this.mesh.material.uniforms.uVolume.value = tex;
  }

  /** Update only the lesion mask channel (rebuilds the RG texture). */
  setLesionMask(mask) {
    if (!this._dims || !this._huU8) return;
    this._lesionMask = mask || new Uint8Array(this._huU8.length);
    this._buildTexture();
  }

  /** Update lesion highlight parameters (color/opacity/toggle) without rebuilding the mask. */
  setLesionParams({ enabled, color, opacity }) {
    if (!this.mesh) return;
    const u = this.mesh.material.uniforms;
    if (enabled != null) u.uLesionEnabled.value = enabled ? 1 : 0;
    if (color) u.uLesionColor.value.set(color[0], color[1], color[2]);
    if (opacity != null) u.uLesionOpacity.value = opacity;
  }

  setLUT(lutUint8, size) {
    if (this.lutTexture) this.lutTexture.dispose();
    const tex = new THREE.DataTexture(lutUint8, size, 1, THREE.RGBAFormat);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.flipY = false;
    tex.unpackAlignment = 1;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.lutTexture = tex;
    if (this.mesh) this.mesh.material.uniforms.uLUT.value = tex;
  }

  setUniforms({ shading, alphaScale }) {
    if (!this.mesh) return;
    if (shading != null) this.mesh.material.uniforms.uShading.value = shading ? 1 : 0;
    if (alphaScale != null) this.mesh.material.uniforms.uAlphaScale.value = alphaScale;
  }

  resetCamera() {
    this.camera.position.set(1.7, 0.7, 2.0);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  resize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  animate() {
    if (this._disposed) return;
    this.raf = requestAnimationFrame(() => this.animate());
    if (this.mesh) {
      this.mesh.updateMatrixWorld();
      this.camera.updateMatrixWorld();
      const mat = this.mesh.material;
      mat.uniforms.uCamLocal.value.copy(
        this.mesh.worldToLocal(this.camera.position.clone()),
      );
      this._nm.getNormalMatrix(this.mesh.matrixWorld);
      mat.uniforms.uNormalMatrix.value.copy(this._nm);
    }
    this.controls.update();
    try {
      this.renderer.render(this.scene, this.camera);
    } catch (e) {
      if (!this._renderErrorReported) {
        this._renderErrorReported = true;
        console.error(e);
        if (this.onError) this.onError(e);
      }
    }
  }

  screenshot() {
    return this.canvas.toDataURL('image/png');
  }

  dispose() {
    this._disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.volume && this.volume.tex) this.volume.tex.dispose();
    if (this.lutTexture) this.lutTexture.dispose();
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
    this.renderer.dispose();
  }
}
