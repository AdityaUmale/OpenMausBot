import { describe, expect, it } from "vitest";

import { MOTION, REST_POSE, bodyPose, bodyTransform, mixPose, poseTransform, stillMotion } from "./CursorAvatar";

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

describe("mixPose", () => {
  const hop = bodyPose(MOTION.bouncing, 140, 1);

  it("starts where the body was and ends on the new pose", () => {
    expect(mixPose(hop, REST_POSE, 0)).toEqual(hop);
    expect(mixPose(hop, REST_POSE, 1)).toEqual(REST_POSE);
  });

  it("passes through the middle rather than jumping", () => {
    const half = mixPose(hop, REST_POSE, 0.5);
    expect(half.dy).toBeCloseTo(hop.dy / 2);
    expect(half.sy).toBeCloseTo((hop.sy + 1) / 2);
  });

  it("writes nothing for the rest pose", () => {
    expect(poseTransform(REST_POSE)).toBe("");
  });
});
