import {
  buildJ2000ToEnuMatrix,
  compileProjectionContext,
  effectiveFovDeg,
  flattenMat3,
} from "@/lib/projection";
import { DSO_STRIDE, STAR_STRIDE } from "@/lib/spatialSkyIndex";
import type {
  ActiveRenderEngine,
  LocationPreset,
  ProjectionMode,
  ProjectionParams,
  SkyFrame,
} from "@/types/sky";

const PROJ_MODE_CODE: Record<ProjectionMode, number> = {
  free_direction: 0,
  horizon_zoom: 1,
  mid_sky: 2,
  zenith: 3,
  all_sky: 4,
  hemisphere_single: 5,
  hemisphere_dual: 6,
  panorama: 7,
  star_chart: 8,
};

const GLSL_PROJECTION_COMMON = `
precision highp float;

const float PI = 3.141592653589793;
const float DEG2RAD = 0.017453292519943295;
const float RAD2DEG = 57.29577951308232;

uniform vec3 uEnuRow0;
uniform vec3 uEnuRow1;
uniform vec3 uEnuRow2;
uniform vec3 uAppRow0;
uniform vec3 uAppRow1;
uniform vec3 uAppRow2;

uniform float uMode;
uniform vec2 uViewport;
uniform float uDpr;
uniform float uStereoScale;
uniform vec2 uCenter;
uniform vec2 uPanoScale;
uniform vec3 uAllSky;
uniform vec2 uCenterAzAlt;

uniform vec3 uBasisFwd0;
uniform vec3 uBasisRight0;
uniform vec3 uBasisUp0;
uniform vec3 uBasisFwd1;
uniform vec3 uBasisRight1;
uniform vec3 uBasisUp1;
uniform vec3 uHem0;
uniform vec3 uHem1;

uniform float uPanel;
uniform float uRefraction;
uniform float uShowBelowHorizon;
uniform float uShowOppositeGround;

float wrapDeg360(float deg) {
  float m = mod(deg, 360.0);
  return m < 0.0 ? m + 360.0 : m;
}

float wrapDeg180(float deg) {
  float d = mod(deg + 180.0, 360.0);
  if (d < 0.0) d += 360.0;
  return d - 180.0;
}

float applyStandardRefractionDeg(float trueAltDeg) {
  if (trueAltDeg < -2.0) return trueAltDeg;
  float clamped = clamp(trueAltDeg, -1.8, 90.0);
  float arg = (clamped + 10.3 / (clamped + 5.11)) * DEG2RAD;
  float rArcmin = 1.02 / tan(arg) + 0.0019279;
  return trueAltDeg + max(0.0, rArcmin) / 60.0;
}

bool projectJ2000ToCssPx(vec3 vJ2000, out vec2 outPx, out float outUzEnu) {
  outPx = vec2(0.0);
  outUzEnu = 0.0;
  if (uViewport.x <= 1.0 || uViewport.y <= 1.0) return false;

  bool isChart = uMode > 7.5;
  bool altOkBase = (uShowBelowHorizon > 0.5) || (uShowOppositeGround > 0.5);

  if (isChart) {
    vec3 vApp = vec3(
      dot(uAppRow0, vJ2000),
      dot(uAppRow1, vJ2000),
      dot(uAppRow2, vJ2000)
    );
    outUzEnu = dot(uEnuRow2, vJ2000);
    if (!altOkBase && outUzEnu < -0.0001) return false;

    float zc = dot(vApp, uBasisFwd0);
    float denom = 1.0 + zc;
    if (zc < -0.82 || denom <= 1e-6) return false;
    float xc = dot(vApp, uBasisRight0);
    float yc = dot(vApp, uBasisUp0);
    outPx = vec2(
      uCenter.x + (xc / denom) * uStereoScale,
      uCenter.y - (yc / denom) * uStereoScale
    );
    return true;
  }

  vec3 enu = vec3(
    dot(uEnuRow0, vJ2000),
    dot(uEnuRow1, vJ2000),
    dot(uEnuRow2, vJ2000)
  );
  if (uRefraction > 0.5) {
    float altDeg = asin(clamp(enu.z, -1.0, 1.0)) * RAD2DEG;
    float refAltDeg = applyStandardRefractionDeg(altDeg);
    float refAltRad = refAltDeg * DEG2RAD;
    float horizLen = length(enu.xy);
    if (horizLen > 1e-12) {
      float scale = cos(refAltRad) / horizLen;
      enu = vec3(enu.x * scale, enu.y * scale, sin(refAltRad));
    } else {
      enu.z = sin(refAltRad);
    }
  }
  outUzEnu = enu.z;
  bool altOk = altOkBase || (enu.z >= -0.0001);
  if (!altOk) return false;

  if (uMode < 3.5) {
    // free_direction, horizon_zoom, mid_sky, zenith
    float zc = dot(enu, uBasisFwd0);
    float denom = 1.0 + zc;
    if (zc < -0.82 || denom <= 1e-6) return false;
    float xc = dot(enu, uBasisRight0);
    float yc = dot(enu, uBasisUp0);
    outPx = vec2(
      uCenter.x + (xc / denom) * uStereoScale,
      uCenter.y - (yc / denom) * uStereoScale
    );
    return true;
  }

  if (uMode < 4.5) {
    // all_sky
    if (uShowBelowHorizon < 0.5 && enu.z < -0.258) return false;
    float altDeg = asin(clamp(enu.z, -1.0, 1.0)) * RAD2DEG;
    float rho = uAllSky.x * ((90.0 - altDeg) / 90.0);
    float rXy = length(enu.xy);
    if (rXy > 1e-12) {
      float sd = (enu.x * uAllSky.z - enu.y * uAllSky.y) / rXy;
      float cd = (enu.x * uAllSky.y + enu.y * uAllSky.z) / rXy;
      outPx = vec2(uCenter.x + rho * sd, uCenter.y + rho * cd);
    } else {
      outPx = vec2(uCenter.x, uCenter.y + rho);
    }
    return true;
  }

  if (uMode < 6.5) {
    // hemisphere_single (5) or hemisphere_dual (6)
    bool secondPanel = (uMode > 5.5) && (uPanel > 0.5);
    vec3 bFwd = secondPanel ? uBasisFwd1 : uBasisFwd0;
    vec3 bRight = secondPanel ? uBasisRight1 : uBasisRight0;
    vec3 bUp = secondPanel ? uBasisUp1 : uBasisUp0;
    vec3 hem = secondPanel ? uHem1 : uHem0;

    float zc = dot(enu, bFwd);
    float denom = 1.0 + zc;
    if (zc < -0.2 || denom <= 1e-6) return false;
    float xc = dot(enu, bRight);
    float yc = dot(enu, bUp);
    float sx = xc / denom;
    float sy = yc / denom;
    if (zc < -1e-6 || (sx * sx + sy * sy) > 1.00001) return false;
    outPx = vec2(hem.x + sx * hem.z, hem.y - sy * hem.z);
    return true;
  }

  // panorama (7)
  float altDeg = asin(clamp(enu.z, -1.0, 1.0)) * RAD2DEG;
  float rXy = length(enu.xy);
  float azDeg = rXy < 1e-12 ? 0.0 : wrapDeg360(atan(enu.x, enu.y) * RAD2DEG);
  float dAz = wrapDeg180(azDeg - uCenterAzAlt.x);
  outPx = vec2(
    uCenter.x + dAz * uPanoScale.x,
    uCenter.y - (altDeg - uCenterAzAlt.y) * uPanoScale.y
  );
  return true;
}
`;

