#!/usr/bin/env node

// restores ignored model data from the verified catalog pin.
import { fileURLToPath } from "node:url";
import { hydratePinnedModelCatalog } from "./update-model-catalog-pin.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const revision = await hydratePinnedModelCatalog(root);
console.log(`Hydrated model data from ${revision}`);
