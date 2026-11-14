/**
 * Registry of every indicator source. `ingest` and `source` both read it,
 * so a new adapter only needs to be added here.
 */
import { CapAdapter } from "./cap.ts";
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
  cap: () => new CapAdapter(),
};

export const SOURCE_NAMES = Object.keys(ADAPTERS);
