
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createServer } from "node:http";
import { previewIt } from "../src/plan/preview";

describe("previewIt — port hygiene", () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(200);
        res.end("alive");
      });
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    port = address.port;
  });

  afterAll(() => {
    server.close();
  });

  test("preview refuses to start on a port that is already in use", async () => {
    const result = await previewIt(
      { command: "sleep 5", url: `http://127.0.0.1:${port}` },
      process.cwd(),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("port-in-use");
    expect(result.detail).toContain("already in use");
  });

  test("port-zero-shaped URL is not flagged as in-use", async () => {
    const result = await previewIt(
      { command: "true", url: "http://127.0.0.1/", readyTimeoutMs: 100 },
      process.cwd(),
    );
    // no explicit port in the URL — port check is skipped, not fired
    expect(result.reason).not.toBe("port-in-use");
  });
});
