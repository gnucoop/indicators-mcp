/**
 * Registry of every indicator source. `ingest` and `source` both read it,
 * so a new adapter only needs to be added here.
 */
import { DhsAdapter } from "./dhs.ts";
import { IndiKitAdapter } from "./indikit.ts";
import { SdgAdapter } from "./sdg.ts";
import type { Adapter } from "./types.ts";
import { WdiAdapter } from "./wdi.ts";

export const ADAPTERS: Record<string, () => Adapter> = {
  indikit: () => new IndiKitAdapter(),
  sdg: () => new SdgAdapter(),
  wdi: () => new WdiAdapter(),
  dhs: () => new DhsAdapter(),
};

export const SOURCE_NAMES = Object.keys(ADAPTERS);
