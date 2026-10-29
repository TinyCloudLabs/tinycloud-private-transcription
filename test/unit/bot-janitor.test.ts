/**
 * TC-904: the bot-janitor compose service. Runs its exact shell script (compose `$$` unescaped)
 * against a fake `docker` CLI: dry-run never removes; apply removes only bot containers finished
 * before the cutoff, and unused bot images older than the pinned one only when
 * BOT_JANITOR_PRUNE_IMAGES=true (default off).
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

// Containers (labels as the Vexa runtime stamps them: docker_backend.py MANAGED_LABEL on every
// workload, vexa.role=worker on agent workers; bots are named vexa-mtg-<workload id>):
//   c_old      expired bot (30 d)                      -> removed in apply
//   c_new      recent bot (1 d)                        -> survives
//   c_live     running bot (docker reports FinishedAt as the zero time) -> survives
//   c_worker   expired runtime-managed NON-bot (agent worker) -> survives
//   c_spoof    expired runtime-managed, bot-style name but a non-bot image -> survives
//   c_keeper   expired bot-image container without runtime labels (bot-image-keeper) -> survives
// Images: the pin, one superseded and unused (sha256:old), one superseded but still used by c_new
// (sha256:used), one newer than the pin (sha256:newer, e.g. pulled by an in-flight deploy), and an
// unrelated image.
const managed = { "runtime.managed": "true" };
const containers = [
  { id: "c_old", status: "exited", finished: iso(30), name: "/vexa-mtg-5-old", image: "ghcr.io/tinycloudlabs/vexa/bot:tc-old", imageId: "sha256:gone", labels: managed },
  { id: "c_new", status: "exited", finished: iso(1), name: "/vexa-mtg-95-new", image: "vexaai/vexa-bot:dev", imageId: "sha256:used", labels: managed },
  { id: "c_live", status: "running", finished: "0001-01-01T00:00:00Z", name: "/vexa-mtg-7-live", image: "ghcr.io/tinycloudlabs/vexa/bot:tc-6d44cb4@sha256:efa1e11d", imageId: "sha256:pin", labels: managed },
  { id: "c_worker", status: "exited", finished: iso(30), name: "/vexa-worker-meet-3-abcd", image: "vexaai/v012-agent-worker:v012", imageId: "sha256:worker", labels: { ...managed, "vexa.role": "worker", "vexa.kind": "meet" } },
  { id: "c_spoof", status: "dead", finished: iso(30), name: "/vexa-mtg-9-spoof", image: "postgres:16", imageId: "sha256:pg", labels: managed },
  { id: "c_keeper", status: "exited", finished: iso(30), name: "/ptx-bot-image-keeper-1", image: "ghcr.io/tinycloudlabs/vexa/bot:tc-6d44cb4", imageId: "sha256:pin", labels: { "com.docker.compose.service": "bot-image-keeper" } },
];
// Fake docker CLI over the fixtures above (one pipe-separated line per container). `ps -aq` honours
// label=/status=/ancestor= filters (same key ORs, different keys AND, as the real CLI) and rejects
// any other filter; `inspect -f` honours the requested ids and format placeholders.
writeFileSync(join(dir, "containers"), containers.map((c) =>
  [c.id, c.status, c.finished, c.name, c.image, c.imageId, Object.entries(c.labels).map(([k, v]) => `${k}=${v}`).join(",")].join("|") + "\n").join(""));
writeFileSync(join(dir, "docker"), `#!/bin/sh
echo "$*" >> "${dir}/calls"
case "$1 $2" in
  "ps -aq")
    shift 2; labels=; statuses=; ancestors=
    while [ $# -gt 0 ]; do
      [ "$1" = --filter ] || { echo "fake docker: unexpected arg $1" >&2; exit 1; }
      case "$2" in
        label=*) labels="$labels \${2#label=}" ;;
        status=*) statuses="$statuses \${2#status=}" ;;
        ancestor=*) ancestors="$ancestors \${2#ancestor=}" ;;
        *) echo "fake docker: unsupported filter $2" >&2; exit 1 ;;
      esac
      shift 2
    done
    while IFS='|' read -r id status finished name image imageid lbls; do
      ok=1
      for l in $labels; do case ",$lbls," in *",$l,"*) ;; *) ok=0 ;; esac; done
      if [ -n "$statuses" ]; then m=0; for s in $statuses; do [ "$s" = "$status" ] && m=1; done; [ $m = 1 ] || ok=0; fi
      if [ -n "$ancestors" ]; then m=0; for a in $ancestors; do [ "$a" = "$imageid" ] && m=1; done; [ $m = 1 ] || ok=0; fi
      [ $ok = 1 ] && echo "$id"
    done < "${dir}/containers" ;;
  "inspect -f")
    fmt=$3; shift 3
    for want in "$@"; do
      while IFS='|' read -r id status finished name image imageid lbls; do
        [ "$id" = "$want" ] || continue
        printf '%s\\n' "$fmt" | sed -e "s|{{.Id}}|$id|" -e "s|{{.State.FinishedAt}}|$finished|" -e "s|{{.Name}}|$name|" -e "s|{{.Config.Image}}|$image|"
      done < "${dir}/containers"
    done ;;
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

function run(mode: string, days = "7", pruneImages?: string) {
  rmSync(join(dir, "calls"), { force: true });
  const proc = Bun.spawnSync(["sh", "-c", script], {
    env: {
      PATH: `${dir}:/usr/bin:/bin`, BOT_JANITOR_MODE: mode, BOT_CONTAINER_RETENTION_DAYS: days, BOT_JANITOR_INTERVAL_SECONDS: "1", BOT_IMAGE: "ghcr.io/tinycloudlabs/vexa/bot:pinned",
      ...(pruneImages === undefined ? {} : { BOT_JANITOR_PRUNE_IMAGES: pruneImages }),
    },
    stdout: "pipe", stderr: "pipe",
  });
  const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  return { out: proc.stdout.toString(), err: proc.stderr.toString(), calls, removals: calls.filter((c) => /^(rm|rmi) /.test(c)) };
}

test("dry-run logs what it would remove and removes nothing, whatever the image flag says", () => {
  for (const flag of [undefined, "false", "true"]) {
    const { out, err, removals } = run("dry-run", "7", flag);
    expect(err).toBe("");
    expect(removals).toEqual([]);
    expect(out).toContain("bot-janitor [dry-run] remove container /vexa-mtg-5-old");
    expect(out).toContain("bot-janitor [dry-run] remove image sha256:old");
    expect(out).not.toContain("vexa-mtg-95-new");
    for (const survivor of ["vexa-mtg-7-live", "vexa-worker-meet-3-abcd", "vexa-mtg-9-spoof", "ptx-bot-image-keeper-1"]) {
      expect(out).not.toContain(survivor);
    }
    expect(out).not.toMatch(/sha256:(pin|used|newer|pg)/);
  }
});

test("apply without BOT_JANITOR_PRUNE_IMAGES removes the old container only and never runs rmi", () => {
  const { out, removals } = run("apply");
  expect(removals).toEqual(["rm c_old"]);
  expect(out).not.toContain("remove image");
});

test("only the expired bot container is removed: managed non-bot, spoofed-name, unlabelled bot-image and running containers survive", () => {
  const { out, calls, removals } = run("apply");
  // The runtime.managed + exited/dead query selects c_old, c_new, c_worker and c_spoof only: the
  // running bot and the unlabelled keeper never reach inspect...
  expect(calls).toContain("inspect -f {{.Id}} {{.State.FinishedAt}} {{.Name}} {{.Config.Image}} c_old c_new c_worker c_spoof");
  // ...and of those, the expired non-bot worker and the bot-named non-bot-image container fail the
  // bot predicate although both are old enough.
  expect(removals).toEqual(["rm c_old"]);
  expect(out).toContain("remove container /vexa-mtg-5-old");
  expect(out).not.toMatch(/c_(live|worker|spoof|keeper)|vexa-worker|vexa-mtg-(7|9)-|image-keeper/);
});

test("any image flag other than true is off", () => {
  for (const flag of ["false", "", "TRUE", "1", "yes"]) {
    expect(run("apply", "7", flag).removals).toEqual(["rm c_old"]);
  }
});

test("apply with BOT_JANITOR_PRUNE_IMAGES=true also removes the unused superseded image, keeping the pin, newer and in-use images", () => {
  const { removals } = run("apply", "7", "true");
  expect(removals).toEqual(["rm c_old", "rmi sha256:old"]);
});

test("invalid settings fall back to dry-run and remove nothing", () => {
  const { out, removals } = run("aply", "seven", "true");
  expect(removals).toEqual([]);
  expect(out).toContain("bot-janitor: invalid BOT_JANITOR_MODE; using dry-run");
  expect(out).toContain("bot-janitor: invalid BOT_CONTAINER_RETENTION_DAYS; using 7 in dry-run");
  expect(run("apply", "x7", "true").removals).toEqual([]);
});
