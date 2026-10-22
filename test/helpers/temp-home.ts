import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Points HOME at a throwaway directory so no test touches the real ~/.kemory. */
export function useTempHome(): { home: string; restore(): void } {
  const previous = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "openclaw-kemory-"));
  process.env.HOME = home;
  return {
    home,
    restore() {
      if (previous === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previous;
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
}
