import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  GetQuotaWindowsContext,
  ProviderQuotaResult,
  QuotaWindow,
  QuotaWindowsCredential,
} from "@paperclipai/adapter-utils";
import type { ClaudeRateLimitSnapshot } from "./parse.js";

const execFileAsync = promisify(execFile);

const CLAUDE_USAGE_SOURCE_OAUTH = "anthropic-oauth";
const CLAUDE_USAGE_SOURCE_CLI = "claude-cli";
// Source label for a result built from a run's own passively-observed
// rate_limit_event instead of a live poll — see pollClaudeQuotaForCredential.
const CLAUDE_USAGE_SOURCE_RUN_TELEMETRY = "claude-run-telemetry";
// A live read is reused for this long before the next poll bothers the
// rate-limited oauth/usage endpoint again.
const CLAUDE_QUOTA_FRESH_MS = 120_000;
// After a live read fails (429 or otherwise), stop retrying it for this long
// and serve the last good read instead, marked stale.
const CLAUDE_QUOTA_BACKOFF_MS = 5 * 60_000;

export function claudeConfigDir(): string {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return path.join(os.homedir(), ".claude");
}

function hasNonEmptyProcessEnv(key: string): boolean {
  const value = process.env[key];
  return typeof value === "string" && value.trim().length > 0;
}

function createClaudeQuotaEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (key.startsWith("ANTHROPIC_")) continue;
    env[key] = value;
  }
  return env;
}

function stripBackspaces(text: string): string {
  let out = "";
  for (const char of text) {
    if (char === "\b") {
      out = out.slice(0, -1);
    } else {
      out += char;
    }
  }
  return out;
}

function stripAnsi(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function cleanTerminalText(text: string): string {
  return stripAnsi(stripBackspaces(text))
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n");
}

function normalizeForLabelSearch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function trimToLatestUsagePanel(text: string): string | null {
  const lower = text.toLowerCase();
  const settingsIndex = lower.lastIndexOf("settings:");
  if (settingsIndex < 0) return null;
  let tail = text.slice(settingsIndex);
  const tailLower = tail.toLowerCase();
  if (!tailLower.includes("usage")) return null;
  if (!tailLower.includes("current session") && !tailLower.includes("loading usage")) return null;
  const stopMarkers = [
    "status dialog dismissed",
    "checking for updates",
    "press ctrl-c again to exit",
  ];
  let stopIndex = -1;
  for (const marker of stopMarkers) {
    const markerIndex = tailLower.indexOf(marker);
    if (markerIndex >= 0 && (stopIndex === -1 || markerIndex < stopIndex)) {
      stopIndex = markerIndex;
    }
  }
  if (stopIndex >= 0) {
    tail = tail.slice(0, stopIndex);
  }
  return tail;
}

async function readClaudeTokenFromFile(credPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(credPath, "utf8");
  } catch {
    return null;
  }
  const credential = parseClaudeCredential(raw);
  if (!credential) return null;
  // On macOS the CLI refreshes the Keychain item, not this file, so a file
  // whose token has expired is a stale leftover. Skip it so the caller can
  // fall through to a live credential instead of failing with a dead token.
  if (credential.expiresAt != null && credential.expiresAt <= Date.now()) return null;
  return credential.token;
}

interface ClaudeCredential {
  token: string;
  /** Epoch milliseconds, when the credential file records one. */
  expiresAt: number | null;
}

function parseClaudeCredential(raw: string): ClaudeCredential | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const oauth = obj["claudeAiOauth"];
  if (typeof oauth !== "object" || oauth === null) return null;
  const token = (oauth as Record<string, unknown>)["accessToken"];
  if (typeof token !== "string" || token.length === 0) return null;
  const expiresAt = (oauth as Record<string, unknown>)["expiresAt"];
  return { token, expiresAt: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null };
}

function parseClaudeCredentialToken(raw: string): string | null {
  return parseClaudeCredential(raw)?.token ?? null;
}

interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
}

