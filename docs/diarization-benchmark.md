# Batch speaker diarization benchmark (TC-595)

Two parts:

1. **Windowed diarization on tdx.small (2026-10-06, what ships).** ptx-batch runs on tdx.small (1 vCPU, 1,853 MiB
   guest; `upload-worker` capped at 320 MiB, no swap). Full-file diarization peaked at 1.34 GB on 2 h of audio, so the
   worker diarizes 10-minute windows that overlap by 60 s, one window per process, and links speakers across windows.
2. **Model choice (2026-10-03, full-file, 4 CPUs).** Which embedding model and clustering threshold to use. The model
   (NeMo TitaNet-S) and threshold (1.0) chosen there are unchanged; that part's sizing conclusion (tdx.large) is
   superseded by part 1.

# Part 1: windowed diarization on tdx.small

## How it works

- `planWindows` (`src/uploads/diarize.ts`) cuts the recording into equal windows of at most 10 min that share 60 s
  with their neighbours (a 2 h file: 14 windows of about 565 s). Each window owns its span up to the middle of each
  overlap, so speech in an overlap is diarized twice but attributed once.
- One `diarize-window` process per window (`src/uploads/diarize-window.c`, on the sherpa-onnx C API): pyannote
  segmentation-3.0 + TitaNet-S + clustering at threshold 1.0, the same settings as the CLI in part 2. It reads only its
  window's samples from the PCM file and prints the window's segments with local speaker ids, plus one embedding per
  local speaker: the duration-weighted mean of L2-normalized TitaNet-S embeddings of its clearest speech (no one else
  talking; 1–10 s pieces, longest first, at most 60 s). The process exits after each window, so its memory is returned.
- `SpeakerLinker` keeps one centroid per recording-wide speaker. A local speaker joins the global speaker with the best
  score at or above 0.6, where the score is the cosine similarity to the centroid plus 0.1 × the share of the local
  speaker's overlap speech it shares with that global speaker in the previous window (only when they share at least
  2 s). Each global speaker takes one local speaker per window, except at a score of 0.8 or more (a window often splits
  one voice in two). Otherwise the local speaker is a new global speaker. Centroids absorb each linked embedding,
  weighted by its seconds.
- After the last window, global speakers never heard in the same window merge while their centroids' similarity is at
  least 0.7 (most similar first). Past 32 speakers (the result ids are `speaker_0`–`speaker_31`), the speaker with the
  least speech joins its most similar speaker.

## Setup

- **Host:** AMD EPYC 7502P (Zen 2), Ubuntu 22.04, shared dev host.
- **tdx.small proxy:** the api image built from this branch, `docker run --cpus=1 --cpuset-cpus=<one core> -m 320m
  --memory-swap 320m`, running the shipped `WindowedDiarizer` (Bun) with the image's `/opt/sherpa-onnx/diarize`. With one
  CPU in its affinity mask the worker gives onnxruntime one thread, as on tdx.small. Memory is sampled from the host at
  5 Hz: anon + shmem of the whole container (Bun and every `diarize-window` process; the cgroup also counts page cache,
  which the kernel reclaims first), and peak RSS per process. Wall time includes model loading in every window.
