/**
 * Exec a command inside a running pod container using the Kubernetes exec API.
 *
 * Uses @kubernetes/client-node's Exec class, which opens a WebSocket to the
 * kube-apiserver and streams stdout/stderr. The statusCallback receives a V1Status
 * with status="Success" or status="Failure" + details.causes[{reason:"ExitCode"}].
 *
 * NOTE: tty=false so stdout and stderr arrive on separate channels. If tty=true
 * were used, they would be merged onto stdout and the exit code would not be
 * reliable from the status callback on older cluster versions.
 *
 * Stdin handling: @kubernetes/client-node v1.x attaches `stdin.on("end", ()
 * => ws.close())`, which closes the entire WebSocket as soon as our PassThrough
 * ends — BEFORE the pod's command has a chance to flush and BEFORE the
 * statusCallback fires. We work around this by removing that listener after
 * exec setup completes so EOF on stdin only signals the pod (via a stdin-
 * channel close frame implicit in our flow) without tearing down the
 * connection. We then close the WebSocket explicitly inside the statusCallback.
 */

import { Exec } from "@kubernetes/client-node";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";
import type { KubeConfig } from "@kubernetes/client-node";

// Minimal WebSocket-like shape covering what we touch. The full type comes from
// @kubernetes/client-node's transitive ws/isomorphic-ws dep (the Node `ws`
// package) but importing it directly couples this file to that internal choice.
// Everything beyond close() is optional so a test double (or a future client
// that hands back a browser-style socket) degrades to "no keepalive" instead of
// crashing.
type WebSocketLike = {
  close(): void;
  terminate?(): void;
  ping?(): void;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  readyState?: number;
  bufferedAmount?: number;
};

// `ws` readyState values (RFC 6455 / WHATWG): 2 = CLOSING, 3 = CLOSED.
const WS_CLOSING = 2;

/**
 * Keepalive / dead-connection detection for a pod exec WebSocket.
 *
 * Why this exists: @kubernetes/client-node's WebSocketHandler.connect() only
 * wires `onerror` BEFORE the socket opens and never wires `onclose` at all, so
 * once the exec is running a dropped connection (apiserver restart, node/NAT
 * blip, kubelet stream torn down) is invisible to us: no status frame, no
 * stream `end`, nothing — the exec just waits out its whole watchdog (3600s for
 * an agent run). A half-open TCP connection (peer vanished without a FIN) is
 * even worse: not even the kernel notices until TCP keepalive (~2h default).
 *
 * The liveness contract: the connection is considered alive while ANY evidence
 * of a live peer arrives — an inbound frame (stdout/stderr/status data), a pong
 * to our periodic ping, or our outbound send buffer draining (the kernel only
 * frees send-buffer space when the peer ACKs, which matters during a big stdin
 * upload where our ping sits queued behind megabytes of data). RFC 6455 §5.5.2
 * obliges the endpoint (the kube-apiserver, whose websocket servers answer
 * pings automatically) to answer every ping, so a command that is merely QUIET
 * but still connected keeps answering pongs and is never killed — only a
 * connection that shows no sign of life for `timeoutMs` is.
 */
export interface ExecLivenessOptions {
  /** How often to ping the apiserver. 0 disables pinging AND the idle check. */
  keepaliveIntervalMs?: number;
  /** Declare the exec dead after this long without any liveness evidence. */
  timeoutMs?: number;
}

export const DEFAULT_EXEC_KEEPALIVE_INTERVAL_MS = 15_000;
export const DEFAULT_EXEC_LIVENESS_TIMEOUT_MS = 60_000;

/** Why an exec failed at the transport level rather than by the command exiting. */
export type PodExecTransportFailureKind =
  | "timeout" // overall watchdog (caller's budget) expired
  | "connection_closed" // WebSocket closed before a status frame arrived
  | "connection_error" // WebSocket emitted an error after setup
  | "keepalive_timeout"; // no frame / pong / send progress within the liveness window

