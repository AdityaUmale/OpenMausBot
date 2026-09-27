import { describe, expect, it } from "vitest";

import { MOTION, bodyTransform, stillMotion } from "./CursorAvatar";

describe("stillMotion", () => {
  it("leaves a still mascot upright when its state only moves", () => {
    for (const elapsed of [0, 137, 410, 2_000]) {
      expect(bodyTransform(stillMotion(MOTION.happy, 0), elapsed, 1)).toBe("");
      expect(bodyTransform(stillMotion(MOTION.celebrate, 0), elapsed, 1)).toBe("");
    }
  });

  it("keeps the state's lean, since the lean is the pose", () => {
    expect(bodyTransform(stillMotion(MOTION.drowsy, 0), 1_234, 1)).toBe(
      bodyTransform({ tilt: MOTION.drowsy.tilt }, 0, 1),
    );
  });

  it("drops one-shot entrances, so a still spawning mascot is full size", () => {
    expect(bodyTransform(stillMotion(MOTION.spawning, 0), 0, 1)).toBe("");
  });

  it("is the state's own motion at full amount", () => {
    for (const elapsed of [90, 333, 1_500]) {
      expect(bodyTransform(stillMotion(MOTION.happy, 1), elapsed, 1)).toBe(
        bodyTransform(MOTION.happy, elapsed, 1),
      );
    }
  });
});