- **Accuracy:** the same windows (saved per-window results, re-linked with the shipped `SpeakerLinker`) against the
  reference RTTMs and against the full-file CLI at threshold 1.0 (part 2's setup, run once per input). DER from
  `pyannote.metrics` 4.1, overlap scored, collar 0.25 s (collar 0 in brackets).

### Inputs (AMI Meeting Corpus, CC-BY-4.0, headset mix, 16 kHz mono; reference RTTMs from pyannote/AMI-diarization-setup `only_words`; audio not committed)

| Input | Length | Speakers | What it tests |
|---|---|---|---|
| `m10` | 600 s | 5 | `EN2001a` 2640–3240 s (part 2's AMI clip): one window, identical to the full-file CLI |
| `h1` | 3,600 s | 5 | `EN2001a` 0–3600 s: 7 windows, two speakers with similar female voices (FEO065, FEO066) |
| `h2` | 7,199 s | 4 | `ES2004a`+`b`+`c`+`d` concatenated, cut at the 2 h cap: the same 4 people in 4 meetings, 14 windows; a speaker must keep one label from the first meeting to the last |

## Memory and time (1 CPU, 320 MiB, no swap)

| Input | Windows | Wall time | Real-time factor | Peak anon+shmem, container | Peak RSS `diarize-window` | Peak RSS Bun | OOM kills |
|---|---|---|---|---|---|---|---|
| m10 (10 min) | 1 | 154 s | 0.26 | 174 MiB | 191 MiB | 34 MiB | 0 |
| h1 (1 h) | 7 | 1,039 s (17 min) | 0.29 | 203 MiB | 219 MiB | 38 MiB | 0 |
| h2 (2 h) | 14 | 1,906 s (32 min) | 0.26 | 216 MiB | 229 MiB | 39 MiB | 0 |

Peak memory barely grows with the recording (174 → 216 MiB from 10 min to 2 h, against the 320 MiB cap): each window is
its own process, and the Bun side keeps only segment lists and one 192-float centroid per speaker. For comparison, the
full-file CLI peaked at 1,340 MB RSS on 2 h (part 2). These runs' outputs are identical to the accuracy runs below (same
DER on all three inputs). The envelope CI (`batch-envelope.yml`, the deployed compose on one CPU of a GitHub runner)
runs a 2 h diarized job too: `upload-worker` peaked at 199 MiB anon + shmem, `diarize-window` at 196 MiB RSS, no OOM
kill (its two synthetic voices take less embedding work: 750 s of processing).

**Why the allocator settings.** With onnxruntime's defaults (CPU memory arena and memory patterns on) and glibc's
defaults, one 10-minute window peaked at 340–380 MB RSS: TitaNet-S runs once per (10 s chunk, local speaker) with
inputs of varying length, and the arena and the heap keep growing. `diarize-window` turns the arena and memory patterns
off (`models/onnxruntime.config`, read by sherpa-onnx through the `cpu:<file>` provider string) and fixes glibc's
thresholds with `mallopt`. One 300 s window on one core, same output in every case:

| Allocator setting | Wall | user / sys CPU | Peak RSS |
|---|---|---|---|
| onnxruntime arena on, glibc defaults | 55 s | 55 / 0.4 s | 347 MB |
| arena off, glibc defaults | 59–69 s | 55–61 / 4–8 s | 248–296 MB |
| arena off, mmap threshold 128 KiB | 109 s | 57 / 52 s | 173 MB |
| arena off, mmap 1 MiB, trim 64 MiB | 99 s | 60 / 38 s | 186 MB |
| **arena off, mmap 4 MiB, trim 64 MiB (shipped)** | 75–79 s | 59–61 / 14–20 s | 200–220 MB |

Ranges are repeated runs. On full 600 s windows the first row peaked at 340–380 MB. Smaller thresholds save a little
more memory but spend most of the extra time in page faults.

**Runtime and the job model.** A 2 h upload spends about 32 minutes in diarization on one core of this host
(a tdx.small vCPU may be slower), then one Tinfoil request per speaker turn, as without diarization. Batch jobs are
asynchronous: create, upload, then the client polls `GET /v1/transcriptions/{id}`. The worker holds the job's claim
with a renewal timer while the diarizer runs (it is a child process; a lost claim kills it), and the job's ceiling is
`maxProcessingSeconds` = 4 h. While diarizing, the job reports `status: processing`, `progress.stage: decoding` and
`regions_total: 0`; TinyChat's upload panel shows "Transcribing…" and then "Transcribing… X of Y parts" once the turns
are known. The TinyChat poller has no overall deadline (it gives up only after 10 minutes of failed polls), so a long
diarization needs nothing from the apps.

## Accuracy and cross-window consistency

DER % collar 0.25 (collar 0); "vs full-file" scores the windowed output against the full-file CLI output as if it
were the reference, i.e. how differently the two label the same speech. Speakers = labels in the diarizer output /
speakers holding at least 1 % of the speech after the worker's turn building.

| Input | Full-file CLI vs reference | Windowed vs reference | Windowed vs full-file | Speakers full / windowed |
|---|---|---|---|---|
| m10 | 19.4 (21.9) | 19.4 (21.9) | 0.0 | 7 / 7 |
| h1 | 7.8 (10.9) | 9.3 (12.3) | 7.6 | 17 (6) / 17 (5) |
| h2 | 31.9 (36.1) | 13.9 (18.6) | 26.3 | 40 (7) / 32 (4) |

- On one window (m10) the result is the CLI's, as intended.
- **h2** (the same four people across four meetings): the full-file CLI splits FEE016 into three labels and MEE014 into
  two over the 2 h; the windowed run keeps each person on one label, so it scores better than the full-file baseline.
- **h1:** slightly worse than full-file. Its two female speakers (FEO065, FEO066) are merged into one cluster inside some
  10-minute windows, where each has little speech; the full-file clustering, with all their speech, keeps them apart.
  Linking cannot undo a merge made inside a window.

Labelled spot-check: the label holding most of each reference speaker's speech in each window's owned span ("-" = under
30 s there), windowed run.

h2 (14 windows):

| Speaker | w1 | w2 | w3 | w4 | w5 | w6 | w7 | w8 | w9 | w10 | w11 | w12 | w13 | w14 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| FEE013 | S0 | S0 | S0 | - | S0 | S0 | S0 | S3 | S0 | S0 | S0 | S0 | S0 | S3 |
| FEE016 | S3 | S3 | - | S3 | S3 | S3 | S3 | S3 | S3 | S3 | S3 | - | S3 | S3 |
| MEE014 | S6 | S6 | S6 | - | S6 | S6 | - | S6 | S6 | S6 | S6 | S6 | S6 | S6 |
| MEO015 | S5 | S5 | - | S5 | S5 | S5 | S5 | - | S5 | S5 | S5 | S6 | S5 | S5 |

The full-file CLI on the same spans: FEE013 S01 throughout; FEE016 S04, then S07 (w9) and S09 (w13–14); MEE014 S24 and
S21 alternating; MEO015 S18 with S24 and S09 in w12–13. The windowed exceptions (FEE013 in w8 and w14, MEO015 in w12)
are windows where that window's clustering put two speakers in one cluster.

h1 (7 windows): MEE067 S2 and MEO069 S3 in all 7; FEO066 S1 in all 6 where it speaks; FEO065 S1, S1, S14; MEE068 S1,
S9, S9. S1 is the merged FEO065/FEO066 cluster described above.

## Overlap, window shift and thresholds

Chosen: **overlap 60 s**, window shift 0.1 (sherpa-onnx's default), clustering threshold 1.0, `linkSimilarity` 0.6,
`sameVoiceSimilarity` 0.8, `anchorBonus` 0.1 (≥ 2 s shared), `mergeSimilarity` 0.7.

- **Overlap.** 60 s against 30 s, everything else shipped: h1 9.3 vs 13.2, h2 13.9 vs 12.7 DER; 60 s is better
  overall for about 5 % more audio diarized (2 h: 14 windows instead of 13).
- **Window shift** (how far the segmentation model's 10 s window moves; sherpa-onnx computes one embedding per chunk and
  local speaker, so this sets the cost). One 600 s window on one core: shift 0.1 → 111–151 s, 0.25 → 57–67 s, 0.5 →
  25–30 s. Windowed h1 DER (with the first linking version): 0.1 → 10.1, 0.25 → 13.2, 0.5 → 18.9; on m10 0.5 merged
five speakers into three (DER 30.3). The default 0.1 stays.
- **Cluster threshold inside a window.** 0.8 and 0.9 over-split each window (h1: 30–32 output labels) and made the
  result depend on the overlap (h1 DER 8.1–16.3); 1.0 stays.
- **Linking.** Local-speaker embeddings separate cleanly: for local speakers with ≥ 5 s of embedded speech and ≥ 70 %
  of it from one reference speaker, cosine to another window's local speaker of the same person is 0.76–0.98 (1st–99th
  percentile, h1) and 0.68–0.98 (h2); of a different person 0.09–0.61 (h1) and −0.01–0.54 (h2). With the first
  linking version, `linkSimilarity` from 0.5 to 0.85 gave h1 DER 10.1–11.7.
- **Overlap evidence.** The first version let co-speech in the overlap decide on its own (any pair sharing ≥ 2 s and
  half the local speaker's overlap speech linked at cosine ≥ 0.3). On h2 (30 s overlap) that made DER 28.1 instead of
  13.4 without it:
  when a window has merged two people, the overlap points the next window's clean speaker at the wrong label. The
  overlap now only adds 0.1 × the shared share to the cosine (0, 0.1, 0.2 and 0.3 all give h1 9.3 and h2 13.8–13.9
  with `sameVoiceSimilarity` in place), and alone links only a local speaker with no embedding. On these recordings the
  voice embeddings carry the linking; the overlap is a tie-breaker.
- **Same voice twice in one window.** Without `sameVoiceSimilarity` (each global speaker strictly once per window), a
  window that split one person in two left a duplicate global speaker, which the merge pass may not join (both were in
  that window), and later windows alternated between the two: h2 DER 13.4–23.6 depending on the overlap evidence
  weight and the overlap, against 12.7–13.9 with it.

## Tests

- Unit (`test/unit/batch.test.ts`, "windowed diarization"): window plans (lengths, 60 s overlaps, owned spans tile the
  recording, no short tail, empty input), the same voice across a boundary keeping its label and a new voice getting a
  new one, overlap evidence, a strong voice match outranking overlap evidence, overlap speech emitted once, the merge
  pass and its same-window rule, the 32-speaker cap, one process per window run one at a time with abort between
  windows, abort killing a running window process, and output parsing.
- `.github/workflows/batch-envelope.yml` runs a 2 h two-voice diarized job through the deployed compose limits (1 CPU,
  320 MiB, no swap) and fails on an OOM kill, a restart, more than 3 speakers, or a turn that is not one ≤ 30 s request.

# Part 2: model choice (2026-10-03)

Gate for the `diarize: true` stage of the batch worker: which sherpa-onnx speaker-embedding model and clustering
threshold to ship. Measured 2026-10-03 on whole files with the sherpa-onnx CLI.

## Setup (part 2)

- **Host:** AMD EPYC 7502P (Zen 2, AVX2), Ubuntu 22.04, shared dev host (load average ≈ 20–25 from other work).
- **tdx.large proxy:** every run pinned to 4 CPUs with `taskset` and 4 onnxruntime threads per stage
  (`--segmentation.num-threads=4 --embedding.num-threads=4`, `OMP_NUM_THREADS=4`), as the worker runs it
  (`DIARIZATION.maxThreads`).
- **Software:** sherpa-onnx `v1.13.8` prebuilt `linux-x64-shared-no-tts` CLI `sherpa-onnx-offline-speaker-diarization`
  (onnxruntime 1.28.2), pyannote segmentation-3.0 ONNX (`model.onnx`, sherpa-onnx `speaker-segmentation-models`
  release), defaults `--min-duration-on=0.3 --min-duration-off=0.5`, unknown speaker count
  (`--clustering.cluster-threshold`). The same CLI was also run inside the production image layout (Alpine
  `oven/bun:1.4.2-alpine` + the glibc runtime from `debian:bookworm-slim`, see `Dockerfile`) with identical output.
- **Scoring:** DER from `pyannote.metrics` 4.1, overlap scored, collar 0.25 s (strict collar 0 in brackets). Speaker
  count = distinct labels the CLI returned vs. the reference RTTM.

| Model (sherpa-onnx file) | Source / licence | Size |
|---|---|---|
| **TitaNet-S** `nemo_en_titanet_small.onnx` | NVIDIA NeMo, Apache-2.0 (the [NGC model card](https://catalog.ngc.nvidia.com/orgs/nvidia/teams/nemo/models/titanet_small) puts it under the NeMo Toolkit licence) | 40 MB |
| ERes2Net `3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx` | 3D-Speaker (ModelScope `iic/speech_eres2net_sv_en_voxceleb_16k`), Apache-2.0 | 26 MB |
| CAM++ `3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx` | 3D-Speaker (ModelScope `iic/speech_campplus_sv_en_voxceleb_16k`), Apache-2.0 | 30 MB |
| ResNet34-LM `wespeaker_en_voxceleb_resnet34_LM.onnx` | WeSpeaker, CC-BY-4.0 (VoxCeleb-trained models follow the dataset licence) | 27 MB |
| segmentation `sherpa-onnx-pyannote-segmentation-3-0/model.onnx` | pyannote, MIT | 6 MB |

### Inputs (openly licensed, with reference RTTMs; audio not committed)

| Input | Kind | Length | Speakers | Source |
|---|---|---|---|---|
| `sample_2spk` | 2-person conversation (short) | 30 s | 2 | pyannote-audio `tutorials/assets/sample.wav` + `sample.rttm` (MIT) |
| `vc_mupzb_2spk` | 2-person conversation, fast turn-taking (90 turns, mean 4.6 s) | 497 s | 2 | VoxConverse test `mupzb` (CC-BY-4.0) |
| `ami_EN2001a_5spk` | 5-person meeting, headset mix | 600 s | 5 | AMI `EN2001a.Mix-Headset.wav` 2640–3240 s (CC-BY-4.0), RTTM from pyannote/AMI-diarization-setup `only_words` |
| `vc_jtagk_6spk` | 6-speaker broadcast/debate | 292 s | 6 | VoxConverse dev `jtagk` |
| `vc_dxbbt_3spk_podcast` | podcast-style, 3 hosts with long turns (41 turns, mean 16.5 s) | 676 s | 3 | VoxConverse test `dxbbt` |

## Accuracy (speakers found / reference, DER % collar 0.25 (collar 0))

Best thresholds per model; the full sweep covered 0.4–1.0 in steps of 0.1 for all four models.

| Model @ threshold | sample 2 | mupzb 2 | AMI 5 | jtagk 6 | dxbbt 3 | mean DER |
|---|---|---|---|---|---|---|
| **TitaNet-S @ 1.0** | 2/2 1.3 (6.3) | 3/2 11.7 (18.0) | 7/5 19.4 (21.9) | 6/6 4.9 (8.0) | 3/3 2.5 (4.5) | **7.9** |
| TitaNet-S @ 0.9 | 2/2 1.3 (6.3) | 7/2 13.2 (20.1) | 10/5 19.7 (22.6) | 7/6 5.1 (8.3) | 3/3 2.5 (4.5) | 8.4 |
| ERes2Net @ 0.8 | 2/2 1.3 (6.3) | 8/2 13.2 (20.0) | 15/5 35.4 (37.8) | 8/6 5.7 (8.8) | 4/3 3.0 (5.1) | 11.7 |
| ERes2Net @ 1.0 | 1/2 48.6 (52.2) | 5/2 13.0 (19.5) | 7/5 6.9 (9.4) | 6/6 5.7 (8.9) | 3/3 2.6 (4.7) | 15.4 |
| ResNet34-LM @ 0.6 | 1/2 48.6 | 8/2 22.3 | 31/5 44.0 | 4/6 9.2 | 5/3 6.6 | 26.1 |
| CAM++ @ 1.0 | 2/2 45.5 | 4/2 51.6 | 6/5 42.3 | 3/6 28.7 | 4/3 17.1 | 37.1 |

- TitaNet-S is the only model that is good across the whole 0.9–1.0 range and never merges the two voices of the short
  sample; ERes2Net either over-splits the AMI meeting (≤ 0.8) or collapses the 30 s sample to one speaker (≥ 0.9).
- Extra speakers are small clusters (crosstalk, laughter, a few short turns); they cost little DER. The worker's turn
  building folds turns < 0.4 s into neighbours, so the smallest of them disappear from the result.
- Five inputs is a small set and the threshold was tuned on it; treat the numbers as a ranking, not a guarantee.

## Speed and memory (4 pinned CPUs)

Real-time factor = wall time / audio duration, including model load. Measured during the sweep, with ten 4-CPU jobs
running side by side on the host, so these are upper bounds (one job alone on 4 cores ran the 30 s sample at RTF 0.13).

| Model | median RTF (inputs ≥ 200 s) | peak RSS (largest input) |
|---|---|---|
| TitaNet-S | 0.157 | 578 MB |
| CAM++ | 0.150 | 364 MB |
| ResNet34-LM | 0.261 | 387 MB |
| ERes2Net | 0.277 | 569 MB |

2 h (7,200 s, the upload cap) with TitaNet-S @ 1.0 on 4 pinned cores: see "2 h run" below.

## 2 h run

A 7,200 s file (the four long inputs above concatenated and repeated; 16 distinct real speakers), TitaNet-S @ 1.0,
alone on cores 0–3: **wall 698 s (RTF 0.097), peak RSS 1,340 MB**. The CLI returned 22 labels; after the worker's
turn building, 21 speakers hold 743 turns (= Tinfoil requests) covering 6,892 s, and 9 speakers hold ≥ 5 % of it. Memory
grows with duration (the CLI holds the whole waveform and all embeddings), so 2 h is the worst case.

## Real speech vs. synthetic (TTS) voices

Speaker counts with the shipped TitaNet-S @ 1.0 on real two-person speech: `sample_2spk` (30 s) 2/2, `vc_mupzb_2spk`
(497 s) 3/2, and the 60 s VoxConverse clip in the end-to-end check 2/2. Real distinct speakers are separated.

The relay's test clip (the repo's espeak-ng `fixtures/alice.wav` + `fixtures/bob.wav`, 21.6 s) comes back as **one**
speaker at 1.0. Its two synthetic voices sit closer together than real speakers in TitaNet's embedding space:

| threshold | 1.0 (shipped) | 0.8 | 0.6 | 0.4 |
|---|---|---|---|---|
| alice+bob TTS, speakers | 1 | 2 | 2 | 2 |

Lowering the threshold to split them would over-split real recordings (TitaNet-S @ 0.8: 10 speakers on the 2-person
`mupzb`, 17 on the 5-person AMI meeting, mean DER 13.5 % instead of 7.9 %), so the threshold stays at 1.0; use real
speech, not TTS fixtures, to test diarization end to end. 1.0 is close to the edge for very short real clips:
`sample_2spk` merges to one speaker at 1.05.

## End-to-end check (local ptx-batch, real Tinfoil)

API + worker from this branch inside the emulated production image (Alpine, `/opt/sherpa-onnx`, TitaNet-S @ 1.0),
local Postgres, real `voxtral-small-24b` calls:

- AMI EN2001a 60 s clip (3 speakers, mp3), `diarize: true`: 3 speakers, 14 turns, 20 s end to end; turns read like
  the meeting ("Are they spoken numbers? …" / "Yeah." / "We have to probably cut that out.").
- VoxConverse 60 s clip (2 speakers, m4a), `diarize: true`: 2 speakers, 7 turns (interviewer / guest), 16 s.
- Same AMI clip, `diarize: false`, on this branch and on `main`: identical speakers, region timings and text; the
  only difference is the new `diarized: false` field.

## Decision

- **Ship TitaNet-S with `clusterThreshold` 1.0** (`src/uploads/diarize.ts`; Apache-2.0, like the runner-up). If a later
  data set shows it over-splitting, the next best is ERes2Net (Apache-2.0) @ 0.8, mean DER 11.7 %, worse on meetings.
- ~~Instance: tdx.large.~~ Superseded: ptx-batch stays on tdx.small and diarizes in windows (part 1).
- The image grows by ≈ 80 MB (`/opt/sherpa-onnx`: `diarize-window`, the sherpa-onnx C API library, onnxruntime, models,
  glibc runtime, licences).
