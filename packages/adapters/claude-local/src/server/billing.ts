/**
 * claude_local's `billingType` config option.
 *
 * By default ("auto") the adapter guesses how a run is billed from the auth
 * it detects: Bedrock auth -> metered_api, an ANTHROPIC_API_KEY -> api,
 * otherwise -> subscription. That guess is wrong for a deployment that
 * authenticates the Claude CLI/ACP with an OAuth or other long-lived token
 * which is *not* a flat subscription — the account is actually billed at
 * standard API prices, but the adapter's auto-detection has no way to tell
 * the two apart from auth shape alone, so the run lands in the cost ledger
 * as a zero-cost subscription run even though the CLI reported a real
 * total_cost_usd.
 *
 * Setting `billingType` explicitly overrides the auto-detection:
 *   - "api": always classify the run as metered API usage.
 *   - "subscription": always classify the run as included in a flat
 *     subscription (billed cost forced to 0 by the server ledger).
 *   - "auto" (default): keep the existing auth-based guess.
 */
export type ClaudeLocalBillingTypeOverride = "auto" | "api" | "subscription";

const CLAUDE_LOCAL_BILLING_TYPE_OVERRIDE_VALUES = ["auto", "api", "subscription"] as const;

/**
 * Parse and validate the `billingType` adapter config value. Throws a
 * descriptive error for anything other than "auto" (or unset), "api", or
 * "subscription" so a typo surfaces as a config validation error instead of
 * silently falling back to auto-detection.
 */
export function parseClaudeBillingTypeOverride(value: unknown): ClaudeLocalBillingTypeOverride {
  if (value === undefined || value === null || value === "") return "auto";
  if (
    typeof value === "string" &&
    (CLAUDE_LOCAL_BILLING_TYPE_OVERRIDE_VALUES as readonly string[]).includes(value)
  ) {
    return value as ClaudeLocalBillingTypeOverride;
  }
  throw new Error(
    `Invalid claude_local config "billingType": ${JSON.stringify(value)}. ` +
      `Expected one of "auto", "api", "subscription".`,
  );
}

/**
 * Apply a validated `billingType` override on top of the adapter's
 * auth-based auto-detection. "auto" passes the detected value through
 * unchanged; "api"/"subscription" force that classification regardless of
 * detected auth.
 */
export function resolveClaudeBillingTypeWithOverride<T extends string>(
  override: ClaudeLocalBillingTypeOverride,
  autoBillingType: T,
): T | "api" | "subscription" {
  if (override === "api") return "api";
  if (override === "subscription") return "subscription";
  return autoBillingType;
}
