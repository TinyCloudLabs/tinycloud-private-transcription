# Changelog

## Unreleased

- TC-1093: diarized batch jobs retain ordinary VAD fallback coverage even when quiet detection's peak gate misses or quiet mode is disabled. Known speaker turns remain intact; newly covered audio uses the existing conservative unknown/sliver attribution, without duplicate audio or requests over 30 seconds.
- Apply the existing floor-coverage bound to final diarized turns before persisting regions or calling the provider. Primary VAD coverage can repair diarizer omissions; an insufficient final union fails `processing_failed` instead of publishing a partial transcript. Result mode/fallback and drop metrics describe the selected mode and final coverage, and remain atomic with saved regions across re-claims.
- Retain deterministic short/fail-closed regressions and a manual public-AMI pre-deploy HTTP API/worker replay in `test/support/diarized-replay.ts`. The replay uses the shipped native diarizer and validates every dispatched WAV against captured worker PCM; its loopback provider returns deterministic text, so it does not measure ASR accuracy or hallucinations. The short bypass existed at both `7e54bcd2` and #105; this is not a claim that #105 caused it.
