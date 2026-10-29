// A Team Cloud's group chats are read per person: each person's own "read up to" line in each room
// (`room-reads.json`), so one person opening a room clears its unread mark for nobody else.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";

const ROOM_READS_FILE = "room-reads.json";
const fileSchema = z.object({ version: z.literal(1), reads: z.record(z.string(), z.record(z.string(), z.string())) });

type PathMessage = { id: string; role: string; kind?: string; at?: number };

const NOT_A_REPLY = new Set(["activity", "screen", "digest", "compaction"]);
const isReply = (message: PathMessage) => message.role === "bot" && !NOT_A_REPLY.has(message.kind ?? "text");

/** Unread for a person: a bot replied after where they read up to; with no line yet, the room's own mark. A line no
 * longer on the path (an edit or a retry moved it) reads up to the last message at or before it; `atOf` gives its time. */
export function roomUnreadFor(path: readonly PathMessage[], readUpTo: string | undefined, roomUnread: boolean, atOf?: (id: string) => number | undefined): boolean {
  if (readUpTo === undefined) return roomUnread;
  let from = path.findIndex((message) => message.id === readUpTo) + 1;
  if (from === 0) {
    const readAt = atOf?.(readUpTo);
    if (readAt === undefined) return false;
    from = path.findLastIndex((message) => (message.at ?? 0) <= readAt) + 1;
  }
  return path.slice(from).some(isReply);
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
    forget(groupId: string, person: string): void {
      if (reads[groupId]?.[person] === undefined) return;
      delete reads[groupId]![person];
      save();
    },
    forgetRoom(groupId: string): void {
      if (!reads[groupId]) return;
      delete reads[groupId];
      save();
    },
    forgetPerson(person: string): void {
      const rooms = Object.values(reads).filter((room) => room[person] !== undefined);
      if (!rooms.length) return;
      for (const room of rooms) delete room[person];
      save();
    },
  };
}

export type RoomReads = ReturnType<typeof createRoomReads>;
