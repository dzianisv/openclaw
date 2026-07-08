// Covers bounded re-read retry when a config snapshot read catches torn JSON.
import fsNode from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigIO } from "./io.js";

/**
 * Wraps the real fs but serves scripted contents for the first reads of
 * configPath, then falls through to the real file. Emulates a reader racing a
 * concurrent config replace: early reads observe torn JSON, later reads see
 * the fully written file.
 */
function makeTornReadFs(configPath: string, tornReads: string[]): {
  fs: typeof fsNode;
  configReadCount: () => number;
} {
  let reads = 0;
  const readFileSync = ((target: fsNode.PathOrFileDescriptor, options?: unknown) => {
    if (target === configPath) {
      const index = reads;
      reads += 1;
      if (index < tornReads.length) {
        return tornReads[index];
      }
    }
    return fsNode.readFileSync(target, options as never);
  }) as typeof fsNode.readFileSync;
  return {
    fs: { ...fsNode, readFileSync } as typeof fsNode,
    configReadCount: () => reads,
  };
}

describe("config snapshot torn-read retry", () => {
  const tempRoots: string[] = [];
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        fsNode.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  function seedConfigHome(): { home: string; configPath: string; raw: string } {
    const home = fsNode.mkdtempSync(path.join(os.tmpdir(), "openclaw-parse-retry-"));
    tempRoots.push(home);
    const stateDir = path.join(home, ".openclaw");
    fsNode.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const configPath = path.join(stateDir, "openclaw.json");
    const raw = `${JSON.stringify({ gateway: { mode: "local" } }, null, 2)}\n`;
    fsNode.writeFileSync(configPath, raw, { mode: 0o600 });
    return { home, configPath, raw };
  }

  it("recovers when a torn read is followed by a clean re-read", async () => {
    const { home, configPath, raw } = seedConfigHome();
    // First read catches the file mid-replace (truncated JSON), the retry
    // observes the fully written content.
    const torn = raw.slice(0, Math.floor(raw.length / 2));
    const { fs, configReadCount } = makeTornReadFs(configPath, [torn]);
    const io = createConfigIO({
      configPath,
      fs,
      homedir: () => home,
      env: {},
      observe: false,
      logger: { error: () => {}, warn: () => {} },
    });

    const snapshot = await io.readConfigFileSnapshot();

    expect(snapshot.valid).toBe(true);
    expect(snapshot.raw).toBe(raw);
    expect(configReadCount()).toBe(2);
  });

  it("still reports invalid when every re-read returns unparseable content", async () => {
    const { home, configPath } = seedConfigHome();
    const torn = '{ "gateway": { "mode": "loc';
    // More scripted torn reads than retry attempts: the file is persistently
    // invalid and must still fail (the retry tolerates torn reads, it does not
    // suppress real corruption).
    const { fs, configReadCount } = makeTornReadFs(configPath, [torn, torn, torn, torn]);
    const io = createConfigIO({
      configPath,
      fs,
      homedir: () => home,
      env: {},
      observe: false,
      logger: { error: () => {}, warn: () => {} },
    });

    const snapshot = await io.readConfigFileSnapshot();

    expect(snapshot.valid).toBe(false);
    expect(snapshot.issues[0]?.message).toContain("JSON5 parse failed");
    // Initial read + bounded retries only — no unbounded spinning.
    expect(configReadCount()).toBe(3);
  });
});