export async function readClaudeAuthStatus(): Promise<ClaudeAuthStatus | null> {
  try {
    const { stdout } = await execFileAsync("claude", ["auth", "status"], {
      env: process.env,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return {
      loggedIn: parsed.loggedIn === true,
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
      subscriptionType: typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : null,
    };
  } catch {
    return null;
  }
}

function describeClaudeSubscriptionAuth(status: ClaudeAuthStatus | null): string | null {
  if (!status?.loggedIn || status.authMethod !== "claude.ai") return null;
  return status.subscriptionType
    ? `Claude is logged in via claude.ai (${status.subscriptionType})`
    : "Claude is logged in via claude.ai";
}

// Claude Code on macOS stores the OAuth credential for a custom
// CLAUDE_CONFIG_DIR in a per-directory Keychain item named
// "Claude Code-credentials-<first 8 hex chars of sha256(dir)>" instead of a
// credentials file in the directory. The suffix binds the item to exactly one
// auth home, so reading it can only ever surface the login performed inside
// that home — none of the cross-account risk of the unsuffixed operator item.
function isolatedKeychainService(configDir: string): string {
  return `Claude Code-credentials-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
}

async function readClaudeTokenFromKeychain(service: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], { timeout: 10000, maxBuffer: 1024 * 1024 });
    return parseClaudeCredentialToken(stdout);
  } catch { return null; }
}

/**
 * Read the credential that a `claude` login performed inside an isolated auth
 * home left in the macOS Keychain. Only that home's own suffixed item is
 * consulted — never the unsuffixed item that holds the server operator's
 * machine-level login. Returns null off macOS.
 */
export async function readIsolatedClaudeKeychainToken(loginHome: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  return readClaudeTokenFromKeychain(isolatedKeychainService(loginHome));
}

export async function readClaudeToken(options: { allowKeychain?: boolean } = {}): Promise<string | null> {
  const configDir = claudeConfigDir();
  for (const filename of [".credentials.json", "credentials.json"]) {
    const token = await readClaudeTokenFromFile(path.join(configDir, filename));
    if (token) return token;
  }
  if (process.platform !== "darwin") return null;
  // A custom auth home owns exactly one Keychain item: the suffixed one the
  // CLI created for that directory. It must never fall through to the
  // unsuffixed item, which belongs to a different account.
  if (process.env.CLAUDE_CONFIG_DIR?.trim()) {
    return readClaudeTokenFromKeychain(isolatedKeychainService(configDir));
  }
  // Only an explicit local-account import may consult the user's Keychain.
  if (options.allowKeychain) {
    return readClaudeTokenFromKeychain("Claude Code-credentials");
  }
  return null;
}

interface AnthropicUsageWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

interface AnthropicExtraUsage {
  is_enabled?: boolean | null;
  monthly_limit?: number | null;
  used_credits?: number | null;
  utilization?: number | null;
  currency?: string | null;
}

interface AnthropicUsageResponse {
  five_hour?: AnthropicUsageWindow | null;
  seven_day?: AnthropicUsageWindow | null;
  seven_day_sonnet?: AnthropicUsageWindow | null;
  seven_day_opus?: AnthropicUsageWindow | null;
  extra_usage?: AnthropicExtraUsage | null;
}

function formatCurrencyAmount(value: number, currency: string | null | undefined): string {
  const code = typeof currency === "string" && currency.trim().length > 0 ? currency.trim().toUpperCase() : "USD";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatExtraUsageLabel(extraUsage: AnthropicExtraUsage): string | null {
  const monthlyLimit = extraUsage.monthly_limit;
  const usedCredits = extraUsage.used_credits;
  if (
    typeof monthlyLimit !== "number" ||
    !Number.isFinite(monthlyLimit) ||
    typeof usedCredits !== "number" ||
    !Number.isFinite(usedCredits)
  ) {
    return null;
  }
  // API returns values in cents — convert to dollars for display
  return `${formatCurrencyAmount(usedCredits / 100, extraUsage.currency)} / ${formatCurrencyAmount(monthlyLimit / 100, extraUsage.currency)}`;
}

/** Convert a utilization value to a 0-100 integer percent. Returns null for null/undefined input.
 *  Handles both 0-1 fractions (legacy) and 0-100 percentages (current API). */
export function toPercent(utilization: number | null | undefined): number | null {
  if (utilization == null) return null;
  return Math.min(100, Math.round(utilization < 1 ? utilization * 100 : utilization));
}

/** fetch with an abort-based timeout so a hanging provider api doesn't block the response indefinitely */
export async function fetchWithTimeout(url: string, init: RequestInit, ms = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchClaudeQuota(token: string): Promise<QuotaWindow[]> {
  const resp = await fetchWithTimeout("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  if (!resp.ok) throw new Error(`anthropic usage api returned ${resp.status}`);
  const body = (await resp.json()) as AnthropicUsageResponse;
  const windows: QuotaWindow[] = [];

  if (body.five_hour != null) {
    windows.push({
      label: "Current session",
      usedPercent: toPercent(body.five_hour.utilization),
      resetsAt: body.five_hour.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.seven_day != null) {
    windows.push({
      label: "Current week (all models)",
      usedPercent: toPercent(body.seven_day.utilization),
      resetsAt: body.seven_day.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.seven_day_sonnet != null) {
    windows.push({
      label: "Current week (Sonnet only)",
      usedPercent: toPercent(body.seven_day_sonnet.utilization),
      resetsAt: body.seven_day_sonnet.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.seven_day_opus != null) {
    windows.push({
      label: "Current week (Opus only)",
      usedPercent: toPercent(body.seven_day_opus.utilization),
      resetsAt: body.seven_day_opus.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.extra_usage != null) {
    windows.push({
      label: "Extra usage",
      usedPercent: body.extra_usage.is_enabled === false ? null : toPercent(body.extra_usage.utilization),
      resetsAt: null,
      valueLabel:
        body.extra_usage.is_enabled === false
          ? "Not enabled"
          : formatExtraUsageLabel(body.extra_usage),
      detail:
        body.extra_usage.is_enabled === false
          ? "Extra usage not enabled"
          : "Monthly extra usage pool",
    });
  }
  return windows;
}

function usageOutputLooksRelevant(text: string): boolean {
  const normalized = normalizeForLabelSearch(text);
  return normalized.includes("currentsession")
    || normalized.includes("currentweek")
    || normalized.includes("loadingusage")
    || normalized.includes("failedtoloadusagedata")
    || normalized.includes("tokenexpired")
    || normalized.includes("authenticationerror")
    || normalized.includes("ratelimited");
}

function usageOutputLooksComplete(text: string): boolean {
  const normalized = normalizeForLabelSearch(text);
  if (
    normalized.includes("failedtoloadusagedata")
    || normalized.includes("tokenexpired")
    || normalized.includes("authenticationerror")
    || normalized.includes("ratelimited")
  ) {
    return true;
  }
  return normalized.includes("currentsession")
    && (normalized.includes("currentweek") || normalized.includes("extrausage"))
    && /[0-9]{1,3}(?:\.[0-9]+)?%/i.test(text);
}

function extractUsageError(text: string): string | null {
  const lower = text.toLowerCase();
  const compact = lower.replace(/\s+/g, "");
  if (lower.includes("token_expired") || lower.includes("token has expired")) {
    return "Claude CLI token expired. Run `claude login` to refresh.";
  }
  if (lower.includes("authentication_error")) {
    return "Claude CLI authentication error. Run `claude login`.";
  }
  if (lower.includes("rate_limit_error") || lower.includes("rate limited") || compact.includes("ratelimited")) {
    return "Claude CLI usage endpoint is rate limited right now. Please try again later.";
  }
  if (lower.includes("failed to load usage data") || compact.includes("failedtoloadusagedata")) {
    return "Claude CLI could not load usage data. Open the CLI and retry `/usage`.";
  }
  return null;
}

function percentFromLine(line: string): number | null {
  const match = line.match(/([0-9]{1,3}(?:\.[0-9]+)?)\s*%/i);
  if (!match) return null;
  const rawValue = Number(match[1]);
  if (!Number.isFinite(rawValue)) return null;
  const clamped = Math.min(100, Math.max(0, rawValue));
  const lower = line.toLowerCase();
  if (lower.includes("remaining") || lower.includes("left") || lower.includes("available")) {
    return Math.max(0, Math.min(100, Math.round(100 - clamped)));
  }
  return Math.round(clamped);
}

function isQuotaLabel(line: string): boolean {
  const normalized = normalizeForLabelSearch(line);
  return normalized === "currentsession"
    || normalized === "currentweekallmodels"
    || normalized === "currentweeksonnetonly"
    || normalized === "currentweeksonnet"
    || normalized === "currentweekopusonly"
    || normalized === "currentweekopus"
    || normalized === "extrausage";
}

function canonicalQuotaLabel(line: string): string {
  switch (normalizeForLabelSearch(line)) {
    case "currentsession":
      return "Current session";
    case "currentweekallmodels":
      return "Current week (all models)";
    case "currentweeksonnetonly":
    case "currentweeksonnet":
      return "Current week (Sonnet only)";
    case "currentweekopusonly":
    case "currentweekopus":
      return "Current week (Opus only)";
    case "extrausage":
      return "Extra usage";
    default:
      return line;
  }
}

function formatClaudeCliDetail(label: string, lines: string[]): string | null {
  const normalizedLabel = normalizeForLabelSearch(label);
  if (normalizedLabel === "extrausage") {
    const compact = lines.join(" ").replace(/\s+/g, "").toLowerCase();
    if (compact.includes("extrausagenotenabled")) {
      return "Extra usage not enabled • /extra-usage to enable";
    }
    const firstLine = lines.find((line) => line.trim().length > 0) ?? null;
    return firstLine;
  }

  const resetLine = lines.find((line) => /^resets/i.test(line) || normalizeForLabelSearch(line).startsWith("resets"));
  if (!resetLine) return null;
  return resetLine
    .replace(/^Resets/i, "Resets ")
    .replace(/([A-Z][a-z]{2})(\d)/g, "$1 $2")
    .replace(/(\d)at(\d)/g, "$1 at $2")
    .replace(/(am|pm)\(/gi, "$1 (")
    .replace(/([A-Za-z])\(/g, "$1 (")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseClaudeCliUsageText(text: string): QuotaWindow[] {
  const cleaned = trimToLatestUsagePanel(cleanTerminalText(text)) ?? cleanTerminalText(text);
  const usageError = extractUsageError(cleaned);
  if (usageError) throw new Error(usageError);

  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const sections: Array<{ label: string; lines: string[] }> = [];
  let current: { label: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (isQuotaLabel(line)) {
      if (current) sections.push(current);
      current = { label: canonicalQuotaLabel(line), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);

  const windows = sections.map<QuotaWindow>((section) => {
    const usedPercent = section.lines.map(percentFromLine).find((value) => value != null) ?? null;
    return {
      label: section.label,
      usedPercent,
      resetsAt: null,
      valueLabel: null,
      detail: formatClaudeCliDetail(section.label, section.lines),
    };
  });

  if (!windows.some((window) => normalizeForLabelSearch(window.label) === "currentsession")) {
    throw new Error("Could not parse Claude CLI usage output.");
  }
  return windows;
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildClaudeCliShellProbeCommand(): string {
  const feed = "(sleep 2; printf '/usage\\r'; sleep 6; printf '\\033'; sleep 1; printf '\\003')";
  const claudeCommand = "claude --tools \"\"";
  if (process.platform === "darwin") {
    return `${feed} | script -q /dev/null ${claudeCommand}`;
  }
  return `${feed} | script -q -e -f -c ${quoteForShell(claudeCommand)} /dev/null`;
}

export async function captureClaudeCliUsageText(timeoutMs = 12_000): Promise<string> {
  const command = buildClaudeCliShellProbeCommand();
  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
      env: createClaudeQuotaEnv(),
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    const output = `${stdout}${stderr}`;
    const cleaned = cleanTerminalText(output);
    if (usageOutputLooksComplete(cleaned)) return output;
    throw new Error("Claude CLI usage probe ended before rendering usage.");
  } catch (error) {
    const stdout =
      typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string"
        ? error.stdout
        : "";
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr
        : "";
    const output = `${stdout}${stderr}`;
    const cleaned = cleanTerminalText(output);
    if (usageOutputLooksComplete(cleaned)) return output;
    if (usageOutputLooksRelevant(cleaned)) {
      throw new Error("Claude CLI usage probe ended before rendering usage.");
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function fetchClaudeCliQuota(): Promise<QuotaWindow[]> {
  const rawText = await captureClaudeCliUsageText();
  return parseClaudeCliUsageText(rawText);
}

function formatProviderError(source: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${source}: ${message}`;
}

/**
 * The original, pre-company-aware probe: read whatever Claude login the
 * Paperclip host itself has (its own `~/.claude/.credentials.json`, `claude
 * auth status`, or a CLI `/usage` scrape) and report that one subscription's
 * windows. Used as-is when the caller gives no company context, and as the
 * fallback for any claude_local agent whose adapter config carries no
 * `CLAUDE_CODE_OAUTH_TOKEN` binding of its own (see getQuotaWindows below).
 */
async function getHostLoginQuotaWindows(label: string | null): Promise<ProviderQuotaResult> {
  const withLabel = (result: ProviderQuotaResult): ProviderQuotaResult =>
    label ? { ...result, label } : result;
  if (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    process.env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    hasNonEmptyProcessEnv("ANTHROPIC_BEDROCK_BASE_URL")
  ) {
    return withLabel({ provider: "anthropic", source: "bedrock", ok: true, windows: [] });
  }

  const authStatus = await readClaudeAuthStatus();
  const authDescription = describeClaudeSubscriptionAuth(authStatus);
  const token = await readClaudeToken();

  const errors: string[] = [];

  if (token) {
    try {
      const windows = await fetchClaudeQuota(token);
      return withLabel({ provider: "anthropic", source: CLAUDE_USAGE_SOURCE_OAUTH, ok: true, windows });
    } catch (error) {
      errors.push(formatProviderError("Anthropic OAuth usage", error));
    }
  }

  try {
    const windows = await fetchClaudeCliQuota();
    return withLabel({ provider: "anthropic", source: CLAUDE_USAGE_SOURCE_CLI, ok: true, windows });
  } catch (error) {
    errors.push(formatProviderError("Claude CLI /usage", error));
  }

  if (hasNonEmptyProcessEnv("ANTHROPIC_API_KEY") && !authDescription) {
    return withLabel({
      provider: "anthropic",
      ok: false,
      error:
        errors[0]
        ?? "ANTHROPIC_API_KEY is set and no local Claude subscription session is available for quota polling",
      windows: [],
    });
  }

  if (authDescription) {
    return withLabel({
      provider: "anthropic",
      ok: false,
      error:
        errors.length > 0
          ? `${authDescription}, but quota polling failed (${errors.join("; ")})`
          : `${authDescription}, but Paperclip could not load subscription quota data`,
      windows: [],
    });
  }

  return withLabel({
    provider: "anthropic",
    ok: false,
    error: errors[0] ?? "no local claude auth token",
    windows: [],
  });
}

// ---------------------------------------------------------------------------
// Company-aware polling: one credential per distinct bound token, each
// cached and backed off independently, falling back to passively-observed
// run telemetry (see parse.ts's claudeRateLimit) when a live read is not
// available. See GetQuotaWindowsContext / QuotaWindowsCredential.
// ---------------------------------------------------------------------------

interface ClaudeQuotaCacheEntry {
  /** The most recent successful live read, kept around (not evicted on a
   *  later failure) so a 429 or outage can still serve something useful. */
  lastGood: ProviderQuotaResult | null;
  /** Epoch ms until which `lastGood` counts as fresh (no live retry needed). */
  goodUntil: number;
  /** Epoch ms before which a live retry is skipped after a failure. */
  backoffUntil: number;
}

// Keyed by sha256(token) — never the token itself. Process-lifetime cache;
// fine to lose on restart since the next poll just repopulates it.
const claudeQuotaCacheByFingerprint = new Map<string, ClaudeQuotaCacheEntry>();

/** sha256 fingerprint of a token, used only as a cache key. Never log the
 *  input to this function; only ever log or compare its output. */
function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function claudeRateLimitWindows(snapshot: ClaudeRateLimitSnapshot): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  const toResetIso = (epochSeconds: number | null): string | null =>
    typeof epochSeconds === "number" && Number.isFinite(epochSeconds)
      ? new Date(epochSeconds * 1000).toISOString()
      : null;
  if (snapshot.windows.five_hour) {
    windows.push({
      label: "Current session",
      usedPercent: toPercent(snapshot.windows.five_hour.utilization),
      resetsAt: toResetIso(snapshot.windows.five_hour.resetsAt),
      valueLabel: null,
      detail: null,
    });
  }
  if (snapshot.windows.seven_day) {
    windows.push({
      label: "Current week (all models)",
      usedPercent: toPercent(snapshot.windows.seven_day.utilization),
      resetsAt: toResetIso(snapshot.windows.seven_day.resetsAt),
      valueLabel: null,
      detail: null,
      ...(snapshot.overageInUse || snapshot.isUsingOverage
        ? { detail: "Extra usage in use — billed at API rates" }
        : {}),
    });
  }
  return windows;
}

/**
 * Defensive read of a passively-observed rate-limit snapshot: the value
 * crossed a DB jsonb column (and possibly an older server version's shape),
 * so every field is re-checked rather than trusted. Returns null when the
 * value is not a usable snapshot.
 */
function asClaudeRateLimitSnapshot(value: unknown): ClaudeRateLimitSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const windowsRecord =
    typeof record.windows === "object" && record.windows !== null
      ? (record.windows as Record<string, unknown>)
      : {};
  const readWindow = (raw: unknown): ClaudeRateLimitSnapshot["windows"]["five_hour"] | undefined => {
    if (typeof raw !== "object" || raw === null) return undefined;
    const w = raw as Record<string, unknown>;
    const utilization = typeof w.utilization === "number" && Number.isFinite(w.utilization) ? w.utilization : null;
    const resetsAt = typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) ? w.resetsAt : null;
    if (utilization == null && resetsAt == null) return undefined;
    return { utilization, resetsAt };
  };
  const fiveHour = readWindow(windowsRecord.five_hour);
  const sevenDay = readWindow(windowsRecord.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return {
    observedAt: typeof record.observedAt === "string" ? record.observedAt : new Date(0).toISOString(),
    status: typeof record.status === "string" ? record.status : null,
    rateLimitType: typeof record.rateLimitType === "string" ? record.rateLimitType : null,
    resetsAt: typeof record.resetsAt === "number" ? record.resetsAt : null,
    overageStatus: typeof record.overageStatus === "string" ? record.overageStatus : null,
    overageResetsAt: typeof record.overageResetsAt === "number" ? record.overageResetsAt : null,
    isUsingOverage: record.isUsingOverage === true,
    overageInUse: record.overageInUse === true,
    windows: {
      ...(fiveHour ? { five_hour: fiveHour } : {}),
      ...(sevenDay ? { seven_day: sevenDay } : {}),
    },
  };
}

