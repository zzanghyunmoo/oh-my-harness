import type { PackageCatalogEntry } from "../catalog/types.js";

export interface PackageToolDefinition {
  readonly packageId: PackageCatalogEntry["id"];
  readonly label: string;
  readonly description: string;
  readonly executables: readonly string[];
  readonly authenticationGuidance: string;
}

export function packageToolDefinitions(
  packages: readonly PackageCatalogEntry[],
): readonly PackageToolDefinition[] {
  return packages.map((entry) => ({
    packageId: entry.id,
    label: entry.displayName,
    description: entry.description,
    executables: [...entry.executables],
    authenticationGuidance: entry.authentication.guidance,
  }));
}
