import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VexaClient } from "../../src/providers/vexa/client.ts";

/** Raw HTTP server: declares `declared` bytes, sends `sent`, then closes (a cut connection). */
function server(declared: number, sent: number) {
  return Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
    data(socket) {
      socket.write(`HTTP/1.1 200 OK\r\nContent-Type: video/webm\r\nContent-Length: ${declared}\r\nConnection: close\r\n\r\n`);
      socket.write(new Uint8Array(sent).fill(7));
      socket.end();
    },
  } });
}

test("a truncated recording download is rejected, never kept as the file (TC-758)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ptx-test-"));
  const short = server(1_000, 10), whole = server(1_000, 1_000);
  try {
    const client = (port: number) => new VexaClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k" });
    await expect(client(short.port).fetchToFile("/recordings/1/raw", join(dir, "short"))).rejects.toThrow();
    expect(await client(whole.port).fetchToFile("/recordings/1/raw", join(dir, "whole"))).toBe(1_000);
    expect((await stat(join(dir, "whole"))).size).toBe(1_000);
  } finally { short.stop(true); whole.stop(true); await rm(dir, { recursive: true, force: true }); }
});
