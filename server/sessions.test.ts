import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EXCHANGE_REPLAY_MS,
  formatPairingCode,
  generatePairingCode,
  LOCKOUT,
  normalizePairingCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_TTL_MS,
  SESSION_TTL_MS,
  SessionRegistry,
  STREAM_TICKET_TTL_MS,
} from "./sessions.ts";

let dir: string;
let clock: number;
let registry: SessionRegistry;
const file = () => join(dir, "sessions.json");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-sessions-"));
  clock = 1_700_000_000_000;
  registry = new SessionRegistry({ file: file(), now: () => clock });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function pair(label = "MacBook", source = "10.0.0.2") {
  const { code } = registry.openPairing();
  const result = registry.exchange({ code, label, source });
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("people behind devices", () => {
  it("carries a userId from the code onto the session and into the file", () => {
    const { code } = registry.openPairing({ userId: "11111111-1111-4111-8111-111111111111" });
    const result = registry.exchange({ code, label: "Ada's Mac", source: "a" });
    if (!result.ok) throw new Error(result.error);
    expect(result.session.userId).toBe("11111111-1111-4111-8111-111111111111");
    expect(registry.openPairings()).toEqual([]);
    const stored = JSON.parse(readFileSync(file(), "utf8"));
    expect(stored.sessions[0].userId).toBe("11111111-1111-4111-8111-111111111111");
    // Reopening keeps the binding.
    expect(new SessionRegistry({ file: file(), now: () => clock }).list()[0].userId)
      .toBe("11111111-1111-4111-8111-111111111111");
  });

  it("a device paired before accounts existed still loads and reports no owner", () => {
    // A real pre-upgrade file: version 1, no userId anywhere.
    const legacy = {
      version: 1,
      sessions: [{
        id: "legacy-1",
        tokenHash: "a".repeat(64),
        label: "Old laptop",
        scopes: ["admin", "client"],
        createdAt: clock,
        lastSeenAt: clock,
        expiresAt: clock + SESSION_TTL_MS,
      }],
    };
    writeFileSync(file(), JSON.stringify(legacy));
    const reopened = new SessionRegistry({ file: file(), now: () => clock });
    const [session] = reopened.list();
    expect(session.userId).toBeNull();
    expect(session.scopes).toEqual(["admin", "client"]);
    expect(reopened.isLive("legacy-1")).toBe(true);
  });

  it("revokeForUser signs out one person's devices, closes their streams, and leaves everyone else alone", () => {
    const ada = "11111111-1111-4111-8111-111111111111";
    const bob = "22222222-2222-4222-8222-222222222222";
    const mint = (userId?: string) => {
      const { code } = registry.openPairing(userId ? { userId } : {});
      const result = registry.exchange({ code, label: "d", source: "s" });
      if (!result.ok) throw new Error(result.error);
      return result.session.id;
    };
    const adaOne = mint(ada);
    const adaTwo = mint(ada);
    const bobOne = mint(bob);
    const legacy = mint();
    const closed: string[] = [];
    registry.onSessionRevoked((id) => closed.push(id));

    expect(registry.revokeForUser(ada)).toBe(2);
    expect(closed.sort()).toEqual([adaOne, adaTwo].sort());
    expect(registry.isLive(adaOne)).toBe(false);
    expect(registry.isLive(bobOne)).toBe(true);
    expect(registry.isLive(legacy)).toBe(true);
    // Persisted, not just in memory.
    expect(new SessionRegistry({ file: file(), now: () => clock }).list().map((s) => s.id).sort())
      .toEqual([bobOne, legacy].sort());
    // Nobody left to revoke is not an error.
    expect(registry.revokeForUser(ada)).toBe(0);
  });

  it("cancels only that person's outstanding codes", () => {
    const ada = "11111111-1111-4111-8111-111111111111";
    registry.openPairing({ userId: ada });
    registry.openPairing({ userId: "22222222-2222-4222-8222-222222222222" });
    registry.openPairing();
    expect(registry.cancelPairingsForUser(ada)).toBe(1);
    expect(registry.openPairings()).toHaveLength(2);
    expect(registry.openPairings().every((p) => p.userId !== ada)).toBe(true);
  });
});

describe("pairing codes", () => {
  it("are 12 unambiguous symbols and survive human retyping", () => {
    for (let i = 0; i < 50; i++) {
      const code = generatePairingCode();
      expect(code).toHaveLength(12);
      for (const ch of code) expect(PAIRING_CODE_ALPHABET).toContain(ch);
    }
    expect(formatPairingCode("ABCDEFGHJKLM")).toBe("ABCD-EFGH-JKLM");
    expect(normalizePairingCode(" abcd-efgh jklm ")).toBe("ABCDEFGHJKLM");
    expect(normalizePairingCode("0O1I")).toBe("OOII");
  });

  it("exchange once, then never again, and expire after five minutes", () => {
    const { code } = registry.openPairing({ label: "phone" });
    const first = registry.exchange({ code: formatPairingCode(code).toLowerCase(), label: "", source: "a" });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.session.label).toBe("phone");
    // without an attempt id there is no replay: the same source asking again is refused too
    const again = registry.exchange({ code, label: "x", source: "a" });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/wrong or has expired/);
    const { code: stale } = registry.openPairing();
    clock += PAIRING_CODE_TTL_MS + 1;
    expect(registry.exchange({ code: stale, label: "x", source: "b" }).ok).toBe(false);
    expect(registry.openPairings()).toEqual([]);
  });

  it("locks a source out after repeated failures, and forgets on success", () => {
    for (let i = 0; i < LOCKOUT.failures; i++) {
      expect(registry.exchange({ code: "AAAAAAAAAAAA", label: "", source: "attacker" }).ok).toBe(false);
    }
    const { code } = registry.openPairing();
    const locked = registry.exchange({ code, label: "", source: "attacker" });
    expect(locked.ok).toBe(false);
    if (!locked.ok) {
      expect(locked.status).toBe(429);
      expect(locked.error).toMatch(/from your address; try again in 60s/);
    }
    // a different source is unaffected, and the code is still unused
    expect(registry.exchange({ code, label: "", source: "friend" }).ok).toBe(true);
    clock += LOCKOUT.lockMs + 1;
    const { code: fresh } = registry.openPairing();
    expect(registry.exchange({ code: fresh, label: "", source: "attacker" }).ok).toBe(true);
  });

  it("answers a lost-response retry with the same session for a minute, keyed on the client's attempt id", () => {
    const { code } = registry.openPairing();
    const first = registry.exchange({ code, label: "phone", source: "a", attemptId: "attempt-0001-abcd" });
    expect(first.ok).toBe(true);
    // same attempt id: the same answer, even from another address (the phone changed networks)
    expect(registry.exchange({ code, label: "phone", source: "b", attemptId: "attempt-0001-abcd" })).toEqual(first);
    expect(registry.list()).toHaveLength(1);
    // a different attempt id, or none, is a new attempt against a consumed code
    expect(registry.exchange({ code, label: "x", source: "a", attemptId: "attempt-0002-efgh" }).ok).toBe(false);
    expect(registry.exchange({ code, label: "x", source: "a" }).ok).toBe(false);
    // malformed attempt ids never replay
    const { code: c2 } = registry.openPairing();
    expect(registry.exchange({ code: c2, label: "p", source: "a", attemptId: "no" }).ok).toBe(true);
    expect(registry.exchange({ code: c2, label: "p", source: "a", attemptId: "no" }).ok).toBe(false);
    clock += EXCHANGE_REPLAY_MS + 1;
    expect(registry.exchange({ code, label: "phone", source: "a", attemptId: "attempt-0001-abcd" }).ok).toBe(false);
  });

  it("forgets a source's failures once its window and lock have passed", () => {
    registry.exchange({ code: "AAAAAAAAAAAA", label: "", source: "flaky" });
    expect(registry.failureSources()).toContain("flaky");
    clock += LOCKOUT.windowMs + 1;
    registry.openPairing(); // any registry activity prunes
    expect(registry.failureSources()).not.toContain("flaky");
  });

  it("names the device from the client, else the code's label, else the user agent", () => {
    const a = registry.openPairing({ label: "Milind's MacBook" });
    const named = registry.exchange({ code: a.code, label: "", source: "s1", fallbackLabel: "Safari on Mac" });
    if (!named.ok) throw new Error(named.error);
    expect(named.session.label).toBe("Milind's MacBook");
    const b = registry.openPairing();
    const ua = registry.exchange({ code: b.code, label: "  ", source: "s2", fallbackLabel: "Safari on Mac" });
    if (!ua.ok) throw new Error(ua.error);
    expect(ua.session.label).toBe("Safari on Mac");
    const c = registry.openPairing({ label: "ignored" });
    const explicit = registry.exchange({ code: c.code, label: "Kitchen iPad", source: "s3", fallbackLabel: "Safari on iPad" });
    if (!explicit.ok) throw new Error(explicit.error);
    expect(explicit.session.label).toBe("Kitchen iPad");
  });

  it("carries scopes from the code into the session, deduplicated", () => {
    const { code } = registry.openPairing({ scopes: ["client", "client"] });
    const result = registry.exchange({ code, label: "viewer", source: "s" });
    if (!result.ok) throw new Error(result.error);
    expect(result.session.scopes).toEqual(["client"]);
    expect(pair().session.scopes).toEqual(["admin", "client"]);
  });
});

