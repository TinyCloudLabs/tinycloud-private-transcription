# Batch speaker diarization benchmark (TC-595)

Gate for the `diarize: true` stage of the batch worker: which sherpa-onnx speaker-embedding model and clustering
threshold to ship, and whether `tdx.large` (4 vCPU, 8 GB) is enough. Measured 2026-10-03.

## Setup

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
- **Instance: tdx.large is enough.** Diarization is CPU-bound at roughly 0.1–0.16 × real time on 4 cores and runs once
  per job, before the (sequential) Tinfoil calls; peak memory (1.3 GB for a 2 h upload) stays well under the 8 GB of tdx.large next to Postgres,
  the api and ffmpeg. tdx.xlarge would only shorten the diarization step (the worker uses at most 4 threads) and is
  not needed. A CVM vCPU may be a hyperthread rather than a core, so expect up to ~2× the RTF above on tdx.large.
- The image grows by ≈ 80 MB (`/opt/sherpa-onnx`: CLI, onnxruntime, models, glibc runtime, licences).
