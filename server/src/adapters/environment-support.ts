/**
 * Environment support of the adapters registered in this server.
 *
 * The shared helpers in `@paperclipai/shared` know which built-in adapter
 * types run in remote managed environments (SSH and sandbox drivers). An
 * adapter module can also declare it itself (`supportsRemoteManagedEnvironments`),
 * which is how an external adapter plugin opts in. These helpers hand the
 * shared ones the registered module, so every gate (agent environment
 * selection, the capabilities listing and execution target resolution) reads
 * the same answer for built-in and external adapters.
 */

import { AGENT_ADAPTER_TYPES, type AdapterEnvironmentSupportSubject } from "@paperclipai/shared";
import { findActiveServerAdapter, listEnabledServerAdapters } from "./registry.js";

/**
 * The adapter as the environment-support helpers should see it: the active
 * registered module when there is one (a paused external override resolves to
 * the built-in it replaced), else the bare type.
 */
export function resolveAdapterEnvironmentSupportSubject(adapterType: string): AdapterEnvironmentSupportSubject {
  const adapter = findActiveServerAdapter(adapterType);
  if (!adapter) return adapterType;
  return {
    type: adapter.type,
    supportsRemoteManagedEnvironments: adapter.supportsRemoteManagedEnvironments,
  };
}

/**
 * Every adapter type the environment capabilities listing describes: the
 * built-in types in their fixed order, then each enabled external adapter type.
 */
export function listAdapterEnvironmentSupportSubjects(): AdapterEnvironmentSupportSubject[] {
  const types: string[] = [...AGENT_ADAPTER_TYPES];
  const seen = new Set(types);
  for (const adapter of listEnabledServerAdapters()) {
    if (seen.has(adapter.type)) continue;
    seen.add(adapter.type);
    types.push(adapter.type);
  }
  return types.map(resolveAdapterEnvironmentSupportSubject);
}
