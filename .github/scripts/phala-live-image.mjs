// TC-3490: prints the 40-hex commit of the api image a CVM runs now, read from its live app compose, so a deploy
// can gate on the migrations between that commit and the pinned one (scripts/migration-gate.ts deploy).
// Fails unless every IMAGE_REPO pin in the live compose names one and the same commit.
//
// Env: PHALA_CLOUD_API_KEY, PHALA_CVM_ID, IMAGE_REPO (e.g. ghcr.io/tinycloudlabs/tinycloud-private-transcription/api).

import { createClient, getCvmComposeFile } from "@phala/cloud";

const apiKey = process.env.PHALA_CLOUD_API_KEY;
const cvmId = process.env.PHALA_CVM_ID;
const repo = process.env.IMAGE_REPO;
if (!apiKey || !cvmId || !repo) {
  console.error("PHALA_CLOUD_API_KEY, PHALA_CVM_ID and IMAGE_REPO are required");
  process.exit(1);
}

const compose = await getCvmComposeFile(createClient({ apiKey }), { id: cvmId }, { schema: false });
const text = compose?.docker_compose_file;
if (typeof text !== "string" || text === "") {
  console.error(`could not read the live docker compose of CVM ${cvmId}`);
  process.exit(1);
}
const escaped = repo.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const pin = new RegExp(`^\\s+image:\\s*["']?${escaped}:([0-9a-f]{40})@sha256:[0-9a-f]{64}["']?\\s*$`, "gm");
const commits = [...new Set([...text.matchAll(pin)].map((m) => m[1]))];
if (commits.length !== 1) {
  console.error(`expected one ${repo} commit in the live compose of CVM ${cvmId}, found ${commits.length}`);
  process.exit(1);
}
console.log(commits[0]);
