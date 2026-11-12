import type { ThalovantEvent } from "./events.js";

export class ThalovantError extends Error {}
export class ThalovantIdentityError extends ThalovantError {}
export class ThalovantConnectionError extends ThalovantError {}
export class ThalovantTimeoutError extends ThalovantError {
  /**
   * A class has one parent, and a hub that has not admitted a connection yet
   * is two things at once: the connection is not usable, and waiting longer
   * may still succeed. {@link ThalovantAdmissionTimeoutError} extends
   * {@link ThalovantConnectionError} and answers `instanceof` for this class as
   * well, so a caller can catch it as either. Every other value is judged by
   * its prototype chain, as `instanceof` always does.
   */
  static [Symbol.hasInstance](value: unknown): boolean {
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    return this === ThalovantTimeoutError && Function.prototype[Symbol.hasInstance].call(ThalovantAdmissionTimeoutError, value);
  }
}
export class ThalovantRuntimeError extends ThalovantError {}

/**
 * A hub turned this connection's credentials away.
 *
 * A hub closes the socket without a status, with 1000, or with 1008 for an
 * access key it does not know, refuses the WebSocket upgrade with 401 or 403,
 * and aborts the Noise handshake for a wrong password. None of those clears up
 * on its own the way a dropped network does: the connection was deleted, its
 * secret changed, or -- for a connection created a moment ago -- its hub has
 * not admitted it yet. {@link HubSession.run} retries through refusals for a
 * grace period for that last reason, then gives up with this error.
 */
export class ThalovantHubRefusedError extends ThalovantConnectionError {}

/**
 * The hub refused this client's own Noise key: it pinned a different one.
 *
 * A hub pins the first static key a connection presents and refuses any other
 * for good, closing the link the moment the XX handshake that showed it ends.
 * Two programs that read the same identity but keep their keys in different
 * folders each present their own key, and whichever came second is locked out.
 * No handshake can recover from this, so {@link HubSession.run} stops on it at
 * once. It is a {@link ThalovantHubRefusedError}, so code that catches a
 * refusal still catches it.
 *
 * `keyFolder` is the folder this client's key is in, and `otherKeyFolder`,
 * when there is a likely one, where another program reading the same identity
 * keeps its key. Re-pair (a new connection pins afresh), or share the key
 * folder: point every program that reads this identity at the folder holding
 * the key the hub trusts (`noiseStateDir`).
 */
export class ThalovantClientKeyRejectedError extends ThalovantHubRefusedError {
  readonly keyFolder?: string;
  readonly otherKeyFolder?: string;

  constructor(message?: string, options?: { keyFolder?: string; otherKeyFolder?: string }) {
    super(message);
    this.keyFolder = options?.keyFolder;
    this.otherKeyFolder = options?.otherKeyFolder;
  }
}

/**
 * A hub answered with another Noise static key than the one pinned for it.
 *
 * The first connection to a hub pins its key; every later one must present
 * the same. A different one is either the hub being replaced or somebody in
 * between, and the SDK cannot tell which, so it never connects and never
 * replaces the pin by itself. It is a connection error rather than a refusal
 * -- the hub did not turn the credentials away -- and retrying changes
 * nothing: {@link HubSession.run} stops on it at once. Drop the pin with
 * `forgetNoisePin` only once the new key is known to be the hub's.
 */
export class ThalovantHubKeyChangedError extends ThalovantConnectionError {}

