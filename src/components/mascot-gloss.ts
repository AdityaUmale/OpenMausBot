/**
 * The mascot's glossy material: a body outline lit as a soft, rounded plastic
 * form, baked once to an image the SVG mascot lays over its flat body.
 *
 * The material model is adapted from bot-avatars' `plastic` shading
 * (https://github.com/Jakubantalik/Libraries.dev, packages/bot-avatars,
 * MIT © Jakub Antalík). It is reimplemented here rather than installed: only
 * the lighting is used, not the package's shapes, rig or canvas renderer.
 *
 *   1. The outline is rasterized and inflated into a pillow height field by
 *      solving ∇²φ = −1 inside it (lobes become domes, points become tubes,
 *      the cusps between them fall into shadow); height is √φ.
 *   2. Each pixel's normal and ambient occlusion come from that field.
 *   3. The normal looks up a lit sphere: wrap-around diffuse with saturated
 *      shadows, a tight hot spot plus a broad sheen, a Fresnel rim under a
 *      cool sky, and a soft window reflection.
 *
 * Our mascot never turns in 3D, so unlike the package the light is fixed and
 * the result can be baked once per (body, colour, resolution) and cached.
 * Everything that animates stays in the SVG.
 */

import { FACE_BOX } from "./cursor-face-data";

/* ------------------------------------------------------------------ tuning */

/** Degrees clockwise from the top the light comes from. */
const LIGHT_ANGLE = 300;
/** Light elevation above the picture plane. */
const LIGHT_ELEVATION = (48 * Math.PI) / 180;
/** Strength of the shadow side, 0–2. */
const SHADOW = 0.35;
/** Strength of the lit side, 0–2. */
const HIGHLIGHT = 1.3;
/** Width of the highlight, 0.4–2.5. */
const SPREAD = 1.55;
/** Fresnel strength, 0–2. */
const RIM = 0.5;
/** How thick the pillow is: its height, in outline units (outline ≈ 100). */
const DEPTH = 9.75;
/** HSL saturation added to the body colour: the material reads a touch more vivid than the swatch. */
const SATURATION_BOOST = 0.25;

/* ------------------------------------------------------------------ layout */

/** The bake works in a 100-unit outline space with this margin on every side. */
const MARGIN = 3;
const SPAN = 100 + 2 * MARGIN;
/** Face-box units per outline unit. */
const FACE_PER_UNIT = FACE_BOX / 100;

/** Where the baked image sits in the mascot's face-box coordinates. */
export const GLOSS_BOX = {
  x: -MARGIN * FACE_PER_UNIT,
  y: -MARGIN * FACE_PER_UNIT,
  size: SPAN * FACE_PER_UNIT,
};

/** Bake resolution for a mascot drawn this many device pixels wide. The shading is soft, so it upsamples cleanly. */
export function glossResolution(devicePixels: number): number {
  return devicePixels <= 100 ? 64 : devicePixels <= 224 ? 96 : 128;
}

/* ------------------------------------------------------------ height field */

const FAR = 1e12;

/** One row of the Felzenszwalb squared Euclidean distance transform. */
function distance1d(
  f: Float32Array,
  n: number,
  d: Float32Array,
  nearest: Int32Array,
  v: Int32Array,
  z: Float32Array,
) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
    nearest[q] = p;
  }
}

/**
 * Squared distance from every pixel to the nearest pixel whose mask equals
 * `target`, plus (optionally) that pixel's index.
 */
function distanceTransform(mask: Uint8Array, target: number, n: number, out: Float32Array, nearestOut?: Int32Array) {
  const f = new Float32Array(n);
  const d = new Float32Array(n);
  const nearest = new Int32Array(n);
  const v = new Int32Array(n);
  const z = new Float32Array(n + 1);
  const columns = new Float32Array(n * n);
  const columnNearest = new Int32Array(n * n);
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) f[y] = mask[y * n + x] === target ? 0 : FAR;
    distance1d(f, n, d, nearest, v, z);
    for (let y = 0; y < n; y++) {
      columns[y * n + x] = d[y];
      columnNearest[y * n + x] = nearest[y];
    }
  }
  for (let y = 0; y < n; y++) {
    const row = y * n;
    for (let x = 0; x < n; x++) f[x] = columns[row + x];
    distance1d(f, n, d, nearest, v, z);
    for (let x = 0; x < n; x++) {
      out[row + x] = d[x];
      if (nearestOut) nearestOut[row + x] = columnNearest[row + nearest[x]] * n + nearest[x];
    }
  }
}

