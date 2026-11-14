# #5865 isolated fixture run (head c1a4561eb) - exact commands

Why not `control-omb launch`: it forwards only FAKE_CLAUDE_* and the OpenAI Live
fixture vars (OMB_OPENAI_LIVE_URL/KEY) into the child, so a Gemini Live fixture
cannot be wired through it. Same isolation by hand (env -i, fresh data dir,
fake Claude CLI, loopback-only endpoints):

```sh
WT=~/work/wt/5845; R=~/work/repro5845i            # worktree at c1a4561eb, fresh data dir
# config.json in $R/data: onboarding done, live.provider "gemini",
#   tts.geminiKey "fake-gemini-key-local-test", claude cli = $WT/server/testing/fake-claude-cli.ts
node ~/work/fake-gemini-interleave.mjs 8931 $R/fake-gemini.log &      # loopback fake Gemini Live
env -i HOME=$R/data OMB_DATA_DIR=$R/data OMB_PORT=8799 OMB_WEBHOOK_PORT=8800 \
  FAKE_CLAUDE_MODE=happy OMB_TEST_SEALED_PATH=1 \
  OMB_BUG_REPORT_URL=http://127.0.0.1:9/devs-sink \
  OMB_GEMINI_LIVE_URL=http://127.0.0.1:8931 \
  node --experimental-strip-types server/dev-server.ts > $R/server.log &
OMB_PORT=8799 pnpm dev --host 127.0.0.1 > $R/vite.log &
# In Chrome: open MausBot chat, start call, speak (fake mic) ->
#   fixture scenario "interleave" (delegate fc-1 + audio), then "cancel" (toolCallCancellation fc-2), hang up.
sqlite3 -json $R/data/messages.db "select ... from messages where thread_id='281e8c65-...' order by at"  # -> 12-messages.json
```

Log paths printed/used by the run: `$R/server.log` (12-server.log), `$R/fake-gemini.log` (11-fake-gemini.log).

Result (12-messages.json): spoken request saved as user text with via "call" + callId;
fake Claude reply "hello from fake claude" turnSucceeded; call card "Call with MausBot · 0:52",
endReason hung-up. server.log: `delegations=1 sentToBot=1 replies=1 end=hung-up errors=none`.
fake-gemini.log: TOOL_RESPONSE scheduling WHEN_IDLE, progress (turnComplete false) then
reply (turnComplete true), toolCallCancellation fc-2 handled, socket CLOSED 1000.
