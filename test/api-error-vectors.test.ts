/**
 * What a control-plane error carries, against the vectors every SDK shares.
 *
 * `contracts/conformance/api-error-vectors.json` in the Python SDK, vendored
 * here unchanged and pinned by the parity contract. The API answers a refusal
 * with a Problem+JSON body whose structured fields say what to do next -- the
 * images a caller may pin instead, the plan's numbers -- and a message cut at
 * 160 characters is not where anybody can read them. Each case is served by a
 * real loopback HTTP peer and read back through the public control plane, so
 * what is recorded is what a caller gets.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { inspect } from "node:util";

import { ThalovantApiError, ThalovantControlPlane } from "../src/index.js";
import { record } from "./conformance-record.js";

interface VectorResponse {
  status: number;
  content_type: string;
  body: string;
}

interface VectorCase {
  name: string;
  response: VectorResponse;
  expect: { status: number; code: string | null; detail: string | null; problem: Record<string, unknown> | null };
  message_excludes?: string[];
}

function loadVectors(name: string): { cases: VectorCase[] } {
  return JSON.parse(readFileSync(new URL(`../../test/${name}`, import.meta.url), "utf8"));
}
const VECTORS = loadVectors("api-error-vectors.json");

async function serving<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (url: string) => Promise<T>,
): Promise<T> {
  const http = createServer(handler);
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${(http.address() as AddressInfo).port}`);
  } finally {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(error => (error ? reject(error) : resolve())));
  }
}

/** A loopback API that answers every request with `response`, byte for byte. */
function answering(response: VectorResponse) {
  const body = Buffer.from(response.body, "utf8");
  return (_request: IncomingMessage, reply: ServerResponse) => {
    reply.writeHead(response.status, { "content-type": response.content_type, "content-length": String(body.length) });
    reply.end(body);
  };
}

async function refusal(response: VectorResponse): Promise<ThalovantApiError> {
  return serving(answering(response), async url => {
    const api = new ThalovantControlPlane(url, { accessToken: "synthetic-token" });
    try {
      await api.getHub("hub-1");
    } catch (error) {
      assert.ok(error instanceof ThalovantApiError, String(error));
      return error;
    }
    assert.fail("getHub() resolved on an error status");
  });
}

/** Every form of the error a caller could print or log. */
function printedForms(error: ThalovantApiError): string[] {
  return [error.message, String(error), inspect(error), JSON.stringify(error), error.stack ?? ""];
}

for (const vector of VECTORS.cases) {
  test(`api error: ${vector.name}`, async () => {
    const error = await refusal(vector.response);
    const produced = {
      status: error.statusCode ?? null,
      code: error.code ?? null,
      detail: error.detail ?? null,
      problem: error.problem ?? null,
    };
    // Recorded before the assert: the record is what this SDK produced, not a
    // restatement of what the vector says it should have.
    record("api-error-vectors.json", vector.name, produced);
    assert.deepEqual(produced, vector.expect);
    for (const echoed of vector.message_excludes ?? []) {
      for (const form of printedForms(error)) {
        assert.ok(!form.includes(echoed), `${JSON.stringify(echoed)} reached ${JSON.stringify(form)}`);
      }
    }
  });
}

test("the message may be shortened but the detail never is", async () => {
  const vector = VECTORS.cases.find(item => item.expect.code === "platform_image_required");
  assert.ok(vector);
  const error = await refusal(vector.response);
  // The display line is what it always was: one bounded line, with the code.
  assert.ok(error.message.startsWith("Thalovant API request failed with HTTP 403: Only an administrator"), error.message);
  assert.ok(error.message.endsWith("… (platform_image_required)"), error.message);
  // The sentence the API wrote is whole, and every list it sent is there.
  assert.equal(error.detail, vector.expect.detail);
  assert.ok((error.detail ?? "").length > 160);
  assert.ok(!error.message.includes(error.detail ?? ""));
  assert.ok(error.problem);
  assert.deepEqual(error.problem.allowed_images, {
    bus: [
      "ghcr.io/thalovant/ovos-messagebus:2026.08.7",
      "ghcr.io/thalovant/ovos-messagebus:2026.09.2",
      "ghcr.io/thalovant/ovos-messagebus:2026.09.3-alpha.1",
    ],
    core: ["ghcr.io/thalovant/ovos-core:2026.09.2", "ghcr.io/thalovant/ovos-core:2026.09.3-alpha.1"],
  });
  assert.deepEqual(error.problem.allowed_repositories, { core: "ghcr.io/thalovant/ovos-core" });
  assert.deepEqual(error.problem.refused_images, {
    bus: "docker.io/example/ovos-messagebus:custom",
    core: "docker.io/example/ovos-core:custom",
  });
});

test("problem is readable but never printed with the error", async () => {
  const vector = VECTORS.cases.find(item => item.message_excludes?.length && item.expect.problem?.errors);
  assert.ok(vector);
  const error = await refusal(vector.response);
  assert.deepEqual(error.problem, vector.expect.problem);
  assert.ok(!Object.keys(error).includes("problem"));
  assert.equal(Object.getOwnPropertyDescriptor(error, "problem")?.enumerable, false);
  // Neither enumerable nor writable: an assignment cannot bring it back into a log.
  assert.throws(() => {
    (error as { problem?: unknown }).problem = { leaked: true };
  }, TypeError);
  assert.deepEqual(error.problem, vector.expect.problem);
  // The fields a log does show are the ones that are safe to.
  assert.deepEqual(JSON.parse(JSON.stringify(error)), { statusCode: 422, detail: "Request validation failed" });
});