/** A separable 1-4-6-4-1 blur, in place. */
function blur(field: Float32Array, n: number, scratch: Float32Array) {
  const at = (i: number) => (i < 0 ? 0 : i > n - 1 ? n - 1 : i);
  for (let y = 0; y < n; y++) {
    const row = y * n;
    for (let x = 0; x < n; x++) {
      scratch[row + x] =
        (field[row + at(x - 2)] + 4 * field[row + at(x - 1)] + 6 * field[row + x] + 4 * field[row + at(x + 1)] + field[row + at(x + 2)]) *
        0.0625;
    }
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      field[y * n + x] =
        (scratch[at(y - 2) * n + x] + 4 * scratch[at(y - 1) * n + x] + 6 * scratch[y * n + x] + 4 * scratch[at(y + 1) * n + x] + scratch[at(y + 2) * n + x]) *
        0.0625;
    }
  }
}

/**
 * Solves ∇²φ = −1 inside the outline (φ = 0 outside) coarse-to-fine: the
 * coarse grids carry the long-range shape, the fine grid the detail.
 */
export function pillow(alpha: Uint8ClampedArray, n: number, unit: number): Float32Array {
  type Level = { n: number; mask: Uint8Array; phi: Float32Array };
  const levels: Level[] = [];
  for (let size = n, step = 1; step <= 4; size >>= 1, step <<= 1) {
    const mask = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sum = 0;
        for (let dy = 0; dy < step; dy++) for (let dx = 0; dx < step; dx++) sum += alpha[(y * step + dy) * n + x * step + dx];
        mask[y * size + x] = sum >= 128 * step * step ? 1 : 0;
      }
    }
    levels.push({ n: size, mask, phi: new Float32Array(size * size) });
    if (size % 2 !== 0) break;
  }

  const relax = ({ n: size, mask, phi }: Level, spacing: number, iterations: number, omega: number) => {
    const source = spacing * spacing;
    for (let it = 0; it < iterations; it++) {
      for (let y = 1; y < size - 1; y++) {
        const row = y * size;
        for (let x = 1; x < size - 1; x++) {
          const i = row + x;
          if (!mask[i]) continue;
          const target = (phi[i - 1] + phi[i + 1] + phi[i - size] + phi[i + size] + source) * 0.25;
          phi[i] += omega * (target - phi[i]);
        }
      }
    }
  };

  for (let index = levels.length - 1; index >= 0; index--) {
    const level = levels[index];
    const scale = 1 << index;
    if (index < levels.length - 1) {
      // Seed from the coarser solution, bilinearly.
      const coarse = levels[index + 1];
      const size = level.n;
      const coarseN = coarse.n;
      for (let y = 0; y < size; y++) {
        const cy = Math.min(coarseN - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
        const y0 = cy | 0;
        const y1 = Math.min(coarseN - 1, y0 + 1);
        const ty = cy - y0;
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          if (!level.mask[i]) continue;
          const cx = Math.min(coarseN - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
          const x0 = cx | 0;
          const x1 = Math.min(coarseN - 1, x0 + 1);
          const tx = cx - x0;
          level.phi[i] =
            (coarse.phi[y0 * coarseN + x0] * (1 - tx) + coarse.phi[y0 * coarseN + x1] * tx) * (1 - ty) +
            (coarse.phi[y1 * coarseN + x0] * (1 - tx) + coarse.phi[y1 * coarseN + x1] * tx) * ty;
        }
      }
    }
    const omega = Math.min(1.9, 2 / (1 + Math.sin(Math.PI / level.n)) - 0.05);
    const spacing = unit * scale;
    relax(level, spacing, 4, 1);
    relax(level, spacing, index === 2 ? 100 : index === 1 ? 30 : 16, omega);
    relax(level, spacing, 8, 1);
  }
  return levels[0].phi;
}

