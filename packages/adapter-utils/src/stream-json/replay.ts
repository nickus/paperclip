import { computeStreamJsonSid, parseRunLogRecords } from "./records.js";
import { StreamJsonRunTranslation } from "./translation.js";
import type {
  StreamJsonItem,
  StreamJsonLimits,
  StreamJsonRunOutcome,
  StreamJsonTranslator,
} from "./types.js";

export interface RunLogRecordInput {
  stream?: "stdout" | "stderr" | "system";
  chunk: string;
  ts: string;
  seq?: number;
}

/** Serializes records the way the run-log store appends them (one JSON object per line). */
export function buildRunLogContent(records: RunLogRecordInput[]): string {
  return records
    .map((record) =>
      `${JSON.stringify({
        ts: record.ts,
        stream: record.stream ?? "stdout",
        chunk: record.chunk,
        ...(typeof record.seq === "number" ? { seq: record.seq } : {}),
      })}\n`,
    )
    .join("");
}

export interface TranslateRunLogContentInput {
  runId: string;
  adapterType: string;
  translator: StreamJsonTranslator;
  /** Complete run-log file content (NDJSON). */
  content: string;
  /** The run outcome when the run is terminal; the finish lines are then included. */
  outcome?: StreamJsonRunOutcome | null;
  redactString?: (value: string) => string;
  limits?: Partial<StreamJsonLimits>;
}

/**
 * Translates a whole run-log file in memory. Handy for translator tests and
 * tools; the server pages through the store with the same translation.
 */
export function translateRunLogContent(input: TranslateRunLogContentInput): {
  sid: string;
  tag: string;
  items: StreamJsonItem[];
} {
  const page = parseRunLogRecords(input.content, 0);
  const translation = new StreamJsonRunTranslation({
    runId: input.runId,
    adapterType: input.adapterType,
    sid: computeStreamJsonSid(input.runId, page.records[0]?.raw ?? null),
    translator: input.translator,
    redactString: input.redactString,
    limits: input.limits,
  });
  if (input.outcome) translation.setOutcome(input.outcome);
  const items: StreamJsonItem[] = [];
  for (const record of page.records) items.push(...translation.push(record));
  items.push(...translation.end(page.consumedBytes));
  return { sid: translation.sid, tag: translation.tag, items };
}

/** The stdout lines of `items`, in order (stderr and system items are skipped). */
export function streamJsonItemLines(items: StreamJsonItem[]): string[] {
  return items
    .filter((item) => item.stream === "stdout")
    .flatMap((item) => item.chunk.split("\n").filter((line) => line.length > 0));
}