/**
 * A control-plane request failed.
 *
 * `statusCode` is the HTTP status when the API answered. Everything else the
 * API said rides beside the message rather than inside it:
 *
 * - `problem` is the whole error body, parsed, when it is a JSON object -- the
 *   Problem+JSON document every Thalovant API refusal is. A structured field
 *   the API adds is reachable here without a new SDK release:
 *   `refused_images`, `allowed_images` and `allowed_repositories` on a
 *   `platform_image_required` refusal, `resource`, `limit` and `used` on a
 *   `plan_limit` one.
 * - `code` is the body's machine-readable code, for branching without reading
 *   the prose.
 * - `detail` is the API's own sentence, whole, exactly as sent.
 * - `fields` names the settings or secrets a refusal is about
 *   (`bridge_settings_invalid`, `bridge_secrets_invalid`, `bridge_url_*`):
 *   their names, never their values. Empty when the API named none.
 *
 * The message is a single bounded line for display; it can be shortened, so it
 * is never where to read what the API said. A value the body echoed back from
 * the request never reaches the message, only `problem` -- which is why
 * `problem` is not enumerable: `console.log`, `util.inspect` and
 * `JSON.stringify` of the error leave it out, and `error.problem` still reads it.
 *
 * Passing `problem` alone derives `code`, `detail` and `fields` from it; an
 * explicit `code`, `detail` or `fields` wins. `code` and `detail` are
 * undefined, and `fields` empty, for a local failure, such as a missing token
 * or an unexpected response shape.
 */
export class ThalovantApiError extends ThalovantError {
  readonly statusCode?: number;
  /** The body's machine-readable code, such as `platform_image_required` or `plan_limit`. */
  readonly code?: string;
  /** The API's whole sentence, exactly as sent: never trimmed or shortened. */
  readonly detail?: string;
  /**
   * The names of the settings or secrets the refusal is about, as the API
   * listed them in the problem's `fields` (at its top, or inside a `detail`
   * object, as `code` is read). Only names, never values; strings only; empty
   * when the API named none.
   */
  readonly fields: readonly string[];
  /**
   * How long the API asked the caller to wait before trying again, in seconds,
   * when it said: a 429's `retry_after_seconds` (at the top of the problem or
   * inside its `detail` object), else its `Retry-After` or `RateLimit-Reset`
   * header. Undefined otherwise.
   */
  readonly retryAfterSeconds?: number;
  /**
   * The whole error body when it is a JSON object. Not enumerable, so logging
   * the error never prints what the body echoed back from the request.
   */
  declare readonly problem?: Record<string, unknown>;

  constructor(
    message?: string,
    options?: ErrorOptions & {
      statusCode?: number;
      code?: string;
      detail?: string;
      problem?: Record<string, unknown>;
      /** Seconds to wait, when the answer's headers said; the problem's own number wins. */
      retryAfterSeconds?: number;
      /** The setting or secret names the refusal is about. */
      fields?: readonly string[];
    },
  ) {
    super(message, options);
    this.statusCode = options?.statusCode;
    // The error keeps its own copy of what it was given. `problem` is declared,
    // not a class field: a field would be redefined as an enumerable own
    // property on top of this one (useDefineForClassFields).
    const problem = isRecord(options?.problem) ? { ...options.problem } : undefined;
    Object.defineProperty(this, "problem", { value: problem, enumerable: false, writable: false, configurable: false });
    const read = problemFields(problem);
    this.code = options?.code ?? read.code;
    this.detail = options?.detail ?? read.detail;
    this.fields = Object.freeze(options?.fields !== undefined ? fieldNames(options.fields) : problemFieldNames(problem));
    this.retryAfterSeconds = problemRetryAfter(problem) ?? options?.retryAfterSeconds;
  }
}

/** The strings of a `fields` list, in order; anything that is not a string is left out. */
function fieldNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * A problem's `fields`, at its top or inside a `detail` object: the API lifts
 * a structured refusal's members to the top, and FastAPI's own envelope keeps
 * them inside `detail`, as it does `code`.
 */
function problemFieldNames(problem: Record<string, unknown> | undefined): string[] {
  if (!problem) return [];
  const top = fieldNames(problem.fields);
  if (top.length) return top;
  return isRecord(problem.detail) ? fieldNames(problem.detail.fields) : [];
}

/**
 * A problem's `retry_after_seconds`, at its top or inside a `detail` object:
 * the API's per-token 429 is FastAPI's envelope around a structured refusal,
 * so the number sits inside `detail`, as `code` does.
 */