/**
 * Transport-level exec failure. Carries whatever stdout/stderr had arrived
 * before the failure so the caller can still surface partial output (e.g. an
 * agent's JSONL session id) instead of dropping it.
 *
 * IMPORTANT: on any kind other than "timeout" the in-pod process may STILL BE
 * RUNNING — the Kubernetes exec API has no re-attach, and the container runtime
 * does not reliably kill an exec'd process when its stream goes away. Callers
 * must NOT blindly re-run the command (agent runs are not idempotent).
 */
export class PodExecTransportError extends Error {
  constructor(
    message: string,
    readonly kind: PodExecTransportFailureKind,
    readonly partialStdout: string,
    readonly partialStderr: string,
  ) {
    super(message);
    this.name = "PodExecTransportError";
  }
}

function describeCloseReason(reason: unknown): string {
  if (Buffer.isBuffer(reason)) return reason.toString("utf-8");
  return typeof reason === "string" ? reason : "";
}

/**
 * Attach close/error listeners and a ping/pong liveness monitor to an exec
 * WebSocket. `onDead` is called at most once with the failure kind and a
 * human-readable detail; `hasStatus()` tells the monitor that a status frame
 * already arrived, in which case a close is the normal end of the exec and is
 * ignored. Returns a disposer that stops the timer and removes the listeners.
 */
