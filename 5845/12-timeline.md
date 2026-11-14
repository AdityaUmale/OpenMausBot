# #5865 fixture run on c1a4561eb - event timeline (UTC)

Sent by the fake Gemini (12-fake-gemini-interleave.mjs, fixed offsets from each SCENARIO line) and received from the app (11-fake-gemini.log, logged as they arrived).

| time | direction | event |
|---|---|---|
| 16:26:45.435 | fake -> app | SCENARIO interleave start; inputTranscription "What's on my " |
| 16:26:45.535 | fake -> app | toolCall fc-1 delegate |
| 16:26:45.635 | fake -> app | modelTurn audio + outputTranscription "Let me check. " |
| 16:26:45.735 | fake -> app | inputTranscription "calendar today?" |
| 16:26:46.935 | fake -> app | turnComplete |
| 16:26:46.939 | app -> fake | TOOL_RESPONSE fc-1 (logged) |
| 16:26:47.478 | app -> fake | CLIENT_CONTENT progress (turnComplete false), then reply (turnComplete true) (logged) |
| 16:27:08.433 | fake -> app | SCENARIO cancel start; inputTranscription "Also email Bob the notes." |
| 16:27:08.533 | fake -> app | toolCall fc-2 delegate |
| 16:27:08.633 | fake -> app | toolCallCancellation fc-2 (logged as SEND) |
| 16:27:08.833 | fake -> app | turnComplete |
| - | app -> fake | no TOOL_RESPONSE for fc-2 (none in 11-fake-gemini.log) |
| 16:27:33.564 | app -> fake | socket CLOSED 1000 (hang up) |

Rows marked (logged) are log lines; the others are script offsets from the logged SCENARIO start.

Result in 12-messages.json: one user message "What's on my calendar today?" (via call), one fake Claude reply, no task for fc-2.

`wait`: the job ended before this record was made (turnSucceeded in 12-messages.json), so `openmausbot wait` on that thread returns at once with exit 0 and nothing running; the messages JSON is the full record of the call's thread.
