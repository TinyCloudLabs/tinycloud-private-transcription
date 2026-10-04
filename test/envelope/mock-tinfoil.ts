/**
 * Stand-in for Tinfoil's POST /v1/audio/transcriptions in the batch memory-envelope CI job (test/envelope/run.sh).
 * Never deployed. Answers every region with short text and records what it received (GET /stats).
 */
let calls = 0;
let maxWavBytes = 0;
let badWav = 0;

const server = Bun.serve({
  port: 8081,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/stats") return Response.json({ calls, max_wav_bytes: maxWavBytes, bad_wav: badWav });
    if (request.method !== "POST" || pathname !== "/v1/audio/transcriptions") return new Response("not found", { status: 404 });
    const entry = (await request.formData()).get("file");
    if (typeof entry === "string" || entry === null) return new Response("missing file", { status: 400 });
    const bytes = new Uint8Array(await new Response(entry).arrayBuffer());
    const head = new TextDecoder().decode(bytes.subarray(0, 12));
    if (!(head.startsWith("RIFF") && head.endsWith("WAVE"))) badWav++;
    calls++;
    maxWavBytes = Math.max(maxWavBytes, bytes.byteLength);
    return Response.json({ text: `region ${calls}`, language: "en" });
  },
});
console.log(JSON.stringify({ msg: "mock tinfoil listening", port: server.port }));
