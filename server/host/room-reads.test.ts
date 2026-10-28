import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createRoomReads, roomUnreadFor } from "./room-reads.ts";

const path = [{ id: "m1", role: "user" }, { id: "m2", role: "bot" }, { id: "m3", role: "user" }];

it("is unread for a person only while a bot's line follows where they read up to", () => {
  expect(roomUnreadFor(path, "m2", true)).toBe(false);
  expect(roomUnreadFor(path, "m1", false)).toBe(true);
  expect(roomUnreadFor(path, undefined, true), "never opened: the room's own mark").toBe(true);
  expect(roomUnreadFor(path, "gone", false), "a line no longer there reads as before everything").toBe(true);
});

it("keeps each person's line apart and across a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "room-reads-"));
  const reads = createRoomReads(dir);
  reads.read("room", "p_ada", "m2");
  expect(reads.readUpTo("room", "p_ada")).toBe("m2");
  expect(reads.readUpTo("room", "p_ben")).toBeUndefined();
  expect(createRoomReads(dir).readUpTo("room", "p_ada")).toBe("m2");
  reads.forgetRoom("room");
  expect(createRoomReads(dir).readUpTo("room", "p_ada")).toBeUndefined();
});
