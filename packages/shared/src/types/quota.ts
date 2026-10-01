/** a single rate-limit or usage window returned by a provider quota API */
export interface QuotaWindow {
  /** human label, e.g. "5h", "7d", "Sonnet 7d", "Credits" */
  label: string;
  /** percent of the window already consumed (0-100), null when not reported */
  usedPercent: number | null;
  /** iso timestamp when this window resets, null when not reported */
  resetsAt: string | null;
  /** free-form value label for credit-style windows, e.g. "$4.20 remaining" */
  valueLabel: string | null;
  /** optional supporting text, e.g. reset details or provider-specific notes */
  detail?: string | null;
}

/** result for one provider from the quota-windows endpoint */
export interface ProviderQuotaResult {
  /** provider slug, e.g. "anthropic", "openai" */
  provider: string;
  /** source label when the provider reports where the quota data came from */
  source?: string | null;
  /** true when the fetch succeeded and windows is populated */
  ok: boolean;
  /** machine-readable error family when ok is false */
  errorFamily?: string | null;
  /** error message when ok is false */
  error?: string;
  windows: QuotaWindow[];
  /**
   * Non-secret display label for the credential this result came from, e.g.
   * a bound company secret's name, "Claude login", or "Server login". Lets
   * the UI render one panel per distinct bound token for providers (like
   * claude_local) that can poll more than one credential for a company.
   * Omitted for providers that only ever report a single, unlabeled result.
   */
  label?: string | null;
  /** ISO timestamp when this result's data was actually observed. Set when
   *  `stale` is true, or when the data came from a passively-observed run
   *  instead of a live poll, so the UI can show "as of <time>". */
  observedAt?: string | null;
  /**
   * True when `windows` reflects a cached or passively-observed snapshot
   * rather than a fresh live poll (e.g. the live endpoint was rate limited
   * and the result is serving the last good read, or no live read is
   * possible and a run's own rate-limit snapshot is shown instead).
   */
  stale?: boolean;
  /**
   * True when the account is currently drawing on "extra usage" beyond its
   * subscription window, which Anthropic bills at standard API prices. Set
   * from a passively observed `rate_limit_event`'s overage fields.
   */
  overageInUse?: boolean | null;
}
