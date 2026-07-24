import type {
  CatalogBundle,
  EnvironmentProfile,
} from "../catalog/types.js";

export interface CatalogPort {
  load(): CatalogBundle;
  profile(profileId: string): EnvironmentProfile | undefined;
}
