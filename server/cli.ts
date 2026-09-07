// `openmausbot` on the command line: run the server anywhere and pair devices
// to it. One implementation for three homes — `npx openmausbot` (the npm
// package), `node dist-server/cli.js` (the container image) and
// `pnpm omb` (a checkout) — because scripts/bundle-server.mjs bundles this
// file next to the server.
//
//   openmausbot serve [--port 8799] [--data-dir ~/.openmausbot] [--label "cab mini"]
//                     [--public-url https://host] [--tailscale | --tunnel] [--no-pair]
//   openmausbot pair  [--label "My MacBook"] [--client] [--public-url https://host]
//   openmausbot sessions [revoke <id>]
//   openmausbot status
//   openmausbot login [--email you@example.com]
//   openmausbot logout
//
// `serve` starts the server, waits for it, and prints a pairing link with a
// QR code: scan it with the phone or open it on a laptop. `--tailscale` asks
// Tailscale to terminate HTTPS for it and uses the MagicDNS name in the link.
// `--tunnel` (after `login`) serves at a public https://….openmausbot.com
// address through a Cloudflare tunnel: no domain, no proxy, no open port.
//
// This module only exports; openmausbot.ts is the entry that runs main(), so
// bundling this file into other entries (pair-cli.ts) never runs it twice.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";

import { explainTailscaleFailure, tailscaleServe, tailscaleServeOff, tailscaleStatus, type TailscaleStatus } from "./tailscale.ts";
import {
  browserEngineStatus,
  describeBrowserEngine,
  ensureChrome,
  installAgentBrowserBinary,
  resolveAgentBrowserBinary,
} from "./browser-engine.ts";
import {
  cleanupTunnelOrigin,
  createTunnelAccount,
  createTunnelOrigin,
  describeTunnelAccount,
  describeTunnelState,
  ensureCloudflared,
  guardianEntry,
  startTunnel,
  tunnelAccess,
  type CompanionOriginEndpoint,
  type ManagedTunnelAccess,
  type RunningTunnel,
} from "./tunnel.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface CliOptions {
  command: "serve" | "pair" | "sessions" | "status" | "login" | "logout" | "browser" | "users" | "help";
  port: number;
  dataDir: string;
  label?: string;
  publicUrl?: string;
  tailscale: boolean;
  tunnel: boolean;
  client: boolean;
  pair: boolean;
  revoke?: string;
  email?: string;
  /** `browser install [--with-deps]` */
  browserAction?: "install" | "status";
  /** `users [add|edit|disable|enable|remove]` */
  userAction?: "list" | "add" | "edit" | "disable" | "enable" | "remove";
  /** The user an action targets, or `pair --user`: an id, email or name. */
  user?: string;
  /** `--name` is the person; `--label` is the device. */
  name?: string;
  role?: "admin" | "member";
  yes?: boolean;
  withDeps?: boolean;
  json: boolean;
}

