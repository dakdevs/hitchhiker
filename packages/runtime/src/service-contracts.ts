import { Effect, Schema } from "effect";

const LocalId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/));
const ContractName = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/),
);
const Semver = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
);
const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const strict = { parseOptions: { onExcessProperty: "error" } } as const;

export const ServiceContractSchema = Schema.Struct({
  name: ContractName,
  version: Semver,
  digest: Digest,
}).annotate(strict);
export type ServiceContract = typeof ServiceContractSchema.Type;

export const ServiceProviderSchema = Schema.Struct({
  id: LocalId,
  contract: ServiceContractSchema,
}).annotate(strict);
export type ServiceProvider = typeof ServiceProviderSchema.Type;

export const ServiceRequirementSchema = Schema.Struct({
  id: LocalId,
  contract: ServiceContractSchema,
  optional: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
}).annotate(strict);
export type ServiceRequirement = typeof ServiceRequirementSchema.Type;

export const ServicePluginDescriptorSchema = Schema.Struct({
  id: LocalId,
  provides: Schema.Array(ServiceProviderSchema)
    .check(Schema.isMaxLength(8))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  requires: Schema.Array(ServiceRequirementSchema)
    .check(Schema.isMaxLength(8))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
}).annotate(strict);
export type ServicePluginDescriptor = typeof ServicePluginDescriptorSchema.Type;

export const ServiceBindingSchema = Schema.Struct({
  consumer: LocalId,
  dependency: LocalId,
  provider: LocalId,
  service: LocalId,
}).annotate(strict);
export type ServiceBinding = typeof ServiceBindingSchema.Type;

const InstalledDescriptorsSchema = Schema.Array(ServicePluginDescriptorSchema).check(
  Schema.isMaxLength(32),
);
const BindingsSchema = Schema.Array(ServiceBindingSchema).check(Schema.isMaxLength(128));

export class ServiceContractError extends Schema.TaggedError<ServiceContractError>()(
  "ServiceContractError",
  { message: Schema.String },
) {}

export interface ResolvedServiceBinding {
  readonly consumer: string;
  readonly dependency: ServiceRequirement;
  readonly provider: string;
  readonly service: ServiceProvider;
}
export interface ServiceGraph {
  readonly plugins: readonly ServicePluginDescriptor[];
  readonly bindings: readonly ResolvedServiceBinding[];
  /** Providers always appear before consumers; unrelated plugins sort by ID. */
  readonly order: readonly string[];
}
export type ValidatedServiceGraph = ServiceGraph;

const sameContract = (left: ServiceContract, right: ServiceContract) =>
  left.name === right.name && left.version === right.version && left.digest === right.digest;
const key = (left: string, right: string) => `${left}\u0000${right}`;
const invalid = (message: string) => new ServiceContractError({ message });

const graph = (
  descriptors: readonly ServicePluginDescriptor[],
  bindings: readonly ServiceBinding[],
): ValidatedServiceGraph | ServiceContractError => {
  const plugins = new Map<string, ServicePluginDescriptor>();
  const provided = new Map<string, ServiceProvider>();
  const required = new Map<string, ServiceRequirement>();
  for (const plugin of descriptors) {
    if (plugins.has(plugin.id))
      return invalid("Plugin service declarations must have distinct IDs");
    plugins.set(plugin.id, plugin);
    for (const service of plugin.provides) {
      const serviceKey = key(plugin.id, service.id);
      if (provided.has(serviceKey)) return invalid("Plugin services must have distinct IDs");
      provided.set(serviceKey, service);
    }
    for (const dependency of plugin.requires) {
      const dependencyKey = key(plugin.id, dependency.id);
      if (required.has(dependencyKey)) return invalid("Plugin requirements must have distinct IDs");
      required.set(dependencyKey, dependency);
    }
  }

  const bound = new Set<string>();
  const resolved: ResolvedServiceBinding[] = [];
  const edges = new Map<string, Set<string>>(
    descriptors.map((plugin) => [plugin.id, new Set<string>()]),
  );
  const incoming = new Map<string, number>(descriptors.map((plugin) => [plugin.id, 0]));
  for (const binding of bindings) {
    const dependencyKey = key(binding.consumer, binding.dependency);
    if (bound.has(dependencyKey)) return invalid("Consumer requirements may be bound once");
    bound.add(dependencyKey);
    if (binding.consumer === binding.provider)
      return invalid("Plugin services cannot bind to themselves");
    if (!plugins.has(binding.consumer) || !plugins.has(binding.provider))
      return invalid("Service binding references an uninstalled plugin");
    const dependency = required.get(dependencyKey);
    const service = provided.get(key(binding.provider, binding.service));
    if (!dependency || !service)
      return invalid("Service binding references an undeclared endpoint");
    if (!sameContract(dependency.contract, service.contract))
      return invalid("Service binding contract does not match exactly");
    resolved.push(
      Object.freeze({
        consumer: binding.consumer,
        dependency: Object.freeze({
          ...dependency,
          contract: Object.freeze({ ...dependency.contract }),
        }),
        provider: binding.provider,
        service: Object.freeze({ ...service, contract: Object.freeze({ ...service.contract }) }),
      }),
    );
    const consumers = edges.get(binding.provider)!;
    if (!consumers.has(binding.consumer)) {
      consumers.add(binding.consumer);
      incoming.set(binding.consumer, incoming.get(binding.consumer)! + 1);
    }
  }
  for (const [dependencyKey, dependency] of required)
    if (!dependency.optional && !bound.has(dependencyKey))
      return invalid("A required service dependency is not bound");

  const ready = [...incoming]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const consumer of [...edges.get(id)!].sort()) {
      const count = incoming.get(consumer)! - 1;
      incoming.set(consumer, count);
      if (count === 0) {
        ready.push(consumer);
        ready.sort();
      }
    }
  }
  if (order.length !== descriptors.length) return invalid("Service bindings contain a cycle");
  return Object.freeze({
    plugins: Object.freeze(
      descriptors.map((plugin) =>
        Object.freeze({
          ...plugin,
          provides: Object.freeze(
            plugin.provides.map((service) =>
              Object.freeze({ ...service, contract: Object.freeze({ ...service.contract }) }),
            ),
          ),
          requires: Object.freeze(
            plugin.requires.map((dependency) =>
              Object.freeze({ ...dependency, contract: Object.freeze({ ...dependency.contract }) }),
            ),
          ),
        }),
      ),
    ),
    bindings: Object.freeze(resolved),
    order: Object.freeze(order),
  });
};

/** Decodes untrusted declarations, then validates the trusted binding graph without side effects. */
export const validateServiceGraph = Effect.fn("ServiceContracts.validateGraph")(function* (
  installed: unknown,
  bindings: unknown,
): Effect.fn.Return<ValidatedServiceGraph, ServiceContractError> {
  const descriptors = yield* Schema.decodeUnknownEffect(InstalledDescriptorsSchema, {
    onExcessProperty: "error",
  })(installed).pipe(Effect.mapError(() => invalid("Malformed service declarations")));
  const decodedBindings = yield* Schema.decodeUnknownEffect(BindingsSchema, {
    onExcessProperty: "error",
  })(bindings).pipe(Effect.mapError(() => invalid("Malformed service bindings")));
  const result = graph(descriptors, decodedBindings);
  return result instanceof ServiceContractError ? yield* result : result;
});
