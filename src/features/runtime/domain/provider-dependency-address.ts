export type ProviderDependencyAddress = {
  readonly parentNodeId: string;
  readonly parentItemIndex: number;
  readonly sourceHandle: string | null;
  readonly targetNodeId: string;
  readonly targetHandle: string | null;
};

export type ProviderDependencyAddressQuery = {
  readonly parentNodeId: string;
  readonly sourceHandle?: string | null;
  readonly targetHandle?: string | null;
};

export function providerDependencyAddressKey(
  address: ProviderDependencyAddress,
) {
  return [
    address.parentNodeId,
    address.parentItemIndex,
    address.sourceHandle ?? "",
    address.targetHandle ?? "",
    address.targetNodeId,
  ].join("\0");
}

export function providerDependencyMatches(
  address: ProviderDependencyAddress,
  query: ProviderDependencyAddressQuery,
) {
  if (address.parentNodeId !== query.parentNodeId) {
    return false;
  }
  if (
    query.sourceHandle !== undefined &&
    address.sourceHandle !== query.sourceHandle
  ) {
    return false;
  }
  return (
    query.targetHandle === undefined ||
    address.targetHandle === query.targetHandle
  );
}

export function isProviderDependencyAddress(
  value: unknown,
): value is ProviderDependencyAddress {
  return (
    isRecord(value) &&
    typeof value.parentNodeId === "string" &&
    typeof value.parentItemIndex === "number" &&
    typeof value.targetNodeId === "string" &&
    (value.sourceHandle === null || typeof value.sourceHandle === "string") &&
    (value.targetHandle === null || typeof value.targetHandle === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