/** Per pixel: which lit-sphere cell its normal looks up, and how occluded it is. 0 occlusion = outside. */
export interface GlossForm {
  n: number;
  normalX: Float32Array;
  normalY: Float32Array;
  occlusion: Uint8Array;
}

const DIR_X = [1, 1, 0, -1, -1, -1, 0, 1];
const DIR_Y = [0, 1, 1, 1, 0, -1, -1, -1];
const DIR_LENGTH = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];

/** Turns an outline's coverage (one alpha byte per pixel) into normals and occlusion. */
export function glossForm(alpha: Uint8ClampedArray, n: number): GlossForm {
  const unit = SPAN / n;
  const size = n * n;
  const inside = new Uint8Array(size);
  for (let i = 0; i < size; i++) inside[i] = alpha[i] >= 128 ? 1 : 0;

  const toOutside = new Float32Array(size);
  const toInside = new Float32Array(size);
  const nearestInside = new Int32Array(size);
  distanceTransform(inside, 0, n, toOutside);
  distanceTransform(inside, 1, n, toInside, nearestInside);

  // Signed distance to the edge, in outline units, positive inside.
  const signed = new Float32Array(size);
  const scratch = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const coverage = alpha[i] / 255;
    signed[i] =
      unit *
      (coverage > 0 && coverage < 1
        ? coverage - 0.5
        : inside[i]
          ? Math.sqrt(toOutside[i]) - 0.5
          : 0.5 - Math.sqrt(toInside[i]));
  }
  blur(signed, n, scratch);
  blur(signed, n, scratch);

  const phi = pillow(alpha, n, unit);
  let peak = 0;
  for (let i = 0; i < size; i++) if (phi[i] > peak) peak = phi[i];
  const natural = 2 * Math.sqrt(peak);
  const thickness = Math.min(0.9 * DEPTH + 0.12 * natural, 1.2 * natural);
  const lift = peak > 0 ? thickness / Math.sqrt(peak) : 0;
  const height = new Float32Array(size);
  for (let i = 0; i < size; i++) height[i] = phi[i] > 0 ? lift * Math.sqrt(phi[i]) : 0;
  blur(height, n, scratch);

  const normalX = new Float32Array(size);
  const normalY = new Float32Array(size);
  const occlusion = new Uint8Array(size);
  const steps = n <= 64 ? [1, 2, 3, 5, 8] : n <= 96 ? [1, 2, 4, 7, 11] : [1, 2, 4, 7, 11, 15];
  const last = n - 1;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      // Anti-aliased edge pixels just outside borrow the nearest inside pixel's shading.
      const source = inside[i] ? i : toInside[i] <= 9 ? nearestInside[i] : -1;
      if (source < 0) continue;
      const sx = source % n;
      const sy = (source - sx) / n;
      const left = sx > 0 ? sx - 1 : 0;
      const right = sx < last ? sx + 1 : last;
      const up = sy > 0 ? sy - 1 : 0;
      const down = sy < last ? sy + 1 : last;

      let nx = -(height[sy * n + right] - height[sy * n + left]) / (2 * unit);
      let ny = -(height[down * n + sx] - height[up * n + sx]) / (2 * unit);
      let nz = 1;
      let length = Math.sqrt(nx * nx + ny * ny + 1);
      nx /= length;
      ny /= length;
      nz /= length;

      // Roll the normal outward over the last couple of units, so the edge turns away.
      const depth = Math.max(0, signed[source]);
      if (depth < 2) {
        let ex = signed[sy * n + right] - signed[sy * n + left];
        let ey = signed[down * n + sx] - signed[up * n + sx];
        const edge = Math.hypot(ex, ey) || 1;
        ex /= edge;
        ey /= edge;
        const roll = 0.7 * (1 - depth / 2);
        nx += roll * (-ex - nx);
        ny += roll * (-ey - ny);
        nz += roll * (0 - nz);
        length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= length;
        ny /= length;
      }

      // Horizon-based occlusion over eight directions.
      const here = height[source];
      let horizon = 0;
      for (let d = 0; d < 8; d++) {
        let steepest = 0;
        for (const step of steps) {
          let px = sx + DIR_X[d] * step;
          let py = sy + DIR_Y[d] * step;
          px = px < 0 ? 0 : px > last ? last : px;
          py = py < 0 ? 0 : py > last ? last : py;
          const slope = (height[py * n + px] - here) / (step * unit * DIR_LENGTH[d]);
          if (slope > steepest) steepest = slope;
        }
        horizon += steepest / Math.sqrt(1 + steepest * steepest);
      }
      const nearEdge = 1 - Math.min(1, depth / 3);
      const edgeFalloff = 1 - 0.2 * nearEdge * nearEdge;
      const open = Math.pow(1 - (0.9 * horizon) / 8, 1.5) * edgeFalloff;
      occlusion[i] = Math.max(1, Math.round(255 * Math.pow(open, 1 / 2.2)));
      normalX[i] = nx;
      normalY[i] = ny;
    }
  }
  return { n, normalX, normalY, occlusion };
}