const STAR_VERT = `
${GLSL_PROJECTION_COMMON}

attribute vec3 aVec;
attribute vec2 aMagCi;

uniform float uEffectiveLimit;
uniform float uLimitingMag;
uniform float uVis;
uniform float uNightVision;
uniform float uMaxPointSize;

varying vec3 vColor;
varying float vAlpha;
varying float vBright;
varying float vNightVision;

vec3 starColorFromBV(float ci, float nv) {
  if (nv > 0.5) {
    float warmth = clamp((ci + 0.2) * 0.45, 0.0, 1.0);
    return mix(vec3(1.0, 0.28, 0.24), vec3(0.92, 0.14, 0.14), warmth);
  }
  if (ci <= -0.08) return vec3(0.62, 0.78, 1.00);
  if (ci <= 0.18)  return mix(vec3(0.62, 0.78, 1.00), vec3(0.84, 0.90, 1.00), (ci + 0.08) / 0.26);
  if (ci <= 0.50)  return mix(vec3(0.84, 0.90, 1.00), vec3(0.98, 0.97, 0.96), (ci - 0.18) / 0.32);
  if (ci <= 0.90)  return mix(vec3(0.98, 0.97, 0.96), vec3(1.00, 0.93, 0.78), (ci - 0.50) / 0.40);
  if (ci <= 1.35)  return mix(vec3(1.00, 0.93, 0.78), vec3(1.00, 0.78, 0.55), (ci - 0.90) / 0.45);
  return vec3(1.00, 0.65, 0.45);
}

void main() {
  float mag = aMagCi.x;
  float ci = aMagCi.y;
  vNightVision = uNightVision;

  if (mag > uEffectiveLimit) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    vAlpha = 0.0;
    vBright = 0.0;
    return;
  }

  vec2 px;
  float uz;
  if (!projectJ2000ToCssPx(aVec, px, uz)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    vAlpha = 0.0;
    vBright = 0.0;
    return;
  }

  float marginCss = 36.0;
  if (
    px.x < -marginCss ||
    px.x > uViewport.x + marginCss ||
    px.y < -marginCss ||
    px.y > uViewport.y + marginCss
  ) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    vAlpha = 0.0;
    vBright = 0.0;
    return;
  }

  // Dual-hemisphere horizontal panel isolation
  if (uMode > 5.5 && uMode < 6.5) {
    float halfW = uViewport.x * 0.5;
    if ((uPanel < 0.5 && px.x > halfW + 16.0) || (uPanel > 0.5 && px.x < halfW - 16.0)) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      vColor = vec3(0.0);
      vAlpha = 0.0;
      vBright = 0.0;
      return;
    }
  }

  vAlpha = clamp((1.15 - (mag + 1.5) / (uLimitingMag + 2.5)) * max(0.25, uVis), 0.18, 1.0);
  vColor = starColorFromBV(ci, uNightVision);
  vBright = mag <= 2.4 ? 1.0 : 0.0;

  float sizeCss;
  if (mag <= 2.4) {
    sizeCss = clamp((4.2 - mag) * 4.6, 8.0, 30.0);
  } else {
    float rCss = clamp(2.75 - mag * 0.28, 0.65, 2.6);
    sizeCss = max(2.4, rCss * 2.5);
  }

  gl_PointSize = clamp(sizeCss * uDpr, 1.5, uMaxPointSize);
  vec2 ndc = vec2(
    (px.x / uViewport.x) * 2.0 - 1.0,
    1.0 - (px.y / uViewport.y) * 2.0
  );
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

const STAR_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec3 vColor;
varying float vAlpha;
varying float vBright;
varying float vNightVision;

void main() {
  if (vAlpha <= 0.001) discard;
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float d = length(uv);
  if (d > 1.0) discard;

  float core;
  float halo;
  if (vBright > 0.5) {
    core = exp(-d * d * 18.0);
    halo = exp(-d * 3.8) * 0.58;
  } else {
    core = exp(-d * d * 7.5);
    halo = smoothstep(1.0, 0.35, d) * 0.72;
  }
  float intensity = clamp(core + halo, 0.0, 1.0) * vAlpha;
  vec3 hotCore = vNightVision > 0.5 ? vec3(1.0, 0.52, 0.45) : vec3(1.0, 0.99, 0.98);
  vec3 rgb = mix(vColor, hotCore, clamp(core * 0.72, 0.0, 1.0));
  gl_FragColor = vec4(rgb * intensity, intensity);
}
`;