export function monitorExecSocket(
  ws: WebSocketLike,
  opts: ExecLivenessOptions | undefined,
  hasStatus: () => boolean,
  onDead: (kind: Exclude<PodExecTransportFailureKind, "timeout">, detail: string) => void,
): () => void {
  const intervalMs = opts?.keepaliveIntervalMs ?? DEFAULT_EXEC_KEEPALIVE_INTERVAL_MS;
  // The liveness window must span at least two pings, or a single delayed pong
  // would already count as dead.
  const timeoutMs = Math.max(opts?.timeoutMs ?? DEFAULT_EXEC_LIVENESS_TIMEOUT_MS, intervalMs * 2);
  let fired = false;
  let lastAliveAt = Date.now();
  let lastBufferedAmount = ws.bufferedAmount ?? 0;

  const fire = (kind: Exclude<PodExecTransportFailureKind, "timeout">, detail: string) => {
    if (fired || hasStatus()) return; // status already in hand => close is the normal end
    fired = true;
    dispose();
    onDead(kind, detail);
  };
  const markAlive = () => { lastAliveAt = Date.now(); };
  const onClose = (code: unknown, reason: unknown) => {
    const why = describeCloseReason(reason);
    fire("connection_closed", `WebSocket closed (code=${String(code)}${why ? `, reason=${why}` : ""})`);
  };
  const onError = (err: unknown) => {
    fire("connection_error", `WebSocket error: ${err instanceof Error ? err.message : String(err)}`);
  };

  const canListen = typeof ws.on === "function";
  if (canListen) {
    ws.on!("close", onClose);
    ws.on!("error", onError);
    ws.on!("message", markAlive); // any stdout/stderr/status frame
    ws.on!("pong", markAlive); // apiserver answered our ping
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  if (intervalMs > 0 && typeof ws.ping === "function") {
    timer = setInterval(() => {
      // Outbound progress: our send buffer shrank since the last tick, so the
      // peer is ACKing data (a large stdin upload can queue our ping behind it).
      const buffered = ws.bufferedAmount ?? 0;
      if (buffered < lastBufferedAmount) markAlive();
      lastBufferedAmount = buffered;

      if (Date.now() - lastAliveAt >= timeoutMs) {
        fire(
          "keepalive_timeout",
          `no frame, pong or send progress for ${Date.now() - lastAliveAt}ms (liveness timeout ${timeoutMs}ms)`,
        );
        return;
      }
      try {
        ws.ping!();
      } catch (err) {
        // `ws` throws synchronously when the socket is no longer OPEN.
        fire("connection_error", `WebSocket ping failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, intervalMs);
    // Never keep the worker process alive just for a keepalive tick.
    (timer as { unref?: () => void }).unref?.();
  }

  function dispose() {
    if (timer) clearInterval(timer);
    timer = null;
    if (canListen && typeof ws.removeListener === "function") {
      ws.removeListener("close", onClose);
      ws.removeListener("error", onError);
      ws.removeListener("message", markAlive);
      ws.removeListener("pong", markAlive);
    }
  }

  // The socket may already be closing/closed by the time the exec promise hands
  // it to us (close events that fired before we listened are otherwise lost).
  if (typeof ws.readyState === "number" && ws.readyState >= WS_CLOSING) {
    fire("connection_closed", `WebSocket already ${ws.readyState === WS_CLOSING ? "closing" : "closed"} when exec setup completed`);
  }

  return dispose;
}

// Tear a dead socket down hard: terminate() destroys the TCP socket without a
// closing handshake, which a vanished peer would never complete anyway.
function killSocket(ws: WebSocketLike | null): void {
  try {
    if (ws && typeof ws.terminate === "function") ws.terminate();
    else ws?.close();
  } catch { /* ignore */ }
}

// Shared error text for a transport failure. Spells out that the command was NOT
// retried and may still be running, so an operator reading the run log knows
// not to assume it stopped.
function transportFailureMessage(
  fn: string,
  kind: Exclude<PodExecTransportFailureKind, "timeout">,
  detail: string,
  podName: string,
  containerName: string,
  cmd0: string,
): string {
  return `${fn} lost its exec connection before the command reported an exit status (${kind}: ${detail}; pod=${podName}, container=${containerName}, cmd0=${cmd0}). The command was not re-run and may still be running in the pod.`;
}

// Single-quote a string for safe interpolation into a sh -c script. Wraps in
// '...' and escapes any embedded single quotes via '\'' (close, escape, reopen).
export function shQuote(segment: string): string {
  return `'${segment.replace(/'/g, "'\\''")}'`;
}

// Wrap a command so the given env vars are exported before it runs. The Kubernetes
// exec API has no env field, so the only way to give an exec'd process additional
// env is to run it under a shell that exports the vars and then `exec`s the real
// command. PATH is deliberately skipped (the caller's PATH is the orchestrator's,
// not the sandbox image's, and overriding it would break command resolution), and
// only valid shell identifiers are exported. Returns the original command unchanged
// when there is nothing to apply.
export function wrapCommandWithEnv(
  command: string[],
  env: Record<string, string> | undefined | null,
): string[] {
  const entries = Object.entries(env && typeof env === "object" ? env : {}).filter(
    ([key, value]) =>
      typeof value === "string" && key !== "PATH" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key),
  );
  if (entries.length === 0) return command;
  const exports = entries.map(([k, v]) => `export ${k}=${shQuote(v)};`).join(" ");
  return ["/bin/sh", "-c", `${exports} exec ${command.map(shQuote).join(" ")}`];
}

export async function execInPod(
  kc: KubeConfig,
  namespace: string,
  podName: string,
  containerName: string,
  command: string[],
  stdin?: string | Buffer,
  timeoutMs?: number,
  // Optional host-side bound on accumulated stdout. The pod is an untrusted,
  // attacker-controlled endpoint: a malicious pod can emit unbounded stdout
  // during an exec (e.g. a native file-sync `syncOut` tarball), which would grow
  // the in-memory accumulator without limit — blowing up the worker's RSS and,
  // past V8's ~512 MB max string length, throwing a synchronous RangeError inside
  // the stream `data` listener that no caller can catch (an uncaught exception =
  // worker crash = cross-tenant DoS). When set, accumulation fails closed the
  // instant it would exceed the cap so the caller can fall back. In-pod size
  // checks are worthless here — only the host can be trusted to enforce this.
  maxStdoutBytes?: number,
  // Same bound for the stderr channel. stderr is equally pod-controlled: a
  // malicious pod can emit an unbounded stderr stream during the SAME exec (e.g.
  // crafted tar/realpath diagnostics on the `syncOut` path) and trigger the
  // identical uncaught-`RangeError` worker crash. When set, stderr accumulation
  // fails closed at the cap; regardless of the cap, the `+=` is guarded so a
  // max-string-length `RangeError` can never escape as an uncaught exception.
  maxStderrBytes?: number,
  // Dead-connection detection (ping/pong keepalive + liveness window). Omitted
  // => defaults (15s ping, 60s window); `keepaliveIntervalMs: 0` disables it.
  // See monitorExecSocket.
  liveness?: ExecLivenessOptions,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const exec = new Exec(kc);
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();

  const stdinPayload: Buffer | null =
    Buffer.isBuffer(stdin) ? stdin
    : typeof stdin === "string" && stdin.length > 0 ? Buffer.from(stdin, "utf-8")
    : null;
  const stdinStream: PassThrough | null = stdinPayload ? new PassThrough() : null;

  // When stdin is provided, wrap the command so its stdin is bounded by
  // `head -c <N>`. Any program reading stdin (`cat`, `claude --print -`,
  // `base64 -d`, etc.) waits for EOF to terminate the read. With the k8s
  // client v0.21.0 stdin-end -> ws.close() limitation (see comment above)
  // we can't reliably deliver EOF without tearing down the exec — so we
  // pipe `head -c <N>` (which exits after exactly N bytes) into the
  // original command. The pipe propagates the exit code of the RHS so the
  // statusCallback still reflects the real command's exit status.
  //
  // NOTE: `stdinPayload.length` is the Buffer's BYTE length (correct for
  // `head -c` which counts bytes). Do NOT substitute `string.length` here
  // if the input is ever non-ASCII — UTF-8 multi-byte sequences would
  // give a byte count that differs from JS character count.
  const effectiveCommand = stdinPayload
    ? ["/bin/sh", "-c", `head -c ${stdinPayload.length} | ${command.map(shQuote).join(" ")}`]
    : command;

  let stdoutData = "";
  let stderrData = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;

  return await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      let ws: WebSocketLike | null = null;
      let resolved = false;
      let pendingExitCode: number | null = null;
      let stdoutEnded = false;
      let stderrEnded = false;
      // Disposer for the keepalive monitor; set once the WebSocket is open.
      let stopMonitor: (() => void) | null = null;

      // The k8s client writes stdout/stderr to our PassThroughs synchronously
      // and calls statusCallback in the same WS message handler. But `data`
      // events on the PassThroughs fire on process.nextTick, so resolving
      // inside statusCallback captures stdoutData/stderrData BEFORE the final
      // bytes have been appended. Wait for both streams' `end` events (which
      // the k8s client triggers via `stream.end()` when it processes the
      // status frame) so all buffered data has been drained into our string
      // accumulators before resolving.
      //
      // Watchdog: the caller's overall budget for the command. A dropped
      // WebSocket is detected much earlier by the keepalive monitor below
      // (close/error events + ping/pong); this timer is the last-resort bound
      // for a command that is alive but simply runs too long, or for a socket
      // double that exposes no events.
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      if (typeof timeoutMs === "number" && timeoutMs > 0) {
        watchdog = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          stopMonitor?.();
          try { ws?.close(); } catch { /* ignore */ }
          reject(new PodExecTransportError(
            `execInPod timed out after ${timeoutMs}ms (pod=${podName}, container=${containerName}, cmd0=${effectiveCommand[0] ?? ""}). No exit status arrived within the exec budget.`,
            "timeout",
            stdoutData,
            stderrData,
          ));
        }, timeoutMs);
      }

      const tryFinish = () => {
        if (resolved) return;
        if (pendingExitCode === null) return;
        if (!stdoutEnded || !stderrEnded) return;
        resolved = true;
        if (watchdog) clearTimeout(watchdog);
        stopMonitor?.();
        try { ws?.close(); } catch { /* ignore */ }
        resolve({ exitCode: pendingExitCode, stdout: stdoutData, stderr: stderrData });
      };

      // Fail the whole exec closed, tearing down the WebSocket so the pod stops
      // streaming. Used by the stdout cap below; the `resolved` guard makes it a
      // no-op if the exec already finished.
      const failClosed = (err: Error) => {
        if (resolved) return;
        resolved = true;
        if (watchdog) clearTimeout(watchdog);
        stopMonitor?.();
        try { ws?.close(); } catch { /* ignore */ }
        reject(err);
      };

      // Accumulate stdout inside the executor so the cap can reject before an
      // unbounded pod payload exhausts memory. Once resolved (finished, timed
      // out, or capped) further chunks are dropped rather than appended.
      stdoutStream.on("data", (chunk: Buffer) => {
        if (resolved) return;
        if (typeof maxStdoutBytes === "number" && maxStdoutBytes >= 0) {
          stdoutBytes += chunk.length;
          if (stdoutBytes > maxStdoutBytes) {
            failClosed(new Error(
              `execInPod stdout exceeded the ${maxStdoutBytes}-byte cap (pod=${podName}, container=${containerName}); the sandbox produced more output than the buffer allows.`,
            ));
            return;
          }
        }
        try {
          stdoutData += chunk.toString("utf-8");
        } catch (err) {
          // Belt-and-suspenders: even under an explicit cap (or with none set),
          // never let a `+=` RangeError at V8's max string length escape this
          // listener as an uncaught exception.
          failClosed(err instanceof Error ? err : new Error(String(err)));
        }
      });

      // stderr is pod-controlled too — bound it with the same fail-closed policy
      // and, unconditionally, guard the `+=` so a max-string-length `RangeError`
      // can never escape this listener as an uncaught (worker-crashing) exception.
      stderrStream.on("data", (chunk: Buffer) => {
        if (resolved) return;
        if (typeof maxStderrBytes === "number" && maxStderrBytes >= 0) {
          stderrBytes += chunk.length;
          if (stderrBytes > maxStderrBytes) {
            failClosed(new Error(
              `execInPod stderr exceeded the ${maxStderrBytes}-byte cap (pod=${podName}, container=${containerName}); the sandbox produced more output than the buffer allows.`,
            ));
            return;
          }
        }
        try {
          stderrData += chunk.toString("utf-8");
        } catch (err) {
          failClosed(err instanceof Error ? err : new Error(String(err)));
        }
      });

      stdoutStream.on("end", () => { stdoutEnded = true; tryFinish(); });
      stderrStream.on("end", () => { stderrEnded = true; tryFinish(); });

      const execPromise = exec.exec(
        namespace,
        podName,
        containerName,
        effectiveCommand,
        stdoutStream,
        stderrStream,
        stdinStream,
        false, // tty=false: keep stdout/stderr on separate channels
        (status) => {
          if (status.status === "Success") {
            pendingExitCode = 0;
          } else {
            const causes = status.details?.causes ?? [];
            const exitCodeCause = causes.find(
              (c: { reason?: string; message?: string }) =>
                c.reason === "ExitCode",
            );
            pendingExitCode = exitCodeCause?.message
              ? Number(exitCodeCause.message)
              : 1;
          }
          tryFinish();
        },
      );

      execPromise
        .then((webSocket) => {
          ws = webSocket as unknown as WebSocketLike;
          if (resolved) {
            // Already failed (watchdog/cap) while connecting: just drop the socket.
            try { ws.close(); } catch { /* ignore */ }
            return;
          }
          // Fail fast on a dead exec connection instead of waiting out the
          // watchdog. The exit status (`pendingExitCode`) is the only proof
          // the command finished; a close after it is the normal teardown.
          const socket = ws;
          stopMonitor = monitorExecSocket(socket, liveness, () => pendingExitCode !== null, (kind, detail) => {
            if (resolved) return;
            resolved = true;
            if (watchdog) clearTimeout(watchdog);
            killSocket(socket);
            reject(new PodExecTransportError(
              transportFailureMessage("execInPod", kind, detail, podName, containerName, effectiveCommand[0] ?? ""),
              kind,
              stdoutData,
              stderrData,
            ));
          });
          if (stdinStream && stdinPayload) {
            // Remove the default `end -> ws.close()` listener that k8s client
            // attaches in handleStandardInput; it tears down the connection
            // before the pod's command can finish flushing. We manage ws
            // closure inside `tryFinish()` instead.
            stdinStream.removeAllListeners("end");
            stdinStream.end(stdinPayload);
          } else if (stdinStream) {
            stdinStream.removeAllListeners("end");
            stdinStream.end();
          }
        })
        .catch((err) => {
          if (resolved) return;
          resolved = true;
          if (watchdog) clearTimeout(watchdog);
          reject(err);
        });
    },
  );
}