describe("sessions", () => {
  it("stores only a hash, owner-only, and reloads from disk", () => {
    const { token, session } = pair();
    const onDisk = readFileSync(file(), "utf8");
    expect(onDisk).not.toContain(token);
    expect(onDisk).toContain(session.id);
    if (process.platform !== "win32") expect(statSync(file()).mode & 0o777).toBe(0o600); // Windows has no POSIX modes
    const reloaded = new SessionRegistry({ file: file(), now: () => clock });
    expect(reloaded.authenticate(token)?.id).toBe(session.id);
    expect(reloaded.authenticate("omb_sess_nope")).toBeNull();
  });

  it("expires after 30 days and can be revoked", () => {
    const { token, session } = pair();
    clock += SESSION_TTL_MS - 1;
    expect(registry.authenticate(token)?.id).toBe(session.id);
    clock += 2;
    expect(registry.authenticate(token)).toBeNull();
    const other = pair("iPad");
    expect(registry.list().map((s) => s.label)).toEqual(["iPad"]);
    expect(registry.revoke(other.session.id)).toBe(true);
    expect(registry.revoke(other.session.id)).toBe(false);
    expect(registry.authenticate(other.token)).toBeNull();
  });

  it("updates last-seen at most once a minute so reads stay cheap", () => {
    const { token } = pair();
    const before = statSync(file()).mtimeMs;
    clock += 1_000;
    registry.authenticate(token);
    expect(registry.list()[0]?.lastSeenAt).toBe(clock - 1_000);
    clock += 60_000;
    registry.authenticate(token);
    expect(registry.list()[0]?.lastSeenAt).toBe(clock);
    expect(statSync(file()).mtimeMs).toBeGreaterThanOrEqual(before);
  });
});

describe("stream tickets", () => {
  it("are single use, short-lived, and die with their session", () => {
    const { session } = pair();
    const { ticket } = registry.issueStreamTicket(session.id);
    expect(registry.redeemStreamTicket(ticket)?.id).toBe(session.id);
    expect(registry.redeemStreamTicket(ticket)).toBeNull();
    const { ticket: late } = registry.issueStreamTicket(session.id);
    clock += STREAM_TICKET_TTL_MS + 1;
    expect(registry.redeemStreamTicket(late)).toBeNull();
    const { ticket: orphan } = registry.issueStreamTicket(session.id);
    registry.revoke(session.id);
    expect(registry.redeemStreamTicket(orphan)).toBeNull();
  });
});