const DSO_VERT = `
${GLSL_PROJECTION_COMMON}

attribute vec2 aCorner;
attribute vec4 aVecMag;
attribute vec4 aGeom;
attribute float aMessier;

uniform float uDsoMagMax;
uniform float uPxPerDeg;
uniform float uDsoAlpha;
uniform vec3 uDsoColor;

varying vec2 vLocalCss;
varying float vRadiusCss;
varying float vRatio;
varying float vKind;
varying float vAlpha;
varying vec3 vColor;

void main() {
  vec3 vJ2000 = aVecMag.xyz;
  float mag = aVecMag.w;
  float majArcmin = aGeom.x;
  float axisRatio = clamp(aGeom.y, 0.18, 1.0);
  float posAngDeg = aGeom.z;
  float kindCode = aGeom.w;

  vColor = uDsoColor;
  vAlpha = 0.0;
  vRadiusCss = 4.5;
  vRatio = axisRatio;
  vKind = kindCode;
  vLocalCss = vec2(0.0);

  if (aMessier < 0.5 && mag > uDsoMagMax) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec2 px;
  float uz;
  if (!projectJ2000ToCssPx(vJ2000, px, uz)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float rCss = clamp((majArcmin / 120.0) * uPxPerDeg, 4.5, 28.0);
  float quadHalf = rCss * 1.45 + 2.5;
  if (
    px.x < -quadHalf ||
    px.x > uViewport.x + quadHalf ||
    px.y < -quadHalf ||
    px.y > uViewport.y + quadHalf
  ) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  if (uMode > 5.5 && uMode < 6.5) {
    float halfW = uViewport.x * 0.5;
    if ((uPanel < 0.5 && px.x > halfW + quadHalf) || (uPanel > 0.5 && px.x < halfW - quadHalf)) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
  }

  float rotRad = 0.0;
  if (kindCode < 0.5) {
    // Match ellipse orientation to local Celestial North + pos_ang_deg
    vec3 northRaw = vec3(-vJ2000.x * vJ2000.z, -vJ2000.y * vJ2000.z, 1.0 - vJ2000.z * vJ2000.z);
    float nLen = length(northRaw);
    float northRot = 0.0;
    if (nLen > 1e-4) {
      vec3 northStep = normalize(vJ2000 + (northRaw / nLen) * 0.0026);
      vec2 pxN;
      float uzN;
      if (projectJ2000ToCssPx(northStep, pxN, uzN)) {
        vec2 dN = pxN - px;
        if (length(dN) > 0.02) {
          northRot = atan(dN.y, dN.x) + PI * 0.5;
        }
      }
    }
    rotRad = northRot + posAngDeg * DEG2RAD;
  }

  vec2 local = aCorner * quadHalf;
  float cr = cos(rotRad);
  float sr = sin(rotRad);
  vec2 rotated = vec2(local.x * cr - local.y * sr, local.x * sr + local.y * cr);
  vec2 worldCss = px + rotated;

  vLocalCss = local;
  vRadiusCss = rCss;
  vAlpha = uDsoAlpha;

  vec2 ndc = vec2(
    (worldCss.x / uViewport.x) * 2.0 - 1.0,
    1.0 - (worldCss.y / uViewport.y) * 2.0
  );
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

const DSO_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec2 vLocalCss;
varying float vRadiusCss;
varying float vRatio;
varying float vKind;
varying float vAlpha;
varying vec3 vColor;

void main() {
  if (vAlpha <= 0.005) discard;
  float stroke = 0.0;
  float r = vRadiusCss;
  float halfW = 0.62;
  vec2 p = vLocalCss;

  if (vKind < 0.5) {
    // Galaxy: ellipse (x/ratio, y) == r
    vec2 ep = vec2(p.x / max(0.18, vRatio), p.y);
    float d = abs(length(ep) - r);
    // Approximate gradient compensation along semi-minor axis
    float gradScale = mix(max(0.25, vRatio), 1.0, abs(normalize(ep + vec2(1e-5)).y));
    stroke = 1.0 - smoothstep(halfW * 0.7, halfW + 0.9, d * gradScale);
  } else if (vKind < 1.5) {
    // Globular cluster: circle + cross
    float dRing = abs(length(p) - r);
    float ring = 1.0 - smoothstep(halfW * 0.7, halfW + 0.9, dRing);
    float crossH = (abs(p.x) <= r ? 1.0 : 0.0) * (1.0 - smoothstep(halfW * 0.7, halfW + 0.9, abs(p.y)));
    float crossV = (abs(p.y) <= r ? 1.0 : 0.0) * (1.0 - smoothstep(halfW * 0.7, halfW + 0.9, abs(p.x)));
    stroke = max(ring, max(crossH, crossV));
  } else if (vKind < 2.5) {
    // Open cluster: dashed circle
    float len = length(p);
    float dRing = abs(len - r);
    float angle = atan(p.y, p.x);
    float dashPhase = fract((angle * max(r, 4.5)) / 4.0);
    float dash = step(0.45, dashPhase);
    stroke = dash * (1.0 - smoothstep(halfW * 0.7, halfW + 0.9, dRing));
  } else if (vKind < 3.5) {
    // Planetary nebula: inner circle + 4 outer ticks
    float dRing = abs(length(p) - r * 0.75);
    float ring = 1.0 - smoothstep(halfW * 0.7, halfW + 0.9, dRing);
    float tickH = ((abs(p.x) >= r * 0.75 && abs(p.x) <= r * 1.3) ? 1.0 : 0.0) *
      (1.0 - smoothstep(halfW * 0.7, halfW + 0.9, abs(p.y)));
    float tickV = ((abs(p.y) >= r * 0.75 && abs(p.y) <= r * 1.3) ? 1.0 : 0.0) *
      (1.0 - smoothstep(halfW * 0.7, halfW + 0.9, abs(p.x)));
    stroke = max(ring, max(tickH, tickV));
  } else {
    // Diffuse nebula / SNR / other: dashed square
    vec2 q = abs(p) - vec2(r);
    float dBox = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    float edgeDist = abs(dBox);
    float coord = abs(q.x) > abs(q.y) ? p.y : p.x;
    float dash = step(0.4, fract((coord + r) / 5.0));
    stroke = dash * (1.0 - smoothstep(halfW * 0.7, halfW + 0.9, edgeDist));
  }

  float a = stroke * vAlpha;
  if (a <= 0.01) discard;
  gl_FragColor = vec4(vColor * a, a);
}
`;

