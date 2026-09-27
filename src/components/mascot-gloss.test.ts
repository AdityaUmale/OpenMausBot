import { describe, expect, it } from "vitest";

import { glossForm, glossImage, glossResolution, litSphere, pillow, shade, vivid } from "./mascot-gloss";

/** Coverage of a centred disc of radius `r` pixels on an n×n grid. */
function disc(n: number, r: number) {
  const alpha = new Uint8ClampedArray(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x + 0.5 - n / 2;
      const dy = y + 0.5 - n / 2;
      alpha[y * n + x] = dx * dx + dy * dy < r * r ? 255 : 0;
    }
  }
  return alpha;
}

const luminance = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

describe("pillow", () => {
  it("inflates a disc into a dome: highest in the middle, zero outside", () => {
    const n = 64;
    const phi = pillow(disc(n, 24), n, 1);
    const centre = phi[32 * n + 32];
    expect(centre).toBeGreaterThan(phi[32 * n + 44]);
    expect(phi[32 * n + 44]).toBeGreaterThan(phi[32 * n + 54]);
    expect(phi[0]).toBe(0);
    // ∇²φ = −1 on a disc of radius R gives φ(0) = R²/4.
    expect(centre).toBeGreaterThan(0.8 * (24 * 24) / 4);
    expect(centre).toBeLessThan(1.2 * (24 * 24) / 4);
  });
});

describe("glossForm", () => {
  const n = 64;
  const form = glossForm(disc(n, 24), n);

  it("faces the viewer in the middle and turns outward toward the edge", () => {
    const middle = 32 * n + 32;
    expect(Math.hypot(form.normalX[middle], form.normalY[middle])).toBeLessThan(0.1);
    const right = 32 * n + 54;
    expect(form.normalX[right]).toBeGreaterThan(0.5);
    const top = 10 * n + 32;
    expect(form.normalY[top]).toBeLessThan(-0.5);
  });

  it("marks outside pixels transparent and inside pixels lit", () => {
    expect(form.occlusion[0]).toBe(0);
    expect(form.occlusion[32 * n + 32]).toBeGreaterThan(200);
  });
});

describe("litSphere", () => {
  const lit = litSphere([59, 130, 246]);

  it("lights the side facing the light (upper left) brighter than the far side", () => {
    expect(luminance(lit(-0.5, -0.5))).toBeGreaterThan(luminance(lit(0.5, 0.5)));
  });

  it("keeps the hue in shadow instead of going grey", () => {
    const [r, g, b] = lit(0.7, 0.7);
    expect(b).toBeGreaterThan(r * 1.5);
    expect(b).toBeGreaterThan(g);
  });
});

describe("shade", () => {
  it("paints the body opaque and leaves the rest transparent", () => {
    const n = 64;
    const pixels = new Uint8ClampedArray(n * n * 4);
    shade(glossForm(disc(n, 24), n), "#3B82F6", pixels);
    expect(pixels[3]).toBe(0);
    expect(pixels[(32 * n + 32) * 4 + 3]).toBe(255);
  });
});

describe("vivid", () => {
  it("raises saturation without moving the hue", () => {
    const [r, g, b] = vivid("#3B82F6");
    expect(b).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(r);
    expect(b - r).toBeGreaterThan(0xf6 - 0x3b);
  });

  it("leaves greys alone", () => {
    expect(vivid("#808080").map(Math.round)).toEqual([128, 128, 128]);
  });
});

describe("glossResolution", () => {
  it("bakes finer for bigger mascots", () => {
    expect(glossResolution(88)).toBe(64);
    expect(glossResolution(224)).toBe(96);
    expect(glossResolution(Infinity)).toBe(128);
  });
});

describe("glossImage", () => {
  it("is null where there is no browser to bake in, so the flat body shows", () => {
    expect(glossImage({ key: "disc", clip: '<path d="M0 0"/>', fit: "", colour: "#3B82F6", resolution: 64 })).toBeNull();
  });
});
