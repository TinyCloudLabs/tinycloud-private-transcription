# Third-party components

This repository is licensed under the [TinyCloud Open Source License](./LICENSE.md). It depends on,
vendors, or generates the following third-party material, each under its own license.

| Component | Where | Version / pin | License |
|---|---|---|---|
| [Vexa](https://github.com/Vexa-ai/vexa) (meeting bots, WhisperLive, meeting API) — via **our fork [TinyCloudLabs/vexa](https://github.com/TinyCloudLabs/vexa)**, branch `tinycloud` | git submodule `infra/vexa/upstream`; control-plane images `vexaai/v012-*:v012` (upstream, unmodified); bot image `ghcr.io/tinycloudlabs/vexa/bot:tc-*` (fork build); compose overlays in `infra/vexa/` | fork commit `2db950be784c843adc1e5408e5b2b2080909cd1b` on upstream base `e0b356d6` (see `infra/vexa/UPSTREAM_PIN`) | Apache-2.0 |
| [docker-jitsi-meet](https://github.com/jitsi/docker-jitsi-meet) (local Jitsi for the capture rig) | `infra/jitsi/docker-compose.yml` copied verbatim; overrides in `infra/jitsi/docker-compose.override.yml` | `stable-11146-2` / `738058b44bc3029ea289bea180cd3838f702af8e` (see `infra/jitsi/UPSTREAM_PIN`) | Apache-2.0 |
| [faster-whisper-server](https://github.com/fedirz/faster-whisper-server) (CPU STT for the rig and the CVM; pulled as a container image, not vendored) | `infra/vexa/docker-compose.override.yml`, `infra/dstack/app-compose.yaml` | image tag as pinned in those files | MIT |
| [espeak-ng](https://github.com/espeak-ng/espeak-ng) | used only to *generate* `fixtures/alice.wav` (`scripts/make-fixture.sh`, voice `en-us+f2`); the binary is not shipped | Debian package at build time | GPL-3.0-or-later (tool); the generated WAV is our own test fixture |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) `sherpa-onnx-offline-speaker-diarization` CLI (batch speaker diarization, TC-595) | downloaded into the api image's `/opt/sherpa-onnx` by the `Dockerfile` (sha256-verified; not vendored) | release `v1.13.8`, `sherpa-onnx-v1.13.8-linux-x64-shared-no-tts.tar.bz2` | Apache-2.0 (licence text shipped in `/opt/sherpa-onnx/licenses`) |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) (`libonnxruntime.so` from that sherpa-onnx release) | `/opt/sherpa-onnx/lib` | 1.28.2 | MIT (+ its ThirdPartyNotices, shipped) |
| [pyannote segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0) (ONNX export redistributed by sherpa-onnx) | `/opt/sherpa-onnx/models/segmentation.onnx` | `sherpa-onnx-pyannote-segmentation-3-0.tar.bz2` sha256 `24615ee8…` | MIT (licence shipped) |
| [NVIDIA NeMo TitaNet-S](https://catalog.ngc.nvidia.com/orgs/nvidia/teams/nemo/models/titanet_small) speaker-embedding model (ONNX export redistributed by sherpa-onnx as `nemo_en_titanet_small.onnx`) | `/opt/sherpa-onnx/models/embedding.onnx` | sha256 `ad4a1802…` | Apache-2.0: the NGC model card (v1.19.0, "Licence") says the model is covered by the NeMo Toolkit licence; NeMo's `LICENSE` at tag `v1.19.0` is shipped as `NeMo.LICENSE`; unmodified |
| glibc, libstdc++, libgcc (runtime for the glibc-linked sherpa-onnx CLI on Alpine) | copied from `debian:bookworm-slim@sha256:3783cc01…` into `/opt/sherpa-onnx/glibc` | Debian 12 packages `libc6`, `libstdc++6`, `libgcc-s1` | LGPL-2.1-or-later (glibc), GPL-3.0 with GCC Runtime Library Exception (libstdc++/libgcc); Debian copyright files shipped; sources from Debian |

Modifications by TinyCloud (Apache-2.0 §4(b)): the fork's `tinycloud` branch changes
`core/meetings/modules/record-chunker` (dynamic recording tap — late-arriving audio tracks attach to the
recording) and adds a fork CI workflow; changed files carry change notices, and the upstream `LICENSE`
is preserved intact in the fork (upstream ships no NOTICE file). `main` on the fork tracks upstream with
no TinyCloud commits. Derived bot image: `infra/vexa/bot/Dockerfile` layers a locally generated dev CA
certificate on top of the fork's published bot image.

Runtime npm dependencies (Hono, drizzle-orm, ulid, Playwright, TypeScript, Bun types) are MIT/Apache-2.0
licensed; see `bun.lock` for exact versions.