function hexToRgb01(hex: string): [number, number, number] {
  const m = hex.trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return [0.22, 0.74, 0.97];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("WebGL createShader failed");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || "Shader compile error";
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function createProgram(
  gl: WebGLRenderingContext,
  vertSrc: string,
  fragSrc: string,
): WebGLProgram {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram();
  if (!prog) {
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    throw new Error("WebGL createProgram failed");
  }
  gl.attachShader(prog, vert);
  gl.attachShader(prog, frag);
  gl.linkProgram(prog);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) || "Program link error";
    gl.deleteProgram(prog);
    throw new Error(log);
  }
  return prog;
}

interface CommonUniformLocs {
  uEnuRow0: WebGLUniformLocation | null;
  uEnuRow1: WebGLUniformLocation | null;
  uEnuRow2: WebGLUniformLocation | null;
  uAppRow0: WebGLUniformLocation | null;
  uAppRow1: WebGLUniformLocation | null;
  uAppRow2: WebGLUniformLocation | null;
  uMode: WebGLUniformLocation | null;
  uViewport: WebGLUniformLocation | null;
  uDpr: WebGLUniformLocation | null;
  uStereoScale: WebGLUniformLocation | null;
  uCenter: WebGLUniformLocation | null;
  uPanoScale: WebGLUniformLocation | null;
  uAllSky: WebGLUniformLocation | null;
  uCenterAzAlt: WebGLUniformLocation | null;
  uBasisFwd0: WebGLUniformLocation | null;
  uBasisRight0: WebGLUniformLocation | null;
  uBasisUp0: WebGLUniformLocation | null;
  uBasisFwd1: WebGLUniformLocation | null;
  uBasisRight1: WebGLUniformLocation | null;
  uBasisUp1: WebGLUniformLocation | null;
  uHem0: WebGLUniformLocation | null;
  uHem1: WebGLUniformLocation | null;
  uPanel: WebGLUniformLocation | null;
  uRefraction: WebGLUniformLocation | null;
  uShowBelowHorizon: WebGLUniformLocation | null;
  uShowOppositeGround: WebGLUniformLocation | null;
}