/**
 * Streaming variant of {@link execInPod} for bulk file transfer over the pod
 * exec data channel.
 *
 * Where `execInPod` buffers the command's whole stdout into an in-memory string
 * (fine for small command output, fatal for a multi-gigabyte tar), this variant
 * PIPES the exec's stdin from a caller `Readable` and its stdout into a caller
 * `Writable` — so a native file-sync `syncIn`/`syncOut` streams raw tar bytes
 * straight to/from a host file on disk and neither the host nor the pod ever
 * holds the whole payload in memory. Both are intentionally kept side by side:
 * `execInPod` still backs the `environmentExecute` path unchanged.
 *
 * stderr is still accumulated into a (bounded) string: it carries only the
 * script's fail-loud diagnostics, and the pod controls how many bytes it emits,
 * so `maxStderrBytes` fails the exec closed the instant the pod floods the
 * channel — the same DoS guard `execInPod` applies. stdout carries no such cap
 * here because it is streamed to disk, not a string; the caller bounds it with
 * its own streamed-bytes guard on the sink `Writable`.
 *
 * Stdin EOF: the same k8s-client `stdin.on("end", () => ws.close())` quirk noted
 * on `execInPod` applies, so we strip that listener and drive the pod command to
 * self-terminate on the byte count instead of relying on EOF (the caller's
 * `syncIn` script bounds its read with `head -c <N>`). We close the WebSocket
 * ourselves from the status callback.
 *
 * Resolves once the command's exit status is known AND both the stdout sink has
 * finished draining and stderr has ended, so a caller that reads the sink file
 * back after `await` always sees the complete archive.
 */
