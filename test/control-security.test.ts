import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ThalovantApiError, ThalovantControlPlane } from "../src/index.js";

async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const http = createServer(handler);
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())) };
}

for (const status of [301, 302, 303, 307, 308]) {
  for (const auth of ["bearer", "password"] as const) {
    test(`control-plane ${auth} refuses ${status} redirect without contacting its target`, async () => {
      let received = 0;
      const target = await server((_request, response) => { received += 1; response.end("{}"); });
      const requests: { authorization?: string; body: string }[] = [];
      const origin = await server((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", chunk => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          requests.push({ authorization: request.headers.authorization, body: Buffer.concat(chunks).toString() });
          response.writeHead(status, { Location: target.url + "/credentials" });
          response.end();
        });
      });
      try {
        const api = new ThalovantControlPlane(origin.url, { accessToken: auth === "bearer" ? "synthetic-token" : undefined });
        await assert.rejects(auth === "bearer" ? api.listHubs() : api.login("synthetic@example.invalid", "synthetic-password"));
        assert.equal(requests.length, 1);
        if (auth === "bearer") assert.equal(requests[0].authorization, "Bearer synthetic-token");
        else assert.equal(JSON.parse(requests[0].body).password, "synthetic-password");
        assert.equal(received, 0, "redirect target must receive neither body nor headers");
      } finally {
        await origin.close();
        await target.close();
      }
    });
  }
}

test("credential-bearing non-TLS origins are rejected before fetch; explicit loopback and HTTPS work", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ access_token: "synthetic-token", hubs: [] }), { headers: { "content-type": "application/json" } });
  };
  try {
    for (const url of ["http://example.invalid", "http://localhost.example.invalid", "ftp://127.0.0.1", "https://user:synthetic-password@example.invalid"]) {
      await assert.rejects(new ThalovantControlPlane(url, { accessToken: "synthetic-token" }).listHubs(), ThalovantApiError);
      await assert.rejects(new ThalovantControlPlane(url).login("synthetic@example.invalid", "synthetic-password"), ThalovantApiError);
    }
    assert.equal(calls.length, 0);
    for (const url of ["https://custom.example.invalid", "http://localhost", "http://127.0.0.1", "http://[::1]"]) {
      await new ThalovantControlPlane(url, { accessToken: "synthetic-token" }).listHubs();
      await new ThalovantControlPlane(url).login("synthetic@example.invalid", "synthetic-password");
    }
    assert.equal(calls.length, 8);
    assert.ok(calls.every(call => call.init?.redirect === "error"));
  } finally {
    globalThis.fetch = original;
  }
});
