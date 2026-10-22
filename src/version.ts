import { readFileSync } from "node:fs";

// ../package.json resolves from both src/ and dist/.
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export const VERSION: string = manifest.version;
