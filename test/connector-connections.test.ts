/**
 * Home bridges (`connection_type: connector`) and the refusals that came with
 * them. No shared vectors: these cases mirror the Python SDK's
 * tests/test_connector_connections.py. Each also holds for an API that does not
 * have the new fields yet.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  CONNECTION_TYPE_CONNECTOR,
  CONNECTION_TYPE_HOME_ASSISTANT,
  ConnectionProblemCode,
  ThalovantApiError,
  ThalovantConnectionTypeUnavailableError,
  ThalovantConnectorsInvalidError,
  ThalovantControlPlane,
  ThalovantCredentialsNotReplayedError,
  ThalovantHubScaleOutBreaksLinksError,
  ThalovantIdempotencyKeySpentError,
  ThalovantOwnerOnlyBesideLinkError,
  ThalovantPrivateHubOnlyError,
  ThalovantUnsupportedConnectionTypeError,
} from "../src/index.js";

type Json = Record<string, unknown>;
const HUB: Json = { id: "hub-1", name: "Home", domain: "home.example.com", wss_enabled: true, http_enabled: true };

interface Answer {
  status: number;
  body: Json;
  headers?: Record<string, string>;
}

/** A loopback API that answers every request with `answer`, recording the bodies. */
async function serving<T>(answer: Answer, run: (api: ThalovantControlPlane, sent: Json[]) => Promise<T>): Promise<T> {
  const sent: Json[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    sent.push(raw ? (JSON.parse(raw) as Json) : {});
    response.writeHead(answer.status, { "content-type": "application/json", ...(answer.headers ?? {}) });
    response.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const api = new ThalovantControlPlane(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { accessToken: "t" });
    return await run(api, sent);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function created(connectionType: string, extra: Json = {}, identify = true): Json {
  const body: Json = {
    id: "client-1",
    name: "Bridge",
    hub_id: "hub-1",
    spec: { version: "1", connection_type: connectionType },
    etag: "e1",
    ...extra,
  };
  if (identify) {
    body.initial_identify = {
      password: "platform-password",
      access_key: "platform-key",
      site_id: "bridge",
      default_port: 443,
      default_master: "wss://home.example.com",
    };
  }
  return body;
}

function problem(status: number, code: string, extra: Json = {}): Answer {
  return { status, body: { detail: "refused", code, ...extra } };
}

test("the kind constants are the wire values", () => {
  assert.equal(CONNECTION_TYPE_CONNECTOR, "connector");
  assert.equal(CONNECTION_TYPE_HOME_ASSISTANT, "home_assistant");
});

test("a bridge is created with its connector list and the platform's credentials", async () => {
  const serves = {
    devices: [{ id: "d1", name: "Kitchen", connection_type: "voice_satellite", active: true }],
    count: 1,
    warning: null,
  };
  await serving({ status: 201, body: created("connector", { serves }) }, async (api, sent) => {
    const result = await api.createClientIdentity(HUB, {
      name: "Bridge",
      connectionType: CONNECTION_TYPE_CONNECTOR,
      spec: { connectors: ["music_assistant"] },
    });
    const spec = sent[0].spec as Json;
    assert.equal(spec.connection_type, "connector");
    assert.deepEqual(spec.connectors, ["music_assistant"]);
    // The answer's credentials are the connection's; the ones minted locally are not.
    assert.equal(result.identity.accessKey, "platform-key");
    assert.equal(result.identity.password, "platform-password");
    assert.equal(result.connectionType, "connector");
    assert.equal(result.replayed, false);
    assert.deepEqual(result.serves, serves);
    assert.equal(result.servesWarning, null);
  });
});

test("a link that serves nobody says so", async () => {
  const serves = { devices: [], count: 0, warning: "No device of your account is on this hub." };
  await serving({ status: 201, body: created("home_assistant", { serves }) }, async (api) => {
    const result = await api.createClientIdentity(HUB, { name: "HA", connectionType: "home_assistant" });
    assert.equal(result.servesWarning, "No device of your account is on this hub.");
  });
});

test("an API without serves still works", async () => {
  await serving({ status: 201, body: created("connector") }, async (api) => {
    const result = await api.createClientIdentity(HUB, { name: "Bridge", connectionType: "connector" });
    assert.equal(result.serves, undefined);
    assert.equal(result.servesWarning, null);
  });
});

for (const [label, answer] of [
  ["header", { status: 201, body: created("connector", {}, false), headers: { "Idempotent-Replayed": "true" } }],
  [
    "marker",
    {
      status: 201,
      body: created("connector", { replay: { code: "idempotent_replay", credentials_included: false, detail: "x" } }, false),
    },
  ],
] as const) {
  test(`a replayed create (${label}) never hands back an identity the SDK made up`, async () => {
    await serving(answer as Answer, async (api) => {
      const error = await api
        .createClientIdentity(HUB, { name: "Bridge", connectionType: "connector", idempotencyKey: "k1" })
        .then(() => assert.fail("a replay returned an identity"), (caught: unknown) => caught);
      assert.ok(error instanceof ThalovantCredentialsNotReplayedError);
      assert.equal(error.clientId, "client-1");
      assert.ok(!("initial_identify" in error.client));
    });
  });
}

test("an answer without credentials that is not a replay keeps the old behaviour", async () => {
  await serving({ status: 201, body: created("connector", {}, false) }, async (api) => {
    const result = await api.createClientIdentity(HUB, { name: "Bridge", connectionType: "connector" });
    assert.ok(result.identity.accessKey);
  });
});

test("a link on another account's hub names the reason", async () => {
  await serving(problem(422, "connection_type_unavailable", { reason: "hub_operated_by_another_account" }), async (api, sent) => {
    const error = await api
      .createClientIdentity(HUB, { name: "HA", connectionType: "home_assistant" })
      .then(() => assert.fail("created"), (caught: unknown) => caught);
    assert.ok(error instanceof ThalovantConnectionTypeUnavailableError);
    assert.equal(error.reason, "hub_operated_by_another_account");
    assert.equal(error.code, ConnectionProblemCode.CONNECTION_TYPE_UNAVAILABLE);
    assert.ok(error instanceof ThalovantUnsupportedConnectionTypeError);
    assert.equal(sent.length, 1, "nothing to delete: the API made nothing");
  });
});

for (const code of ["connection_type_unknown", "connection_type_ambiguous"]) {
  test(`${code} is unsupported`, async () => {
    await serving(problem(422, code, { known: ["voice_satellite", "connector"] }), async (api) => {
      const error = await api
        .createClientIdentity(HUB, { name: "X", connectionType: "plex" })
        .then(() => assert.fail("created"), (caught: unknown) => caught);
      assert.ok(error instanceof ThalovantUnsupportedConnectionTypeError);
      assert.equal(error.code, code);
    });
  });
}

for (const reason of ["duplicate", "own_kind", "unknown_or_malformed"]) {
  test(`a refused connector list (${reason}) says why and what is known`, async () => {
    await serving(problem(422, "connectors_invalid", { reason, known: ["music_assistant"] }), async (api) => {
      const error = await api
        .createClientIdentity(HUB, {
          name: "Bridge",
          connectionType: "connector",
          spec: { connectors: ["music_assistant", "music_assistant"] },
        })
        .then(() => assert.fail("created"), (caught: unknown) => caught);
      assert.ok(error instanceof ThalovantConnectorsInvalidError);
      assert.equal(error.reason, reason);
      assert.deepEqual(error.known, ["music_assistant"]);
    });
  });
}

for (const code of [
  "device_owner_only_beside_home_link",
  "setup_session_owner_only_beside_home_link",
  "device_identity_owner_only_beside_home_link",
]) {
  test(`${code} names the link`, async () => {
    await serving(problem(403, code, { link_client_id: "client-9" }), async (api) => {
      const error = await api
        .createClientIdentity(HUB, { name: "Speaker", ownerId: "someone" })
        .then(() => assert.fail("created"), (caught: unknown) => caught);
      assert.ok(error instanceof ThalovantOwnerOnlyBesideLinkError);
      assert.equal(error.linkClientId, "client-9");
      assert.equal(error.statusCode, 403);
    });
  });
}

test("the other new codes are typed", async () => {
  const cases: Array<[Answer, new (...args: never[]) => Error]> = [
    [problem(409, "hub_scale_out_breaks_links", { links: 2 }), ThalovantHubScaleOutBreaksLinksError],
    [problem(409, "idempotency_key_spent"), ThalovantIdempotencyKeySpentError],
    [problem(422, "skill_config_private_hub_only", { settings: ["url", "token"] }), ThalovantPrivateHubOnlyError],
  ];
  for (const [answer, kind] of cases) {
    await serving(answer, async (api) => {
      const error = await api.createClientIdentity(HUB, { name: "X" }).then(() => assert.fail("created"), (caught: unknown) => caught);
      assert.ok(error instanceof kind);
      assert.equal((error as ThalovantApiError).code, answer.body.code);
      if (error instanceof ThalovantHubScaleOutBreaksLinksError) assert.equal(error.links, 2);
      if (error instanceof ThalovantPrivateHubOnlyError) assert.deepEqual(error.settings, ["url", "token"]);
    });
  }
});

test("a structured refusal inside detail is read too", async () => {
  const body = { detail: { code: "connectors_invalid", reason: "duplicate", known: ["music_assistant"] } };
  await serving({ status: 422, body }, async (api) => {
    const error = await api
      .createClientIdentity(HUB, { name: "Bridge", connectionType: "connector" })
      .then(() => assert.fail("created"), (caught: unknown) => caught);
    assert.ok(error instanceof ThalovantConnectorsInvalidError);
    assert.equal(error.reason, "duplicate");
  });
});

test("an unlisted code stays a plain API error", async () => {
  await serving(problem(409, "something_new"), async (api) => {
    const error = await api.createClientIdentity(HUB, { name: "X" }).then(() => assert.fail("created"), (caught: unknown) => caught);
    assert.ok(error instanceof ThalovantApiError);
    assert.equal(Object.getPrototypeOf(error), ThalovantApiError.prototype);
  });
});

test("a connectors refusal that names connection_type stays itself", async () => {
  const body = {
    detail: "Invalid connectors for connection_type connector",
    code: "connectors_invalid",
    reason: "duplicate",
    known: ["music_assistant"],
  };
  await serving({ status: 422, body }, async (api) => {
    const error = await api
      .createClientIdentity(HUB, { name: "Bridge", connectionType: "connector" })
      .then(() => assert.fail("created"), (caught: unknown) => caught);
    assert.ok(error instanceof ThalovantConnectorsInvalidError);
    assert.equal(error.reason, "duplicate");
    assert.deepEqual(error.known, ["music_assistant"]);
  });
});

test("the unknown-kind codes are unsupported on any call", async () => {
  for (const code of ["connection_type_unknown", "connection_type_ambiguous"]) {
    await serving(problem(422, code), async (api) => {
      const error = await api
        .createClient({ hub_id: "hub-1", name: "x", spec: {} })
        .then(() => assert.fail("created"), (caught: unknown) => caught);
      assert.ok(error instanceof ThalovantUnsupportedConnectionTypeError);
    });
  }
});
