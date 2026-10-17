# ptx-batch CVM boot failure: SignCert timeout / stuck stopped

Applies to the production ptx-batch CVM (`cvm_OwmRYDj3`, Phala prod5); the same signature on other ptx CVMs should be treated the same way.

## Detection signature

Seen in the guest serial log (`phala` serial/console capture) of a failed boot, in this order:

```
dstack_util::system_setup: Requesting app keys from KMS: https://kms.dstack-pha-prod5.phala.network/prpc
dstack_util::system_setup: Requesting new client certificates
Error: Failed to request cert
    0: Failed to sign the CSR
    1: Failed to send request
    2: error sending request for url (https://kms.dstack-pha-prod5.phala.network/prpc/SignCert?json)
    3: client error (Connect)
    4: operation timed out
[FAILED] Failed to start dstack Guest Preparation Service.
```

Operational symptoms: the deploy step times out after the 300 s ready wait, `phala cvms get` shows `status=error` (or `stopped` after a retry) with zero containers from `phala ps`, and `/health` is unreachable. A match on `/prpc/SignCert` plus `operation timed out` is the signature; the CVM stuck `stopped` with no new guest boot after an update is the second form.

## First incident (2026-10-16, TC-959)

Two CI updates (runs 38834532880 and 38837498099) failed this way, and a direct update then left the CVM `stopped`. The drafted Phala support ticket was **not sent**: Sam decided on 2026-10-16 (18:48Z) to skip it for now. Drafted ticket and evidence: `tinycloud-dev/.context/incidents/tc-959-ptx-batch-boot-signcert/` (`phala-ticket.md`, `timeline.md`, `serial.log`, `cvm-metadata.json`). RCA: private TC-959 comment 628f12be.

## Repeat-failure rule

If a ptx CVM boot fails the same way again (SignCert/certificate provisioning timeout on boot, or the CVM stuck `stopped`):

1. Do not retry updates blindly; keep admission drained and keep admission in `drain` until health is confirmed.
2. Prepare **one** Phala support ticket covering **both** incidents: start from `phala-ticket.md` in the evidence path above, and add the new incident's identifiers, UTC timeline and sanitized serial excerpt.
3. Put the ticket to Sam as a card (the usual card channel). Sam decides whether to send it; the 2026-10-16 skip does not carry over, so ask again.
4. **Do not send it unasked.**

Never include secret values, env contents or raw tokens in the ticket or evidence; names and public IDs only.