const COMMANDS = ["serve", "pair", "sessions", "status", "login", "logout", "browser", "users", "help", "--help", "-h"];

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions | { error: string } {
  const [command = "help", ...rest] = argv;
  if (!COMMANDS.includes(command)) {
    return { error: `unknown command "${command}"` };
  }
  const options: CliOptions = {
    command: command === "--help" || command === "-h" ? "help" : (command as CliOptions["command"]),
    port: Number(env.OMB_PORT || 8799),
    dataDir: env.OMB_DATA_DIR || join(homedir(), ".openmausbot"),
    tailscale: false,
    tunnel: false,
    client: false,
    pair: true,
    withDeps: false,
    json: false,
    ...(command === "users" ? { userAction: "list" as const } : {}),
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = () => {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };
    try {
      if (arg === "--port") options.port = Number(value());
      else if (arg === "--data-dir") options.dataDir = resolve(value());
      else if (arg === "--label") options.label = value();
      else if (arg === "--public-url") options.publicUrl = value().replace(/\/+$/, "");
      else if (arg === "--tailscale") options.tailscale = true;
      else if (arg === "--tunnel") options.tunnel = true;
      else if (arg === "--client") options.client = true;
      else if (arg === "--no-pair") options.pair = false;
      else if (arg === "--json") options.json = true;
      else if (arg === "--email") options.email = value();
      else if (arg === "--user") options.user = value();
      else if (arg === "--name") options.name = value();
      else if (arg === "--yes") options.yes = true;
      else if (arg === "--role") {
        const role = value();
        if (role !== "admin" && role !== "member") return { error: '--role must be admin or member' };
        options.role = role;
      }
      else if (options.command === "users" && i === 0 && ["add", "edit", "disable", "enable", "remove"].includes(arg)) {
        options.userAction = arg as CliOptions["userAction"];
        // add takes its name from --name; the rest target a user positionally
        if (arg !== "add" && rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) options.user = rest[++i];
      }
      else if (options.command === "sessions" && arg === "revoke") options.revoke = value();
      else if (options.command === "browser" && (arg === "install" || arg === "status")) options.browserAction = arg;
      else if (options.command === "browser" && arg === "--with-deps") options.withDeps = true;
      else return { error: `unknown argument "${arg}"` };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) return { error: "--port must be 1-65535" };
  if (options.publicUrl && !/^https?:\/\//.test(options.publicUrl)) return { error: "--public-url must start with http:// or https://" };
  if (options.tailscale && options.tunnel) return { error: "choose one of --tailscale (your tailnet) and --tunnel (a public address)" };
  if (options.command === "browser" && !options.browserAction) return { error: "browser needs an action: install or status" };
  if (options.command === "users") {
    if (options.userAction === "add" && !options.name) return { error: "users add needs --name" };
    if (["edit", "disable", "enable", "remove"].includes(options.userAction ?? "") && !options.user) {
      return { error: `users ${options.userAction} needs a user (id, email or name)` };
    }
  }
  return options;
}

export const USAGE = `openmausbot — run the server anywhere, pair devices to it

  openmausbot serve [--port 8799] [--data-dir DIR] [--label NAME]
                    [--public-url https://host] [--tailscale | --tunnel] [--no-pair]
  openmausbot pair  [--label NAME] [--client] [--public-url https://host]
  openmausbot sessions [revoke ID]
  openmausbot users [add --name NAME [--email E] [--role admin|member]
                     | edit USER [--name N] [--email E] [--role R]
                     | disable USER | enable USER | remove USER [--yes]]
  openmausbot status
  openmausbot login [--email you@example.com]
  openmausbot logout
  openmausbot browser install [--with-deps] | status

serve   starts the server and prints a pairing link + QR code
pair    mints a pairing code against a running server (--client: chat only)
sessions lists paired devices; "sessions revoke ID" signs one out
users   the people devices belong to. With no accounts the server behaves
        as it always has; once one exists, every new device names a person
        ("pair --user"). USER is an id, an email or an exact name.
        --name is the person, --label is the device.
status  what the server says about itself
login   signs this machine in to an OpenMausBot account (an emailed code)
        and reserves its public address for --tunnel
logout  releases that address and signs out
browser install: the bots' browser engine (agent-browser, pinned) and a
        Chrome for Testing, into the data dir; --with-deps also installs
        the Linux libraries Chrome needs (run as root once). status: what
        this machine has.

--tailscale  serve over your tailnet: Tailscale terminates HTTPS and the
             link uses this machine's MagicDNS name (needs Tailscale signed in
             and HTTPS certificates enabled for the tailnet)
--tunnel     serve at a public https://….openmausbot.com address through a
             Cloudflare tunnel: no domain, no proxy, no open port. Run
             \`openmausbot login\` once on this machine first.
`;

/** Terminal in, terminal out; tests substitute all three. */
export interface CliIo {
  log(line: string): void;
  error(line: string): void;
  ask(question: string): Promise<string>;
}

export function defaultIo(): CliIo {
  return {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

/** The version this command ships with: package.json is one level up in the
 * npm package (dist-server/), the image and a checkout (server/). */
export function serverVersion(here = HERE): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf8"));
    const version = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "version") : undefined;
    return typeof version === "string" && version ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ── talking to a running server (loopback = owner) ────────────────────
async function api(port: number, path: string, init: { method?: string; body?: string } = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: init.method, body: init.body, headers: { "content-type": "application/json" } });
  const body: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function serverUp(port: number): Promise<boolean> {
  try {
    const { status } = await api(port, "/api/health");
    return status === 200;
  } catch {
    return false;
  }
}

/** The pairing link a device opens, rendered as text and a QR code. */
export function pairingBlock(input: { code: string; url: string | null; expiresAt: number; hint?: string | null }): string {
  const lines = [`pairing code:  ${input.code}`, `expires:       ${new Date(input.expiresAt).toLocaleTimeString()} (single use)`];
  if (input.url) {
    lines.push(`open or scan:  ${input.url}`);
    lines.push("");
    lines.push(qrToString(input.url));
  } else {
    lines.push(`open:          /pair on the address you use for this server, and type the code`);
    if (input.hint) lines.push(`               (${input.hint})`);
  }
  return lines.join("\n");
}

export function qrToString(text: string): string {
  let out = "";
  qrcode.generate(text, { small: true }, (rendered: string) => {
    out = rendered;
  });
  return out;
}

async function mintPairing(port: number, options: { label?: string; client?: boolean; publicUrl?: string; user?: string }): Promise<string> {
  const request: { label?: string; scopes?: string[]; userId?: string } = {};
  if (options.label) request.label = options.label;
  if (options.client) request.scopes = ["client"];
  const users = await fetchUsers(port);
  if (options.user) {
    const found = resolveUser(users, options.user);
    if ("error" in found) throw new Error(found.error);
    request.userId = found.id;
  } else if (users.length) {
    // Minting an unnamed code here would hand out an anonymous admin device
    // and quietly undo the roster.
    throw new Error("this server has accounts: pass --user <id|email|name> (openmausbot users to list)");
  }
  const { status, body } = await api(port, "/api/auth/pairing", { method: "POST", body: JSON.stringify(request) });
  if (status !== 200) throw new Error(`server refused to mint a pairing code: ${typeof body?.error === "string" ? body.error : status}`);
  const url = options.publicUrl ? `${options.publicUrl}/pair#code=${body.code}` : typeof body.url === "string" ? body.url : null;
  return pairingBlock({ code: body.code, url, expiresAt: body.expiresAt, hint: typeof body.hint === "string" ? body.hint : null });
}

interface CliUser { id: string; name: string; email: string | null; role: string; status: string }

async function fetchUsers(port: number): Promise<CliUser[]> {
  const { body } = await api(port, "/api/auth/users");
  return Array.isArray(body?.users) ? body.users : [];
}

/** An id, an email, or an exact name. An ambiguous name is an error that
 * lists the ids, because silently picking one would target the wrong person. */
export function resolveUser(users: CliUser[], needle: string): { id: string } | { error: string } {
  const value = needle.trim();
  const byId = users.find((u) => u.id === value);
  if (byId) return { id: byId.id };
  const lower = value.toLowerCase();
  const matches = users.filter((u) => u.email === lower || u.name.toLowerCase() === lower);
  if (matches.length === 1) return { id: matches[0].id };
  if (matches.length > 1) {
    return { error: `"${value}" matches ${matches.length} accounts; use an id:\n${matches.map((u) => `  ${u.id}  ${u.name}`).join("\n")}` };
  }
  return { error: `no account matches "${value}" (openmausbot users to list)` };
}

export function formatUsers(users: CliUser[], deviceCounts: Record<string, number> = {}): string {
  const rows = users.map((u) => [
    u.id,
    u.name,
    u.email ?? "—",
    u.role,
    u.status === "active" ? "active" : "disabled",
    String(deviceCounts[u.id] ?? 0),
  ]);
  const head = ["id", "name", "email", "role", "status", "devices"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [line(head), ...rows.map(line), "", "pair a device with: openmausbot pair --user <id|email|name>"].join("\n");
}

export async function runUsers(options: CliOptions, io: CliIo = defaultIo()): Promise<number> {
  if (!(await serverUp(options.port))) {
    io.error(`no OpenMausBot server on http://127.0.0.1:${options.port}`);
    return 1;
  }
  const users = await fetchUsers(options.port);
  const target = async (): Promise<string | null> => {
    const found = resolveUser(users, options.user ?? "");
    if ("error" in found) {
      io.error(found.error);
      return null;
    }
    return found.id;
  };
  const send = async (path: string, method: string, body?: unknown): Promise<number> => {
    const { status, body: reply } = await api(options.port, path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (status >= 400) {
      io.error(typeof reply?.error === "string" ? reply.error : `server refused (${status})`);
      return 1;
    }
    return 0;
  };

  switch (options.userAction) {
    case "add": {
      const body: Record<string, unknown> = { name: options.name, role: options.role ?? "member" };
      if (options.email) body.email = options.email;
      const { status, body: reply } = await api(options.port, "/api/auth/users", { method: "POST", body: JSON.stringify(body) });
      if (status !== 201) {
        io.error(typeof reply?.error === "string" ? reply.error : `server refused (${status})`);
        return 1;
      }
      io.log(`created ${reply.user.name} (${reply.user.role})  id ${reply.user.id}`);
      // Say the limit out loud: "member" restricts what they may CHANGE, not
      // yet what they may READ.
      if (reply.user.role === "member") io.log("a member can chat with every bot and read every transcript; it limits changes, not visibility");
      io.log(`pair their first device with: openmausbot pair --user ${reply.user.id}`);
      return 0;
    }
    case "edit": {
      const id = await target();
      if (!id) return 1;
      const patch: Record<string, unknown> = {};
      if (options.name) patch.name = options.name;
      if (options.email) patch.email = options.email;
      if (options.role) patch.role = options.role;
      if (!Object.keys(patch).length) {
        io.error("nothing to change: pass --name, --email or --role");
        return 1;
      }
      const code = await send(`/api/auth/users/${encodeURIComponent(id)}`, "PATCH", patch);
      if (code === 0) io.log("updated");
      return code;
    }
    case "disable":
    case "enable": {
      const id = await target();
      if (!id) return 1;
      const status = options.userAction === "disable" ? "disabled" : "active";
      const { status: code, body: reply } = await api(options.port, `/api/auth/users/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      if (code !== 200) {
        io.error(typeof reply?.error === "string" ? reply.error : `server refused (${code})`);
        return 1;
      }
      io.log(status === "disabled"
        ? `disabled: ${reply.revokedSessions} device(s) signed out. Their records are kept — enable to restore them without re-pairing.`
        : "enabled: their devices work again, with no re-pairing");
      return 0;
    }
    case "remove": {
      const id = await target();
      if (!id) return 1;
      const person = users.find((u) => u.id === id);
      if (!options.yes) {
        io.error(`this permanently deletes ${person?.name ?? id} and signs out every one of their devices.`);
        io.error("re-run with --yes to confirm (or use `users disable` to switch them off reversibly)");
        return 1;
      }
      const { status, body: reply } = await api(options.port, `/api/auth/users/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (status !== 200) {
        io.error(typeof reply?.error === "string" ? reply.error : `server refused (${status})`);
        return 1;
      }
      io.log(`removed: ${reply.revokedSessions} device(s) signed out`);
      return 0;
    }
    default: {
      if (options.json) {
        io.log(JSON.stringify(users, null, 2));
        return 0;
      }
      if (!users.length) {
        io.log("no accounts yet: every paired device is an anonymous admin device.");
        io.log('create the first person with: openmausbot users add --name "Your Name" --role admin');
        return 0;
      }
      const { body } = await api(options.port, "/api/auth/sessions");
      const counts: Record<string, number> = {};
      for (const s of Array.isArray(body?.sessions) ? body.sessions : []) {
        if (s.userId) counts[s.userId] = (counts[s.userId] ?? 0) + 1;
      }
      io.log(formatUsers(users, counts));
      return 0;
    }
  }
}

// ── commands ───────────────────────────────────────────────────────────
export async function runPair(options: CliOptions): Promise<number> {
  if (!(await serverUp(options.port))) {
    console.error(`no OpenMausBot server on http://127.0.0.1:${options.port}; start one with \`openmausbot serve\` or set OMB_PORT`);
    return 1;
  }
  console.log(await mintPairing(options.port, { label: options.label, client: options.client, publicUrl: options.publicUrl, user: options.user }));
  if (options.client) console.log("(client scope: chat and approvals only; cannot change settings or pair others)");
  return 0;
}

export async function runSessions(options: CliOptions): Promise<number> {
  if (!(await serverUp(options.port))) {
    console.error(`no OpenMausBot server on http://127.0.0.1:${options.port}`);
    return 1;
  }
  if (options.revoke) {
    const { status, body } = await api(options.port, `/api/auth/sessions/${encodeURIComponent(options.revoke)}`, { method: "DELETE" });
    if (status !== 200) {
      console.error(`could not revoke: ${typeof body?.error === "string" ? body.error : status}`);
      return 1;
    }
    console.log(`revoked ${options.revoke}: that device is signed out and its stream is closed`);
    return 0;
  }
  const { body } = await api(options.port, "/api/auth/sessions");
  const sessions: Array<{ id: string; label: string; scopes: string[]; lastSeenAt: number; expiresAt: number }> = Array.isArray(body?.sessions) ? body.sessions : [];
  if (options.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return 0;
  }
  if (!sessions.length) {
    console.log("no paired devices yet: run `openmausbot pair`");
    return 0;
  }
  console.log(formatSessions(sessions));
  return 0;
}

export function formatSessions(sessions: Array<{ id: string; label: string; scopes: string[]; lastSeenAt: number; expiresAt: number }>, now = Date.now()): string {
  const age = (ms: number) => {
    const m = Math.max(0, Math.floor((now - ms) / 60_000));
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
  };
  const rows = sessions.map((s) => [s.id, s.label || "(unnamed)", s.scopes.includes("admin") ? "admin" : "client", age(s.lastSeenAt), new Date(s.expiresAt).toISOString().slice(0, 10)]);
  const head = ["id", "device", "scope", "last seen", "expires"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [line(head), ...rows.map(line), "", "revoke one with: openmausbot sessions revoke <id>"].join("\n");
}

export async function runStatus(options: CliOptions, io: CliIo = defaultIo()): Promise<number> {
  let code = 0;
  try {
    const res = await fetch(`http://127.0.0.1:${options.port}/.well-known/openmausbot/environment`);
    const body: any = await res.json();
    io.log(options.json ? JSON.stringify(body, null, 2) : `${body.label} · OpenMausBot ${body.version} on ${body.platform} · id ${body.environmentId}`);
  } catch {
    io.error(`no OpenMausBot server on http://127.0.0.1:${options.port}`);
    code = 1;
  }
  if (!options.json) {
    const account = describeTunnelAccount(createTunnelAccount({ dataDir: options.dataDir, version: serverVersion() }).credentials.read());
    if (account.address) io.log(`public address: ${account.address} (signed in as ${account.email ?? "?"}; serve it with --tunnel)`);
  }
  return code;
}

export async function runLogin(options: CliOptions, io: CliIo = defaultIo()): Promise<number> {
  const account = createTunnelAccount({ dataDir: options.dataDir, version: serverVersion() });
  if (account.credentials.status === "unavailable") {
    io.error(`${account.credentials.file} exists but could not be read; fix or remove it, then try again`);
    return 1;
  }
  if (!account.controlPlane) {
    io.error("OMB_CONTROL_PLANE_URL is set but is not an https address");
    return 1;
  }
  const existing = describeTunnelAccount(account.credentials.read());
  if (existing.address) io.log(`already signed in as ${existing.email ?? "?"} (${existing.address}); signing in again refreshes it`);
  const email = (options.email ?? (await io.ask("Email for your OpenMausBot account: "))).trim();
  if (!email) {
    io.error("an email address is needed: openmausbot login --email you@example.com");
    return 1;
  }
  try {
    await account.service.requestCode(email);
  } catch (error) {
    io.error(`could not send a sign-in code: ${message(error)}`);
    return 1;
  }
  const code = (await io.ask(`Enter the 8-digit code we emailed to ${email}: `)).trim();
  let state;
  try {
    state = await account.service.verifyCode(email, code);
  } catch (error) {
    io.error(`sign-in failed: ${message(error)}`);
    return 1;
  }
  const signedIn = describeTunnelAccount(account.credentials.read());
  if (!signedIn.address) {
    io.error(`signed in, but no public address was issued${state.message ? `: ${state.message}` : ""}`);
    return 1;
  }
  io.log(`Signed in as ${signedIn.email ?? email}.`);
  io.log(`This machine's public address: ${signedIn.address}`);
  io.log("Serve there with:  openmausbot serve --tunnel");
  return 0;
}

export async function runLogout(options: CliOptions, io: CliIo = defaultIo()): Promise<number> {
  const account = createTunnelAccount({ dataDir: options.dataDir, version: serverVersion() });
  const before = describeTunnelAccount(account.credentials.read());
  if (!before.email) {
    io.log("this machine is not signed in");
    return 0;
  }
  let state;
  try {
    state = await account.service.signOut();
  } catch (error) {
    io.error(`sign-out failed: ${message(error)}`);
    return 1;
  }
  const after = describeTunnelAccount(account.credentials.read());
  if (after.email) {
    io.error(`still signed in${state.message ? `: ${state.message}` : ""}`);
    return 1;
  }
  io.log(`Signed out ${before.email}${before.address ? `; ${before.address} is released` : ""}.`);
  return 0;
}

export async function runBrowser(options: CliOptions, io: CliIo = defaultIo()): Promise<number> {
  const status = browserEngineStatus({ dataDir: options.dataDir });
  if (options.browserAction === "status") {
    io.log(describeBrowserEngine(status));
    if (status.kind !== "ready" && status.installable) io.log("install it with:  openmausbot browser install");
    return status.kind === "ready" ? 0 : 1;
  }
  let binary = resolveAgentBrowserBinary({ dataDir: options.dataDir });
  if (binary) {
    io.log(`agent-browser is already here: ${binary}`);
  } else {
    if (status.kind !== "ready" && !status.installable) {
      io.error(status.reason);
      return 1;
    }
    try {
      binary = await installAgentBrowserBinary({ dataDir: options.dataDir, log: io.log });
    } catch (error) {
      io.error(`could not install agent-browser: ${message(error)}`);
      return 1;
    }
    io.log(`installed ${binary}`);
  }
  try {
    await ensureChrome(binary, { withDeps: options.withDeps === true, log: io.log });
  } catch (error) {
    io.error(`Chrome is not ready: ${message(error)}`);
    if (process.platform === "linux" && !options.withDeps) io.error("on Linux, Chrome needs system libraries: run `sudo openmausbot browser install --with-deps` once");
    return 1;
  }
  io.log("bots on this server can use a browser now: turn it on under Settings → Experimental, then per bot");
  return 0;
}

/** Where the server bundle lives relative to this file: next to it in the
 * npm package and the image (dist-server/), or the TypeScript source in a
 * checkout. */
export function serverEntry(here = HERE): { command: string; args: string[]; staticDir: string | null; skillsDir: string | null } {
  const bundled = join(here, "index.js");
  const root = resolve(here, "..");
  if (existsSync(bundled)) {
    const staticDir = [join(root, "dist"), join(here, "..", "ui")].find((d) => existsSync(join(d, "index.html"))) ?? null;
    const skillsDir = existsSync(join(root, "skills")) ? join(root, "skills") : null;
    return { command: process.execPath, args: [bundled], staticDir, skillsDir };
  }
  const source = join(here, "index.ts");
  const staticDir = existsSync(join(root, "dist", "index.html")) ? join(root, "dist") : null;
  return { command: process.execPath, args: ["--experimental-strip-types", source], staticDir, skillsDir: existsSync(join(root, "skills")) ? join(root, "skills") : null };
}

interface TunnelPlan {
  access: ManagedTunnelAccess;
  binary: string;
  guardian: string;
  origin: CompanionOriginEndpoint;
}

/** Everything `--tunnel` needs before the server starts, or the one reason
 * it cannot have it. Fails closed: no silent fallback to a local-only server. */
async function planTunnel(options: CliOptions, log: (line: string) => void): Promise<TunnelPlan | { error: string }> {
  const account = createTunnelAccount({ dataDir: options.dataDir, version: serverVersion() });
  if (account.credentials.status === "unavailable") return { error: `${account.credentials.file} exists but could not be read; fix or remove it` };
  if (!describeTunnelAccount(account.credentials.read()).email) {
    return { error: "no account on this machine yet: run `openmausbot login` first, then `openmausbot serve --tunnel`" };
  }
  // A fresh connector token when the control plane answers; the saved one otherwise.
  try {
    const state = await account.service.retry();
    if (state.message && !tunnelAccess(account.credentials.read())) log(`tunnel: ${state.message}`);
  } catch (error) {
    log(`tunnel: control plane not reachable right now (${message(error)}); using the saved address`);
  }
  const access = tunnelAccess(account.credentials.read());
  if (!access) return { error: "this machine has no public address; run `openmausbot login` again" };
  let binary: string;
  try {
    binary = await ensureCloudflared({ dataDir: options.dataDir, log });
  } catch (error) {
    return { error: `--tunnel: ${message(error)}` };
  }
  const guardian = guardianEntry();
  if (!guardian) return { error: "--tunnel: the connector guardian is missing from this install" };
  return { access, binary, guardian, origin: createTunnelOrigin() };
}

export async function runServe(options: CliOptions, log: (line: string) => void = console.log): Promise<number> {
  if (await serverUp(options.port)) {
    console.error(`something already answers on http://127.0.0.1:${options.port}; use \`openmausbot pair\` against it, or --port for a second server`);
    return 1;
  }
  let publicUrl = options.publicUrl;
  let tailscale: TailscaleStatus | null = null;
  if (options.tailscale) {
    const probe = await tailscaleStatus();
    if ("failure" in probe) {
      console.error(`--tailscale: ${explainTailscaleFailure(probe.failure)}`);
      return 1;
    }
    tailscale = probe.status;
  }
  let plan: TunnelPlan | null = null;
  if (options.tunnel) {
    const planned = await planTunnel(options, log);
    if ("error" in planned) {
      console.error(planned.error);
      return 1;
    }
    plan = planned;
    if (publicUrl && publicUrl !== plan.access.endpoint) log(`note: --public-url is ignored with --tunnel; the address is ${plan.access.endpoint}`);
    publicUrl = plan.access.endpoint;
  }
  const entry = serverEntry();
  if (!entry.staticDir) log("note: no built UI found next to the server; the API runs but browsers get no page (build with `pnpm exec vite build`)");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OMB_DATA_DIR: options.dataDir,
    OMB_PORT: String(options.port),
    OMB_WEBHOOK_PORT: process.env.OMB_WEBHOOK_PORT || String(options.port + 1),
  };
  if (entry.staticDir) env.OMB_STATIC_DIR = entry.staticDir;
  if (entry.skillsDir && !process.env.OMB_SKILLS_DIR) env.OMB_SKILLS_DIR = entry.skillsDir;
  if (options.label && !process.env.OMB_ENVIRONMENT_LABEL) env.OMB_ENVIRONMENT_LABEL = options.label;
  if (plan) env.OMB_TUNNEL_SOCKET = plan.origin.socketPath;
  if (tailscale) {
    const served = await tailscaleServe(tailscale, options.port);
    if ("failure" in served) {
      console.error(`--tailscale: ${explainTailscaleFailure(served.failure)}`);
      return 1;
    }
    publicUrl = served.origin;
    log(`tailscale: serving https://${tailscale.dnsName} → http://127.0.0.1:${options.port} (only your tailnet can reach it)`);
  }
  if (publicUrl) env.OMB_PUBLIC_URL = publicUrl;

  const child: ChildProcess = spawn(entry.command, entry.args, { env, stdio: ["ignore", "inherit", "inherit"] });
  let exited: number | null = null;
  child.on("exit", (code) => {
    exited = code ?? 1;
  });
  let tunnel: RunningTunnel | null = null;
  let stopping: Promise<void> | null = null;
  const stop = () => {
    stopping ??= (async () => {
      // The gateway stops accepting before the server it forwards to goes away.
      if (tunnel) await tunnel.stop().catch(() => undefined);
      if (tailscale) await tailscaleServeOff(tailscale).catch(() => undefined);
      if (exited === null) child.kill("SIGTERM");
      if (plan) cleanupTunnelOrigin(plan.origin);
    })();
    return stopping;
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && exited === null) {
    if (await serverUp(options.port)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (exited !== null) {
    if (plan) cleanupTunnelOrigin(plan.origin);
    return exited;
  }
  if (!(await serverUp(options.port))) {
    console.error("the server did not answer within a minute; see its output above");
    await stop();
    return 1;
  }
  if (plan && child.pid) {
    tunnel = startTunnel({
      dataDir: options.dataDir,
      access: plan.access,
      originTarget: { pid: child.pid, socketPath: plan.origin.socketPath },
      binaryPath: plan.binary,
      guardian: plan.guardian,
      onState: (state) => log(describeTunnelState(state, plan.access.endpoint)),
    });
    tunnel.started.catch((error: unknown) => log(`tunnel: ${message(error)}`));
  }
  log("");
  log(`OpenMausBot is running on http://127.0.0.1:${options.port}${publicUrl ? `, reachable at ${publicUrl}` : ""}`);
  log(`data: ${options.dataDir}`);
  log(describeBrowserEngine(browserEngineStatus({ dataDir: options.dataDir })));
  if (options.pair) {
    log("");
    log(await mintPairing(options.port, { label: options.label ? `${options.label} owner` : undefined, publicUrl: publicUrl ?? undefined }));
    log("");
    log("another device later:  openmausbot pair --label \"Kitchen iPad\"");
  }
  log("stop with Ctrl+C");
  return await new Promise<number>((resolveExit) => {
    child.on("exit", (code) => {
      void stop().finally(() => resolveExit(code ?? 0));
    });
  });
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  if ("error" in options) {
    console.error(`${options.error}\n\n${USAGE}`);
    return 2;
  }
  switch (options.command) {
    case "serve":
      return runServe(options);
    case "pair":
      return runPair(options);
    case "sessions":
      return runSessions(options);
    case "status":
      return runStatus(options);
    case "login":
      return runLogin(options);
    case "logout":
      return runLogout(options);
    case "browser":
      return runBrowser(options);
    case "users":
      return runUsers(options);
    default:
      console.log(USAGE);
      return 0;
  }
}
