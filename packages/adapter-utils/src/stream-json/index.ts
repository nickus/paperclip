// Translation of adapter run output into Claude Code stream-json.
//
// Pure and deterministic: no Node APIs, no clock, no randomness. The server
// feeds it persisted run-log records; adapters (and adapter plugins) provide
// a `StreamJsonTranslator` that maps their stdout lines to operations.

export {
  DEFAULT_STREAM_JSON_LIMITS,
  STREAM_JSON_CONTRACT,
  STREAM_JSON_ENCODER_VERSION,
  STREAM_JSON_FORMAT,
  STREAM_JSON_FORMAT_VERSION,
} from "./types.js";
export type {
  RunLogRecord,
  StreamJsonBlockKind,
  StreamJsonItem,
  StreamJsonLimits,
  StreamJsonLineMeta,
  StreamJsonLineTranslator,
  StreamJsonNoticeLevel,
  StreamJsonOps,
  StreamJsonResult,
  StreamJsonRunOutcome,
  StreamJsonTranslator,
  StreamJsonTranslatorContext,
  StreamJsonTranslatorFactory,
  StreamJsonUsage,
} from "./types.js";
export {
  compareStreamJsonPositions,
  formatStreamJsonCursor,
  parseStreamJsonCursor,
  streamJsonTranslatorTag,
  type StreamJsonCursor,
} from "./cursor.js";
export { computeStreamJsonSid, parseRunLogRecords, type RunLogRecordPage } from "./records.js";
export { isHostNoticeLine, parseStdoutLine, readTruncationMarker, type ParsedLine } from "./repair.js";
export { serializeWithinLimit } from "./shrink.js";
export { findSegmentBoundary } from "./encoder.js";
export { StreamJsonRunTranslation, type StreamJsonTranslationOptions } from "./translation.js";
export { rawStreamJsonTranslator } from "./raw-translator.js";
export { describeInvalidStreamJsonTranslator, isStreamJsonTranslator } from "./validate.js";
export { utf8ByteLength } from "./utf8.js";
export {
  buildRunLogContent,
  streamJsonItemLines,
  translateRunLogContent,
  type RunLogRecordInput,
  type TranslateRunLogContentInput,
} from "./replay.js";
