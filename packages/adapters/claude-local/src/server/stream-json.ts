import {
  STREAM_JSON_CONTRACT,
  type StreamJsonTranslator,
} from "@paperclipai/adapter-utils/stream-json";

/**
 * Stream-json translator for claude_local.
 *
 * The CLI engine already prints Claude Code stream-json
 * (`--output-format stream-json`), so its JSON object lines pass through
 * byte for byte (the host still repairs redaction damage and caps the line
 * size). ACP engine lines (`acpx.*`) are not translated yet and go out as
 * `paperclip_raw` lines, like any other line that is not a JSON object.
 */
export const claudeStreamJsonTranslator: StreamJsonTranslator = {
  contract: STREAM_JSON_CONTRACT,
  id: "claude_local",
  version: 1,
  create() {
    return {
      line(line, meta, ops) {
        const json = meta.json;
        if (typeof json !== "object" || json === null || Array.isArray(json)) {
          ops.raw(line);
          return;
        }
        const type = (json as Record<string, unknown>).type;
        if (typeof type !== "string" || type.length === 0 || type.startsWith("acpx.")) {
          ops.raw(line);
          return;
        }
        ops.passthrough(line);
      },
    };
  },
};
