import { unprocessable } from "../errors.js";

/**
 * Adapter config checks shared by agent create, hire and update.
 *
 * They only reject values that can never work, so they stay independent of
 * any adapter's model catalog: a model id newer than the catalog is accepted.
 * On update, a value the agent already had is not re-checked, so an agent
 * whose stored config predates a check stays editable.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Control characters (including newlines and tabs) never appear in a model id.
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;

/**
 * Reject an `adapterConfig.model` that no adapter can run: a number or
 * boolean, or a string with surrounding whitespace or control characters
 * (typically a pasted value). An empty string keeps meaning "adapter default",
 * and object values are left to adapters that define a structured model.
 */
export function assertAdapterModelValue(
  adapterConfig: Record<string, unknown>,
  previousAdapterConfig?: Record<string, unknown> | null,
) {
  if (!Object.hasOwn(adapterConfig, "model")) return;
  const model = adapterConfig.model;
  if (previousAdapterConfig && Object.is(previousAdapterConfig.model, model)) return;
  if (typeof model === "number" || typeof model === "boolean") {
    throw unprocessable(
      `adapterConfig.model must be a model id string, not a ${typeof model}. ` +
        'Send it as a string, for example "model":"<model-id>".',
      { code: "invalid_adapter_config", field: "adapterConfig.model" },
    );
  }
  if (typeof model !== "string" || model.length === 0) return;
  if (model.trim() !== model || CONTROL_CHARACTER_RE.test(model)) {
    throw unprocessable(
      `adapterConfig.model ${JSON.stringify(model)} contains surrounding whitespace or control characters. ` +
        "Send the model id without them.",
      { code: "invalid_adapter_config", field: "adapterConfig.model" },
    );
  }
}

/** Ids of the company secrets an adapter config's `env` already references. */
export function boundEnvSecretIds(adapterConfig: Record<string, unknown> | null | undefined): string[] {
  const env = asRecord(adapterConfig?.env);
  if (!env) return [];
  const ids = new Set<string>();
  for (const binding of Object.values(env)) {
    const record = asRecord(binding);
    if (record?.type === "secret_ref" && typeof record.secretId === "string") {
      ids.add(record.secretId);
    }
  }
  return [...ids];
}
