#!/usr/bin/env bun
import { API_KEY_SCOPES, createApiKey, DEFAULT_KEY_SCOPES, parseScopes } from "./api/auth.ts";
import { createContext } from "./context.ts";
import { runMigrations } from "./db/migrate.ts";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const USAGE = `usage: bun run cli <create-key --project <name> [--scopes <scope>[,<scope>...]] | migrate | eval ...>
  eval run --meeting <id> [--models <m>[,<m>...]]     re-transcribe retained audio with each model (TC-745)
  eval reference --meeting <id> --source <name> < file   store a reference transcript (e.g. Gemini) and re-score
  eval report --meeting <id>                          coverage (captured vs transcribed speech) and metrics for the published transcript and every eval
  eval show --meeting <id> [--eval <evalId>]          print the published (or an eval's) transcript
  gapfill-check --meeting <id|vexa id> [--windows N] [--all]   align the retained recording and cut a few voiced
                                                      windows exactly as gap fill would; prints planned vs measured
                                                      energy. Sends nothing to Tinfoil, writes no ledger rows (TC-758)
  scopes: ${API_KEY_SCOPES.join(", ")} (default ${DEFAULT_KEY_SCOPES.join(",")}; quote them in the shell, e.g. --scopes 'transcriptions:*')`;
const fail = (message: string): never => {
  console.error(message);
  console.error(USAGE);
  process.exit(1);
};

switch (cmd) {
  case "create-key": {
    const project = flag("project") ?? "demo";
    const scopesArg = flag("scopes");
    if (rest.includes("--scopes") && scopesArg === undefined) fail("--scopes needs a value");
    let scopes = [...DEFAULT_KEY_SCOPES];
    if (scopesArg !== undefined) {
      try {
        scopes = parseScopes(scopesArg.split(",").map((scope) => scope.trim()));
      } catch (err) {
        fail((err as Error).message);
      }
    }
    await runMigrations();
    const ctx = createContext();
    const { key, webhookSecret } = await createApiKey(ctx, project, scopes);
    console.log(`Project:        ${project}`);
    console.log(`Scopes:         ${scopes.join(",")}`);
    console.log(`API key:        ${key}`);
    console.log(`Webhook secret: ${webhookSecret}`);
    console.log("Store the API key now; it is only shown once (only its sha256 hash is persisted).");
    process.exit(0);
  }
  case "migrate": {
    await runMigrations();
    console.log("migrations applied");
    process.exit(0);
  }
  case "eval": {
    const { runTranscriptEval, setReferenceTranscript, transcriptEvalReport, transcriptEvalText } = await import("./services/transcript-eval.ts");
    const sub = rest[0];
    const meetingId = flag("meeting") ?? fail("--meeting is required");
    await runMigrations();
    const ctx = createContext();
    if (sub === "run") {
      const models = (flag("models") ?? ctx.config.eval.models.join(",") ?? "").split(",").map((m) => m.trim()).filter(Boolean);
      if (!models.length) fail("--models (or EVAL_MODELS) is required");
      const ids = await runTranscriptEval(ctx, meetingId, models, (line) => console.error(line));
      console.log(ids.join("\n"));
    } else if (sub === "reference") {
      const turns = await setReferenceTranscript(ctx, meetingId, flag("source") ?? "reference", await Bun.stdin.text());
      console.log(`reference stored: ${turns} turns`);
    } else if (sub === "report") {
      const report = await transcriptEvalReport(ctx, meetingId);
      console.log(`reference: ${report.reference ?? "none"}`);
      const c = report.coverage as Record<string, number | string> | null;
      const sec = (ms: unknown) => typeof ms === "number" ? `${(ms / 1000).toFixed(1)}s` : "?";
      console.log(c ? `coverage: captured ${sec(c.captured_ms)}, transcribed ${sec(c.transcribed_ms)} (attributed ${sec(c.attributed_ms)} + recording ${sec(c.recording_ms)}), silent ${sec(c.silent_ms)}, gaps ${sec(c.gap_ms)}; ${c.retried_batches}/${c.batches} batches retried; gap fill: align ${c.gap_align}, ${c.gap_chunks_filled}/${c.gap_chunks} chunks filled, ${c.gap_rows_unverified} unverified rows`
        : "coverage: none (not an attributed meeting, or published before TC-758)");
      const keys = ["wer", "word_recall", "trigram_recall", "speaker_accuracy", "hyp_words", "ref_words", "speakers", "unknown_word_share", "turns", "median_turn_words", "hallucinated_turns", "dropped_hallucinations", "failed_batches"];
      console.table(report.rows.map((row) => ({ source: row.source, status: row.status, calls: row.calls, ...Object.fromEntries(keys.map((key) => [key, (row.metrics as Record<string, unknown>)[key]])) })));
    } else if (sub === "show") {
      console.log(await transcriptEvalText(ctx, meetingId, flag("eval")));
    } else fail(`unknown eval command: ${sub}`);
    process.exit(0);
  }
  case "gapfill-check": {
    const { gapFillCheck } = await import("./services/attributed-transcription.ts");
    const meetingId = flag("meeting") ?? fail("--meeting is required");
    const windows = flag("windows") ? Number(flag("windows")) : undefined;
    if (windows !== undefined && (!Number.isSafeInteger(windows) || windows <= 0)) fail("--windows must be a positive integer");
    const ctx = createContext();
    const report = await gapFillCheck(ctx, meetingId, { windows, all: rest.includes("--all") });
    const { checked, analysis, ...summary } = report;
    console.log(JSON.stringify(summary, null, 2));
    const a = analysis;
    console.log(`alignment: ${a.accepted ? "ACCEPTED" : "REJECTED"} — best ${a.best ? `${a.best.offset_ms} ms r=${a.best.r} z=${a.best.z}` : "none"}; runner-up (>1.5 s away) ${a.runner_up ? `${a.runner_up.offset_ms} ms r=${a.runner_up.r}` : "none"}; prior ${a.prior_ms ?? "none"} ms; ${a.offsets} offsets, r mean ${a.mean_r} sd ${a.sd_r}; speech frames ${a.speech_frames}, recording frames ${a.recording_frames}, voiced share ${a.voiced_share}`);
    if (checked.length) console.table(checked);
    else console.log(report.alignment ? "no voiced windows to cut" : "recording did not align: gap fill would send nothing and list every span as a gap");
    process.exit(0);
  }
  default:
    console.error(USAGE);
    process.exit(1);
}