/* -------------------------------------------------------------- lit sphere */

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smoothstep = (a: number, b: number, v: number) => {
  const t = v <= a ? 0 : v >= b ? 1 : (v - a) / (b - a);
  return t * t * (3 - 2 * t);
};
/** 1 inside ±centre, fading to 0 over ±soft. */
const band = (centre: number, soft: number, v: number) => 1 - smoothstep(centre - soft, centre + soft, v);
const normalize = (v: [number, number, number]): [number, number, number] => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
/** Linear light to an sRGB byte, rolling highlights off above 0.75 instead of clipping them. */
const toByte = (v: number) => {
  const soft = v <= 0.75 ? Math.max(0, v) : 0.75 + 0.25 * (1 - Math.exp(-(v - 0.75) / 0.25));
  const encoded = soft <= 0.0031308 ? 12.92 * soft : 1.055 * Math.pow(soft, 1 / 2.4) - 0.055;
  return 255 * encoded;
};

const SPECULAR = [1, 0.98, 0.95];
const SKY = [0.92, 0.96, 1];

/** The material's colour for a surface facing (nx, ny, √(1−nx²−ny²)), as sRGB bytes. */
export function litSphere(base: [number, number, number]) {
  const angle = (LIGHT_ANGLE * Math.PI) / 180;
  const lx = Math.sin(angle);
  const ly = -Math.cos(angle);
  const light = normalize([Math.cos(LIGHT_ELEVATION) * lx, Math.cos(LIGHT_ELEVATION) * ly, Math.sin(LIGHT_ELEVATION)]);
  const view = [0, 0, 1];
  const half = normalize([light[0], light[1], light[2] + 1]);
  const lateral = [lx, ly, 0];
  const wx = Math.cos((80 * Math.PI) / 180) * lx - Math.sin((80 * Math.PI) / 180) * ly;
  const wy = Math.sin((80 * Math.PI) / 180) * lx + Math.cos((80 * Math.PI) / 180) * ly;
  const window = normalize([0.55 * wx, 0.55 * wy, 0.83]);
  const across = normalize([window[1], -window[0], 0]);
  const upward = [
    window[1] * across[2] - window[2] * across[1],
    window[2] * across[0] - window[0] * across[2],
    window[0] * across[1] - window[1] * across[0],
  ];

  const albedo = base.map((c) => toLinear(c / 255)) as [number, number, number];
  const peak = Math.max(albedo[0], albedo[1], albedo[2], 0.05);
  // Shadows keep the hue at full chroma instead of going grey.
  const ambient = Math.max(0.03, 0.3 - 0.15 * SHADOW);
  const shadowTint = albedo.map((c) => (ambient * c) / peak);
  const wrap = 0.15 + 0.14 * SPREAD;
  const hotExponent = Math.min(90, Math.round(110 / Math.pow(SPREAD, 1.3)));
  const sheenExponent = Math.max(2, Math.round(8 / SPREAD));
  const hot = 0.45 * HIGHLIGHT;
  const sheen = 0.1 * HIGHLIGHT;
  const windowStrength = 0.11 * HIGHLIGHT;
  const rim = 0.3 * RIM;

  return (nx: number, ny: number): [number, number, number] => {
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    const normal = [nx, ny, nz];
    const facing = Math.max(0, nz);
    const diffuse = clamp01((dot(normal, light) + wrap) / (1 + wrap));
    const glancing = 1 - facing;
    const fresnel3 = glancing * glancing * glancing;
    const fresnel5 = fresnel3 * glancing * glancing;
    const toward = Math.max(0, dot(normal, half));
    const specular = (hot * Math.pow(toward, hotExponent) + sheen * Math.pow(toward, sheenExponent)) * (1 + 3 * fresnel5);
    const reflected = [2 * facing * nx - view[0], 2 * facing * ny - view[1], 2 * facing * nz - view[2]];
    const skyLit = 0.45 + 0.55 * smoothstep(-0.4, 0.6, dot(reflected, lateral));
    const intoWindow = dot(reflected, window);
    let pane = 0;
    if (intoWindow > 0.5) {
      pane = band(0.34, 0.12, Math.abs(dot(reflected, across) / intoWindow)) * band(0.12, 0.06, Math.abs(dot(reflected, upward) / intoWindow));
    }
    const reflection = rim * fresnel3 * skyLit + windowStrength * pane;
    return [0, 1, 2].map((c) =>
      toByte(albedo[c] * (shadowTint[c] + 0.85 * diffuse) + specular * SPECULAR[c] + reflection * SKY[c]),
    ) as [number, number, number];
  };
}

