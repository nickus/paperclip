import type { QuotaWindow } from "@paperclipai/shared";
import { cn, quotaSourceDisplayName } from "@/lib/utils";

interface ClaudeSubscriptionPanelProps {
  windows: QuotaWindow[];
  source?: string | null;
  error?: string | null;
  /** Non-secret display label for this panel's credential, e.g. a bound
   *  company secret's name, "Claude login", or "Server login". Replaces the
   *  generic "Anthropic subscription" heading when set, so multiple panels
   *  (one per distinct bound token) read distinctly. */
  label?: string | null;
  /** When this data was actually observed. Shown as "as of <time>" whenever
   *  `stale` is true, so a cached or passively-observed read is never
   *  mistaken for a fresh live read. */
  observedAt?: string | null;
  /** True when `windows` is a cached or passively-observed snapshot rather
   *  than a fresh live poll. */
  stale?: boolean;
  /** True when the account is currently drawing on billed "extra usage"
   *  beyond its subscription window. */
  overageInUse?: boolean | null;
}

function formatObservedAt(observedAt: string): string | null {
  const date = new Date(observedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const WINDOW_ORDER = [
  "currentsession",
  "currentweekallmodels",
  "currentweeksonnetonly",
  "currentweeksonnet",
  "currentweekopusonly",
  "currentweekopus",
  "extrausage",
] as const;

function normalizeLabel(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function detailText(window: QuotaWindow): string | null {
  if (typeof window.detail === "string" && window.detail.trim().length > 0) return window.detail.trim();
  if (window.resetsAt) {
    const formatted = new Date(window.resetsAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    return `Resets ${formatted}`;
  }
  return null;
}

function orderedWindows(windows: QuotaWindow[]): QuotaWindow[] {
  return [...windows].sort((a, b) => {
    const aIndex = WINDOW_ORDER.indexOf(normalizeLabel(a.label) as (typeof WINDOW_ORDER)[number]);
    const bIndex = WINDOW_ORDER.indexOf(normalizeLabel(b.label) as (typeof WINDOW_ORDER)[number]);
    return (aIndex === -1 ? WINDOW_ORDER.length : aIndex) - (bIndex === -1 ? WINDOW_ORDER.length : bIndex);
  });
}

function fillClass(usedPercent: number | null): string {
  if (usedPercent == null) return "bg-zinc-700";
  if (usedPercent >= 90) return "bg-(--status-task-blocked)";
  if (usedPercent >= 70) return "bg-(--status-task-todo)";
  return "bg-primary/70";
}

export function ClaudeSubscriptionPanel({
  windows,
  source = null,
  error = null,
  label = null,
  observedAt = null,
  stale = false,
  overageInUse = null,
}: ClaudeSubscriptionPanelProps) {
  const ordered = orderedWindows(windows);
  const observedAtText = stale && observedAt ? formatObservedAt(observedAt) : null;
  const weeklyWindowExhausted = windows.some(
    (window) => normalizeLabel(window.label) === "currentweekallmodels" && (window.usedPercent ?? 0) >= 100,
  );

  return (
    <div className="border border-border px-4 py-4">
      <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
            {label ?? "Anthropic subscription"}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {observedAtText ? `As of ${observedAtText}.` : "Live Claude quota windows."}
          </div>
        </div>
        {source ? (
          <span className="shrink-0 border border-border px-2.5 py-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
            {quotaSourceDisplayName(source)}
          </span>
        ) : null}
      </div>

      {overageInUse ? (
        <div className="mt-4 border border-(--status-task-blocked)/40 bg-(--status-task-blocked)/10 px-3 py-2 text-sm text-foreground">
          {weeklyWindowExhausted
            ? "Weekly window used up — extra usage in use, billed at API rates."
            : "Extra usage in use — billed at API rates."}
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="mt-4 space-y-4">
        {ordered.map((window) => {
          const normalized = normalizeLabel(window.label);
          const detail = detailText(window);
          if (normalized === "extrausage") {
            return (
              <div
                key={window.label}
                className="border border-border px-3.5 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-foreground">{window.label}</div>
                  {window.valueLabel ? (
                    <div className="text-sm font-medium text-foreground">{window.valueLabel}</div>
                  ) : null}
                </div>
                {detail ? (
                  <div className="mt-2 text-sm text-muted-foreground">{detail}</div>
                ) : null}
              </div>
            );
          }

          const width = Math.min(100, Math.max(0, window.usedPercent ?? 0));
          return (
            <div
              key={window.label}
              className="border border-border px-3.5 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{window.label}</div>
                  {detail ? (
                    <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
                  ) : null}
                </div>
                {window.usedPercent != null ? (
                  <div className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                    {window.usedPercent}% used
                  </div>
                ) : null}
              </div>

              <div className="mt-3 h-2 overflow-hidden bg-muted">
                <div
                  className={cn("h-full transition-(--tp-width) duration-200", fillClass(window.usedPercent))}
                  style={{ width: `${width}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
