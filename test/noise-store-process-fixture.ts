import { loadOrCreateNoiseKey, pinHubKey } from "../src/noise-store.js";

process.once("message", (mode) => {
  const work = mode === "key"
    ? loadOrCreateNoiseKey(process.argv[2]).then(key => ({ key: Buffer.from(key).toString("hex") }))
    : pinHubKey(process.argv[2], process.argv[3] ?? "process-peer", (process.argv[4] ?? "cd").repeat(32)).then(() => ({ result: "pinned" }));
  void work
    .then(result => process.send?.(result))
    .catch(() => process.send?.({ result: "failed" }));
});
process.send?.({ ready: true });