function queryCommonUniforms(
  gl: WebGLRenderingContext,
  prog: WebGLProgram,
): CommonUniformLocs {
  return {
    uEnuRow0: gl.getUniformLocation(prog, "uEnuRow0"),
    uEnuRow1: gl.getUniformLocation(prog, "uEnuRow1"),
    uEnuRow2: gl.getUniformLocation(prog, "uEnuRow2"),
    uAppRow0: gl.getUniformLocation(prog, "uAppRow0"),
    uAppRow1: gl.getUniformLocation(prog, "uAppRow1"),
    uAppRow2: gl.getUniformLocation(prog, "uAppRow2"),
    uMode: gl.getUniformLocation(prog, "uMode"),
    uViewport: gl.getUniformLocation(prog, "uViewport"),
    uDpr: gl.getUniformLocation(prog, "uDpr"),
    uStereoScale: gl.getUniformLocation(prog, "uStereoScale"),
    uCenter: gl.getUniformLocation(prog, "uCenter"),
    uPanoScale: gl.getUniformLocation(prog, "uPanoScale"),
    uAllSky: gl.getUniformLocation(prog, "uAllSky"),
    uCenterAzAlt: gl.getUniformLocation(prog, "uCenterAzAlt"),
    uBasisFwd0: gl.getUniformLocation(prog, "uBasisFwd0"),
    uBasisRight0: gl.getUniformLocation(prog, "uBasisRight0"),
    uBasisUp0: gl.getUniformLocation(prog, "uBasisUp0"),
    uBasisFwd1: gl.getUniformLocation(prog, "uBasisFwd1"),
    uBasisRight1: gl.getUniformLocation(prog, "uBasisRight1"),
    uBasisUp1: gl.getUniformLocation(prog, "uBasisUp1"),
    uHem0: gl.getUniformLocation(prog, "uHem0"),
    uHem1: gl.getUniformLocation(prog, "uHem1"),
    uPanel: gl.getUniformLocation(prog, "uPanel"),
    uRefraction: gl.getUniformLocation(prog, "uRefraction"),
    uShowBelowHorizon: gl.getUniformLocation(prog, "uShowBelowHorizon"),
    uShowOppositeGround: gl.getUniformLocation(prog, "uShowOppositeGround"),
  };
}

export interface WebglRenderParams {
  width: number;
  height: number;
  dpr: number;
  params: ProjectionParams;
  frame: SkyFrame;
  location: LocationPreset;
  starBuffer: Float32Array | null;
  starCount: number;
  dsoBuffer: Float32Array | null;
  dsoCount: number;
  limitingMag: number;
  refractionEnabled: boolean;
  nightVision: boolean;
  dsoMarkersEnabled: boolean;
  zoomTexturesEnabled: boolean;
  dsoHexColor: string;
}

export class WebglSkyRenderer {
  readonly engine: Exclude<ActiveRenderEngine, "canvas2d">;
  readonly gpuInfo: string;
  readonly hasDsoInstancing: boolean;

  private readonly gl: WebGLRenderingContext;
  private readonly gl2: WebGL2RenderingContext | null;
  private readonly instExt: ANGLE_instanced_arrays | null;
  private readonly maxPointSize: number;

  private readonly starProg: WebGLProgram;
  private readonly starLocs: CommonUniformLocs & {
    aVec: number;
    aMagCi: number;
    uEffectiveLimit: WebGLUniformLocation | null;
    uLimitingMag: WebGLUniformLocation | null;
    uVis: WebGLUniformLocation | null;
    uNightVision: WebGLUniformLocation | null;
    uMaxPointSize: WebGLUniformLocation | null;
  };
  private readonly starVbo: WebGLBuffer;
  private uploadedStarRef: Float32Array | null = null;
  private uploadedStarCount = 0;

  private readonly dsoProg: WebGLProgram | null = null;
  private readonly dsoLocs: (CommonUniformLocs & {
    aCorner: number;
    aVecMag: number;
    aGeom: number;
    aMessier: number;
    uDsoMagMax: WebGLUniformLocation | null;
    uPxPerDeg: WebGLUniformLocation | null;
    uDsoAlpha: WebGLUniformLocation | null;
    uDsoColor: WebGLUniformLocation | null;
  }) | null = null;
  private readonly dsoQuadVbo: WebGLBuffer | null = null;
  private readonly dsoVbo: WebGLBuffer | null = null;
  private uploadedDsoRef: Float32Array | null = null;
  private uploadedDsoCount = 0;

  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    const attrs: WebGLContextAttributes = {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    };

    const gl2 = canvas.getContext("webgl2", attrs) as WebGL2RenderingContext | null;
    let gl: WebGLRenderingContext | null = gl2;
    let engine: Exclude<ActiveRenderEngine, "canvas2d"> = "webgl2";

    if (!gl) {
      gl =
        (canvas.getContext("webgl", attrs) as WebGLRenderingContext | null) ??
        (canvas.getContext("experimental-webgl", attrs) as WebGLRenderingContext | null);
      engine = "webgl1";
    }

    if (!gl) {
      throw new Error("WebGL2 および WebGL1 コンテキストを取得できませんでした。");
    }

