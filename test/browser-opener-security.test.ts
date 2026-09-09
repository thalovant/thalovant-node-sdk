import assert from "node:assert/strict";
import test from "node:test";
import { externalUrlCommand, openExternalUrl } from "../src/platform/node.js";

test("browser opener rejects non-web targets and embedded credentials before starting a process", async () => {
  for (const target of ["file:///tmp/payload", "javascript:alert(1)", "--execute", "https://user:secret@example.invalid", "not a URL"]) {
    for (const platform of ["win32", "darwin", "linux"]) assert.equal(externalUrlCommand(target, platform), undefined);
    assert.equal(await openExternalUrl(target), false);
  }
});

test("Windows verification URL remains one data argument and never enters cmd", () => {
  const url = 'https://example.invalid/activate?code=synthetic&value="&calc.exe&"';
  const invocation = externalUrlCommand(url, "win32");
  assert.deepEqual(invocation, ["rundll32.exe", ["url.dll,FileProtocolHandler", new URL(url).href]]);
  assert.equal(invocation?.[1].length, 2);
  assert.ok(!invocation?.flat().includes("cmd"));
  assert.deepEqual(externalUrlCommand(url, "darwin"), ["open", ["--", new URL(url).href]]);
  assert.deepEqual(externalUrlCommand(url, "linux"), ["xdg-open", [new URL(url).href]]);
});
