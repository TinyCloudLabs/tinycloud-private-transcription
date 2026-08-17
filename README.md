# tinycloud-private-transcription

Private meeting transcription API. See SPEC.md.

## Meeting-capture rig (step 1)
Local Vexa + Jitsi + fake participant, and the happy-path gate. See `infra/README.md` for bring-up and
`docs/vexa-findings.md` for the Vexa API shapes we observed. Gate: `bun run scripts/vexa-smoke.ts`.
