# Repository instructions

This repository owns the published Node.js and TypeScript client and agent SDK for supported Thalovant public API and HiveMind runtime contracts. Read the platform contracts in `../infra-manifests/docs/thalovant-platform/` when available.

Rules:

- Preserve compatibility with the documented Node.js and Thalovant API support window.
- Update types, implementation, examples, tests, changelog, version, and public documentation together for observable contract changes.
- Consume additive server behavior only after compatible server support exists.
- Never publish credentials, npm tokens, identity files, or generated secrets.
- Do not create a release for internal platform changes with no Node SDK impact; record `no SDK impact` in the coordinated change instead.
- Validate package contents and an install from npm before declaring a release complete.
- Update affected `docs.thalovant.com` SDK pages in the same release train.

Validate with `npm ci`, `npm test`, and `npm pack --dry-run`. A published release also requires a clean-project install of `@thalovant/sdk@<version>` from npm and an ESM import smoke test.

Rollback by moving the npm `latest` dist-tag to the last compatible version and deprecating the broken version, followed by a corrected patch release. Do not unpublish a version that consumers may already use.
