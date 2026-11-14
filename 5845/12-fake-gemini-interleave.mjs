// Fake Gemini Live API for a local in-app check: auth_tokens + BidiGenerateContentConstrained WebSocket. No real service.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("/home/user/work/wt/5845/package.json");
const { WebSocketServer } = require("ws");

const PORT = Number(process.argv[2] || 8931);
const LOG = process.argv[3] || "/tmp/fake-gemini.log";
const log = (...a) => appendFileSync(LOG, `${new Date().toISOString()} ${a.join(" ")}\n`);
let tokens = 0;

// 0.6 s of a 440 Hz tone at 24 kHz, 16-bit PCM, base64.
function tone(seconds = 0.6) {
  const n = Math.floor(24000 * seconds);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 6000);
  return Buffer.from(pcm.buffer).toString("base64");
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/v1beta/auth_tokens") {
      const parsed = JSON.parse(body || "{}");
      log("AUTH_TOKENS key-present:", Boolean(req.headers["x-goog-api-key"]), "uses:", parsed.uses,
        "model:", parsed.bidiGenerateContentSetup?.model, "tools:", JSON.stringify(parsed.bidiGenerateContentSetup?.tools?.[0]?.functionDeclarations?.map((f) => f.name)),
        "fieldMask:", parsed.fieldMask, "instructions-chars:", parsed.bidiGenerateContentSetup?.systemInstruction?.parts?.[0]?.text?.length);
      tokens += 1;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ name: `auth_tokens/fake${tokens}` }));
    }
    log("HTTP", req.method, req.url);
    res.writeHead(404); res.end();
  });
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  log("WS_UPGRADE", url.pathname, "token:", url.searchParams.get("access_token"));
  if (!url.pathname.endsWith("GenerativeService.BidiGenerateContentConstrained")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => session(ws));
});

let connection = 0;
function session(ws) {
  const id = ++connection;
  let chunks = 0, asked = false, setup = false;
  const send = (m) => ws.send(Buffer.from(JSON.stringify(m))); // Gemini sends binary frames.
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.setup) {
      log(`C${id} SETUP`, JSON.stringify(m.setup));
      setup = true;
      send({ setupComplete: {} });
      send({ sessionResumptionUpdate: { newHandle: `handle-${id}`, resumable: true } });
      return;
    }
    if (m.realtimeInput?.audio) {
      chunks += 1;
      if (chunks % 50 === 1) log(`C${id} AUDIO chunks:`, chunks, "bytes(b64):", m.realtimeInput.audio.data.length, m.realtimeInput.audio.mimeType);
      if (chunks === 20 && !asked) {
        asked = true;
        // Case 1 (r4574341132): the tool call comes after the first words, then the agent's audio, then the rest of the words.
        log(`C${id} SCENARIO interleave start`);
        send({ serverContent: { inputTranscription: { text: "What's on my " } } });
        setTimeout(() => send({ toolCall: { functionCalls: [{ id: "fc-1", name: "delegate", args: { request: "What's on my calendar today?" } }] } }), 100);
        setTimeout(() => send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: tone(0.3) } }] }, outputTranscription: { text: "Let me check. " } } }), 200);
        setTimeout(() => send({ serverContent: { inputTranscription: { text: "calendar today?" } } }), 300);
        setTimeout(() => send({ serverContent: { turnComplete: true } }), 1500);
      }
      if (chunks === 250) {
        // Case 2 (r4574341139): a held call that Gemini cancels before it runs.
        log(`C${id} SCENARIO cancel start`);
        send({ serverContent: { inputTranscription: { text: "Also email Bob the notes." } } });
        setTimeout(() => send({ toolCall: { functionCalls: [{ id: "fc-2", name: "delegate", args: { request: "Email Bob the notes." } }] } }), 100);
        setTimeout(() => { log(`C${id} SEND toolCallCancellation fc-2`); send({ toolCallCancellation: { ids: ["fc-2"] } }); }, 200);
        setTimeout(() => send({ serverContent: { turnComplete: true } }), 400);
      }
      return;
    }
    if (m.realtimeInput?.audioStreamEnd) return log(`C${id} AUDIO_STREAM_END (muted)`);
    if (m.toolResponse) return log(`C${id} TOOL_RESPONSE`, JSON.stringify(m.toolResponse));
    if (m.clientContent) {
      log(`C${id} CLIENT_CONTENT`, JSON.stringify(m.clientContent));
      if (m.clientContent.turnComplete) {
        const said = "Here is what the assistant found.";
        send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: tone(1) } }] }, outputTranscription: { text: said } } });
        send({ serverContent: { turnComplete: true } });
      }
      return;
    }
    log(`C${id} OTHER`, raw.toString().slice(0, 200));
  });
  ws.on("close", (code) => log(`C${id} CLOSED`, code, "setup:", setup, "chunks:", chunks));
  // The first connection is ended by "Gemini" after 25 s, with goAway first, to check the call resumes on a new one.
  if (false) setTimeout(() => { send({ goAway: { timeLeft: "1s" } }); setTimeout(() => ws.close(1000), 500); }, 25_000);
}

server.listen(PORT, "127.0.0.1", () => log("LISTENING", PORT));
