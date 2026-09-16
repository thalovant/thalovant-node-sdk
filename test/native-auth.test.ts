import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DEFAULT_NATIVE_SCOPES,
  beginNativeSignIn,
  challengeFor,
  codeFrom,
  isThalovantUrl,
  newVerifier,
  assertSecureTokenExchange,
  assertSafeDashboard,
} from "../src/native-auth.js";

/**
 * The authorization-code grant, which every client that needed it wrote for
 * itself until this existed. What is tested is what is a security bug when
 * wrong and looks fine when wrong.
 */

function query(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

test("the challenge is the S256 of the verifier, which is what the API checks", async () => {
  const begun = await beginNativeSignIn({ clientId: "thalovant-cli", redirectUri: "http://127.0.0.1:8765/" });
  const expected = createHash("sha256").update(begun.verifier, "ascii").digest("base64url");
  assert.equal(query(begun.authorizationUrl).get("code_challenge"), expected);
  assert.equal(await challengeFor(begun.verifier), expected);
});

test("the verifier never reaches the browser", async () => {
  const begun = await beginNativeSignIn({ clientId: "app", redirectUri: "app://auth" });
  assert.ok(!begun.authorizationUrl.includes(begun.verifier));
});

test("S256 is the only method offered, because plain is the weaker one", async () => {
  const begun = await beginNativeSignIn({ clientId: "app", redirectUri: "app://auth" });
  assert.equal(query(begun.authorizationUrl).get("code_challenge_method"), "S256");
});

test("every attempt gets its own verifier and state", async () => {
  const first = await beginNativeSignIn({ clientId: "app", redirectUri: "app://auth" });
  const second = await beginNativeSignIn({ clientId: "app", redirectUri: "app://auth" });
  assert.notEqual(first.verifier, second.verifier);
  assert.notEqual(first.state, second.state);
  assert.notEqual(newVerifier(), newVerifier());
});

test("the request carries what the authorize endpoint matches on", async () => {
  const begun = await beginNativeSignIn({
    clientId: "thalovant-cli",
    redirectUri: "http://127.0.0.1:8765/",
    scopes: ["hubs:read", "clients:write"],
  });
  const parameters = query(begun.authorizationUrl);
  assert.equal(parameters.get("client_id"), "thalovant-cli");
  assert.equal(parameters.get("redirect_uri"), "http://127.0.0.1:8765/");
  assert.equal(parameters.get("response_type"), "code");
  assert.equal(parameters.get("scope"), "hubs:read clients:write");
  assert.equal(parameters.get("state"), begun.state);
  assert.ok(begun.authorizationUrl.startsWith("https://dash.thalovant.com/authorize?"));
});

test("the default scopes are the three a free plan may mint", async () => {
  const begun = await beginNativeSignIn({ clientId: "app", redirectUri: "app://auth" });
  assert.equal(query(begun.authorizationUrl).get("scope"), DEFAULT_NATIVE_SCOPES.join(" "));
});

test("a redirect answering a different attempt is refused", async () => {
  const begun = await beginNativeSignIn({ clientId: "app", redirectUri: "app://auth" });
  assert.equal(codeFrom(begun, "app://auth?code=abc&state=somebody-elses"), null);
  assert.equal(codeFrom(begun, `app://auth?code=abc&state=${begun.state}`), "abc");
});

test("no code, or an error instead, is not success", async () => {
  const begun = await beginNativeSignIn({ clientId: "app", redirectUri: "app://auth" });
  assert.equal(codeFrom(begun, `app://auth?state=${begun.state}`), null);
  assert.equal(codeFrom(begun, `app://auth?code=&state=${begun.state}`), null);
  assert.equal(codeFrom(begun, `app://auth?error=access_denied&state=${begun.state}`), null);
  assert.equal(codeFrom(begun, "app://auth"), null);
});

test("a code with url-escaped characters survives the round trip", async () => {
  const begun = await beginNativeSignIn({ clientId: "app", redirectUri: "app://auth" });
  assert.equal(codeFrom(begun, `app://auth?code=a%2Bb%2Fc%3D&state=${begun.state}`), "a+b/c=");
});

test("an empty client or redirect is refused here rather than at the API", async () => {
  await assert.rejects(() => beginNativeSignIn({ clientId: "", redirectUri: "app://auth" }), TypeError);
  await assert.rejects(() => beginNativeSignIn({ clientId: "app", redirectUri: "   " }), TypeError);
});

test("a Thalovant URL is recognised by scheme and host, and nothing else is", async () => {
  assert.ok(isThalovantUrl("https://dash.thalovant.com/authorize?x=1"));
  assert.ok(isThalovantUrl("https://thalovant.com"));
  assert.ok(!isThalovantUrl("http://dash.thalovant.com"));
  // The one that matters: a lookalike host ending in the same letters.
  assert.ok(!isThalovantUrl("https://dash.thalovant.com.evil.test"));
  // A host that passes, reached through credentials that read as another.
  assert.ok(!isThalovantUrl("https://evil.test@dash.thalovant.com"));
  assert.ok(!isThalovantUrl("https://notthalovant.com"));
  assert.ok(!isThalovantUrl("nonsense"));
});

test("a refusal that also carries a code is still a refusal", async () => {
  // CodeRabbit caught this: checking only for a missing code accepted
  // `error=access_denied&code=...` and would have started an exchange on a
  // code the authorization server had just declined to issue.
  const begun = await beginNativeSignIn({ clientId: "app", redirectUri: "app://auth" });
  assert.equal(codeFrom(begun, `app://auth?error=access_denied&code=abc&state=${begun.state}`), null);
  assert.equal(codeFrom(begun, `app://auth?code=abc&error=server_error&state=${begun.state}`), null);
});

test("the token exchange refuses cleartext, and allows loopback", () => {
  assert.throws(() => assertSecureTokenExchange("http://control.example.test"), /cleartext/);
  // Loopback has no cleartext to observe, and is how the API is run locally.
  for (const local of ["http://localhost:8080", "http://127.0.0.1:8080", "https://api.thalovant.com"]) {
    assert.doesNotThrow(() => assertSecureTokenExchange(local));
  }
});

test("a callback arriving somewhere else is refused", async () => {
  // CodeRabbit: state proves the answer belongs to this request; it does not
  // prove it came back to the app that made it.
  const begun = await beginNativeSignIn({ clientId: "app", redirectUri: "app://auth" });
  assert.equal(codeFrom(begun, `app://auth?code=abc&state=${begun.state}`), "abc");
  assert.equal(codeFrom(begun, `app://elsewhere?code=abc&state=${begun.state}`), null);
  assert.equal(codeFrom(begun, `https://evil.test/auth?code=abc&state=${begun.state}`), null);
});

test("a dashboard that is not safe to hand the request to is refused", async () => {
  for (const bad of [
    "http://dash.example.test",
    "https://evil.test@dash.thalovant.com",
    "ftp://dash.thalovant.com",
    "nonsense",
    // A fragment puts every parameter somewhere a browser never sends.
    "https://dash.example.test#section",
    "https://dash.example.test?next=/x",
  ]) {
    assert.throws(() => assertSafeDashboard(bad), TypeError, bad);
    await assert.rejects(
      () => beginNativeSignIn({ clientId: "app", redirectUri: "app://auth", dashboardUrl: bad }),
      TypeError,
    );
  }
  // A self-hosted https dashboard is real, and loopback never leaves the machine.
  for (const good of ["https://dash.example.test", "http://localhost:9000", "http://127.0.0.1:9000"]) {
    assert.doesNotThrow(() => assertSafeDashboard(good));
  }
});

test("the token exchange is reachable and refuses a cleartext control plane", async () => {
  // CodeRabbit: completeNativeSignIn had no test caller at all.
  const { ThalovantControlPlane } = await import("../src/control.js");
  const plane = new ThalovantControlPlane("http://control.example.test");
  await assert.rejects(
    () => plane.completeNativeSignIn("code", "verifier", "app", "app://auth"),
    /cleartext/,
  );
  assert.equal(plane.accessToken, undefined);
});

test("the token exchange posts the code and verifier, unauthenticated, and keeps a bad token out", async () => {
  // CodeRabbit asked for the endpoint, the body, the absence of bearer auth,
  // and a malformed response leaving the stored token alone -- the last one
  // matters because a client that "succeeded" with an unusable token fails on
  // the next request instead of here.
  const { ThalovantControlPlane } = await import("../src/control.js");
  const original = globalThis.fetch;
  const seen: Array<{ url: string; init: RequestInit }> = [];
  let answer: unknown = { access_token: "issued" };
  globalThis.fetch = async (input: any, init: any) => {
    seen.push({ url: String(input), init });
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as any;
  };
  try {
    const plane = new ThalovantControlPlane("https://control.example.test");
    await plane.completeNativeSignIn("the-code", "the-verifier", "app", "app://auth");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://control.example.test/v1/auth/native/token");
    assert.equal(seen[0].init.method, "POST");
    assert.deepEqual(JSON.parse(String(seen[0].init.body)), {
      code: "the-code",
      code_verifier: "the-verifier",
      client_id: "app",
      redirect_uri: "app://auth",
    });
    const headers = new Headers(seen[0].init.headers as HeadersInit);
    assert.equal(headers.get("authorization"), null, "the exchange is what issues the token");
    assert.equal(plane.accessToken, "issued");

    // A response with no usable token must not replace the one already stored.
    for (const bad of [{}, { access_token: "" }, { access_token: 42 }, { access_token: null }]) {
      answer = bad;
      await assert.rejects(
        () => plane.completeNativeSignIn("the-code", "the-verifier", "app", "app://auth"),
        /access_token/,
        JSON.stringify(bad),
      );
      assert.equal(plane.accessToken, "issued", JSON.stringify(bad));
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("an error body echoing the code or the verifier never reaches the message", async () => {
  const { ThalovantControlPlane } = await import("../src/control.js");
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ detail: "bad code the-code with verifier the-verifier" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }) as any;
  try {
    const plane = new ThalovantControlPlane("https://control.example.test");
    await plane.completeNativeSignIn("the-code", "the-verifier", "app", "app://auth").then(
      () => assert.fail("expected a rejection"),
      (error: Error) => {
        assert.ok(!error.message.includes("the-code"), error.message);
        assert.ok(!error.message.includes("the-verifier"), error.message);
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});
