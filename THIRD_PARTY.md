# Third-party components

This repository is licensed under the [TinyCloud Open Source License](./LICENSE.md). It depends on,
vendors, or generates the following third-party material, each under its own license.

| Component | Where | Version / pin | License |
|---|---|---|---|
| [Vexa](https://github.com/Vexa-ai/vexa) (meeting bots, WhisperLive, meeting API) | git submodule `infra/vexa/upstream`; images `vexaai/v012-*:v012`, `vexaai/vexa-bot:v012`; compose overlays in `infra/vexa/` | commit `e0b356d6de3f8322db45d3cb9d66282ae108bebf` (see `infra/vexa/UPSTREAM_PIN`) | Apache-2.0 |
| [docker-jitsi-meet](https://github.com/jitsi/docker-jitsi-meet) (local Jitsi for the capture rig) | `infra/jitsi/docker-compose.yml` copied verbatim; overrides in `infra/jitsi/docker-compose.override.yml` | `stable-11146-2` / `738058b44bc3029ea289bea180cd3838f702af8e` (see `infra/jitsi/UPSTREAM_PIN`) | Apache-2.0 |
| [faster-whisper-server](https://github.com/fedirz/faster-whisper-server) (CPU STT for the rig and the CVM; pulled as a container image, not vendored) | `infra/vexa/docker-compose.override.yml`, `infra/dstack/app-compose.yaml` | image tag as pinned in those files | MIT |
| [espeak-ng](https://github.com/espeak-ng/espeak-ng) | used only to *generate* `fixtures/alice.wav` (`scripts/make-fixture.sh`, voice `en-us+f2`); the binary is not shipped | Debian package at build time | GPL-3.0-or-later (tool); the generated WAV is our own test fixture |

Derived bot image: `infra/vexa/bot/Dockerfile` layers a locally generated dev CA certificate on top of the
unmodified upstream `vexaai/vexa-bot` image (no upstream sources are changed).

Runtime npm dependencies (Hono, drizzle-orm, ulid, Playwright, TypeScript, Bun types) are MIT/Apache-2.0
licensed; see `bun.lock` for exact versions.