function passiveResultFromSnapshot(label: string, raw: unknown): ProviderQuotaResult | null {
  const snapshot = asClaudeRateLimitSnapshot(raw);
  if (!snapshot) return null;
  const windows = claudeRateLimitWindows(snapshot);
  if (windows.length === 0) return null;
  return {
    provider: "anthropic",
    source: CLAUDE_USAGE_SOURCE_RUN_TELEMETRY,
    ok: true,
    windows,
    label,
    observedAt: snapshot.observedAt,
    stale: true,
    overageInUse: snapshot.overageInUse || snapshot.isUsingOverage,
  };
}

/**
 * Poll (or serve from cache) one distinct bound credential. Never throws —
 * every failure becomes an `ok: false` result — and never includes the token
 * itself in anything returned, logged, or thrown.
 */
async function pollClaudeQuotaForCredential(credential: QuotaWindowsCredential): Promise<ProviderQuotaResult> {
  const token = credential.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (!token) {
    // This credential entry carries no token of its own (the "Server login"
    // fallback entry for agents with no CLAUDE_CODE_OAUTH_TOKEN binding) —
    // defer to the host-login probe, just labeled like the other panels.
    return getHostLoginQuotaWindows(credential.label);
  }

  const fingerprint = tokenFingerprint(token);
  const now = Date.now();
  const entry = claudeQuotaCacheByFingerprint.get(fingerprint) ?? {
    lastGood: null,
    goodUntil: 0,
    backoffUntil: 0,
  };

  if (entry.lastGood && now < entry.goodUntil) {
    return { ...entry.lastGood, label: credential.label };
  }

  if (now >= entry.backoffUntil) {
    try {
      const windows = await fetchClaudeQuota(token);
      const result: ProviderQuotaResult = {
        provider: "anthropic",
        source: CLAUDE_USAGE_SOURCE_OAUTH,
        ok: true,
        windows,
        label: credential.label,
        observedAt: new Date(now).toISOString(),
        stale: false,
      };
      claudeQuotaCacheByFingerprint.set(fingerprint, {
        lastGood: result,
        goodUntil: now + CLAUDE_QUOTA_FRESH_MS,
        backoffUntil: now,
      });
      return result;
    } catch (error) {
      claudeQuotaCacheByFingerprint.set(fingerprint, {
        lastGood: entry.lastGood,
        goodUntil: entry.goodUntil,
        backoffUntil: now + CLAUDE_QUOTA_BACKOFF_MS,
      });
      // formatProviderError only ever stringifies the fetch's own error
      // (e.g. an HTTP status), never the token — fall through below.
      void formatProviderError("Anthropic OAuth usage", error);
    }
  }

  if (entry.lastGood) {
    return { ...entry.lastGood, label: credential.label, stale: true };
  }

  const passive = passiveResultFromSnapshot(credential.label, credential.passiveSnapshot);
  if (passive) return passive;

  return {
    provider: "anthropic",
    ok: false,
    label: credential.label,
    error: "Could not read live Claude usage right now, and no recent run data is available either.",
    windows: [],
  };
}

/**
 * Fetch live provider quota/rate-limit windows. Without a company context
 * (no `ctx`, or an empty credentials list) this keeps its original behavior:
 * probe the Paperclip host's own Claude login and return one result.
 *
 * With `ctx.credentials`, each entry is a distinct bound
 * `CLAUDE_CODE_OAUTH_TOKEN` the server resolved for the company (already
 * resolved to an env var — this adapter never sees a secret reference), and
 * this returns one ProviderQuotaResult per entry, labeled, so the UI can show
 * one panel per distinct bound token instead of one shared panel that only
 * ever reflects the host's own login.
 */
export async function getQuotaWindows(
  ctx?: GetQuotaWindowsContext,
): Promise<ProviderQuotaResult | ProviderQuotaResult[]> {
  const credentials = ctx?.credentials;
  if (!credentials || credentials.length === 0) {
    return getHostLoginQuotaWindows(null);
  }
  return Promise.all(credentials.map((credential) => pollClaudeQuotaForCredential(credential)));
}
