---
title: Claude Stream-JSON Output
summary: Read any adapter's run output as Claude Code stream-json, live or paged, and add a translator to an adapter
---

API clients that already render Claude Code stream-json (`claude --print --output-format stream-json`) can read the output of every adapter in that format. The server translates each run's persisted log; `claude_local` runs pass through almost unchanged, and other adapters provide a translator (or fall back to raw lines).

## Reading translated output

### Log API

```
GET /api/heartbeat-runs/:runId/log?format=claude-stream-json[&after=<cursor>|&before=<cursor>|&tail=1][&limitBytes=N]
```

Access checks and read-time redaction are the same as for the raw log. `offset` cannot be combined with `format` (400). The response:

```json
{
  "runId": "…",
  "format": "claude-stream-json",
  "translator": "claude_local@1",
  "sid": "k3f9a2Qx0b",
  "items": [
    {
      "cursor": "claude_local@1/k3f9a2Qx0b/18342.0",
      "prev": "claude_local@1/k3f9a2Qx0b/17001.0",
      "offset": 18342, "k": 0, "lines": 2, "seq": 57, "ts": "…", "stream": "stdout",
      "chunk": "{…claude line…}\n{…claude line…}\n"
    }
  ],
  "nextCursor": "claude_local@1/k3f9a2Qx0b/18342.0",
  "complete": false,
  "runStatus": "running",
  "reset": false
}
```

- `after` returns items strictly after the cursor, until their total `chunk` size reaches `limitBytes` (default and maximum 1 MiB; at least one item is returned). `nextCursor` is the newest item's cursor (the request cursor when nothing new follows); continue forward with `after=<nextCursor>`.
- `before` returns the newest items strictly before the cursor; `tail=1` the newest items of the log (same size limit). `nextCursor` is the oldest item's cursor; continue backward with `before=<nextCursor>`. It is `null` once the page starts at the beginning of the output. To follow new output after a `tail` or `before` page, use `after=<cursor of its last item>`.
- `complete` is true when the run is terminal, its final lines were emitted and no item follows the page.
- A cursor from another translation (another translator version, or a rewritten log: another `sid`) sets `reset: true`; the items then start from the beginning (`after`) or the end (`before`).
- Logs over 64 MiB are not translated (413 `log_too_large_for_translation`); read them in the raw format.

### Live events

```
GET /api/companies/:companyId/events/ws?format=claude-stream-json[&includeRawLogs=1]
```

Authorization is unchanged. Without `format` the socket's event stream is exactly what it was before. With it:

1. The first message is a hello: `{"type":"heartbeat.run.stream_json","payload":{"kind":"hello","format":"claude-stream-json","formatVersion":1,"includeRawLogs":false,"partial":false}}`. A server without the format ignores the parameter and sends no hello, so a client can fall back to raw logs.
2. Raw `heartbeat.run.log` events are suppressed unless `includeRawLogs=1`. Every other event type is delivered as before.
3. Translated output arrives as `heartbeat.run.stream_json` events with `payload.kind = "items"`, carrying `runId`, `agentId`, `issueId`, `translator`, `sid` and the same item objects as the log API.
4. `payload.kind = "reset"` (with `runId` and `reason`) tells the client to drop that run's rendered output and fetch it again.

An unknown `format`, an invalid flag value, or a server started with `PAPERCLIP_STREAM_JSON=off` rejects the upgrade with 400.

### Client algorithm

```
connect with ?format=claude-stream-json; no hello within ~2 s -> raw mode
for a run on screen:
    buffer its live items
    page the log API with after=<last applied cursor> until caught up
    apply buffered items that come after the last applied one
for each item:
    already applied (same cursor or earlier)   -> drop
    item.prev != last applied cursor           -> gap: page the log API from the last applied cursor
    reset, or translator/sid changed           -> clear the run and fetch from the start
```

The live path and the log API translate the same persisted file with the same deterministic translation, so their items are identical, cursors included. This holds on the server process that executes the run; another process reads the object-store mirror of an active run's log, which may lag.

## The format