export async function execInPodStreaming(
  kc: KubeConfig,
  namespace: string,
  podName: string,
  containerName: string,
  command: string[],
  io: {
    stdin?: Readable;
    stdout?: Writable;
    timeoutMs?: number;
    maxStderrBytes?: number;
    // Dead-connection detection; see execInPod / monitorExecSocket.
    liveness?: ExecLivenessOptions;
  },
): Promise<{ exitCode: number; stderr: string }> {
  const exec = new Exec(kc);
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();
  const stdinStream: PassThrough | null = io.stdin ? new PassThrough() : null;

  let stderrData = "";
  let stderrBytes = 0;

  return await new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
    let ws: WebSocketLike | null = null;
    let resolved = false;
    let pendingExitCode: number | null = null;
    let stdoutDone = false;
    let stderrEnded = false;
    let stopMonitor: (() => void) | null = null;

    let watchdog: ReturnType<typeof setTimeout> | null = null;
    if (typeof io.timeoutMs === "number" && io.timeoutMs > 0) {
      watchdog = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        stopMonitor?.();
        try { ws?.close(); } catch { /* ignore */ }
        try { stdinStream?.destroy(); } catch { /* ignore */ }
        reject(new PodExecTransportError(
          `execInPodStreaming timed out after ${io.timeoutMs}ms (pod=${podName}, container=${containerName}, cmd0=${command[0] ?? ""}). No exit status arrived within the exec budget.`,
          "timeout",
          "",
          stderrData,
        ));
      }, io.timeoutMs);
    }

    const tryFinish = () => {
      if (resolved) return;
      if (pendingExitCode === null) return;
      if (!stdoutDone || !stderrEnded) return;
      resolved = true;
      if (watchdog) clearTimeout(watchdog);
      stopMonitor?.();
      try { ws?.close(); } catch { /* ignore */ }
      resolve({ exitCode: pendingExitCode, stderr: stderrData });
    };

    // Fail the whole exec closed, tearing down the WebSocket so the pod stops
    // streaming. Fired by a sink error (e.g. the caller's disk guard tripping)
    // or a stream error; the `resolved` guard makes it a no-op once finished.
    const failClosed = (err: Error) => {
      if (resolved) return;
      resolved = true;
      if (watchdog) clearTimeout(watchdog);
      stopMonitor?.();
      try { ws?.close(); } catch { /* ignore */ }
      try { stdinStream?.destroy(); } catch { /* ignore */ }
      reject(err);
    };

    // Pipe stdout to the caller sink (streamed to disk), or drain it if the
    // caller wants none. Piping with the default `end: true` ends the sink when
    // the pod's stdout closes, so the sink's `finish` marks the archive fully
    // written. A sink error (the caller's streamed-bytes guard, a full disk)
    // fails the exec closed and stops the pod.
    if (io.stdout) {
      const sink = io.stdout;
      sink.on("error", failClosed);
      stdoutStream.on("error", failClosed);
      sink.on("finish", () => { stdoutDone = true; tryFinish(); });
      stdoutStream.pipe(sink);
    } else {
      stdoutStream.on("data", () => { /* drain */ });
      stdoutStream.on("end", () => { stdoutDone = true; tryFinish(); });
      stdoutStream.on("error", failClosed);
    }

    // stderr is pod-controlled — bound it with the same fail-closed policy as
    // execInPod and guard the `+=` so a max-string-length RangeError can never
    // escape as an uncaught (worker-crashing) exception.
    stderrStream.on("data", (chunk: Buffer) => {
      if (resolved) return;
      if (typeof io.maxStderrBytes === "number" && io.maxStderrBytes >= 0) {
        stderrBytes += chunk.length;
        if (stderrBytes > io.maxStderrBytes) {
          failClosed(new Error(
            `execInPodStreaming stderr exceeded the ${io.maxStderrBytes}-byte cap (pod=${podName}, container=${containerName}); the sandbox produced more diagnostics than the buffer allows.`,
          ));
          return;
        }
      }
      try {
        stderrData += chunk.toString("utf-8");
      } catch (err) {
        failClosed(err instanceof Error ? err : new Error(String(err)));
      }
    });
    stderrStream.on("end", () => { stderrEnded = true; tryFinish(); });

    const execPromise = exec.exec(
      namespace,
      podName,
      containerName,
      command,
      stdoutStream,
      stderrStream,
      stdinStream,
      false, // tty=false: keep stdout/stderr on separate channels
      (status) => {
        if (status.status === "Success") {
          pendingExitCode = 0;
        } else {
          const causes = status.details?.causes ?? [];
          const exitCodeCause = causes.find(
            (c: { reason?: string; message?: string }) => c.reason === "ExitCode",
          );
          pendingExitCode = exitCodeCause?.message ? Number(exitCodeCause.message) : 1;
        }
        tryFinish();
      },
    );

    execPromise
      .then((webSocket) => {
        ws = webSocket as unknown as WebSocketLike;
        if (resolved) {
          try { ws.close(); } catch { /* ignore */ }
          return;
        }
        // Same fast dead-connection detection as execInPod. Whether a dropped
        // transfer may be retried is the caller's decision, not ours.
        const socket = ws;
        stopMonitor = monitorExecSocket(socket, io.liveness, () => pendingExitCode !== null, (kind, detail) => {
          if (resolved) return;
          resolved = true;
          if (watchdog) clearTimeout(watchdog);
          killSocket(socket);
          try { stdinStream?.destroy(); } catch { /* ignore */ }
          reject(new PodExecTransportError(
            transportFailureMessage("execInPodStreaming", kind, detail, podName, containerName, command[0] ?? ""),
            kind,
            "",
            stderrData,
          ));
        });
        if (stdinStream && io.stdin) {
          // Strip the default `end -> ws.close()` listener (see execInPod) so
          // EOF on our stdin only signals the pod, then stream the caller's
          // source into the exec stdin channel. A source error fails closed.
          stdinStream.removeAllListeners("end");
          io.stdin.on("error", failClosed);
          io.stdin.pipe(stdinStream);
        } else if (stdinStream) {
          stdinStream.removeAllListeners("end");
          stdinStream.end();
        }
      })
      .catch((err) => {
        if (resolved) return;
        resolved = true;
        if (watchdog) clearTimeout(watchdog);
        reject(err);
      });
  });
}
