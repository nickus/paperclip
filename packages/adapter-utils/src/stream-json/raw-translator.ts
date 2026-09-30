import { STREAM_JSON_CONTRACT, type StreamJsonTranslator } from "./types.js";

/**
 * Fallback for adapters without a translator: a `system/init` before the
 * first line, then every stdout line as a `system/paperclip_raw` line. The
 * host still adds notices for `[paperclip]` lines and synthesizes the
 * result when the run ends.
 */
export const rawStreamJsonTranslator: StreamJsonTranslator = {
  contract: STREAM_JSON_CONTRACT,
  id: "raw",
  version: 1,
  create(ctx) {
    let started = false;
    return {
      line(line, _meta, ops) {
        if (!started) {
          started = true;
          ops.init({ sessionId: `paperclip-run-${ctx.runId}`, extra: { fallback: true } });
        }
        ops.raw(line);
      },
    };
  },
};