Lines follow Claude Code stream-json: `system/init`, `assistant` lines with exactly one content block each (`text`, `thinking` or `tool_use`; lines of one model response share `message.id`), `user` lines with a `tool_result`, and exactly one `result` per run. When a run ends without a result (cancelled, crashed, or an adapter that reports none), the server synthesizes one from the run record, marked `paperclip.synthesized: true`.

Paperclip additions sit under a `paperclip` key or in `system` lines with a `paperclip_*` subtype, which Claude-only clients ignore:

- `system/paperclip_notice` (`level`, `text`): host lines such as `[paperclip] …`, truncation notices and adapter errors.
- `system/paperclip_raw` (`text`, `truncated`): a line no translator understood (at most 8 KiB).
- `system/paperclip_entry` (`entry`): a transcript entry without a Claude equivalent.
- `assistant.paperclip` = `{ block, seg, last }`: streamed text is emitted in segments, cut at a text boundary once the segment is 1.5 s old (by record time) or 2,000 characters long, and never longer than 8,000 characters.
- `paperclip.truncated`: a line over 64 KiB had the middle of its longest strings cut.

Items with `stream: "stderr"` carry the raw stderr text, as the raw log does.

## Adding a translator to an adapter

An adapter module can declare `streamJsonTranslator` (see `ServerAdapterModule`). The translator maps stdout lines to operations; the host encodes them, so every output line is valid JSON with stable ids.

```ts
import { STREAM_JSON_CONTRACT, type StreamJsonTranslator } from "@paperclipai/adapter-utils/stream-json";

export const streamJsonTranslator: StreamJsonTranslator = {
  contract: STREAM_JSON_CONTRACT,
  id: "my_adapter",
  version: 1, // bump whenever output for the same input changes
  create({ runId }) {
    return {
      line(line, meta, ops) {
        const event = meta.json as { type?: string } | undefined;
        if (event?.type === "session") ops.init({ sessionId: String((event as any).id) });
        else if (event?.type === "text_delta") ops.delta({ blockKey: "answer", kind: "text", text: String((event as any).text) });
        else ops.raw(line);
      },
    };
  },
};
```

Operations: `init`, `message(key)` (groups lines under one `message.id`), `delta` (streamed text or thinking, coalesced and segmented), `block` (complete text or thinking), `closeBlocks`, `toolUse` (returns the tool-use id; source ids are kept when they are safe and unique), `toolResult` (synthesizes the `tool_use` if it was never reported), `hasToolUse`, `usage` (current message), `apiError`, `user`, `notice`, `raw`, `passthrough` (a line that already is Claude stream-json), `entry` (a UI transcript entry) and `result`. An optional `finish(outcome, ops)` runs once when the run ends, before the host closes open blocks and synthesizes a missing result.

Rules:

- `line()` must be a pure function of the lines received so far: no clock, no randomness, no I/O. Live output and later replays feed the same lines and must produce the same operations.
- `meta.json` holds the parsed line when it is JSON. Lines damaged by log redaction are repaired first when possible (`meta.repaired`).
- `[paperclip] …` host lines and the run-log truncation marker are handled by the host and never reach the translator.
- A translator that throws on a line gets that line emitted as `paperclip_raw`; translation continues.
- A translator that fails validation (`contract`, `id`, `version`, `create`) is ignored with a warning, and the adapter's runs use the raw fallback: an init line, then every stdout line as `paperclip_raw`.

`translateRunLogContent` and `buildRunLogContent` from `@paperclipai/adapter-utils/stream-json` translate a whole run log in memory, which is convenient for translator tests.

## Limits and redaction

- The source of truth is the persisted run log, whose chunks are sanitized when they are written. Strings the host re-serializes are sanitized again; the log API applies the run's secret registry at read time, and live items are redacted with the same registry before they are published (output is withheld when the registry cannot be read).
- The live hub keeps one translation per run for companies with an opted-in socket, at most 256 runs and about 64 MiB, dropping state 120 s after a run ends or the company's last opted-in socket leaves. An evicted active run gets a `reset`.
- The translator is chosen by the agent's current adapter type, as the web UI does.
