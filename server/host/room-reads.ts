// A Team Cloud's group chats are read per person: each person's own "read up to" line in each room
// (`room-reads.json`), so one person opening a room clears its unread mark for nobody else.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";

const ROOM_READS_FILE = "room-reads.json";
const fileSchema = z.object({ version: z.literal(1), reads: z.record(z.string(), z.record(z.string(), z.string())) });

/** Unread for a person: a line nobody of them wrote after where they read up to; with no line yet, the room's own mark. */
export function roomUnreadFor(path: ReadonlyArray<{ id: string; role: string }>, readUpTo: string | undefined, roomUnread: boolean): boolean {
  if (readUpTo === undefined) return roomUnread;
  return path.slice(path.findIndex((message) => message.id === readUpTo) + 1).some((message) => message.role !== "user");
}

export function createRoomReads(dataDir: string) {
  const file = join(dataDir, ROOM_READS_FILE);
  let reads: Record<string, Record<string, string>> = {};
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) reads = parsed.data.reads;
    else console.warn(`room reads: ${file} is not a room reads file; starting fresh`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`room reads: ${file} is unreadable; starting fresh`);
  }
  const save = () => {
    try {
      writeFileAtomic(file, `${JSON.stringify({ version: 1, reads })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`room reads: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return {
    readUpTo: (groupId: string, person: string): string | undefined => reads[groupId]?.[person],
    read(groupId: string, person: string, messageId: string): void {
      if (reads[groupId]?.[person] === messageId) return;
      (reads[groupId] ??= {})[person] = messageId;
      save();
    },
    forgetRoom(groupId: string): void {
      if (!reads[groupId]) return;
      delete reads[groupId];
      save();
    },
  };
}

export type RoomReads = ReturnType<typeof createRoomReads>;
