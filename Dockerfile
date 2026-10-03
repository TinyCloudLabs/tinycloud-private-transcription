# Speaker diarization for the batch worker (TC-595, docs/diarization-benchmark.md): the prebuilt sherpa-onnx CLI, the
# pyannote segmentation-3.0 model and the NVIDIA NeMo TitaNet-S embedding model, each sha256-verified. The CLI
# is linked against glibc and this image is Alpine (musl), so the glibc runtime it needs is copied from a pinned Debian
# image into /opt/sherpa-onnx/glibc, and /opt/sherpa-onnx/diarize runs the CLI through that loader. Nothing else uses it.
FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS diarization
WORKDIR /build
RUN set -eu; \
    release=https://github.com/k2-fsa/sherpa-onnx/releases/download; \
    wget -q -O sherpa-onnx.tar.bz2 "$release/v1.13.8/sherpa-onnx-v1.13.8-linux-x64-shared-no-tts.tar.bz2"; \
    wget -q -O segmentation.tar.bz2 "$release/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"; \
    wget -q -O embedding.onnx "$release/speaker-recongition-models/nemo_en_titanet_small.onnx"; \
    wget -q -O sherpa-onnx.LICENSE https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v1.13.8/LICENSE; \
    wget -q -O onnxruntime.LICENSE https://raw.githubusercontent.com/microsoft/onnxruntime/v1.28.2/LICENSE; \
    wget -q -O onnxruntime.ThirdPartyNotices.txt https://raw.githubusercontent.com/microsoft/onnxruntime/v1.28.2/ThirdPartyNotices.txt; \
    wget -q -O NeMo.LICENSE https://raw.githubusercontent.com/NVIDIA/NeMo/v1.19.0/LICENSE; \
    printf '%s  %s\n' \
      d0f96c8b65c6cd0974fada22737e337de81bc8cd2abbec2e39caf358b1eec5fc sherpa-onnx.tar.bz2 \
      24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488 segmentation.tar.bz2 \
      ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e embedding.onnx \
      cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 sherpa-onnx.LICENSE \
      2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c onnxruntime.LICENSE \
      0e07b95f3a8d6230037707c5c4a2b554d12c4cb67369669ac255635528ffcee2 onnxruntime.ThirdPartyNotices.txt \
      43070e2d4e532684de521b885f385d0841030efa2b1a20bafb76133a5e1379c1 NeMo.LICENSE \
      | sha256sum -c -; \
    tar -xjf sherpa-onnx.tar.bz2; \
    tar -xjf segmentation.tar.bz2; \
    mkdir -p /opt/sherpa-onnx/bin /opt/sherpa-onnx/lib /opt/sherpa-onnx/models /opt/sherpa-onnx/licenses; \
    cp sherpa-onnx-v1.13.8-linux-x64-shared-no-tts/bin/sherpa-onnx-offline-speaker-diarization /opt/sherpa-onnx/bin/; \
    cp sherpa-onnx-v1.13.8-linux-x64-shared-no-tts/lib/libonnxruntime.so /opt/sherpa-onnx/lib/; \
    cp sherpa-onnx-pyannote-segmentation-3-0/model.onnx /opt/sherpa-onnx/models/segmentation.onnx; \
    cp embedding.onnx /opt/sherpa-onnx/models/embedding.onnx; \
    cp sherpa-onnx-pyannote-segmentation-3-0/LICENSE /opt/sherpa-onnx/licenses/pyannote-segmentation-3.0.LICENSE; \
    cp ./*.LICENSE onnxruntime.ThirdPartyNotices.txt /opt/sherpa-onnx/licenses/; \
    printf '#!/bin/sh\nexec /opt/sherpa-onnx/glibc/ld-linux-x86-64.so.2 --library-path /opt/sherpa-onnx/glibc:/opt/sherpa-onnx/lib /opt/sherpa-onnx/bin/sherpa-onnx-offline-speaker-diarization "$@"\n' \
      > /opt/sherpa-onnx/diarize; \
    chmod 755 /opt/sherpa-onnx/diarize
COPY --from=debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 \
  /usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 /usr/lib/x86_64-linux-gnu/libc.so.6 /usr/lib/x86_64-linux-gnu/libm.so.6 \
  /usr/lib/x86_64-linux-gnu/libpthread.so.0 /usr/lib/x86_64-linux-gnu/libdl.so.2 /usr/lib/x86_64-linux-gnu/librt.so.1 \
  /usr/lib/x86_64-linux-gnu/libgcc_s.so.1 /opt/sherpa-onnx/glibc/
COPY --from=debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 \
  /usr/lib/x86_64-linux-gnu/libstdc++.so.6.0.30 /opt/sherpa-onnx/glibc/libstdc++.so.6
COPY --from=debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 \
  /usr/share/doc/libc6/copyright /opt/sherpa-onnx/licenses/glibc.copyright
COPY --from=debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 \
  /usr/share/doc/libstdc++6/copyright /opt/sherpa-onnx/licenses/libstdc++.copyright
COPY --from=debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 \
  /usr/share/doc/libgcc-s1/copyright /opt/sherpa-onnx/licenses/libgcc.copyright

FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS base
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY --from=diarization /opt/sherpa-onnx /opt/sherpa-onnx
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY drizzle.config.ts tsconfig.json ./
ENV NODE_ENV=production
# API by default; the worker service overrides CMD.
CMD ["bun", "run", "src/api/server.ts"]