function problemRetryAfter(problem: Record<string, unknown> | undefined): number | undefined {
  if (!problem) return undefined;
  for (const source of [problem, isRecord(problem.detail) ? problem.detail : {}]) {
    const value = source.retry_after_seconds;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

/**
 * The control-plane API could not be reached: the request never got an
 * answer (a refused connection, a failed name lookup, a reset, a redirect the
 * SDK will not follow). That says nothing about what the API would have
 * answered, so a wait that meets it reports it as it is rather than as the
 * API refusing anything. `statusCode` is undefined.
 */
export class ThalovantApiUnreachableError extends ThalovantApiError {}

/** A string with something in it, exactly as sent; anything else is absent. */
function problemText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * The `code` and `detail` of an API error body.
 *
 * Read from the body's own members first. When `detail` is itself an object,
 * it is FastAPI's envelope around a structured refusal -- what the API sends
 * when its Problem+JSON handler has not lifted that object's members to the
 * top -- so the code and the sentence are read from inside it. Nothing is
 * trimmed or shortened: `detail` is the whole sentence.
 */
function problemFields(problem: Record<string, unknown> | undefined): { code?: string; detail?: string } {
  if (!problem) return {};
  const member = problem.detail;
  const nested = isRecord(member) ? member : {};
  return {
    code: problemText(problem.code) ?? problemText(nested.code),
    detail: problemText(member) ?? problemText(nested.detail),
  };
}

export class ThalovantUnsupportedProtocolError extends ThalovantError {}

/** The options every API error subclass takes, as {@link ThalovantApiError} does. */
type ApiErrorOptions = ConstructorParameters<typeof ThalovantApiError>[1];

/**
 * The control plane rejected the API token itself.
 *
 * A 401 (the token is unknown, expired or revoked), a 423 (the account is
 * locked), or a 403 whose detail is `Insufficient scopes`. Signing in again is
 * the way out of each, which is true of no other refusal.
 */
export class ThalovantAuthError extends ThalovantApiError {}

/**
 * The account's plan does not allow the request.
 *
 * A 402, or a 403 whose code is `plan_limit`; `problem` carries the
 * `resource`, `limit` and `used` the API reported.
 */
export class ThalovantPlanError extends ThalovantApiError {}

/**
 * The `code` of every refusal the intercom routes (and the connection routes
 * beside them) add. The API's answers are `application/problem+json`: read
 * `code` first. The typed error for each code is named in its comment; any
 * code not listed here follows the ordinary mappings by status (a 401 is a
 * {@link ThalovantAuthError}, a 429 a {@link ThalovantRateLimitedError}, ...)
 * and is otherwise a plain {@link ThalovantApiError}, with `code` and `problem`
 * either way.
 */
export const IntercomProblemCode = Object.freeze({
  /** 403: `priority: "urgent"` (and so every `repeat`) needs `intercom:urgent` as well as `intercom:send`. {@link ThalovantUrgentScopeRequiredError} */
  URGENT_SCOPE_REQUIRED: "urgent_scope_required",
  /** 429: the hub (or the platform) already has its urgent announcements repeating; `scope` says which. {@link ThalovantUrgentBusyError} */
  URGENT_BUSY: "intercom_urgent_busy",
  /** 409: an urgent announcement on a hub whose runtime has no active Intercom skill. {@link ThalovantSkillNotInstalledError} */
  SKILL_NOT_INSTALLED: "skill_not_installed",
  /** 422: `receive: true`, or a `speakers` target, on a connection that cannot play speech. {@link ThalovantNotASpeakerError} */
  NOT_A_SPEAKER: "not_a_speaker",
  /** 422: a connection named like the platform's own Intercom client. {@link ThalovantReservedNameError} */
  RESERVED_NAME: "reserved_name",
  /** 403: the hub is locked; nothing was changed. {@link ThalovantHubLockedError} */
  HUB_LOCKED: "hub_locked",
  /** 403: an impersonated session cannot send announcements. {@link ThalovantImpersonationNotAllowedError} */
  IMPERSONATION_NOT_ALLOWED: "impersonation_not_allowed",
  /** 422: `all`, a room or a group resolved to more than 50 speakers. {@link ThalovantTooManyTargetsError} */
  TOO_MANY_TARGETS: "too_many_targets",
  /** 422: intercom is never available on this hub (a kid hub or a public hub); `reason` says which. {@link ThalovantIntercomUnavailableError} */
  UNAVAILABLE: "intercom_unavailable",
  /** 503: intercom is switched off for the whole platform; nothing was sent. {@link ThalovantIntercomPlatformDisabledError} */
  DISABLED_PLATFORM: "intercom_disabled_platform",
  /** 503: the operator has not configured intercom yet; nothing was sent. {@link ThalovantIntercomNotConfiguredError} */
  NOT_CONFIGURED: "intercom_not_configured",
  /** 403: the platform-managed Intercom client cannot be managed or given credentials. {@link ThalovantManagedClientError} */
  MANAGED_CLIENT: "managed_client",
  /** 409: only an announcement that is still `sending` can be cancelled; `announcement_status` is its current status. {@link ThalovantNotCancellableError} */
  NOT_CANCELLABLE: "not_cancellable",
  /** 502: the hub did not take the announcement; `announcement_id` names the failed record. {@link ThalovantHubUnreachableError} */
  HUB_UNREACHABLE: "hub_unreachable",
  /** The hub's switch is off. {@link ThalovantIntercomDisabledError} */
  DISABLED: "intercom_disabled",
} as const);

/** A member of a problem body, at its top or inside an object `detail` (FastAPI's envelope). */
function problemMember(problem: Record<string, unknown> | undefined, key: string): unknown {
  if (!problem) return undefined;
  for (const source of [problem, isRecord(problem.detail) ? problem.detail : {}]) {
    if (key in source) return (source as Record<string, unknown>)[key];
  }
  return undefined;
}

function problemString(problem: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = problemMember(problem, key);
  return typeof value === "string" && value ? value : undefined;
}

function problemStrings(problem: Record<string, unknown> | undefined, key: string): readonly string[] {
  const value = problemMember(problem, key);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : [];
}

/**
 * Intercom is off for the hub (code `intercom_disabled`), or cannot run on it
 * at all.
 *
 * The hub's feature flag is off: turn it on with `setIntercomSettings` (needs
 * `hubs:write` and a plan with intercom). The subclasses say the stronger
 * cases, which turning the hub's switch on cannot change:
 * {@link ThalovantIntercomUnavailableError} (a kid hub or a public hub) and
 * {@link ThalovantIntercomPlatformDisabledError} (the platform's own switch).
 */
export class ThalovantIntercomDisabledError extends ThalovantApiError {}

/**
 * Intercom is never available on the hub (422 `intercom_unavailable`):
 * {@link reason} is `kid_hub` or `public_hub`. It cannot be turned on there
 * for any plan. Not retryable.
 */
export class ThalovantIntercomUnavailableError extends ThalovantIntercomDisabledError {
  /** Why: `kid_hub` or `public_hub` (an open value), or undefined when the body did not say. */
  get reason(): string | undefined {
    return problemString(this.problem, "reason");
  }
}

/**
 * Intercom is switched off for the whole platform (503
 * `intercom_disabled_platform`). Nothing was written, sent or spent. Show an
 * explanation, not an error toast: only the platform operator can turn it on,
 * and no hub setting changes that. Reads (speakers, history) and
 * `cancelAnnouncement` still work.
 */
export class ThalovantIntercomPlatformDisabledError extends ThalovantIntercomDisabledError {}

/**
 * Intercom is not configured on this platform yet (503
 * `intercom_not_configured`). The operator has not finished setting it up.
 * Nothing was sent. Disabling, reads and cancelling are unaffected. Say
 * "Intercom is not available yet".
 */
export class ThalovantIntercomNotConfiguredError extends ThalovantApiError {}

/**
 * An urgent announcement was sent without `intercom:urgent` (403
 * `urgent_scope_required`). `priority: "urgent"` (and so every `repeat`) needs
 * `intercom:urgent` IN ADDITION to `intercom:send`; nothing implies it. It is
 * checked before the idempotency lookup, the rate limit and the hub: nothing
 * was spent. Sign in again asking for the scope (the plan must allow it), or
 * send a normal announcement.
 */
export class ThalovantUrgentScopeRequiredError extends ThalovantAuthError {}

/**
 * Too many requests (429). `retryAfterSeconds` says how long to wait.
 *
 * Intercom limits a hub to 20 normal announcements a minute and 10 urgent
 * ones an hour. A full urgent pool is the subclass
 * {@link ThalovantUrgentBusyError}.
 */
export class ThalovantRateLimitedError extends ThalovantApiError {}

/**
 * The urgent pool is full (429 `intercom_urgent_busy`). A hub may have 2 urgent
 * announcements repeating at once, and the platform a fixed number per API
 * replica; {@link scope} says which one is full (`hub` or `platform`).
 * `retryAfterSeconds` says when to ask again. Nothing was stored and no rate
 * token was spent; cancel one that is running (`cancelAnnouncement`) or wait.
 */
export class ThalovantUrgentBusyError extends ThalovantRateLimitedError {
  /** `hub` or `platform` (an open value), or undefined when the body did not say. */
  get scope(): string | undefined {
    return problemString(this.problem, "scope");
  }
}

/**
 * The hub has no Intercom skill yet (409 `skill_not_installed`). An urgent
 * announcement needs the skill active on the hub's runtime. Nothing was sent.
 * Switch intercom on for the hub (`setIntercomSettings`), wait for the skill to
 * install, and try again.
 */
export class ThalovantSkillNotInstalledError extends ThalovantApiError {}

/**
 * A connection that cannot play speech was asked to receive (422
 * `not_a_speaker`). Two cases: `updateIntercomSpeaker({ receive: true })` on a
 * connection whose effective `can_play` is false ({@link kind} is its
 * connection kind), and an announcement that names such connections in
 * `targets.speakers` ({@link notSpeakers} lists them). Its owner declares
 * `can_play` on the connection (`spec.intercom.can_play`), never on the speaker.
 */
export class ThalovantNotASpeakerError extends ThalovantApiError {
  /** The connection kind of a refused `receive` (`home_assistant`, `developer`, `embedded`...), or undefined. */
  get kind(): string | undefined {
    return problemString(this.problem, "kind");
  }

  /** The named connections that cannot play speech, for a refused announcement; empty otherwise. */
  get notSpeakers(): readonly string[] {
    return problemStrings(this.problem, "not_speakers");
  }
}

/**
 * A connection was created or renamed onto a name the platform reserves (422
 * `reserved_name`): the name `thalovant-intercom-...` and the slug
 * `thalovant-intercom` belong to the platform's own Intercom client. Choose
 * another name.
 */
export class ThalovantReservedNameError extends ThalovantApiError {}

/**
 * The hub is locked (403 `hub_locked`): nothing was changed or sent. An
 * announcement, a switch or a speaker change is refused on a locked hub;
 * switching intercom off (by a platform administrator) and
 * `cancelAnnouncement` still work. Not retryable until the hub is unlocked.
 */
export class ThalovantHubLockedError extends ThalovantApiError {}

/**
 * An impersonated session tried to announce (403 `impersonation_not_allowed`).
 * A staff member looking through somebody's session cannot enable intercom,
 * change a speaker or announce. Switching it off and cancelling stay open.
 */
export class ThalovantImpersonationNotAllowedError extends ThalovantApiError {}

/**
 * `all`, a room or a group resolved to more than 50 speakers (422
 * `too_many_targets`). {@link matched} is how many it resolved to. Naming that
 * same room or group resolves to the same speakers: choose a narrower target
 * (a smaller room or group) or name at most 50 speakers.
 */
export class ThalovantTooManyTargetsError extends ThalovantApiError {
  /** How many speakers the targets resolved to, or undefined when the body did not say. */
  get matched(): number | undefined {
    const value = problemMember(this.problem, "matched");
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
  }
}

/**
 * A connection the platform manages (403 `managed_client`). The platform's own
 * Intercom client cannot be edited, paused, deleted, given credentials or named
 * in an access policy by anybody; switch Intercom off and on for the hub to
 * repair it. It is identified by `spec.intercomApi === "platform"`.
 * {@link refusedClientRefs} lists the managed connections an access policy
 * named, when it was one. Not retryable.
 */
export class ThalovantManagedClientError extends ThalovantApiError {
  /** The managed connections an access policy named; empty otherwise. */
  get refusedClientRefs(): readonly string[] {
    return problemStrings(this.problem, "refused_client_refs");
  }
}

/**
 * The API could not reach the hub to speak (502 `hub_unreachable`). Whether the
 * text was spoken is not guaranteed either way: the hub may have spoken it and
 * lost the answer. The API records the attempt as a `failed` announcement and
 * names it in {@link announcementId}.
 *
 * **Do not resend blindly.** Read the announcement first
 * (`getAnnouncement(hubId, error.announcementId)`). Reusing the same
 * `idempotencyKey` does *not* retry: the API replays the stored `failed`
 * record and never sends again. A `failed` record is not proof that nothing
 * was spoken: weigh the risk of a repeated announcement, and use a **new** key
 * only when you choose to send a second attempt.
 */
export class ThalovantHubUnreachableError extends ThalovantApiError {
  /** The announcement the API recorded for the failed attempt (`announcement_id` in the problem), or undefined. */
  get announcementId(): string | undefined {
    return problemString(this.problem, "announcement_id");
  }
}

/**
 * An announcement cannot be cancelled (409 `not_cancellable`). Only an
 * announcement that is still `sending` can be; one that has completed, failed
 * or been cancelled already cannot. {@link announcementStatus} is its current
 * status: refresh the result (`getAnnouncement`) instead of showing an error.
 */
export class ThalovantNotCancellableError extends ThalovantApiError {
  /** The announcement's current status (`completed`, `partial`, `failed` or `cancelled`), or undefined. */
  get announcementStatus(): string | undefined {
    return problemString(this.problem, "announcement_status");
  }
}

/**
 * A hub already has the one connection of this kind it allows.
 *
 * A 409 `home_assistant_already_linked`: a hub takes one Home Assistant
 * connection. `clientId` names the connection that holds the link, when the
 * API said which.
 */
export class ThalovantAlreadyLinkedError extends ThalovantApiError {
  readonly clientId?: string;

  constructor(message?: string, options?: ApiErrorOptions & { clientId?: string }) {
    super(message, options);
    this.clientId = options?.clientId;
  }
}

/**
 * The API does not know the connection type asked for.
 *
 * A 422 naming `connection_type`, or a created connection whose type did not
 * come back as asked: an API that silently ignored the field would hand out an
 * ordinary connection instead. The SDK deletes such a connection before it
 * throws, and then `statusCode` is undefined.
 */
export class ThalovantUnsupportedConnectionTypeError extends ThalovantApiError {}

/**
 * One device sign-in poll found nobody had decided yet.
 *
 * Poll again after `interval` seconds (`intervalMs` milliseconds), which a
 * `slow_down` from the API has already lengthened -- for good, for every later
 * poll of the same code.
 */
export class ThalovantDeviceLoginPendingError extends ThalovantApiError {
  /** Seconds to wait before the next poll. */
  readonly interval: number;

  constructor(message?: string, options?: ApiErrorOptions & { interval?: number }) {
    super(message, options);
    this.interval = options?.interval ?? 5;
  }

  /** The same wait in milliseconds, for `setTimeout`. */
  get intervalMs(): number {
    return this.interval * 1000;
  }
}

/** The device code expired before anybody approved it; begin a new sign-in. */
export class ThalovantDeviceLoginExpiredError extends ThalovantApiError {}

/** The person declined the device sign-in in the browser. */
export class ThalovantDeviceLoginDeniedError extends ThalovantApiError {}

/**
 * A hub has not admitted a new connection within the wait.
 *
 * Both a connection error and a timeout -- `instanceof` answers true for
 * {@link ThalovantConnectionError} and {@link ThalovantTimeoutError} -- because
 * the connection exists and may still be admitted: waiting longer, or
 * connecting later, can succeed.
 */
export class ThalovantAdmissionTimeoutError extends ThalovantConnectionError {}

/**
 * A new connection will not be admitted.
 *
 * Either the operation that admits it failed or timed out on the platform --
 * `errorCode` is the operation's own code, and `statusCode` is undefined -- or
 * the API refused the wait itself, and then `statusCode`, `code`, `detail` and
 * `problem` keep what it answered, as a `ThalovantApiError` does. An
 * authentication refusal is not this: it is thrown as the API's own error.
 */
export class ThalovantAdmissionFailedError extends ThalovantConnectionError {
  readonly errorCode?: string;
  readonly statusCode?: number;
  readonly code?: string;
  readonly detail?: string;
  /** The whole body of the API's refusal, when it was a JSON object. Not enumerable. */
  declare readonly problem?: Record<string, unknown>;

  constructor(
    message?: string,
    options?: ErrorOptions & {
      errorCode?: string;
      statusCode?: number;
      code?: string;
      detail?: string;
      problem?: Record<string, unknown>;
    },
  ) {
    super(message, options);
    this.errorCode = options?.errorCode;
    this.statusCode = options?.statusCode;
    const problem = isRecord(options?.problem) ? { ...options.problem } : undefined;
    Object.defineProperty(this, "problem", { value: problem, enumerable: false, writable: false, configurable: false });
    const read = problemFields(problem);
    this.code = options?.code ?? read.code;
    this.detail = options?.detail ?? read.detail;
  }
}

/**
 * The numbers behind a refusal that is a spent allowance, not a policy.
 *
 * The intent-quota policy denies with `intent_quota_exceeded` and sends which
 * counter ran out (`daily`, `monthly`), what it allows, how much was used, and
 * how many seconds until it resets. Without them a caller can only say
 * "refused", which is what an app showed somebody who had used up the day.
 */
export interface ThalovantQuota {
  readonly period: string;
  readonly limit: number;
  readonly used: number;
  /** Seconds until the counter resets, or 0 when the hub did not say. */
  readonly resetAfter: number;
}

/**
 * The hub refused a message, the instant it did.
 *
 * Three different things arrive as `hive.policy.denied`, and each needs
 * something different said about it: an allow-list refusal
 * (`acl_disallowed_type`, with `allowed`), a spent allowance
 * (`intent_quota_exceeded`, with `quota`), and a hub whose agent bus is down
 * (`backend_unavailable`) -- which nothing the caller does will fix.
 */
export class ThalovantPolicyDeniedError extends ThalovantRuntimeError {
  static readonly QUOTA_EXCEEDED = "intent_quota_exceeded";
  static readonly BACKEND_UNAVAILABLE = "backend_unavailable";

  /** The message type the hub refused, for example `recognizer_loop:utterance`. */
  readonly deniedType: string;
  /** The hub's code: `acl_disallowed_type`, `intent_quota_exceeded`, `backend_unavailable`. */
  readonly code: string;
  readonly reason: string;
  /** The types the connection may publish, as the hub reported them. */
  readonly allowed: readonly string[];
  /** The numbers behind a spent quota; undefined for any other refusal. */
  readonly quota?: ThalovantQuota;

  constructor(
    deniedType: string,
    options: { code?: string; reason?: string; allowed?: readonly string[]; quota?: ThalovantQuota } = {},
  ) {
    super(refusalMessage(deniedType, options.code ?? "", options.reason ?? "", options.quota));
    this.deniedType = deniedType;
    this.code = options.code ?? "";
    this.reason = options.reason ?? "";
    this.allowed = [...(options.allowed ?? [])];
    this.quota = options.quota;
  }

  /** Build the error from a `hive.policy.denied` event as the hub sends it. */
  static fromEvent(event: Pick<ThalovantEvent, "data">): ThalovantPolicyDeniedError {
    const data = event.data ?? {};
    // The policy's own detail rides nested under data.data
    // (hivemind-core _send_policy_denied: "data": verdict.data).
    const inner = isRecord(data.data) ? data.data : {};
    // Only non-blank strings, trimmed: a number, a null or a blank in the list
    // is not a message type, and stringifying one would put "3" or "null" in
    // front of an operator reading which types to allow.
    const allowed = Array.isArray(inner.allowed)
      ? inner.allowed.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
      : [];
    const code = typeof data.code === "string" ? data.code : "";
    const quota = code === ThalovantPolicyDeniedError.QUOTA_EXCEEDED
      ? {
          period: typeof inner.period === "string" ? inner.period : "",
          limit: count(inner.limit),
          used: count(inner.used),
          resetAfter: count(inner.reset_after),
        }
      : undefined;
    return new ThalovantPolicyDeniedError(typeof data.denied_type === "string" ? data.denied_type : "", {
      code,
      reason: typeof data.reason === "string" ? data.reason : "",
      allowed,
      quota,
    });
  }
}

/**
 * The hub understood a question and has nothing for it.
 *
 * `ovos.intent.unmatched` (`complete_intent_failure` from older hubs) is
 * neither a refusal nor a fault. As a bare runtime error a caller could only
 * report that something failed.
 */
export class ThalovantUnansweredError extends ThalovantRuntimeError {
  readonly said: string;
  constructor(said = "") {
    super(said || "The hub has no skill that answers this.");
    this.said = said;
  }
}

/**
 * A whole, non-negative count from the wire, or 0: never a boolean, never a
 * guess. A negative limit, usage or reset time is not something a policy can
 * mean, and passing one through would have an app say "-1 of -5 questions used".
 */
function count(value: unknown): number {
  // Whole, non-negative, and no larger than 2**53-1 -- the largest whole
  // number every JSON decoder carries exactly, and the contract's ceiling.
  // Above it a decoder backed by a double can no longer tell one whole number
  // from the next, so two SDKs would report different allowances for the same
  // denial.
  const whole = typeof value === "number" && Number.isInteger(value) ? value
    : typeof value === "string" && /^\s*-?\d+\s*$/.test(value) ? Number.parseInt(value, 10)
    : Number.NaN;
  if (!Number.isSafeInteger(whole) || whole < 0) return 0;
  return whole;
}

function refusalMessage(deniedType: string, code: string, reason: string, quota?: ThalovantQuota): string {
  // Advice follows the kind of refusal. Telling somebody who used up their day
  // to "allow this connection to publish recognizer_loop:utterance" sent them
  // to a settings page that could not help.
  if (quota) {
    if (!quota.limit && !quota.used && !quota.resetAfter && !quota.period) {
      // Refused on a quota, with none of the numbers. "All questions used"
      // would be inventing one.
      return `The hub refused "${deniedType}": a quota has run out.`;
    }
    const used = quota.limit ? `${quota.used} of ${quota.limit}` : "all";
    const period = quota.period ? ` ${quota.period}` : "";
    const resets = quota.resetAfter ? `; it resets in ${quota.resetAfter}s` : "";
    return `The hub refused "${deniedType}": ${used}${period} questions used${resets}.`;
  }
  if (code === ThalovantPolicyDeniedError.BACKEND_UNAVAILABLE) {
    return `The hub could not reach its assistant${reason ? `: ${reason}` : ""}. Try again shortly.`;
  }
  const detail = reason || code || "refused by the hub's policy";
  return (
    `The hub refused "${deniedType}": ${detail}. Allow this connection to publish ` +
    `"${deniedType}" in the dashboard's connection settings.`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
