import type { LiveEventType } from "../constants.js";

export interface LiveEvent {
  id: number;
  companyId: string;
  type: LiveEventType;
  createdAt: string;
  payload: Record<string, unknown>;
}

/**
 * One translated unit of a run's output in Claude Code stream-json
 * (`heartbeat.run.stream_json` events and the run-log API with
 * `format=claude-stream-json`). `chunk` holds complete lines ending in `\n`;
 * stderr and system items carry the raw text. `cursor` names the item's
 * first line, `(offset, k)`; `prev` is the previous item's cursor, so a
 * client can detect a gap.
 */
export interface HeartbeatRunStreamJsonItem {
  cursor: string;
  prev: string | null;
  offset: number;
  k: number;
  lines: number;
  seq: number | null;
  ts: string;
  stream: "stdout" | "stderr" | "system";
  chunk: string;
}

export type HeartbeatRunStreamJsonResetReason =
  | "source_rewritten"
  | "translator_changed"
  | "evicted"
  | "reordered";

/** Payloads of `heartbeat.run.stream_json` live events. */
export type HeartbeatRunStreamJsonPayload =
  | {
      kind: "hello";
      format: "claude-stream-json";
      formatVersion: number;
      includeRawLogs: boolean;
      partial: boolean;
    }
  | {
      kind: "items";
      runId: string;
      agentId: string;
      issueId: string | null;
      format: "claude-stream-json";
      /** `<translator id>@<version>` */
      translator: string;
      sid: string;
      items: HeartbeatRunStreamJsonItem[];
    }
  | {
      kind: "reset";
      runId: string;
      reason: HeartbeatRunStreamJsonResetReason;
    };

/** Response of `GET /api/heartbeat-runs/:runId/log?format=claude-stream-json`. */
export interface HeartbeatRunStreamJsonPage {
  runId: string;
  format: "claude-stream-json";
  translator: string;
  sid: string;
  items: HeartbeatRunStreamJsonItem[];
  nextCursor: string | null;
  /** The run is terminal, its finish was emitted, and nothing follows `nextCursor`. */
  complete: boolean;
  runStatus: string;
  /** The request's cursor belonged to another translation; items start over. */
  reset: boolean;
}
