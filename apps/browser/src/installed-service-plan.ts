import { Effect } from "effect";
import {
  ServiceContractError,
  validateServiceGraph,
  type LivePluginManifest,
  type ServiceBinding,
  type ServiceGraph,
} from "@hitchhiker/runtime";

export interface InstalledServiceEntry {
  readonly manifest: LivePluginManifest;
  readonly enabled: boolean;
}

export interface InstalledServicePlan {
  readonly graph: ServiceGraph;
  /** Enabled identities which cannot run because a required provider is unavailable. */
  readonly blocked: readonly string[];
}

const invalid = (message: string) => new ServiceContractError({ message });
const key = (consumer: string, dependency: string) => `${consumer}\u0000${dependency}`;

/**
 * Finds the enabled cohort which can satisfy every required dependency. Contract
 * validity remains the runtime graph validator's job after dormant endpoints are removed.
 */
export const planInstalledServices = Effect.fn("Browser.planInstalledServices")(function* (
  entries: readonly InstalledServiceEntry[],
  bindings: readonly ServiceBinding[],
): Effect.fn.Return<InstalledServicePlan, ServiceContractError> {
  const aliases = new Set<string>();
  for (const binding of bindings) {
    const alias = key(binding.consumer, binding.dependency);
    if (aliases.has(alias))
      return yield* invalid("Service recipe binds a dependency more than once");
    aliases.add(alias);
  }
  const enabled = new Map(
    entries.filter((entry) => entry.enabled).map((entry) => [entry.manifest.id, entry.manifest]),
  );
  const runnable = new Set(enabled.keys());
  const byDependency = new Map(
    bindings.map((binding) => [key(binding.consumer, binding.dependency), binding]),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, manifest] of enabled) {
      if (!runnable.has(id)) continue;
      const blocked = (manifest.requires ?? []).some((dependency) => {
        if (dependency.optional) return false;
        const binding = byDependency.get(key(id, dependency.id));
        return !binding || !runnable.has(binding.provider);
      });
      if (blocked) {
        runnable.delete(id);
        changed = true;
      }
    }
  }
  const descriptors = [...runnable].sort().map((id) => {
    const manifest = enabled.get(id)!;
    return {
      id: manifest.id,
      provides: manifest.provides ?? [],
      requires: manifest.requires ?? [],
    };
  });
  const activeBindings = bindings.filter(
    (binding) => runnable.has(binding.consumer) && runnable.has(binding.provider),
  );
  const graph = yield* validateServiceGraph(descriptors, activeBindings);
  return Object.freeze({
    graph,
    blocked: Object.freeze([...enabled.keys()].filter((id) => !runnable.has(id)).sort()),
  });
});

/** Required consumers which must stop when one of `ids` loses service availability. */
export const requiredDependentClosure = (graph: ServiceGraph, ids: ReadonlySet<string>) => {
  const result = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const binding of graph.bindings)
      if (
        !binding.dependency.optional &&
        result.has(binding.provider) &&
        !result.has(binding.consumer)
      ) {
        result.add(binding.consumer);
        changed = true;
      }
  }
  return result;
};
