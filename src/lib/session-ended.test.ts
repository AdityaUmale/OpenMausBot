import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function refusedWith(sessionStatus: number) {
  vi.stubGlobal("window", {});
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (path) => path === "/api/auth/session"
    ? new Response(JSON.stringify(sessionStatus === 200 ? { kind: "session", id: "s", scopes: ["client"] } : { error: "forbidden: this request came through a proxy (pair this device to use the server remotely)" }), { status: sessionStatus })
    : new Response(JSON.stringify({ error: "forbidden: this request came through a proxy (pair this device to use the server remotely)" }), { status: 403 })));
  const { api } = await import("@/state/api");
  const { sessionEnded, sessionCheck } = await import("./session-ended");
  await api("/api/notifications", { background: true }).catch(() => {});
  await sessionCheck();
  return sessionEnded();
}

it("learns that the session ended when the server refuses a request and no longer knows this device", async () => {
  expect(await refusedWith(403)).toBe(true);
});

it("stays signed in when only one request was refused", async () => {
  expect(await refusedWith(200)).toBe(false);
});
