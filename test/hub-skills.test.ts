/**
 * Hub-scoped skill management: `/v1/hubs/{hub_id}/skills`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_HUB_SKILL_POLL_INTERVAL_MS,
  DEFAULT_HUB_SKILL_WAIT_TIMEOUT_MS,
  ThalovantApiError,
  ThalovantControlPlane,
  ThalovantTimeoutError,
  type HubSkillList,
  type HubSkillOperation,
} from "../src/index.js";

const WEATHER_ROW = {
  skill: "skill-weather",
  title: "Weather",
  marketplace_skill_id: "8d6f7c2e-1c1a-4f7e-9c0f-2b1a1c3d4e5f",
  package_name: "skill-weather",
  source_type: "catalog",
  install_source: "index",
  version: "latest",
  version_pin: null,
  installed_version: "1.1.0",
  observed_version: "1.1.0",
  previous_version: "1.0.0",
  latest_version: "1.2.0",
  available_version: "1.2.0",
  update_available: true,
  changelog: "Adds hourly forecasts.",
  active: true,
  state: "installed",
  operator_phase: "Ready",
  operator_message: null,
  operator_last_error: null,
  last_transition_at: "2026-09-09T12:00:00Z",
};

const LISTING = {
  hub_id: "hub-1",
  runtime_group_id: "rg-1",
  observed_at: "2026-09-09T12:00:05Z",
  source: "ovos-runtime-operator",
  operator_phase: "Ready",
  operator_message: null,
  data: [
    WEATHER_ROW,
    {
      skill: "skill-jokes",
      version: "0.3.0",
      installed_version: "0.3.0",
      latest_version: "0.3.0",
      update_available: false,
      active: false,
      state: "failed",
      operator_last_error: "pip install failed",
      last_transition_at: "2026-09-09T12:01:00Z",
    },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function operation(status: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "op-1",
    kind: "hub.skill.install",
    aggregate_type: "hub",
    aggregate_id: "hub-1",
    status,
    details: {},
    git_commit_sha: null,
    error_code: null,
    error_message: null,
    created_at: "2026-09-09T12:00:00Z",
    updated_at: "2026-09-09T12:00:01Z",
    committed_at: null,
    applied_at: null,
    ready_at: null,
    terminal_at: null,
    links: { self: "/v1/operations/op-1" },
    ...overrides,
  };
}

interface Recorded {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

interface Scripted {
  routes: Record<string, [number, unknown]>;
  operations?: Array<Record<string, unknown>>;
}

/** Route fetch to a script; operation reads pop the queue. Returns the recorded calls. */
function scriptFetch(script: Scripted): { requests: Recorded[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const requests: Recorded[] = [];
  const operations = [...(script.operations ?? [])];
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers.authorization, "Bearer token");
    const record: Recorded = { method, path: parsed.pathname };
    if (init?.body) record.body = JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push(record);
    if (method === "GET" && parsed.pathname === "/api/v1/operations/op-1") {
      const next = operations.shift();
      assert.ok(next, "unexpected operation read");
      return jsonResponse(200, next);
    }
    const scripted = script.routes[`${method} ${parsed.pathname}`];
    if (!scripted) throw new Error(`unexpected request ${method} ${parsed.pathname}`);
    return jsonResponse(scripted[0], scripted[1]);
  };
  return {
    requests,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function api(): ThalovantControlPlane {
  return new ThalovantControlPlane("https://dash.example.com/api", { accessToken: "token" });
}

/** A fake clock: `sleep` advances it, so the wait loop never really waits. */
function fakeClock(): { now: () => number; sleep: (ms: number) => void; elapsed: () => number } {
  let current = 0;
  return {
    now: () => current,
    sleep: (ms: number) => {
      current += ms;
    },
    elapsed: () => current,
  };
}

const ACCEPTED_INSTALL = {
  operation_id: "op-1",
  hub_id: "hub-1",
  runtime_group_id: "rg-1",
  skill: "skill-weather",
  version: "latest",
  previous_version: null,
  state: "installing",
};

test("hub skill defaults match the contract", () => {
  assert.equal(DEFAULT_HUB_SKILL_WAIT_TIMEOUT_MS, 120_000);
  assert.equal(DEFAULT_HUB_SKILL_POLL_INTERVAL_MS, 2_000);
});

test("listHubSkills parses the data envelope into a typed listing", async () => {
  const fetchScript = scriptFetch({ routes: { "GET /api/v1/hubs/hub-1/skills": [200, LISTING] } });
  try {
    const listing: HubSkillList = await api().listHubSkills("hub-1");
    assert.equal(listing.hub_id, "hub-1");
    assert.equal(listing.runtime_group_id, "rg-1");
    assert.equal(listing.observed_at, "2026-09-09T12:00:05Z");
    assert.equal(listing.source, "ovos-runtime-operator");
    assert.equal(listing.operator_phase, "Ready");
    assert.equal(listing.operator_message, null);
    assert.equal(listing.data.length, 2);
    const [weather, jokes] = listing.data;
    assert.deepEqual(weather, WEATHER_ROW);
    // Absent row fields come back as null / false / true, never undefined.
    assert.equal(jokes.state, "failed");
    assert.equal(jokes.title, null);
    assert.equal(jokes.marketplace_skill_id, null);
    assert.equal(jokes.previous_version, null);
    assert.equal(jokes.update_available, false);
    assert.equal(jokes.active, false);
    assert.equal(jokes.operator_last_error, "pip install failed");
    assert.equal(jokes.operator_phase, null);
    assert.equal(fetchScript.requests[0].body, undefined);
  } finally {
    fetchScript.restore();
  }
});

test("listHubSkills accepts an empty hub and defaults active to true", async () => {
  const fetchScript = scriptFetch({
    routes: {
      "GET /api/v1/hubs/hub-1/skills": [
        200,
        { hub_id: "hub-1", runtime_group_id: "rg-1", observed_at: null, source: "runtime-group-cache-empty", data: [] },
      ],
    },
  });
  try {
    const listing = await api().listHubSkills("hub-1");
    assert.deepEqual(listing.data, []);
    assert.equal(listing.observed_at, null);
    assert.equal(listing.operator_phase, null);
  } finally {
    fetchScript.restore();
  }
  const minimal = scriptFetch({
    routes: { "GET /api/v1/hubs/hub-1/skills": [200, { hub_id: "hub-1", data: [{ skill: "skill-x", state: "pending" }] }] },
  });
  try {
    const [row] = (await api().listHubSkills("hub-1")).data;
    assert.equal(row.active, true);
    assert.equal(row.update_available, false);
    assert.equal(row.installed_version, null);
  } finally {
    minimal.restore();
  }
});

test("listHubSkills rejects an envelope without a data array", async () => {
  for (const body of [{ hub_id: "hub-1", items: [] }, { hub_id: "hub-1", data: "nope" }]) {
    const fetchScript = scriptFetch({ routes: { "GET /api/v1/hubs/hub-1/skills": [200, body] } });
    try {
      await assert.rejects(api().listHubSkills("hub-1"), (error: unknown) => {
        assert.ok(error instanceof ThalovantApiError);
        assert.match(error.message, /unexpected hub skill listing shape/);
        return true;
      });
    } finally {
      fetchScript.restore();
    }
  }
});

test("installHubSkill sends latest by default and returns the acceptance", async () => {
  const fetchScript = scriptFetch({ routes: { "POST /api/v1/hubs/hub-1/skills": [202, ACCEPTED_INSTALL] } });
  try {
    const result: HubSkillOperation = await api().installHubSkill("hub-1", "skill-weather");
    assert.deepEqual(result, {
      operation_id: "op-1",
      hub_id: "hub-1",
      runtime_group_id: "rg-1",
      skill: "skill-weather",
      version: "latest",
      previous_version: null,
      state: "installing",
    });
    assert.equal(result.operation, undefined);
    assert.deepEqual(fetchScript.requests, [
      { method: "POST", path: "/api/v1/hubs/hub-1/skills", body: { skill: "skill-weather", version: "latest" } },
    ]);
  } finally {
    fetchScript.restore();
  }
});

test("installHubSkill sends an exact version and reports the previous one", async () => {
  const fetchScript = scriptFetch({
    routes: { "POST /api/v1/hubs/hub-1/skills": [202, { ...ACCEPTED_INSTALL, version: "1.2.0", previous_version: "1.1.0" }] },
  });
  try {
    const result = await api().installHubSkill("hub-1", "skill-weather", { version: "1.2.0" });
    assert.equal(result.version, "1.2.0");
    assert.equal(result.previous_version, "1.1.0");
    assert.deepEqual(fetchScript.requests[0].body, { skill: "skill-weather", version: "1.2.0" });
  } finally {
    fetchScript.restore();
  }
});

test("installHubSkill waits until the operation is ready", async () => {
  const clock = fakeClock();
  const fetchScript = scriptFetch({
    routes: { "POST /api/v1/hubs/hub-1/skills": [202, ACCEPTED_INSTALL] },
    operations: [operation("requested"), operation("applied"), operation("ready", { ready_at: "2026-09-09T12:00:15Z" })],
  });
  try {
    const result = await api().installHubSkill("hub-1", "skill-weather", { wait: true, ...clock });
    assert.equal(result.state, "installed");
    assert.equal(result.operation_id, "op-1");
    assert.equal(result.hub_id, "hub-1");
    assert.equal(result.operation?.status, "ready");
    assert.equal(result.operation?.ready_at, "2026-09-09T12:00:15Z");
    const reads = fetchScript.requests.filter((request) => request.path === "/api/v1/operations/op-1");
    assert.equal(reads.length, 3);
    // Two polls apart at the 2 s interval.
    assert.equal(clock.elapsed(), 4_000);
  } finally {
    fetchScript.restore();
  }
});

test("updateHubSkill patches the version, requires it, and waits", async () => {
  const clock = fakeClock();
  const fetchScript = scriptFetch({
    routes: {
      "PATCH /api/v1/hubs/hub-1/skills/skill-weather": [
        202,
        { ...ACCEPTED_INSTALL, version: "1.2.0", previous_version: "1.1.0", state: "updating" },
      ],
    },
    operations: [operation("ready")],
  });
  try {
    const accepted = await api().updateHubSkill("hub-1", "skill-weather", { version: "1.2.0" });
    assert.equal(accepted.state, "updating");
    assert.equal(accepted.previous_version, "1.1.0");
    assert.deepEqual(fetchScript.requests[0], {
      method: "PATCH",
      path: "/api/v1/hubs/hub-1/skills/skill-weather",
      body: { version: "1.2.0" },
    });

    const waited = await api().updateHubSkill("hub-1", "skill-weather", { version: "1.2.0", wait: true, ...clock });
    assert.equal(waited.state, "installed");
    assert.equal(waited.version, "1.2.0");

    await assert.rejects(
      api().updateHubSkill("hub-1", "skill-weather", { version: "" }),
      /updateHubSkill requires a version/,
    );
    // The rejected call never reached the network.
    assert.equal(fetchScript.requests.filter((request) => request.method === "PATCH").length, 2);
  } finally {
    fetchScript.restore();
  }
});

test("removeHubSkill deletes without a body and converges on removed", async () => {
  const clock = fakeClock();
  const fetchScript = scriptFetch({
    routes: {
      "DELETE /api/v1/hubs/hub-1/skills/skill-weather": [
        202,
        { ...ACCEPTED_INSTALL, version: null, previous_version: "1.1.0", state: "removing" },
      ],
    },
    operations: [operation("ready")],
  });
  try {
    const accepted = await api().removeHubSkill("hub-1", "skill-weather");
    assert.equal(accepted.state, "removing");
    assert.equal(accepted.version, null);
    assert.equal(accepted.previous_version, "1.1.0");
    assert.equal(fetchScript.requests[0].body, undefined);

    const waited = await api().removeHubSkill("hub-1", "skill-weather", { wait: true, ...clock });
    assert.equal(waited.state, "removed");
    assert.equal(waited.operation?.status, "ready");
  } finally {
    fetchScript.restore();
  }
});

test("hub and skill path segments are URL-encoded", async () => {
  const fetchScript = scriptFetch({
    routes: {
      "DELETE /api/v1/hubs/hub%2F1/skills/skill%20weather%2Fx": [
        202,
        { ...ACCEPTED_INSTALL, skill: "skill weather/x", version: null, state: "removing" },
      ],
    },
  });
  try {
    await api().removeHubSkill("hub/1", "skill weather/x");
    assert.equal(fetchScript.requests.length, 1);
  } finally {
    fetchScript.restore();
  }
});

test("wait rejects with the operation error message on failure", async () => {
  const clock = fakeClock();
  const fetchScript = scriptFetch({
    routes: { "POST /api/v1/hubs/hub-1/skills": [202, ACCEPTED_INSTALL] },
    operations: [operation("failed", { error_code: "install_failed", error_message: "pip install failed" })],
  });
  try {
    await assert.rejects(api().installHubSkill("hub-1", "skill-weather", { wait: true, ...clock }), (error: unknown) => {
      assert.ok(error instanceof ThalovantApiError);
      assert.match(error.message, /skill-weather failed: pip install failed/);
      return true;
    });
  } finally {
    fetchScript.restore();
  }
});

test("wait falls back to the error code and then the status", async () => {
  const clock = fakeClock();
  const withCode = scriptFetch({
    routes: { "POST /api/v1/hubs/hub-1/skills": [202, ACCEPTED_INSTALL] },
    operations: [operation("timed_out", { error_code: "runtime_timeout" })],
  });
  try {
    await assert.rejects(api().installHubSkill("hub-1", "skill-weather", { wait: true, ...clock }), /failed: runtime_timeout/);
  } finally {
    withCode.restore();
  }
  const bare = scriptFetch({
    routes: { "POST /api/v1/hubs/hub-1/skills": [202, ACCEPTED_INSTALL] },
    operations: [operation("timed_out")],
  });
  try {
    await assert.rejects(
      api().installHubSkill("hub-1", "skill-weather", { wait: true, ...clock }),
      /ended with status timed_out/,
    );
  } finally {
    bare.restore();
  }
});

test("wait times out with a typed error", async () => {
  const clock = fakeClock();
  const fetchScript = scriptFetch({
    routes: { "POST /api/v1/hubs/hub-1/skills": [202, ACCEPTED_INSTALL] },
    operations: Array.from({ length: 10 }, () => operation("requested")),
  });
  try {
    await assert.rejects(
      api().installHubSkill("hub-1", "skill-weather", { wait: true, timeoutMs: 5_000, ...clock }),
      (error: unknown) => {
        assert.ok(error instanceof ThalovantTimeoutError);
        assert.match(error.message, /Timed out after 5000ms/);
        return true;
      },
    );
    // 0 s, 2 s, 4 s, then the 1 s remainder: four reads, never a fifth.
    const reads = fetchScript.requests.filter((request) => request.path === "/api/v1/operations/op-1");
    assert.equal(reads.length, 4);
    assert.equal(clock.elapsed(), 5_000);
  } finally {
    fetchScript.restore();
  }
});

test("problem codes from the hub skill routes are kept in the error message", async () => {
  const conflict = scriptFetch({
    routes: {
      "POST /api/v1/hubs/hub-1/skills": [
        409,
        {
          type: "about:blank",
          title: "Conflict",
          status: 409,
          code: "skill_version_already_installed",
          message: "Skill version already installed.",
        },
      ],
    },
  });
  try {
    await assert.rejects(
      api().installHubSkill("hub-1", "skill-weather", { version: "1.2.0" }),
      /Thalovant API request failed with HTTP 409: Skill version already installed\. \(skill_version_already_installed\)$/,
    );
  } finally {
    conflict.restore();
  }
  const noGroup = scriptFetch({
    routes: {
      "POST /api/v1/hubs/hub-1/skills": [
        404,
        { status: 404, code: "hub_without_runtime_group", message: "Hub has no runtime group." },
      ],
    },
  });
  try {
    await assert.rejects(
      api().installHubSkill("hub-1", "skill-weather"),
      /HTTP 404: Hub has no runtime group\. \(hub_without_runtime_group\)/,
    );
  } finally {
    noGroup.restore();
  }
  // A plain 404 (unknown hub, or a skill that is not installed) carries no code.
  const plain = scriptFetch({ routes: { "DELETE /api/v1/hubs/hub-1/skills/skill-weather": [404, { detail: "Not Found" }] } });
  try {
    await assert.rejects(api().removeHubSkill("hub-1", "skill-weather"), /Thalovant API request failed with HTTP 404: Not Found$/);
  } finally {
    plain.restore();
  }
  const invalid = scriptFetch({
    routes: { "PATCH /api/v1/hubs/hub-1/skills/skill-weather": [422, { code: "invalid_version", message: "Version 'x' is not valid." }] },
  });
  try {
    await assert.rejects(
      api().updateHubSkill("hub-1", "skill-weather", { version: "x" }),
      /HTTP 422: Version 'x' is not valid\. \(invalid_version\)/,
    );
  } finally {
    invalid.restore();
  }
  const scope = scriptFetch({ routes: { "GET /api/v1/hubs/hub-1/skills": [403, { detail: "Insufficient scopes" }] } });
  try {
    await assert.rejects(api().listHubSkills("hub-1"), /HTTP 403: Insufficient scopes/);
  } finally {
    scope.restore();
  }
});

test("an accepted body must carry an operation id", async () => {
  const fetchScript = scriptFetch({
    routes: { "POST /api/v1/hubs/hub-1/skills": [202, { skill: "skill-weather", state: "installing" }] },
  });
  try {
    await assert.rejects(api().installHubSkill("hub-1", "skill-weather"), /missing operation_id/);
  } finally {
    fetchScript.restore();
  }
});
