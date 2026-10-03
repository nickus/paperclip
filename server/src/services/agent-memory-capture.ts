import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type { SourceTrustMetadata } from "@paperclipai/shared";
import { AGENT_MEMORY_BODY_MAX_CHARS, AGENT_MEMORY_MAX_WRITES_PER_RUN } from "@paperclipai/shared";
import type { AgentMemoryMode } from "@paperclipai/adapter-utils/wake-run-brief";
import { logger } from "../middleware/logger.js";
import { writeAgentMemoryEntry } from "./agent-memory.js";

/**
 * Run-end "Remember:" capture (implementation spec §9). No free-form
 * heuristic mining of a run's summary or comment text (owner decision 2);
 * the only capture path in v1 is an explicit, whole-line `Remember: ...`
 * marker, case-insensitive, never a mid-sentence occurrence (so an agent
 * discussing "please remember to..." in prose is never captured).
 */
const REMEMBER_LINE_RE = /^\s*remember:\s*(.+)$/i;

/** Scans `text` line by line; returns each captured, trimmed, length-bounded body. */
export function extractRememberLines(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = REMEMBER_LINE_RE.exec(line);
      const body = match?.[1]?.trim();
      return body ? [body.slice(0, AGENT_MEMORY_BODY_MAX_CHARS)] : [];
    });
}

/**
 * Deterministic key for an auto-captured entry (§9.2): no kind is inferred
 * from the sentence (default "lesson") and no key is supplied by the agent,
 * so the key is `sha256(body)` truncated to 16 hex chars, prefixed `auto-`.
 * Guaranteed to satisfy the key regex, and to collide only when the body is
 * byte-identical -- exactly the ADD/NOOP behavior wanted for a repeated
 * `Remember:` line.
 */
function autoMemoryKey(body: string): string {
  return `auto-${createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
}

/**
 * Extension point, unimplemented, behind a flag (owner decision 2): a later
 * async extractor (reading the same two texts, but proposing candidates via
 * an LLM call rather than the `Remember:` regex) would be wired here,
 * fire-and-forget, never blocking run finalization. No extractor logic is
 * written in this pass -- this flag is dead code until that follow-up lands.
 */
export const AGENT_MEMORY_LLM_EXTRACTOR_ENV = "PAPERCLIP_AGENT_MEMORY_LLM_EXTRACTOR";
export function isAgentMemoryLlmExtractorEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[AGENT_MEMORY_LLM_EXTRACTOR_ENV] === "on";
}

/**
 * Run-end capture (§9.3), called once from heartbeat.ts right after the
 * run's final summary and (when one is posted) issue comment are resolved.
 * Gated by the effective mode (§10) *before* any DB work: an "off" instance
 * or agent never even scans the text, matching §10.2's "writes are always
 * active whenever the instance kill switch is not off" -- shadow and on
 * both capture, only *injection* differs between those two modes.
 *
 * Routed through the exact same `writeAgentMemoryEntry` (+ its redaction
 * pipeline) as the explicit `POST /api/agents/me/memory` route -- there is
 * no separate, less-checked write path for auto-captured text. Best-effort:
 * each candidate write is caught and logged individually, so one rejected
 * or capped write (a long-quoted-text heuristic hit, a secret, a per-run
 * cap) never drops a sibling `Remember:` line in the same text, and this
 * function itself never throws -- a memory-capture failure must never fail
 * or delay run finalization.
 */
export async function captureRememberLinesForRun(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string;
    sourceIssueId: string | null;
    sourceTrust: SourceTrustMetadata | null;
    summaryText: string | null;
    commentText: string | null;
    effectiveMode: AgentMemoryMode;
  },
): Promise<{ captured: number }> {
  if (input.effectiveMode === "off") return { captured: 0 };

  // Dedup: the same `Remember:` text appearing in both the summary and the
  // posted comment is captured once. Bounded to the per-run write cap before
  // any DB work: `writeAgentMemoryEntry` itself rejects anything past that
  // cap anyway (one count query + a thrown error per call), so an agent
  // whose output contains far more `Remember:` lines than the cap allows
  // (buggy or adversarial) can never turn run finalization into a loop of
  // work proportional to its own output size.
  const lines = [
    ...new Set([
      ...extractRememberLines(input.summaryText),
      ...extractRememberLines(input.commentText),
    ]),
  ].slice(0, AGENT_MEMORY_MAX_WRITES_PER_RUN);
  if (lines.length === 0) return { captured: 0 };

  let captured = 0;
  for (const body of lines) {
    try {
      await writeAgentMemoryEntry({
        db,
        companyId: input.companyId,
        agentId: input.agentId,
        actor: { type: "agent", id: input.agentId, agentId: input.agentId, runId: input.runId },
        sourceIssueId: input.sourceIssueId,
        sourceTrust: input.sourceTrust,
        candidate: { kind: "lesson", key: autoMemoryKey(body), body },
        hints: {},
      });
      captured += 1;
    } catch (err) {
      // A rejected write (redaction, cap, CAS/near-dup conflict) or any
      // other failure never drops the rest of this run's finalization, or
      // the capture of its sibling `Remember:` lines.
      logger.warn(
        { err, companyId: input.companyId, agentId: input.agentId, runId: input.runId },
        "agent memory capture: failed to write a Remember: line; continuing",
      );
    }
  }
  return { captured };
}
