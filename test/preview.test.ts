import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { previewCheckOnce, previewIt, stopIt } from "../src/plan/preview";

/**
 * A contract can be correct and still not run.
 *
 * The toolkit that passed every check in its matrix had a `listen()` nobody
 * called. Nothing asserted on the code could find that. So the plan declares
 * how to preview the result, and this runs it.
 */

const dir = () => mkdtempSync(join(tmpdir(), "cubicore-preview-"));

describe("previewCheckOnce", () => {
  it("runs a command that becomes ready and reports success", async () => {
    const root = dir();
    writeFileSync(join(root, "server.sh"), "#!/bin/sh\necho 'listening on 3000'\nsleep 30\n");
    const outcome = await previewCheckOnce(
      { command: "sh server.sh", readyLine: "listening on 3000", readyTimeoutMs: 5000 },
      root,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toContain("listening on 3000");
  });

  it("fails when the command never reports ready", async () => {
    const root = dir();
    writeFileSync(join(root, "quiet.sh"), "#!/bin/sh\nsleep 30\n");
    const outcome = await previewCheckOnce(
      { command: "sh quiet.sh", readyLine: "never happens", readyTimeoutMs: 1500 },
      root,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("no-ready-line");
  });

  it("fails when nothing answers the URL", async () => {
    const root = dir();
    const outcome = await previewCheckOnce(
      { command: "sleep 30", url: "http://127.0.0.1:1/nothing", readyTimeoutMs: 1500 },
      root,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("never-answered");
  });

  it("checks the status the founder expected", async () => {
    const root = dir();
    writeFileSync(join(root, "srv.sh"), '#!/bin/sh\necho hi\nsleep 30\n');
    const outcome = await previewCheckOnce(
      { command: "sh srv.sh", url: "http://127.0.0.1:9/x", expect: { status: 200 }, readyTimeoutMs: 1200 },
      root,
    );
    expect(outcome.ok).toBe(false);
  });

  it("does not leave the process running", async () => {
    const root = dir();
    const marker = join(root, "still-running");
    writeFileSync(join(root, "srv.sh"), `#!/bin/sh\ntouch ${marker}\nsleep 30\n`);
    await previewCheckOnce({ command: "sh srv.sh", readyLine: "", readyTimeoutMs: 800 }, root);
    await Bun.sleep(400);

    const { existsSync } = await import("node:fs");
    const before = existsSync(marker);
    await Bun.sleep(600);
    expect(before || !existsSync(marker)).toBe(true);
  });
});

describe("previewIt", () => {
  it("leaves the preview running for the founder", async () => {
    const root = dir();
    writeFileSync(join(root, "server.sh"), "#!/bin/sh\necho 'listening on 3000'\nsleep 30\n");
    const outcome = await previewIt(
      { command: "sh server.sh", readyLine: "listening on 3000", readyTimeoutMs: 5000 },
      root,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.pid).toBeDefined();
    if (outcome.pid) expect(outcome.pid).toBeGreaterThan(0);

    const stop = await stopIt(root);
    expect(stop.ok).toBe(true);
  });
});
