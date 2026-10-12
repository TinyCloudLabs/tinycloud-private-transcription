/**
 * TC-904: the bot-janitor compose service. Runs its exact shell script (compose `$$` unescaped)
 * against a fake `docker` CLI: dry-run never removes; apply removes only bot containers finished
 * before the cutoff, then only unused bot images older than the pinned one.
 */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const compose = readFileSync(new URL("../../infra/dstack/app-compose.yaml", import.meta.url), "utf8");
const block = compose.slice(compose.indexOf("\n  bot-janitor:\n"));
const script = block.slice(block.indexOf("      - |\n") + 10, block.indexOf("\n    environment:\n"))
  .split("\n").map((line) => line.replace(/^ {8}/, "")).join("\n").replaceAll("$$", "$");

const dir = mkdtempSync(join(tmpdir(), "bot-janitor-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

// Containers: c_old finished 30 days ago, c_new 1 day ago. Images: the pin, one superseded and
// unused (sha256:old), one superseded but still used by c_new (sha256:used), one newer than the
// pin (sha256:newer, e.g. pulled by an in-flight deploy), and an unrelated image.
writeFileSync(join(dir, "docker"), `#!/bin/sh
echo "$*" >> "${dir}/calls"
case "$1 $2" in
  "ps -aq")
    case "$*" in
      *ancestor=sha256:used*) echo c_new ;;
      *ancestor=*) ;;
      *) printf 'c_old\\nc_new\\n' ;;
    esac ;;
  "inspect -f") echo "c_old ${iso(30)} /vexa-mtg-5-old"; echo "c_new ${iso(1)} /vexa-mtg-95-new" ;;
  "image inspect")
    case "$*" in
      *"{{.Id}} {{.Created}}"*) echo "sha256:pin 2026-10-02T10:00:00.000000000Z" ;;
      *sha256:old*) echo "2026-09-01T00:00:00Z" ;;
      *sha256:used*) echo "2026-09-20T00:00:00Z" ;;
      *sha256:newer*) echo "2026-10-09T00:00:00Z" ;;
      *sha256:pin*) echo "2026-10-02T10:00:00.000000000Z" ;;
    esac ;;
  "images --no-trunc")
    printf '%s\\n' "ghcr.io/tinycloudlabs/vexa/bot sha256:pin" "ghcr.io/tinycloudlabs/vexa/bot sha256:old" \\
      "vexaai/vexa-bot sha256:used" "ghcr.io/tinycloudlabs/vexa/bot sha256:newer" "postgres sha256:pg" ;;
esac
`);
// The loop's sleep ends the run after one sweep.
writeFileSync(join(dir, "sleep"), "#!/bin/sh\nkill $PPID\n");
chmodSync(join(dir, "docker"), 0o755);
chmodSync(join(dir, "sleep"), 0o755);

function run(mode: string, days = "7") {
  rmSync(join(dir, "calls"), { force: true });
  const proc = Bun.spawnSync(["sh", "-c", script], {
    env: { PATH: `${dir}:/usr/bin:/bin`, BOT_JANITOR_MODE: mode, BOT_CONTAINER_RETENTION_DAYS: days, BOT_JANITOR_INTERVAL_SECONDS: "1", BOT_IMAGE: "ghcr.io/tinycloudlabs/vexa/bot:pinned" },
    stdout: "pipe", stderr: "pipe",
  });
  const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  return { out: proc.stdout.toString(), err: proc.stderr.toString(), removals: calls.filter((c) => /^(rm|rmi) /.test(c)) };
}

test("dry-run logs what it would remove and removes nothing", () => {
  const { out, err, removals } = run("dry-run");
  expect(err).toBe("");
  expect(removals).toEqual([]);
  expect(out).toContain("bot-janitor [dry-run] remove container /vexa-mtg-5-old");
  expect(out).toContain("bot-janitor [dry-run] remove image sha256:old");
  expect(out).not.toContain("vexa-mtg-95-new");
  expect(out).not.toMatch(/sha256:(pin|used|newer|pg)/);
});

test("apply removes old bot containers and unused superseded bot images only", () => {
  const { removals } = run("apply");
  expect(removals).toEqual(["rm c_old", "rmi sha256:old"]);
});

test("invalid settings fall back to dry-run and remove nothing", () => {
  const { out, removals } = run("aply", "seven");
  expect(removals).toEqual([]);
  expect(out).toContain("bot-janitor: invalid BOT_JANITOR_MODE; using dry-run");
  expect(out).toContain("bot-janitor: invalid BOT_CONTAINER_RETENTION_DAYS; using 7 in dry-run");
  expect(run("apply", "x7").removals).toEqual([]);
});
