/**
 * `PAPERCLIP_STREAM_JSON=off` disables the Claude stream-json format on the
 * run-log API and the live-events socket; opt-in requests then get 400 and
 * clients fall back to raw logs.
 */
export function isStreamJsonEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PAPERCLIP_STREAM_JSON ?? "").trim().toLowerCase() !== "off";
}
