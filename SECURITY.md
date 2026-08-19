# Security Policy

TinyCloud Private Transcription sends meeting bots into calls, stores transcripts and API-key hashes in
Postgres, and (optionally) forwards recorded audio to a confidential-inference transcription provider.
Please report vulnerabilities privately.

## Reporting a Vulnerability

Email security reports to security@tinycloud.xyz, or use GitHub's private vulnerability reporting on this
repository ("Report a vulnerability" under the Security tab). Include:

- affected repository, commit, or release
- reproduction steps
- expected impact
- any proof-of-concept code or logs that help verify the issue

Do not open a public GitHub issue for suspected vulnerabilities. TinyCloud Labs will acknowledge valid
reports and coordinate remediation before public disclosure.

## Scope

In scope:

- transcript or recording disclosure, or authorization bypasses between projects / API keys
- webhook signature, idempotency, or session handling bugs that expose or forge data
- leakage of upstream (Vexa / transcription-provider) credentials from the API or CVM
- attestation or TEE boundary issues in the dstack deployment
- supply-chain or build configuration issues that affect released images

Out of scope:

- social engineering
- denial-of-service without a data exposure or authorization impact
- issues in the local development rig (`infra/jitsi`, `infra/certs`) that require host access; its
  credentials and CA are throwaway by design
- reports that require access to a user's private keys, browser profile, or device without another vulnerability
