import { createHash } from "node:crypto";

import { validateExplicitDesiredState } from "../domain/environment-instance.js";
import { isCompositionProfileId } from "../domain/catalog.js";
import type { ApplyPlan, ApplyPlanInput } from "./actions.js";

function canonicalize(value: unknown, path = "$"): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path}: unsupported JSON value`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalize(entry, `${path}[${index}]`));
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${path}: unsupported JSON value`);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry, `${path}.${key}`)]),
  );
}

function canonicalSha256(value: unknown): string {
  const encoded = JSON.stringify(canonicalize(value));
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function unsignedPlan(input: ApplyPlanInput): Omit<ApplyPlan, "digest"> {
  return {
    $schema: "../contracts/apply-plan.schema.json",
    schemaVersion: "2.0.0",
    kind: "apply-plan",
    catalogRevision: input.catalogRevision,
    desiredState: structuredClone(input.desiredState),
    platform: structuredClone(input.platform),
    observedState: structuredClone(input.observedState),
    preflights: structuredClone(input.preflights),
    actions: structuredClone(input.actions),
  };
}

export function createApplyPlan(input: ApplyPlanInput): ApplyPlan {
  if (!/^[0-9a-f]{64}$/.test(input.catalogRevision)) {
    throw new Error("catalogRevision must be a SHA-256 digest");
  }
  if (
    input.desiredState.selectedAgents.length === 0
    && !isCompositionProfileId(input.desiredState.profileId)
  ) {
    throw new Error("selected agents must be non-empty");
  }
  const explicitFields = [
    input.desiredState.instance,
    input.desiredState.capabilitySet,
    input.desiredState.selectedCapabilities,
    input.desiredState.selectedPackages,
    input.desiredState.toolRoutes,
  ];
  if (explicitFields.some((value) => value !== undefined)) {
    if (explicitFields.some((value) => value === undefined)) {
      throw new Error("explicit environment desired state must be complete");
    }
    validateExplicitDesiredState(
      {
        capabilitySet: input.desiredState.capabilitySet!,
        instance: input.desiredState.instance!,
        selectedCapabilities: input.desiredState.selectedCapabilities! as never,
        selectedPackages: input.desiredState.selectedPackages! as never,
        toolRoutes: input.desiredState.toolRoutes!,
      },
      input.platform,
    );
  }
  const failed = input.preflights.find(
    ({ required, status }) => required && status !== "ready",
  );
  if (failed !== undefined) {
    throw new Error(`required preflight failed: ${failed.id}`);
  }
  const ids = input.actions.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error("action ids must be unique");

  const unsigned = unsignedPlan(input);
  return deepFreeze({
    ...unsigned,
    digest: canonicalSha256(unsigned),
  });
}

export function verifyApplyPlanDigest(plan: ApplyPlan): boolean {
  const { digest, ...unsigned } = plan;
  return /^[0-9a-f]{64}$/.test(digest) && canonicalSha256(unsigned) === digest;
}