    this.gl = gl;
    this.gl2 = gl2;
    this.engine = engine;
    this.instExt = gl2 ? null : gl.getExtension("ANGLE_instanced_arrays");
    this.hasDsoInstancing = Boolean(gl2 || this.instExt);

    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const rendererStr = dbg
      ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string | null)
      : (gl.getParameter(gl.RENDERER) as string | null);
    this.gpuInfo = `${engine.toUpperCase()}${rendererStr ? ` · ${rendererStr}` : ""}`;

    const ptRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | number[] | null;
    this.maxPointSize =
      ptRange && ptRange.length >= 2 && Number.isFinite(ptRange[1])
        ? Math.max(8, Math.min(128, ptRange[1]))
        : 64;

    this.starProg = createProgram(gl, STAR_VERT, STAR_FRAG);
    const starVbo = gl.createBuffer();
    if (!starVbo) throw new Error("Failed to allocate WebGL star VBO");
    this.starVbo = starVbo;

    this.starLocs = {
      ...queryCommonUniforms(gl, this.starProg),
      aVec: gl.getAttribLocation(this.starProg, "aVec"),
      aMagCi: gl.getAttribLocation(this.starProg, "aMagCi"),
      uEffectiveLimit: gl.getUniformLocation(this.starProg, "uEffectiveLimit"),
      uLimitingMag: gl.getUniformLocation(this.starProg, "uLimitingMag"),
      uVis: gl.getUniformLocation(this.starProg, "uVis"),
      uNightVision: gl.getUniformLocation(this.starProg, "uNightVision"),
      uMaxPointSize: gl.getUniformLocation(this.starProg, "uMaxPointSize"),
    };

    if (this.hasDsoInstancing) {
      this.dsoProg = createProgram(gl, DSO_VERT, DSO_FRAG);
      this.dsoQuadVbo = gl.createBuffer();
      this.dsoVbo = gl.createBuffer();
      if (!this.dsoQuadVbo || !this.dsoVbo) {
        throw new Error("Failed to allocate WebGL DSO buffers");
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dsoQuadVbo);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
      this.dsoLocs = {
        ...queryCommonUniforms(gl, this.dsoProg),
        aCorner: gl.getAttribLocation(this.dsoProg, "aCorner"),
        aVecMag: gl.getAttribLocation(this.dsoProg, "aVecMag"),
        aGeom: gl.getAttribLocation(this.dsoProg, "aGeom"),
        aMessier: gl.getAttribLocation(this.dsoProg, "aMessier"),
        uDsoMagMax: gl.getUniformLocation(this.dsoProg, "uDsoMagMax"),
        uPxPerDeg: gl.getUniformLocation(this.dsoProg, "uPxPerDeg"),
        uDsoAlpha: gl.getUniformLocation(this.dsoProg, "uDsoAlpha"),
        uDsoColor: gl.getUniformLocation(this.dsoProg, "uDsoColor"),
      };
    }

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private setAttribDivisor(loc: number, divisor: number): void {
    if (loc < 0) return;
    if (this.gl2) {
      this.gl2.vertexAttribDivisor(loc, divisor);
    } else if (this.instExt) {
      this.instExt.vertexAttribDivisorANGLE(loc, divisor);
    }
  }

  private applyCommonUniforms(
    locs: CommonUniformLocs,
    pCtx: ReturnType<typeof compileProjectionContext>,
    mJ2000ToEnu: Float64Array,
    mJ2000ToApp: Float64Array,
    dpr: number,
    refractionEnabled: boolean,
    showOppositeGroundSky: boolean,
    panel: number,
  ): void {
    const gl = this.gl;
    const isChart = pCtx.params.mode === "star_chart";
    const b0 = isChart ? pCtx.eqBasis : pCtx.basis0;
    const b1 = pCtx.basis1 ?? b0;

    gl.uniform3f(locs.uEnuRow0, mJ2000ToEnu[0], mJ2000ToEnu[1], mJ2000ToEnu[2]);
    gl.uniform3f(locs.uEnuRow1, mJ2000ToEnu[3], mJ2000ToEnu[4], mJ2000ToEnu[5]);
    gl.uniform3f(locs.uEnuRow2, mJ2000ToEnu[6], mJ2000ToEnu[7], mJ2000ToEnu[8]);
    gl.uniform3f(locs.uAppRow0, mJ2000ToApp[0], mJ2000ToApp[1], mJ2000ToApp[2]);
    gl.uniform3f(locs.uAppRow1, mJ2000ToApp[3], mJ2000ToApp[4], mJ2000ToApp[5]);
    gl.uniform3f(locs.uAppRow2, mJ2000ToApp[6], mJ2000ToApp[7], mJ2000ToApp[8]);

    gl.uniform1f(locs.uMode, PROJ_MODE_CODE[pCtx.params.mode]);
    gl.uniform2f(locs.uViewport, pCtx.params.width, pCtx.params.height);
    gl.uniform1f(locs.uDpr, dpr);
    gl.uniform1f(locs.uStereoScale, pCtx.stereoScalePx);
    gl.uniform2f(locs.uCenter, pCtx.cx, pCtx.cy);
    gl.uniform2f(locs.uPanoScale, pCtx.panoScaleX, pCtx.panoScaleY);
    gl.uniform3f(
      locs.uAllSky,
      pCtx.allSkyRadius,
      pCtx.allSkySinAz0,
      pCtx.allSkyCosAz0,
    );
    gl.uniform2f(locs.uCenterAzAlt, pCtx.params.center_az_deg, pCtx.params.center_alt_deg);

    gl.uniform3f(locs.uBasisFwd0, b0.fx, b0.fy, b0.fz);
    gl.uniform3f(locs.uBasisRight0, b0.rx, b0.ry, b0.rz);
    gl.uniform3f(locs.uBasisUp0, b0.ux, b0.uy, b0.uz);
    gl.uniform3f(locs.uBasisFwd1, b1.fx, b1.fy, b1.fz);
    gl.uniform3f(locs.uBasisRight1, b1.rx, b1.ry, b1.rz);
    gl.uniform3f(locs.uBasisUp1, b1.ux, b1.uy, b1.uz);
    gl.uniform3f(locs.uHem0, pCtx.hemCx0, pCtx.hemCy0, pCtx.hemRadius0);
    gl.uniform3f(locs.uHem1, pCtx.hemCx1, pCtx.hemCy1, pCtx.hemRadius1);

    gl.uniform1f(locs.uPanel, panel);
    gl.uniform1f(locs.uRefraction, refractionEnabled ? 1 : 0);
    gl.uniform1f(locs.uShowBelowHorizon, pCtx.params.show_below_horizon ? 1 : 0);
    gl.uniform1f(locs.uShowOppositeGround, showOppositeGroundSky ? 1 : 0);
  }

  clear(): void {
    if (this.disposed) return;
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  render(args: WebglRenderParams): void {
    if (this.disposed) return;
    const gl = this.gl;
    if (gl.isContextLost()) return;

    const {
      width,
      height,
      dpr,
      params,
      frame,
      location,
      starBuffer,
      starCount,
      dsoBuffer,
      dsoCount,
      limitingMag,
      refractionEnabled,
      nightVision,
      dsoMarkersEnabled,
      zoomTexturesEnabled,
      dsoHexColor,
    } = args;

    const targetW = Math.round(width * dpr);
    const targetH = Math.round(height * dpr);
    gl.viewport(0, 0, targetW, targetH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const pCtx = compileProjectionContext(params);
    const showOppositeGroundSky = !(
      params.mode === "all_sky" ||
      params.mode === "hemisphere_single" ||
      params.mode === "hemisphere_dual"
    );
    const skyPCtx =
      params.show_below_horizon || !showOppositeGroundSky
        ? pCtx
        : compileProjectionContext({ ...params, show_below_horizon: true });

    const mJ2000ToApp = flattenMat3(frame.j2000_to_apparent_matrix);
    const mJ2000ToEnu = frame.j2000_to_enu_override
      ? flattenMat3(frame.j2000_to_enu_override)
      : buildJ2000ToEnuMatrix(
          frame.j2000_to_apparent_matrix,
          frame.last_deg,
          location.lat_deg,
        );
    const panels = params.mode === "hemisphere_dual" ? [0, 1] : [0];
    const vis = frame.sky_palette.star_visibility_factor;
    const isOtherStar = frame.view_mode === "other_star";
    const effFov = effectiveFovDeg(params.mode, params.fov_deg) / Math.max(0.2, params.zoom);
    const pxPerDeg = Math.min(width, height) / Math.max(0.25, effFov);

    // 1. DSO instanced markers (rendered just underneath stars)
    if (
      this.hasDsoInstancing &&
      this.dsoProg &&
      this.dsoLocs &&
      this.dsoVbo &&
      this.dsoQuadVbo &&
      dsoMarkersEnabled &&
      !isOtherStar &&
      vis > 0.25 &&
      dsoBuffer &&
      dsoCount > 0
    ) {
      if (this.uploadedDsoRef !== dsoBuffer) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.dsoVbo);
        gl.bufferData(gl.ARRAY_BUFFER, dsoBuffer, gl.STATIC_DRAW);
        this.uploadedDsoRef = dsoBuffer;
        this.uploadedDsoCount = Math.min(dsoCount, Math.floor(dsoBuffer.length / DSO_STRIDE));
      }
      if (this.uploadedDsoCount > 0) {
        const dsoLocs = this.dsoLocs;
        gl.useProgram(this.dsoProg);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.dsoQuadVbo);
        if (dsoLocs.aCorner >= 0) {
          gl.enableVertexAttribArray(dsoLocs.aCorner);
          gl.vertexAttribPointer(dsoLocs.aCorner, 2, gl.FLOAT, false, 8, 0);
          this.setAttribDivisor(dsoLocs.aCorner, 0);
        }

        const strideBytes = DSO_STRIDE * 4;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.dsoVbo);
        if (dsoLocs.aVecMag >= 0) {
          gl.enableVertexAttribArray(dsoLocs.aVecMag);
          gl.vertexAttribPointer(dsoLocs.aVecMag, 4, gl.FLOAT, false, strideBytes, 0);
          this.setAttribDivisor(dsoLocs.aVecMag, 1);
        }
        if (dsoLocs.aGeom >= 0) {
          gl.enableVertexAttribArray(dsoLocs.aGeom);
          gl.vertexAttribPointer(dsoLocs.aGeom, 4, gl.FLOAT, false, strideBytes, 16);
          this.setAttribDivisor(dsoLocs.aGeom, 1);
        }
        if (dsoLocs.aMessier >= 0) {
          gl.enableVertexAttribArray(dsoLocs.aMessier);
          gl.vertexAttribPointer(dsoLocs.aMessier, 1, gl.FLOAT, false, strideBytes, 32);
          this.setAttribDivisor(dsoLocs.aMessier, 1);
        }

        const [dr, dg, db] = nightVision ? [0.86, 0.2, 0.2] : hexToRgb01(dsoHexColor);
        const dsoAlpha = (zoomTexturesEnabled && effFov < 30 ? 0.42 : 1.0) * 0.85;
        gl.uniform1f(dsoLocs.uDsoMagMax, Math.min(12.8, limitingMag + 3.6));
        gl.uniform1f(dsoLocs.uPxPerDeg, pxPerDeg);
        gl.uniform1f(dsoLocs.uDsoAlpha, dsoAlpha);
        gl.uniform3f(dsoLocs.uDsoColor, dr, dg, db);

        for (const panel of panels) {
          this.applyCommonUniforms(
            dsoLocs,
            skyPCtx,
            mJ2000ToEnu,
            mJ2000ToApp,
            dpr,
            refractionEnabled,
            showOppositeGroundSky,
            panel,
          );
          if (this.gl2) {
            this.gl2.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.uploadedDsoCount);
          } else if (this.instExt) {
            this.instExt.drawArraysInstancedANGLE(
              gl.TRIANGLE_STRIP,
              0,
              4,
              this.uploadedDsoCount,
            );
          }
        }

        // Reset divisors before drawing non-instanced star points
        this.setAttribDivisor(dsoLocs.aVecMag, 0);
        this.setAttribDivisor(dsoLocs.aGeom, 0);
        this.setAttribDivisor(dsoLocs.aMessier, 0);
        if (dsoLocs.aCorner >= 0) gl.disableVertexAttribArray(dsoLocs.aCorner);
        if (dsoLocs.aVecMag >= 0) gl.disableVertexAttribArray(dsoLocs.aVecMag);
        if (dsoLocs.aGeom >= 0) gl.disableVertexAttribArray(dsoLocs.aGeom);
        if (dsoLocs.aMessier >= 0) gl.disableVertexAttribArray(dsoLocs.aMessier);
      }
    }

    // 2. Stars (120,000+ point sprites culled in vertex shader by mag, hemisphere & screen)
    if (starBuffer && starCount > 0) {
      if (this.uploadedStarRef !== starBuffer) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.starVbo);
        gl.bufferData(gl.ARRAY_BUFFER, starBuffer, gl.STATIC_DRAW);
        this.uploadedStarRef = starBuffer;
        this.uploadedStarCount = Math.min(starCount, Math.floor(starBuffer.length / STAR_STRIDE));
      }
      if (this.uploadedStarCount > 0) {
        const starLocs = this.starLocs;
        gl.useProgram(this.starProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.starVbo);

        const strideBytes = STAR_STRIDE * 4;
        if (starLocs.aVec >= 0) {
          gl.enableVertexAttribArray(starLocs.aVec);
          gl.vertexAttribPointer(starLocs.aVec, 3, gl.FLOAT, false, strideBytes, 0);
        }
        if (starLocs.aMagCi >= 0) {
          gl.enableVertexAttribArray(starLocs.aMagCi);
          gl.vertexAttribPointer(starLocs.aMagCi, 2, gl.FLOAT, false, strideBytes, 12);
        }

        const effectiveLimit =
          vis < 0.25 ? Math.min(limitingMag, 2.2) : vis < 0.7 ? limitingMag - 1.5 : limitingMag;
        gl.uniform1f(starLocs.uEffectiveLimit, effectiveLimit);
        gl.uniform1f(starLocs.uLimitingMag, limitingMag);
        gl.uniform1f(starLocs.uVis, vis);
        gl.uniform1f(starLocs.uNightVision, nightVision ? 1 : 0);
        gl.uniform1f(starLocs.uMaxPointSize, this.maxPointSize);

        for (const panel of panels) {
          this.applyCommonUniforms(
            starLocs,
            skyPCtx,
            mJ2000ToEnu,
            mJ2000ToApp,
            dpr,
            refractionEnabled,
            showOppositeGroundSky,
            panel,
          );
          gl.drawArrays(gl.POINTS, 0, this.uploadedStarCount);
        }

        if (starLocs.aVec >= 0) gl.disableVertexAttribArray(starLocs.aVec);
        if (starLocs.aMagCi >= 0) gl.disableVertexAttribArray(starLocs.aMagCi);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    gl.deleteBuffer(this.starVbo);
    gl.deleteProgram(this.starProg);
    if (this.dsoQuadVbo) gl.deleteBuffer(this.dsoQuadVbo);
    if (this.dsoVbo) gl.deleteBuffer(this.dsoVbo);
    if (this.dsoProg) gl.deleteProgram(this.dsoProg);
    this.uploadedStarRef = null;
    this.uploadedDsoRef = null;
  }
}

export function normalizeRenderEnginePreference(raw: unknown): "auto" | "webgl" | "canvas2d" {
  if (raw === "webgl" || raw === "canvas2d" || raw === "auto") return raw;
  return "auto";
}