/* ------------------------------------------------------------------ colour */

function parseHex(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", "").slice(0, 6), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** The swatch with its HSL saturation raised by `boost`. */
export function vivid(hex: string, boost = SATURATION_BOOST): [number, number, number] {
  const [r, g, b] = parseHex(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [r * 255, g * 255, b * 255];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const sat = clamp01(s + boost);
  const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
  const p = 2 * l - q;
  const channel = (t: number) => {
    t = ((t % 1) + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  return [channel(h / 6 + 1 / 3) * 255, channel(h / 6) * 255, channel(h / 6 - 1 / 3) * 255];
}

/* -------------------------------------------------------------------- bake */

/** Writes the lit body into `pixels` (RGBA, n×n). */
export function shade(form: GlossForm, colour: string, pixels: Uint8ClampedArray) {
  const lit = litSphere(vivid(colour));
  const aoStrength = Math.min(1.3, 1.2 * SHADOW);
  for (let i = 0, o = 0; i < form.n * form.n; i++, o += 4) {
    const occlusion = form.occlusion[i];
    if (occlusion === 0) {
      pixels[o + 3] = 0;
      continue;
    }
    const [r, g, b] = lit(form.normalX[i], form.normalY[i]);
    const ao = Math.max(0, 1 - aoStrength * (1 - occlusion / 255));
    pixels[o] = r * ao;
    pixels[o + 1] = g * ao;
    pixels[o + 2] = b * ao;
    pixels[o + 3] = 255;
  }
}

/** The body's fit transform, `translate(x y) scale(s)`, as numbers. */
function parseFit(fit: string): { x: number; y: number; scale: number } {
  const translate = /translate\(\s*([-\d.]+)[\s,]+([-\d.]+)\s*\)/.exec(fit);
  const scale = /scale\(\s*([-\d.]+)/.exec(fit);
  return {
    x: translate ? Number(translate[1]) : 0,
    y: translate ? Number(translate[2]) : 0,
    scale: scale ? Number(scale[1]) : 1,
  };
}

function canvas(n: number): OffscreenCanvas | HTMLCanvasElement | null {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(n, n);
  if (typeof document !== "undefined") {
    const element = document.createElement("canvas");
    element.width = element.height = n;
    return element;
  }
  return null;
}

/** Rasterizes the outline's coverage, one alpha byte per pixel. */
function coverage(clip: string, fit: string, n: number): Uint8ClampedArray | null {
  if (typeof Path2D !== "function") return null;
  const surface = canvas(n);
  const context = surface?.getContext("2d", { willReadFrequently: true }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null
    | undefined;
  if (!context) return null;
  const pixelsPerUnit = n / SPAN / FACE_PER_UNIT;
  const margin = (MARGIN * n) / SPAN;
  const { x, y, scale } = parseFit(fit);
  context.setTransform(pixelsPerUnit * scale, 0, 0, pixelsPerUnit * scale, margin + pixelsPerUnit * x, margin + pixelsPerUnit * y);
  context.fillStyle = "#fff";
  for (const [, d] of clip.matchAll(/\sd="([^"]+)"/g)) context.fill(new Path2D(d));
  const data = context.getImageData(0, 0, n, n).data;
  const alpha = new Uint8ClampedArray(n * n);
  for (let i = 0; i < n * n; i++) alpha[i] = data[i * 4 + 3];
  return alpha;
}

/** A PNG data URL, which (unlike a blob URL) never needs revoking while something still shows it. */
function encode(pixels: Uint8ClampedArray<ArrayBuffer>, n: number): string | null {
  if (typeof document === "undefined") return null;
  const surface = document.createElement("canvas");
  surface.width = surface.height = n;
  const context = surface.getContext("2d");
  if (!context) return null;
  context.putImageData(new ImageData(pixels, n, n), 0, 0);
  return surface.toDataURL("image/png");
}

/* ------------------------------------------------------------------- cache */

export interface GlossRequest {
  /** Stable name for the outline, e.g. the body id. */
  key: string;
  clip: string;
  fit: string;
  colour: string;
  resolution: number;
}

const MAX_CACHED = 48;
const forms = new Map<string, GlossForm | null>();
const images = new Map<string, string | null>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
const queue: (() => void)[] = [];
let draining = false;

const imageKey = (r: GlossRequest) => `${r.key}|${r.colour}|${r.resolution}`;

function idle(run: () => void) {
  const schedule = (globalThis as { requestIdleCallback?: (cb: () => void, o: { timeout: number }) => void }).requestIdleCallback;
  if (schedule) schedule(run, { timeout: 120 });
  else setTimeout(run, 16);
}

function drain() {
  if (draining) return;
  const job = queue.shift();
  if (!job) return;
  draining = true;
  idle(() => {
    try {
      job();
    } finally {
      draining = false;
      drain();
    }
  });
}

function bake(request: GlossRequest) {
  const key = imageKey(request);
  const formKey = `${request.key}|${request.resolution}`;
  let form = forms.get(formKey);
  if (form === undefined) {
    const alpha = coverage(request.clip, request.fit, request.resolution);
    form = alpha ? glossForm(alpha, request.resolution) : null;
    if (forms.size >= MAX_CACHED) forms.clear();
    forms.set(formKey, form);
  }
  let url: string | null = null;
  if (form) {
    const pixels = new Uint8ClampedArray(request.resolution * request.resolution * 4);
    shade(form, request.colour, pixels);
    url = encode(pixels, request.resolution);
  }
  if (images.size >= MAX_CACHED) images.clear();
  images.set(key, url);
  pending.delete(key);
  for (const listener of listeners) listener();
}

/**
 * The baked body image for this request, or null until it is ready (and
 * always where there is no canvas to bake with). Asking starts the bake on
 * idle time; subscribers hear when it lands.
 */
export function glossImage(request: GlossRequest): string | null {
  const key = imageKey(request);
  const cached = images.get(key);
  if (cached !== undefined) return cached;
  if (!pending.has(key) && typeof window !== "undefined") {
    pending.add(key);
    queue.push(() => {
      try {
        bake(request);
      } catch {
        // A failed bake leaves the flat gradient body, which is still a complete mascot.
        images.set(key, null);
        pending.delete(key);
      }
    });
    drain();
  }
  return null;
}

export function subscribeGloss(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