test("a device sign-in poll that fails carries what the API said", async () => {
  const problem = {
    type: "about:blank",
    title: "HTTPException",
    status: 403,
    detail: "Free plan allows up to 1 connection.",
    code: "plan_limit",
    resource: "client",
    limit: 1,
    used: 1,
    plan: "Free",
  };
  const error = await serving(
    (request, response) => {
      if (request.url === "/v1/auth/device/authorize") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          device_code: "device-code-1",
          user_code: "ABCD-EFGH",
          verification_uri: "https://dash.example.invalid/device",
          interval: 0,
        }));
        return;
      }
      response.writeHead(403, { "content-type": "application/problem+json" });
      response.end(JSON.stringify(problem));
    },
    async url => {
      const api = new ThalovantControlPlane(url);
      try {
        await api.loginWithBrowser({ openBrowser: false, prompt: () => {}, timeoutMs: 5000 });
      } catch (caught) {
        assert.ok(caught instanceof ThalovantApiError, String(caught));
        return caught;
      }
      assert.fail("loginWithBrowser() resolved on an error status");
    },
  );
  assert.equal(error.message, "Thalovant API request failed with HTTP 403: Free plan allows up to 1 connection. (plan_limit)");
  assert.equal(error.statusCode, 403);
  assert.equal(error.code, "plan_limit");
  assert.equal(error.detail, "Free plan allows up to 1 connection.");
  assert.deepEqual(error.problem, problem);
});

test("secrets the SDK generated and sent reach neither detail nor problem", async () => {
  const sent: { apiKey?: string; password?: string } = {};
  const error = await serving(
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const spec = JSON.parse(Buffer.concat(chunks).toString("utf8")).spec;
        sent.apiKey = spec.apiKey;
        sent.password = spec.password;
        // Worst case: the API echoes the generated credentials in its sentence
        // and in a structured member beside it.
        response.writeHead(400, { "content-type": "application/problem+json" });
        response.end(JSON.stringify({
          detail: `spec rejected: apiKey=${spec.apiKey} password=${spec.password}`,
          code: "invalid_spec",
          errors: [{ input: { apiKey: spec.apiKey, password: spec.password } }],
        }));
      });
    },
    async url => {
      const api = new ThalovantControlPlane(url, { accessToken: "synthetic-token" });
      try {
        await api.createClientIdentity({ id: "hub-1" }, { name: "kiosk" });
      } catch (caught) {
        assert.ok(caught instanceof ThalovantApiError, String(caught));
        return caught;
      }
      assert.fail("createClientIdentity() resolved on an error status");
    },
  );
  assert.ok((sent.apiKey ?? "").length >= 8 && (sent.password ?? "").length >= 8);
  assert.equal(error.code, "invalid_spec");
  assert.equal(error.detail, "spec rejected: apiKey=[redacted] password=[redacted]");
  assert.deepEqual(error.problem?.errors, [{ input: { apiKey: "[redacted]", password: "[redacted]" } }]);
  const everything = [...printedForms(error), JSON.stringify(error.problem), error.detail ?? ""];
  for (const secret of [sent.apiKey!, sent.password!]) {
    for (const form of everything) assert.ok(!form.includes(secret), "a generated secret reached the error");
  }
});

test("an error raised the old way still reads the old way", () => {
  let error = new ThalovantApiError("Missing Thalovant API access token.");
  assert.deepEqual([error.statusCode, error.code, error.detail, error.problem], [undefined, undefined, undefined, undefined]);
  assert.equal(error.message, "Missing Thalovant API access token.");
  assert.ok(error instanceof Error);

  error = new ThalovantApiError("conflict", { statusCode: 412 });
  assert.equal(error.statusCode, 412);
  assert.deepEqual([error.code, error.detail, error.problem], [undefined, undefined, undefined]);

  const cause = new ThalovantApiError("inner");
  error = new ThalovantApiError("outer", { cause });
  assert.equal(error.cause, cause);
  assert.equal(new ThalovantApiError().message, "");
});

test("a problem alone gives its code and detail, and an explicit one wins", () => {
  const problem = { detail: "Free plan allows up to 1 connection.", code: "plan_limit", limit: 1 };
  let error = new ThalovantApiError("refused", { statusCode: 403, problem });
  assert.deepEqual([error.code, error.detail], ["plan_limit", "Free plan allows up to 1 connection."]);
  assert.deepEqual(error.problem, problem);
  assert.notEqual(error.problem, problem, "the error keeps its own copy of what it was given");

  error = new ThalovantApiError("refused", { statusCode: 403, code: "other", detail: "said differently", problem });
  assert.deepEqual([error.code, error.detail], ["other", "said differently"]);

  // FastAPI's envelope, when the API's handler has not lifted it.
  error = new ThalovantApiError("refused", { problem: { detail: { code: "plan_limit", detail: "Free plan allows up to 1 connection." } } });
  assert.deepEqual([error.code, error.detail], ["plan_limit", "Free plan allows up to 1 connection."]);
});

test("the vectors cover every shape the rules name", () => {
  // A vector set that quietly lost its non-JSON or its nested case would still pass.
  const expects = VECTORS.cases.map(item => item.expect);
  assert.ok(expects.some(e => e.problem === null));
  assert.ok(expects.some(e => e.code && e.detail === null));
  assert.ok(expects.some(e => e.detail && e.code === null));
  assert.ok(expects.some(e => e.problem !== null && typeof e.problem.detail === "object" && !Array.isArray(e.problem.detail)));
  assert.ok(expects.some(e => e.problem !== null && Array.isArray(e.problem.detail)));
  assert.ok(expects.some(e => (e.detail ?? "").length > 256), "no detail longer than any SDK's message limit");
  assert.ok(expects.some(e => (e.detail ?? "").includes("\n")));
  assert.ok(VECTORS.cases.some(item => item.message_excludes?.length));
});
