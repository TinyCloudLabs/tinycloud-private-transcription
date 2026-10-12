import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { positiveIntegerEnv, requireDatabaseUrl } from "../../src/config.ts";

test("VEXA_MAX_TIME_LEFT_ALONE_MS accepts only positive integers", () => {
  const previous = process.env.VEXA_MAX_TIME_LEFT_ALONE_MS;
  try {
    delete process.env.VEXA_MAX_TIME_LEFT_ALONE_MS;
    expect(positiveIntegerEnv("VEXA_MAX_TIME_LEFT_ALONE_MS", "300000")).toBe(300_000);
    for (const value of ["0", "-1", "1.5", "bad"]) {
      process.env.VEXA_MAX_TIME_LEFT_ALONE_MS = value;
      expect(() => positiveIntegerEnv("VEXA_MAX_TIME_LEFT_ALONE_MS", "300000")).toThrow("VEXA_MAX_TIME_LEFT_ALONE_MS must be a positive integer");
    }
  } finally {
    if (previous === undefined) delete process.env.VEXA_MAX_TIME_LEFT_ALONE_MS;
    else process.env.VEXA_MAX_TIME_LEFT_ALONE_MS = previous;
  }
});

test("config load rejects an invalid RECORDING_RECOVERY_ADMISSION_MS", () => {
  // Load the real config module in a fresh process so its module-level env parse runs.
  for (const value of ["0", "-1", "1.5", "bad"]) {
    const proc = Bun.spawnSync(
      [process.execPath, "-e", 'await import("./src/config.ts")'],
      {
        cwd: new URL("../..", import.meta.url).pathname,
        env: { ...process.env, RECORDING_RECOVERY_ADMISSION_MS: value },
        stderr: "pipe",
      },
    );
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("RECORDING_RECOVERY_ADMISSION_MS must be a positive integer");
  }
});

test("config load rejects an invalid VEXA_MAX_CONCURRENT_BOTS (TC-902)", () => {
  // NaN would never compare >= running, silently disabling the meeting bot cap.
  for (const value of ["0", "-1", "1.5", "bad", ""]) {
    const proc = Bun.spawnSync(
      [process.execPath, "-e", 'await import("./src/config.ts")'],
      {
        cwd: new URL("../..", import.meta.url).pathname,
        env: { ...process.env, VEXA_MAX_CONCURRENT_BOTS: value },
        stderr: "pipe",
      },
    );
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("VEXA_MAX_CONCURRENT_BOTS must be a positive integer");
  }
  const ok = Bun.spawnSync(
    [process.execPath, "-e", 'const { config } = await import("./src/config.ts"); console.log(config.vexa.maxConcurrentBots)'],
    { cwd: new URL("../..", import.meta.url).pathname, env: { ...process.env, VEXA_MAX_CONCURRENT_BOTS: "2" }, stdout: "pipe" },
  );
  expect(ok.stdout.toString().trim()).toBe("2");
});

test("DATABASE_URL has no committed default and fails clearly when missing (TC-929)", () => {
  for (const value of [undefined, ""]) expect(() => requireDatabaseUrl(value)).toThrow("DATABASE_URL is required");
  // An unexpanded ${POSTGRES_PASSWORD} in .env leaves an empty password.
  expect(() => requireDatabaseUrl("postgres://ptx:@localhost:55432/ptx")).toThrow("DATABASE_URL has an empty password");
  expect(requireDatabaseUrl("postgres://ptx:s3cret@localhost:55432/ptx")).toBe("postgres://ptx:s3cret@localhost:55432/ptx");
  expect(requireDatabaseUrl("postgres://ptx@localhost:55432/ptx")).toBe("postgres://ptx@localhost:55432/ptx");

  // The API refuses to start without it; a process that never opens Postgres still loads config.
  const cwd = new URL("../..", import.meta.url).pathname;
  const { DATABASE_URL: _omit, ...env } = process.env;
  const api = Bun.spawnSync([process.execPath, "--no-env-file", "src/api/server.ts"], { cwd, env, stderr: "pipe" });
  expect(api.exitCode).toBe(1);
  expect(api.stderr.toString()).toContain("DATABASE_URL is required");
  const load = Bun.spawnSync([process.execPath, "--no-env-file", "-e", 'await import("./src/config.ts")'], { cwd, env, stderr: "pipe" });
  expect(load.exitCode).toBe(0);
});

test("signal smoke rejects a missing DATABASE_URL before spawning any child (TC-929)", () => {
  // The script spawns its children as `bun …` from PATH; a `bun` shim first on PATH records any spawn.
  const shimDir = mkdtempSync(join(tmpdir(), "signal-smoke-shim-"));
  const marker = join(shimDir, "spawned");
  try {
    writeFileSync(join(shimDir, "bun"), `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
    chmodSync(join(shimDir, "bun"), 0o755);
    const { DATABASE_URL: _db, SMOKE_DATABASE_URL: _smoke, ...env } = process.env;
    const proc = Bun.spawnSync([process.execPath, "--no-env-file", "scripts/signal-smoke.ts"], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...env, PATH: `${shimDir}:${env.PATH ?? ""}` },
      stderr: "pipe",
      timeout: 20_000,
    });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("DATABASE_URL is required");
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
  }
});
