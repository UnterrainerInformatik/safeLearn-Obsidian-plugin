import {
  App,
  Editor,
  MarkdownPostProcessorContext,
  MarkdownRenderer,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
} from "obsidian";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { Range, Text } from "@codemirror/state";

/**
 * `MenuItem.setSubmenu` is API Obsidian has and does not publish.
 *
 * The application defines it - 1.13.7 puts it on the object `Menu.addItem`
 * hands out, and Obsidian builds its own **Format** and **Table** entries with
 * it - while the `obsidian` typings declare only `setTitle`, `setIcon`,
 * `setSection` and `onClick`. Declared here, in one place and in words, rather
 * than reached with an `as any` at the call site: a cast there would silence
 * every other mistake in the same expression along with the one thing it is
 * for. If a later `obsidian` package declares it too, this merges silently; if
 * it declares it differently, that is a compile error, which is where it
 * belongs. Either way it is this block to delete.
 *
 * The call itself is still guarded - see the `editor-menu` subscription.
 */
declare module "obsidian" {
  interface MenuItem {
    setSubmenu(): Menu;
  }
}

/**
 * `App.setting` is the settings window, which Obsidian has and does not publish.
 *
 * The status-bar item this change adds opens the plugin's own settings when
 * clicked, because every remedy the settings tab names is in the settings tab -
 * and there is no published way to ask for that. `app.setting.open()` followed
 * by `openTabById(id)` is what Obsidian's own "Options" entry does, and what
 * `test/obsidian/harness.js` already drives to open this very tab. Declared
 * here for the same reason `MenuItem.setSubmenu` is, and with the same
 * consequence: if a later `obsidian` package declares it, this merges or fails
 * to compile, and either is better than an `as any` at the call site.
 */
declare module "obsidian" {
  interface App {
    setting: {
      open(): void;
      openTabById(id: string): void;
    };
  }
}

// ################### Directory login: data, PKCE and the class heuristic ###################

/**
 * What `saveData`/`loadData` persist, in `data.json`.
 *
 * Only the refresh token is written here, never the access token - see
 * `SafeLearnPlugin.refreshAccessToken`. `keycloakUrl` and `realm` exist
 * because `keycloak.json` (the safeLearn server's own connection details) is
 * deliberately never served to a browser, and a self-hosted deployment can
 * point at a Keycloak of its own - so they are settings, each defaulted to
 * this project's shared identity provider, the same default/override shape
 * `docs-testing.md` already uses for `SAFELEARN_TEST_IDP_URL`/`SAFELEARN_TEST_REALM`.
 *
 * `refreshTokenLifetimeSeconds` is the realm's own answer to how long a refresh
 * token lives - `refresh_expires_in`, which Keycloak sends with every
 * successful exchange and which this plugin used to drop. It is kept because a
 * login in progress is given exactly that long to conclude (`design.md`): the
 * realm already knows the figure, so a constant in the source would be a second
 * copy of it, free to be wrong on every deployment that is not this one.
 */
interface SafeLearnPluginData {
  instanceUrl: string;
  keycloakUrl: string;
  realm: string;
  serverClientId: string;
  refreshToken: string | null;
  refreshTokenLifetimeSeconds: number;
  // Gates `debugLog` - off by default, switched on from the settings tab
  // only while troubleshooting a login/directory-search problem.
  debugLogging: boolean;
}

const DEFAULT_DATA: SafeLearnPluginData = {
  instanceUrl: "",
  keycloakUrl: "https://auth.unterrainer.info/",
  realm: "safeLearn",
  // The safeLearn server's own Keycloak client id (its `keycloak.json`'s
  // `resource`), not this plugin's - see `DIRECTORY_CLIENT_ID` and
  // `hasDirectoryRole`. Deployment-specific like `keycloakUrl`/`realm` above;
  // defaulted to this project's own convention.
  serverClientId: "safeLearn",
  refreshToken: null,
  // Keycloak's own default for SSO Session Idle, which is what
  // `refresh_expires_in` follows out of the box. It is a seed and not a
  // setting: the first successful exchange replaces it with what the realm
  // actually answered, and a wrong seed costs exactly one attempt, since it
  // decides only how long the very first login waits before giving up.
  refreshTokenLifetimeSeconds: 30 * 60,
  // Off by default - only turned on while actively chasing a bug, not left
  // logging token-adjacent detail for every install.
  debugLogging: false,
};

/**
 * The plugin's own Keycloak client - public, PKCE-only, no client roles of
 * its own (`tasks.md` #1). Not a setting: it is this project's own
 * convention, unlike the host and realm above, which vary per deployment.
 */
const DIRECTORY_CLIENT_ID = "safelearn-plugin";

/** A person the directory has an entry for: what the search endpoint hands back, and nothing else. */
interface DirectoryEntry {
  name: string;
  roles: Record<string, boolean>;
}

/**
 * How far a directory fetch on the server has got, as its status endpoint
 * reports it. `total` is `null` while the running phase does not know its own
 * total yet - the server deliberately reports that rather than guessing one,
 * so a percentage is simply not shown for that window.
 */
interface DirectoryFetchProgress {
  phase: "idle" | "counting" | "entries" | "roles";
  done: number;
  total: number | null;
}

/**
 * What the server holds and what it is doing about it, from
 * `GET /api/admin/directory/status`. `entries`/`builtAt` are `null` when it
 * holds nothing at all; `skipped` is a count of records that could not be
 * retrieved while the held data was built, and never says which.
 */
interface DirectoryState extends DirectoryFetchProgress {
  fetching: boolean;
  entries: number | null;
  builtAt: number | null;
  skipped: number;
}

/**
 * What a directory search came back with, distinguishing the ways it can fail
 * to reach `entries` from an actual, empty match: `"unreachable"` (a
 * `requestUrl` exception - no route to the instance at all), `"refused"` (a
 * `403`, deliberately shown identically to not being logged in, per
 * `plugin-login-state`'s existing boundary - unchanged here), `"failed"`
 * (any other `>=400`, chiefly the `502` a Keycloak-side failure raises), and
 * `"fetching"` (a `202`: the server has no directory data yet and is building
 * it, carrying how far along in `progress`). `entries` is populated only for
 * `"ok"`.
 *
 * `"fetching"` is emphatically not a failure - a fetch of a realm this size
 * takes minutes, and the whole point of the server answering rather than
 * holding the request open is that the wait becomes something a person can see
 * happening.
 */
interface DirectorySearchResult {
  outcome: "ok" | "unreachable" | "failed" | "refused" | "fetching";
  entries: DirectoryEntry[];
  progress?: DirectoryFetchProgress;
}

/**
 * How often anything waiting on a directory fetch asks the instance where it
 * has got to. The endpoint reads process memory and answers a handful of
 * numbers, so this costs the server nothing worth counting; what it must stay
 * clear of is being mistaken for a progress *bar*'s refresh rate, which is why
 * nothing here animates between readings.
 */
const DIRECTORY_POLL_MS = 2000;

/** What each fetch phase is called where a person reads it. */
const DIRECTORY_PHASE_LABELS: Record<DirectoryFetchProgress["phase"], string> = {
  idle: "starting",
  counting: "counting its entries",
  entries: "retrieving entries",
  roles: "resolving roles",
};

/** Whatever of a status/`202` body is actually shaped like progress - the rest is ignored rather than trusted. */
function directoryProgressOf(body: unknown): DirectoryFetchProgress {
  const source = (body ?? {}) as Record<string, unknown>;
  const phase = source.phase;
  return {
    phase:
      phase === "counting" || phase === "entries" || phase === "roles" || phase === "idle"
        ? phase
        : "idle",
    done: typeof source.done === "number" ? source.done : 0,
    total: typeof source.total === "number" ? source.total : null,
  };
}

/**
 * The one wording every waiting surface uses, so the picker, the info view and
 * the "list classes" notice never describe the same fetch differently.
 *
 * The percentage is derived here rather than asked of the server: the server
 * reports each phase's own raw figures precisely so that no single blended bar
 * has to weight the two phases against each other, their relative cost being
 * realm-specific.
 */
function directoryFetchProgressText(progress: DirectoryFetchProgress | null): string {
  const label = DIRECTORY_PHASE_LABELS[progress?.phase ?? "idle"];
  if (!progress || progress.total === null || progress.total <= 0) {
    return `Fetching the directory — ${label}…`;
  }
  const percent = Math.min(100, Math.floor((progress.done / progress.total) * 100));
  return `Fetching the directory — ${label} ${percent}% (${progress.done}/${progress.total})`;
}

/** The five role/group values that mean "everyone holding this role", not a class. Mirrors `NAMES_RESERVED_FOR_ROLES`, lowercased. */
const ROLE_MARKERS = new Set(["teacher", "teachers", "student", "students", "admin"]);

/**
 * Every role/group value across `entries` that is not one of the five
 * built-in markers, de-duplicated.
 *
 * The backend has no closed notion of what counts as a class - `teacher`, a
 * class, and something like `examParticipant` are one flat role/group map by
 * design. This is therefore an accepted approximation (`design.md`): an
 * exam-participant-style marker is occasionally listed as if it were a
 * class, because the plugin cannot recover a distinction the backend never
 * made.
 */
function classLikeValues(entries: DirectoryEntry[]): string[] {
  const found = new Set<string>();
  for (const entry of entries) {
    for (const role of Object.keys(entry.roles)) {
      if (!ROLE_MARKERS.has(role.toLowerCase())) found.add(role);
    }
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** A URL setting typed without a scheme resolves against nothing and fails outright - default it to `https://`. */
function ensureProtocol(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

// PKCE (RFC 7636). A code verifier and a login's `state` are both just
// unguessable random strings, so one generator serves both.
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomPkceString(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** `S256`: the base64url-encoded SHA-256 digest of the verifier. Web Crypto, not Node's - see `design.md` on mobile support. */
async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * The access token's own `resource_access[resource].roles`, read locally from its
 * unverified payload - the same claim `utils.js`'s `getClientRoles` reads server-side
 * off `keycloakConfig.resource`. That id is a deployment's own Keycloak client name,
 * not this project's fixed convention (a fork's server is commonly registered under
 * its own name), so the caller passes the token's own `azp` rather than a literal.
 * Never used to establish trust (the server still checks the token itself on every
 * call); only to tell a person, from their own already-issued token, whether the
 * directory endpoint's teacher-or-admin gate will let them through - the endpoint's
 * own refusal does not say why, on purpose.
 */
function accessTokenResourceRoles(token: string, resource: string): string[] {
  const roles = accessTokenPayload(token)?.resource_access?.[resource]?.roles;
  return Array.isArray(roles) ? roles : [];
}

/**
 * Mirrors `deriveRoles` in the server's `keycloak-middleware.js`: whether the
 * `ldap` claim's `OU=...` segments include a teacher or admin group, applying
 * the same `teachers` -> `teacher` alias.
 */
function ldapCarriesTeacherOrAdmin(ldap: unknown): boolean {
  if (typeof ldap !== "string") return false;
  const matches = ldap.match(/OU=[^,]*/gi);
  if (!matches) return false;
  return matches.some((match) => {
    const value = match.replace(/^OU=/i, "").trim().toLowerCase();
    return value === "teacher" || value === "teachers" || value === "admin";
  });
}

/**
 * An access token's own payload, decoded locally and never verified.
 *
 * Two questions are asked of it - which roles it carries and who it was issued
 * for - and both are asked of a token this plugin already holds. Decoding it
 * twice, in two places, would be two chances to get base64url padding wrong in
 * only one of them. A token that is not a JWT at all is not an error here: it
 * answers neither question, which is what `null` says.
 */
function accessTokenPayload(token: string): any | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    let base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = base64.length % 4;
    if (pad) base64 += "=".repeat(4 - pad);
    return JSON.parse(atob(base64));
  } catch {
    return null;
  }
}

/**
 * Who the held token says is logged in.
 *
 * `plugin-login-state` requires that either logged-in state names who is logged
 * in, and this is the only place that could answer it without asking the server
 * something. Keycloak always issues `preferred_username` and adds `name` where
 * the account has one, so the first of those that is there is what a person
 * would recognise as themselves. A token carrying none of them is not a state
 * of its own: the login is held either way, and "logged in" without a name is
 * the honest thing to show.
 */
function accessTokenAccountName(token: string): string | null {
  const payload = accessTokenPayload(token);
  for (const claim of [payload?.name, payload?.preferred_username, payload?.email]) {
    if (typeof claim === "string" && claim.trim() !== "") return claim.trim();
  }
  return null;
}

// ################### The login's state, its causes and their words ###################

/**
 * Why a login ended without an identity, as a tag rather than as a sentence.
 *
 * Three surfaces show this at three lengths and a check asserts on it, and a
 * sentence built where the failure happened can serve none of them: each
 * surface wants a different length of it, and a check asserting on prose breaks
 * on every rewording. So the failure travels as a tag and each surface renders
 * it - see `design.md`.
 *
 * A cause is constructed only where the plugin observed the thing first-hand:
 * the transport failure of its own request, the status its own request was
 * answered with, the parameters a callback carried. Never from how the safeLearn
 * server answered a directory call - `directory-search` makes "holds no
 * identity" and "holds neither role" indistinguishable on purpose, and nothing
 * here may become the side channel that tells them apart.
 */
type LoginFailure =
  | { kind: "unreachable" }
  | { kind: "endpoint-unresolvable" }
  | { kind: "provider-refused"; status: number }
  | { kind: "redirect-not-registered" }
  | { kind: "no-code" }
  | { kind: "no-callback" }
  | { kind: "cancelled" }
  | { kind: "another-window" }
  | { kind: "no-longer-pending" };

/**
 * The five states of `plugin-login-state`, each carrying the particulars that
 * tell one instance of it from another. Derived, never stored: a state written
 * down at each transition is free to disagree with the tokens, and a surface
 * showing a state that disagrees with what a call will do is the defect this
 * change exists to repair, one level up.
 */
type LoginState =
  | { name: "logged-out" }
  | { name: "logging-in"; startedAt: number; instanceUrl: string | null }
  | { name: "logged-in"; account: string | null }
  | { name: "logged-in-without-role"; account: string | null }
  | { name: "login-failed"; cause: LoginFailure };

/** A login this instance started and is waiting on: what it needs to finish, and what it needs to be shown and to expire. */
interface PendingLogin {
  /** The PKCE verifier the exchange needs - `null` for the start-up restore, which has a refresh token instead and can complete no callback. */
  verifier: string | null;
  startedAt: number;
  expiresAt: number;
  instanceUrl: string | null;
}

/**
 * How often a login in progress is checked for having passed its lifetime.
 *
 * A second is short enough that nobody watching the status bar sees a state
 * that is no longer true, and cheap enough to be beneath notice: the check is a
 * walk over a map that holds at most one entry.
 */
const EXPIRY_TICK_MS = 1000;

/** How many concluded logins are remembered, which is only as many as could still have a callback in flight. */
const CONCLUDED_LOGINS_KEPT = 20;

/**
 * An error carrying the cause a surface will render.
 *
 * The site that observes a failure is the only site that knows what it was, and
 * it is several calls below the site that shows it. The alternative is a
 * `console.error` and a caller left to guess, which is what this change is
 * repairing. Not named `cause`: `Error` already has a property by that name.
 */
class LoginFailureError extends Error {
  constructor(readonly failure: LoginFailure) {
    super(causeAsSentence(failure));
  }
}

/**
 * The cause an exchange ended with.
 *
 * Everything below `applyTokenResponse` throws a `LoginFailureError`, so the
 * fallback covers only something answering on the token endpoint's address that
 * is not a token endpoint - a body that is not JSON, a field that is not there.
 * That is what an unresolvable endpoint is, so it is what it is called.
 */
function failureOf(error: unknown): LoginFailure {
  return error instanceof LoginFailureError ? error.failure : { kind: "endpoint-unresolvable" };
}

/**
 * What a refusal from the token endpoint actually was, read off the answer to
 * this plugin's own request and nothing else.
 *
 * A realm that is not there is not a refusal at all - Keycloak has no such path
 * to serve and answers 404, and telling somebody the provider refused them when
 * the realm name is misspelt sends them looking in the wrong place. A redirect
 * address the client does not carry is refused with a 400 that names it in the
 * body, and it earns its own cause because it is the one failure here that
 * nobody fixes by logging in again.
 *
 * All of this is a fact of a request this plugin made. Nothing here reads or
 * repeats how the safeLearn server answered anything.
 */
function refusalOf(status: number, body: string): LoginFailure {
  if (status === 404) return { kind: "endpoint-unresolvable" };
  if (/redirect_uri/i.test(body ?? "")) return { kind: "redirect-not-registered" };
  return { kind: "provider-refused", status };
}

/** The five state names as a person reads them, without the particulars each one carries. */
function loginStateName(state: LoginState): string {
  switch (state.name) {
    case "logged-out":
      return "Not logged in";
    case "logging-in":
      return "Logging in…";
    case "logged-in":
      return "Logged in";
    case "logged-in-without-role":
      return "Logged in, no directory role";
    case "login-failed":
      return "Login failed";
  }
}

/** A cause in the fewest words that still say which one it is - the status bar's length. */
function causeInBrief(cause: LoginFailure): string {
  switch (cause.kind) {
    case "unreachable":
      return "nothing answered";
    case "endpoint-unresolvable":
      return "no realm there";
    case "provider-refused":
      return `refused, status ${cause.status}`;
    case "redirect-not-registered":
      return "redirect not registered";
    case "no-code":
      return "no code came back";
    case "no-callback":
      return "nothing came back";
    case "cancelled":
      return "cancelled";
    case "another-window":
      return "a login from another window";
    case "no-longer-pending":
      return "a login already given up on";
  }
}

/** A cause as the one sentence a Notice carries - what happened, and nothing about what to do. */
function causeAsSentence(cause: LoginFailure): string {
  switch (cause.kind) {
    case "unreachable":
      return "The identity provider could not be reached at all.";
    case "endpoint-unresolvable":
      return "The configured Keycloak URL and realm do not resolve to a login endpoint.";
    case "provider-refused":
      return `The identity provider refused the login, with status ${cause.status}.`;
    case "redirect-not-registered":
      return "The identity provider does not accept the address this plugin listens on for the answer.";
    case "no-code":
      return "The login came back without an authorization code.";
    case "no-callback":
      return "The login was started and nothing ever came back from the browser.";
    case "cancelled":
      return "The login was ended before it finished.";
    case "another-window":
      return "A login started in another Obsidian window came back here.";
    case "no-longer-pending":
      return "A login came back here after it had already been given up on.";
  }
}

/** A cause with what to do about it - the settings tab's length, and the only surface with room for it. */
function causeWithRemedy(cause: LoginFailure): string {
  switch (cause.kind) {
    case "unreachable":
      return `${causeAsSentence(cause)} Check the Keycloak URL above and this machine's connection, then log in again.`;
    case "endpoint-unresolvable":
      return `${causeAsSentence(cause)} Check the Keycloak URL and the realm above against the safeLearn instance you are logging in to.`;
    case "provider-refused":
      return `${causeAsSentence(cause)} Logging in again is usually enough; if it keeps happening, whoever administers the realm can say why.`;
    case "redirect-not-registered":
      return `${causeAsSentence(cause)} It has to be a valid redirect URI on this plugin's own Keycloak client, which is something whoever administers the realm adds once.`;
    case "no-code":
      return `${causeAsSentence(cause)} Logging in again usually produces one; if it does not, the realm refused the login itself.`;
    case "no-callback":
      return `${causeAsSentence(cause)} The browser may have been closed before the login finished, or the answer was delivered to another Obsidian window - it goes to whichever one is in front, not to the one that asked. Log in again.`;
    case "cancelled":
      return `${causeAsSentence(cause)} Log in again whenever you want to.`;
    case "another-window":
      return `${causeAsSentence(cause)} That window is the one waiting for it, and nothing was logged in here. If you meant to log in here, start a login from here.`;
    case "no-longer-pending":
      return `${causeAsSentence(cause)} Nothing was logged in from it. Log in again if you still want to.`;
  }
}

/** The moment a login was started, in the reader's own clock - a duration would have to be recomputed to stay true, and nothing redraws it while it is read. */
function timeOfDay(at: number): string {
  return new Date(at).toLocaleTimeString();
}

/**
 * Roughly how long ago something happened, for the directory data's age.
 *
 * A duration rather than a clock time here, unlike `timeOfDay` above: the
 * question a person asks of directory data is "is this current?", which a
 * duration answers and a timestamp makes them do the arithmetic for. The
 * surfaces that show it redraw it (the settings line on its own interval, the
 * info view each time it opens), so it does not go quietly wrong the way the
 * login's own never-redrawn line would.
 */
function howLongAgo(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

/**
 * The directory's state in one line, for the settings tab and the info view
 * alike - `null` where the server could not tell us (an instance too old to
 * have the status endpoint, or one that could not be reached).
 */
function directoryStateSummary(state: DirectoryState | null): string {
  if (!state) return "Directory state unknown.";
  if (state.fetching) return directoryFetchProgressText(state);
  if (state.entries === null || state.builtAt === null) return "No directory data held yet.";
  return (
    `${state.entries} entries, built ${howLongAgo(state.builtAt)}` +
    (state.skipped > 0 ? `, ${state.skipped} record${state.skipped === 1 ? "" : "s"} skipped` : "")
  );
}

/** The state and its particulars in one sentence: what a Notice announces and what the status bar carries as its tooltip. */
function loginStateSentence(state: LoginState): string {
  switch (state.name) {
    case "logged-out":
      return "Not logged in.";
    case "logging-in":
      return `Logging in since ${timeOfDay(state.startedAt)}${state.instanceUrl ? `, against ${state.instanceUrl}` : ""}.`;
    case "logged-in":
      return state.account ? `Logged in as ${state.account}.` : "Logged in.";
    case "logged-in-without-role":
      return `${state.account ? `Logged in as ${state.account}` : "Logged in"}, but this account carries neither the teacher nor the admin role on this safeLearn instance.`;
    case "login-failed":
      return causeAsSentence(state.cause);
  }
}

/** The state in the fewest words that still name it - the status-bar item's own line. */
function loginStateInBrief(state: LoginState): string {
  return state.name === "login-failed"
    ? `${loginStateName(state)}: ${causeInBrief(state.cause)}`
    : loginStateName(state);
}

/**
 * The state, its particulars and what to do about it - the settings tab's
 * length. A `DocumentFragment` only for `logged-in-without-role`, so its hint
 * back at the `Server client id` field above can set that field's name apart
 * - a wrong value there and a role that is genuinely missing look identical
 * from here, and the setting is the cheaper thing to rule out first.
 */
function loginStateInFull(state: LoginState): string | DocumentFragment {
  switch (state.name) {
    case "logged-out":
      return 'Log in to use the directory picker, "List classes" and "Show directory info".';
    case "logging-in":
      return `${loginStateSentence(state)} The browser has the rest of it; this comes back on its own when it does.`;
    case "logged-in":
      return `${loginStateSentence(state)} The directory picker, "List classes" and "Show directory info" are available.`;
    case "logged-in-without-role": {
      const fragment = document.createDocumentFragment();
      fragment.append(
        `${loginStateSentence(state)} The directory picker, "List classes" and "Show directory info" will stay empty. ` +
          "Check the "
      );
      const fieldName = document.createElement("strong");
      fieldName.textContent = "Server client id";
      fragment.append(fieldName);
      fragment.append(
        " setting above first - a value that does not match this safeLearn server's own client hides a role " +
          "that is really assigned, the same as a role that is genuinely missing. Otherwise, ask whoever " +
          "administers the realm to grant one, or log in as a different account."
      );
      return fragment;
    }
    case "login-failed":
      return `${loginStateName(state)}. ${causeWithRemedy(state.cause)}`;
  }
}

export default class SafeLearnPlugin extends Plugin {
  data: SafeLearnPluginData = DEFAULT_DATA;

  /** In memory only - never written to `data.json`. See `design.md`. */
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  /** A login in progress, keyed by its `state`, so a mismatched callback can be told apart from a real one. */
  private pendingLogins = new Map<string, PendingLogin>();

  /**
   * The `state` of every login this instance started and then stopped waiting
   * on - expired, cancelled, or superseded by a later one.
   *
   * Without it a callback arriving late is indistinguishable from one belonging
   * to another window, and `plugin-login-state` requires those two to be told
   * apart. Bounded, because it is only ever read by a callback that can still
   * arrive: the oldest go first, which is the order they stop being able to.
   */
  private concludedLogins = new Set<string>();

  /**
   * Why the last login attempt ended without an identity, or `null` where
   * nothing has failed since one last succeeded.
   *
   * Nothing held this before - a failed exchange went to `console.error` and
   * was gone, which is why the person who could act on it never saw it.
   */
  private lastFailure: LoginFailure | null = null;

  /** Held so a login that completes can redraw it - the callback arrives while the tab is the very thing being looked at. */
  private settingTab: SafeLearnSettingTab | null = null;

  /** The status-bar item, while there is one. Absent - not empty - while no instance is configured, per `plugin-directory-auth`. */
  private statusBarItem: HTMLElement | null = null;

  /** The state last announced, as a signature, so that a state which has not changed is not announced again. */
  private announcedState: string | null = null;

  async onload() {
    console.log("✅ SafeLearn plugin loaded");

    this.data = Object.assign({}, DEFAULT_DATA, await this.loadData());

    this.registerEditorExtension(safelearnHighlighter);
    this.registerMarkdownPostProcessor((el, ctx) => hideTags(el, ctx, this));

    // The palette and the context menu are built from one list. Two lists would
    // be free to disagree, and the way that shows is a command present in one
    // and missing from the other - which reads as the menu being broken rather
    // than as an entry having been forgotten.
    for (const command of AUTHORING_COMMANDS) {
      this.addCommand({
        id: command.id,
        name: command.name,
        editorCallback: (editor) => command.run(editor, this),
      });
    }
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        // Every command, offered in whichever menu is passed in. A section is
        // what an entry needs only while it stands among Obsidian's own and
        // other plugins': inside a menu of our own it would buy nothing but
        // separators between them.
        const offerAll = (target: Menu, section: string | null) => {
          for (const command of AUTHORING_COMMANDS) {
            target.addItem((entry) => {
              entry
                .setTitle(command.name)
                .setIcon(command.icon)
                .onClick(() => command.run(editor, this));
              if (section !== null) entry.setSection(section);
            });
          }
        };

        // Where nothing can be nested, the menu this plugin builds is the one
        // it built before this change: the commands standing together in a
        // section of their own. Asked before anything is added rather than
        // discovered halfway through - an entry that opens nothing is not that
        // menu.
        if (!canNestMenus()) {
          offerAll(menu, MENU_SECTION);
          return;
        }

        // One entry, with everything under it. The menu belongs to Obsidian and
        // other plugins fill it too, so what this plugin costs somebody who
        // wants none of it is one line rather than one per command.
        menu.addItem((item) => {
          item
            // A section of its own is how the entry says where it belongs among
            // Obsidian's groups rather than landing wherever the order of
            // subscription put it. Asked of the one entry now, not of each.
            .setSection(MENU_SECTION)
            .setTitle(MENU_TITLE)
            .setIcon(MENU_ICON);
          offerAll(item.setSubmenu(), null);
        });
      })
    );

    this.settingTab = new SafeLearnSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.registerObsidianProtocolHandler(this.protocolAction(), (params) => this.handleAuthCallback(params));

    // Read-only, no editor needed - this is not one of `AUTHORING_COMMANDS`.
    // `checkCallback` is Obsidian's own mechanism for a command that is only
    // sometimes available: returning `false` here is what keeps it out of the
    // palette while no login is held, per `plugin-directory-auth`'s "stays
    // silent" requirement - see `tasks.md` #6.4.
    this.addCommand({
      id: "list-classes",
      name: "List classes",
      checkCallback: (checking) => {
        if (!this.hasLogin()) return false;
        if (!checking) void this.listClasses();
        return true;
      },
    });

    // Gated on `hasDirectoryRole()`, not just `hasLogin()` like "List classes"
    // above: the view's whole point is a teacher/admin overview, so it stays
    // out of the palette for the same two cases `plugin-directory-info-view`
    // names - no connection held, and one held without the role.
    this.addCommand({
      id: "show-directory-info",
      name: "Show directory info",
      checkCallback: (checking) => {
        if (!this.hasDirectoryRole()) return false;
        if (!checking) new DirectoryInfoModal(this).open();
        return true;
      },
    });

    // A login in progress ends itself when its lifetime passes, on a timer
    // rather than on the next read of the state: a status-bar item that only
    // corrects itself when somebody opens the settings is the same defect
    // wearing a different hat. Registered through `registerInterval` so
    // Obsidian tears it down with the plugin.
    this.registerInterval(window.setInterval(() => this.expirePendingLogins(), EXPIRY_TICK_MS));

    // Not awaited: onload should not block Obsidian's own startup on a
    // network round trip. See `tasks.md` #5.2. What has changed is that the
    // interval it takes is no longer indistinguishable from being logged out -
    // `restoreLogin` registers it as a login in progress first.
    if (this.data.refreshToken) void this.restoreLogin();

    // Draws the status-bar item for whatever state the above just put the
    // plugin in. Announces nothing: neither state it can be in here is one
    // this plugin announces, and a Notice at every start would be noise.
    this.notifyLoginStateChanged();
  }

  // ################### Settings (2) ###################

  async saveSettings() {
    await this.saveData(this.data);
  }

  /**
   * Console logging for the login/directory-search path, gated behind the
   * "Debug logging" setting so it stays off by default and can be switched on
   * from the settings tab only while troubleshooting.
   */
  private debugLog(...args: unknown[]) {
    if (this.data.debugLogging) console.log("[SafeLearn debug]", ...args);
  }

  /** The configured safeLearn instance URL, or `null` if unset - callers never re-check for blank/whitespace themselves. */
  instanceUrl(): string | null {
    const trimmed = this.data.instanceUrl.trim();
    return trimmed === "" ? null : ensureProtocol(trimmed);
  }

  private keycloakUrl(): string {
    const trimmed = this.data.keycloakUrl.trim();
    return trimmed === "" ? DEFAULT_DATA.keycloakUrl : ensureProtocol(trimmed);
  }

  private realm(): string {
    const trimmed = this.data.realm.trim();
    return trimmed === "" ? DEFAULT_DATA.realm : trimmed;
  }

  private serverClientId(): string {
    const trimmed = this.data.serverClientId.trim();
    return trimmed === "" ? DEFAULT_DATA.serverClientId : trimmed;
  }

  private authorizationEndpoint(): string {
    return `${stripTrailingSlash(this.keycloakUrl())}/realms/${this.realm()}/protocol/openid-connect/auth`;
  }

  private tokenEndpoint(): string {
    return `${stripTrailingSlash(this.keycloakUrl())}/realms/${this.realm()}/protocol/openid-connect/token`;
  }

  /** `obsidian://<manifest-id>-auth` - namespaced by the plugin's own id, since the action name is a namespace every plugin shares. See `design.md`. */
  private protocolAction(): string {
    return `${this.manifest.id}-auth`;
  }

  private redirectUri(): string {
    return `obsidian://${this.protocolAction()}`;
  }

  // ################### Login state ###################

  /** Whether the plugin currently holds a usable identity. Everything that depends on a login checks this, and only this. */
  hasLogin(): boolean {
    return this.accessToken !== null;
  }

  /**
   * Whether the held token's own claims carry the teacher/admin role the directory
   * endpoint gates on. Diagnostic only, for the settings tab - nothing else gates on
   * this, since the endpoint's own refusal already collapses "no role" into the same
   * response as "not logged in" (`app.js`), and every other feature must keep doing
   * the same rather than being able to tell the two apart from a failed call.
   *
   * Mirrors `verifyCallerIdentity` in the server's `directory-service.js`, which
   * merges the same two sources: the client roles nested under the configured
   * `serverClientId` setting in `resource_access`, and the LDAP claim's `OU=...`
   * groups. The client-role check reads that setting, never the token's own
   * `azp` - `azp` is always this plugin's own client (`DIRECTORY_CLIENT_ID`),
   * which by design never carries client roles of its own.
   */
  hasDirectoryRole(): boolean {
    if (!this.accessToken) return false;
    const payload = accessTokenPayload(this.accessToken);
    const roles = accessTokenResourceRoles(this.accessToken, this.serverClientId());
    if (roles.includes("teacher") || roles.includes("teachers") || roles.includes("admin")) {
      return true;
    }
    return ldapCarriesTeacherOrAdmin(payload?.ldap);
  }

  /**
   * Which of `plugin-login-state`'s five states the login is in.
   *
   * The one derivation, from what is already held: the pending entries, the
   * tokens, and the last recorded failure. It has no side effects - it expires
   * nothing, records nothing and draws nothing - so that every surface can call
   * it as often as it likes and a check can construct a situation and ask.
   *
   * The order the four inputs are consulted in is the whole of the design:
   *
   * - A login in progress comes first, because a person who has just clicked
   *   "Log in" is logging in whatever else is true, and because a restore that
   *   has not concluded must not read as being logged out.
   * - A held identity comes next, and above any recorded failure. A failed
   *   attempt while an identity is still held leaves the directory working, and
   *   a surface saying "login failed" over a login that works is exactly the
   *   disagreement between what is shown and what a call will do that this
   *   change exists to end. The Notice still names that failure once.
   * - A pending entry past its lifetime reads as the failure the timer is about
   *   to record, rather than as nothing at all, so the two cannot disagree in
   *   the tick between them.
   *
   * "A usable identity" is the same question `hasLogin` asks, and deliberately
   * so: a state derived from a stricter test than the one everything gates on
   * would be a state that disagrees with what a call will do.
   */
  loginState(): LoginState {
    const now = Date.now();
    let expired: PendingLogin | null = null;
    for (const pending of this.pendingLogins.values()) {
      if (now < pending.expiresAt) {
        return { name: "logging-in", startedAt: pending.startedAt, instanceUrl: pending.instanceUrl };
      }
      expired = pending;
    }

    if (this.accessToken) {
      const account = accessTokenAccountName(this.accessToken);
      return this.hasDirectoryRole()
        ? { name: "logged-in", account }
        : { name: "logged-in-without-role", account };
    }

    if (expired) return { name: "login-failed", cause: { kind: "no-callback" } };
    if (this.lastFailure) return { name: "login-failed", cause: this.lastFailure };
    return { name: "logged-out" };
  }

  /**
   * Every surface, from one place, whenever a fact behind the state changed.
   *
   * Called after an exchange, after a refresh, on logout, on a cancellation, on
   * an expiry and on a rejected callback. Before this the plugin had exactly one
   * redraw in it, put where the one path anybody noticed was broken - which is
   * why the other four went on showing a state that had stopped being true.
   */
  private notifyLoginStateChanged() {
    const state = this.loginState();
    this.renderStatusBar(state);
    // Redrawn whether or not it is open: a tab that is closed rebuilds a
    // container nobody is looking at, and asking Obsidian whether this
    // particular tab is the one on screen is more machinery than that costs.
    this.settingTab?.display();
    this.announceLoginState(state);
  }

  /**
   * The status-bar item: the state, for as long as the state lasts, without the
   * settings being open.
   *
   * It exists only while an instance is configured. `plugin-directory-auth`
   * asks for absence and not for an empty or neutral item, and an item saying
   * "Not logged in" on a vault that has never been pointed at a safeLearn
   * instance would be exactly the thing it forbids.
   */
  private renderStatusBar(state: LoginState) {
    if (!this.instanceUrl()) {
      this.statusBarItem?.remove();
      this.statusBarItem = null;
      return;
    }

    if (!this.statusBarItem) {
      this.statusBarItem = this.addStatusBarItem();
      this.statusBarItem.addClass("safelearn-login-status");
      // Every remedy the settings tab names is in the settings tab, so that is
      // where the one clickable thing carrying a state goes.
      this.statusBarItem.addEventListener("click", () => this.openOwnSettings());
    }

    this.statusBarItem.setText(`SafeLearn: ${loginStateInBrief(state)}`);
    // The state name as a value rather than as a colour or a word, so that a
    // check reads what the plugin concluded and not how it was worded.
    this.statusBarItem.dataset.safelearnLoginState = state.name;
    this.statusBarItem.setAttr("aria-label", loginStateSentence(state));
  }

  /** Opens this plugin's own settings tab, which is what the status-bar item is for. */
  private openOwnSettings() {
    this.app.setting.open();
    this.app.setting.openTabById(this.manifest.id);
  }

  /**
   * Announces a state that differs from the one last announced, and only that.
   *
   * A change of failure cause counts as a change even where the state name does
   * not, because "login failed" twice for two different reasons is two things a
   * person needs to know. A background renewal that leaves the state exactly
   * where it was announces nothing, which is what keeps a flapping refresh from
   * becoming a stream of notices.
   *
   * Only the three states worth interrupting somebody for are announced. Being
   * logged out and starting a login are both things a person just did, and the
   * status-bar item carries them for as long as they last.
   */
  private announceLoginState(state: LoginState) {
    const signature =
      state.name === "login-failed"
        ? `${state.name}:${state.cause.kind}:${"status" in state.cause ? state.cause.status : ""}`
        : state.name;
    if (signature === this.announcedState) return;
    this.announcedState = signature;

    if (state.name === "logged-out" || state.name === "logging-in") return;
    this.announceLogin(loginStateSentence(state));
  }

  /** Raises one Notice, unless no instance is configured - in which case this plugin says nothing about a login anywhere. */
  private announceLogin(text: string) {
    if (!this.instanceUrl()) return;
    new Notice(`SafeLearn: ${text}`);
  }

  /** Records why a login ended without an identity, and tells every surface. Settling the pending entries is the caller's, which is where that is known. */
  private failLogin(cause: LoginFailure) {
    this.lastFailure = cause;
    this.notifyLoginStateChanged();
  }

  /** How long a login in progress is given: what the realm itself last answered for a refresh token, read at the moment the login starts. */
  private pendingLoginLifetimeMs(): number {
    const seconds = Number(this.data.refreshTokenLifetimeSeconds);
    const usable = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_DATA.refreshTokenLifetimeSeconds;
    return usable * 1000;
  }

  /** Stops waiting on every login in progress, remembering each so a callback arriving afterwards can say what became of it. */
  private concludePendingLogins() {
    for (const state of this.pendingLogins.keys()) this.rememberConcluded(state);
    this.pendingLogins.clear();
  }

  private rememberConcluded(state: string) {
    this.concludedLogins.add(state);
    while (this.concludedLogins.size > CONCLUDED_LOGINS_KEPT) {
      const oldest = this.concludedLogins.values().next().value;
      if (oldest === undefined) break;
      this.concludedLogins.delete(oldest);
    }
  }

  /**
   * Ends a login that has been in progress longer than its lifetime.
   *
   * This is what turns *logging in* into *login failed* without anybody having
   * to click, and it is the only thing that ever ends a login nobody came back
   * from. The entry is dropped: `plugin-login-state` says nothing is retained
   * past that point, and the `state` is remembered instead, which is what lets
   * a callback that turns up afterwards be told from a stray one.
   */
  private expirePendingLogins() {
    const now = Date.now();
    let expired = false;
    for (const [state, pending] of [...this.pendingLogins]) {
      if (now < pending.expiresAt) continue;
      this.pendingLogins.delete(state);
      this.rememberConcluded(state);
      expired = true;
    }
    if (!expired) return;
    this.failLogin({ kind: "no-callback" });
  }

  /**
   * The renewal that follows a restart, shown as what it is.
   *
   * It is registered as a login in progress before it fires, so the interval
   * between Obsidian starting and the token landing reads as *logging in*
   * rather than as *not logged in*, and it is removed in a `finally` so that
   * interval ends whichever way the renewal went. Not awaited by `onload`: the
   * whole point of the state is that the start of the application is not held
   * up waiting for it.
   */
  private async restoreLogin() {
    // Prefixed, and with no verifier: a callback can never carry this `state`,
    // since a `state` only ever comes back from one this plugin sent.
    const key = `restore:${randomPkceString()}`;
    const startedAt = Date.now();
    this.pendingLogins.set(key, {
      verifier: null,
      startedAt,
      expiresAt: startedAt + this.pendingLoginLifetimeMs(),
      instanceUrl: this.instanceUrl(),
    });
    this.notifyLoginStateChanged();

    try {
      await this.refreshAccessToken();
    } finally {
      this.pendingLogins.delete(key);
      this.notifyLoginStateChanged();
    }
  }

  // ################### PKCE login (4) ###################

  /**
   * Starts a login: opens the realm's own login page in the system browser and
   * returns immediately - the rest happens in `handleAuthCallback`.
   *
   * Reachable from every state, `logging in` and `login failed` included, and
   * starting again supersedes whatever was already in flight rather than adding
   * to it: `plugin-login-state` asks for exactly one login in progress
   * afterwards, and two entries waiting on two browser tabs is a state nobody
   * could read.
   */
  async login() {
    const verifier = randomPkceString();
    const state = randomPkceString();
    const challenge = await pkceChallenge(verifier);

    // Built before anything is registered: a Keycloak URL that resolves to
    // nothing is a failure of this login, and a pending entry that was never
    // sent anywhere would sit there until it expired.
    let url: URL;
    try {
      url = new URL(this.authorizationEndpoint());
    } catch {
      this.concludePendingLogins();
      this.failLogin({ kind: "endpoint-unresolvable" });
      return;
    }

    this.concludePendingLogins();
    const startedAt = Date.now();
    this.pendingLogins.set(state, {
      verifier,
      startedAt,
      expiresAt: startedAt + this.pendingLoginLifetimeMs(),
      instanceUrl: this.instanceUrl(),
    });
    // The attempt now in progress is what is true; the last one's failure is
    // not, and leaving it recorded would outlive the state it belonged to.
    this.lastFailure = null;
    this.notifyLoginStateChanged();

    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", DIRECTORY_CLIENT_ID);
    url.searchParams.set("redirect_uri", this.redirectUri());
    url.searchParams.set("scope", "openid");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    // Obsidian polyfills `window.open` to the OS's default browser on both
    // desktop and mobile - no Electron-specific call, so this is unchanged
    // wherever the plugin runs. See `design.md`.
    window.open(url.toString());
  }

  /** Discards the held identity. Nothing that depends on a login is offered again until logging in. */
  logout() {
    this.data.refreshToken = null;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.lastFailure = null;
    this.concludePendingLogins();
    void this.saveSettings();
    this.notifyLoginStateChanged();
  }

  /**
   * Ends a login in progress without waiting for it to expire.
   *
   * The lifetime a login gets is the realm's figure for a refresh token, which
   * on a realm with long sessions is far longer than anybody waits on a browser
   * round trip - so `plugin-login-state` requires a way out that is not the
   * timer. Recorded as a cancellation rather than as nothing, because the state
   * it leaves behind is a person's own doing and reads wrongly as "not logged
   * in", which is what it was before they clicked anything.
   */
  cancelLogin() {
    if (this.pendingLogins.size === 0) return;
    this.concludePendingLogins();
    this.failLogin({ kind: "cancelled" });
  }

  /**
   * Handles `obsidian://<manifest-id>-auth?...`.
   *
   * `obsidian://` callbacks are dispatched to whichever Obsidian window is
   * frontmost, not necessarily the vault that started the login. That is the
   * environment and not a defect to fix - what changed is that this window no
   * longer returns in silence from any of its three exits. The window a
   * callback lands in is the one window that knows what became of that login,
   * and it used to be the one that said nothing.
   *
   * Nothing here coordinates with the window that is still waiting. It gets its
   * own expiry, which is the honest answer: from where it stands, a callback
   * that went elsewhere and a callback that never existed are one observation.
   */
  private async handleAuthCallback(params: Record<string, string>) {
    const state = params.state;
    const held = typeof state === "string" ? this.pendingLogins.get(state) : undefined;
    // Past its lifetime is past it, whether or not the timer has come round to
    // sweeping the entry yet. The alternative is a login that completes or does
    // not depending on which second the callback lands in.
    const expired = held !== undefined && Date.now() >= held.expiresAt;
    const pending = held !== undefined && !expired ? held : undefined;

    if (expired && typeof state === "string") {
      this.pendingLogins.delete(state);
      this.rememberConcluded(state);
    }

    if (!pending || pending.verifier === null || typeof state !== "string") {
      // Told apart by what this window remembers: a `state` it once waited on
      // and gave up is a login of its own that came back too late, and anything
      // else was begun somewhere this window knows nothing about. It names no
      // vault, because there is nothing here to name it from.
      const cause: LoginFailure =
        typeof state === "string" && (expired || this.concludedLogins.has(state))
          ? { kind: "no-longer-pending" }
          : { kind: "another-window" };
      this.lastFailure = cause;
      this.notifyLoginStateChanged();
      // A callback landing while this window waits on a login of its own leaves
      // the state at *logging in*, which is what `plugin-login-state` requires -
      // and so the notifier announced nothing. The observation is still this
      // window's to report, so it is reported here rather than swallowed by a
      // state that outranks it.
      if (this.loginState().name !== "login-failed") this.announceLogin(causeAsSentence(cause));
      return;
    }

    this.pendingLogins.delete(state);
    this.rememberConcluded(state);

    if (typeof params.code !== "string") {
      this.failLogin({ kind: "no-code" });
      return;
    }

    try {
      await this.exchangeCodeForTokens(params.code, pending.verifier);
      this.lastFailure = null;
      this.notifyLoginStateChanged();
    } catch (error) {
      this.failLogin(failureOf(error));
    }
  }

  private async exchangeCodeForTokens(code: string, verifier: string) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri(),
      client_id: DIRECTORY_CLIENT_ID,
      code_verifier: verifier,
    });
    await this.applyTokenResponse(body);
  }

  // ################### Token storage and refresh (5) ###################

  /**
   * Refreshes the access token from the stored refresh token.
   *
   * A failure here - the refresh token itself expired or was revoked -
   * clears it and returns the plugin to "not logged in" rather than being
   * retried on every subsequent call. See `tasks.md` #5.4. That is unchanged;
   * what it gains is a cause somebody can read, in place of a `false` that
   * every caller turned back into "not logged in" without a reason.
   */
  async refreshAccessToken(): Promise<boolean> {
    const refreshToken = this.data.refreshToken;
    if (!refreshToken) return false;

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: DIRECTORY_CLIENT_ID,
    });

    try {
      await this.applyTokenResponse(body);
      this.lastFailure = null;
      this.notifyLoginStateChanged();
      return true;
    } catch (error) {
      this.data.refreshToken = null;
      this.accessToken = null;
      this.accessTokenExpiresAt = 0;
      void this.saveSettings();
      this.failLogin(failureOf(error));
      return false;
    }
  }

  /**
   * The one request that obtains tokens, for both grants.
   *
   * Every way out of it that is not a token is a cause, constructed here
   * because here is where it was observed: the address that could not be built,
   * the request nothing answered, the status the answer carried. A caller two
   * frames up cannot tell any of those apart, which is why the failure travels
   * as a tag rather than as a `false`.
   */
  private async applyTokenResponse(body: URLSearchParams) {
    let endpoint: string;
    try {
      endpoint = new URL(this.tokenEndpoint()).toString();
    } catch {
      throw new LoginFailureError({ kind: "endpoint-unresolvable" });
    }

    let response;
    try {
      response = await requestUrl({
        url: endpoint,
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        body: body.toString(),
        throw: false,
      });
    } catch {
      // `throw: false` covers an answer that carries a status. It does not
      // cover a request that never got one, and that is the single observation
      // separating a host which is not there from a realm which refused.
      throw new LoginFailureError({ kind: "unreachable" });
    }

    if (response.status >= 400) throw new LoginFailureError(refusalOf(response.status, response.text));

    const json = response.json;
    this.accessToken = json.access_token;
    this.accessTokenExpiresAt = Date.now() + Math.max(0, Number(json.expires_in) - 30) * 1000;
    this.data.refreshToken = json.refresh_token ?? this.data.refreshToken;
    // Kept, where it used to be dropped: this is the realm's own figure for how
    // long the token it just issued lives, and it is what a login in progress
    // is given to conclude in. See `design.md`.
    const lifetime = Number(json.refresh_expires_in);
    if (Number.isFinite(lifetime) && lifetime > 0) this.data.refreshTokenLifetimeSeconds = lifetime;
    await this.saveSettings();
  }

  /** Refreshes the access token first when it is missing or close to expiry. Called before every directory client call. */
  private async ensureAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      this.debugLog("ensureAccessToken: reusing cached token, expires in", Math.round((this.accessTokenExpiresAt - Date.now()) / 1000), "s");
      return this.accessToken;
    }
    this.debugLog("ensureAccessToken: cached token missing/expired, refreshing");
    const refreshed = await this.refreshAccessToken();
    this.debugLog("ensureAccessToken: refresh outcome", refreshed, "lastFailure", this.lastFailure);
    return refreshed ? this.accessToken : null;
  }

  // ################### Directory client (3) ###################

  /**
   * Searches the configured instance's directory. An empty `query` asks for
   * the whole directory - what "list classes" and the class-filter dropdown
   * both build on, now that the endpoint answers one that way.
   *
   * A refusal from the endpoint - no token, an expired one, or a caller
   * lacking teacher/admin - is deliberately undifferentiated here from not
   * being logged in at all (`tasks.md` #3.2 of `plugin-admin-directory-ui`):
   * both come back as `"refused"`, which the caller renders exactly as an
   * absent picker would, nothing shown. An instance that could not be reached
   * at all and a request the server itself failed on are told apart from that
   * and from each other - `design.md`'s "`searchDirectory` reports an
   * outcome, not just a result list".
   */
  async searchDirectory(query: string): Promise<DirectorySearchResult> {
    const instanceUrl = this.instanceUrl();
    if (!instanceUrl) {
      this.debugLog("searchDirectory: refused, no instance URL configured");
      return { outcome: "refused", entries: [] };
    }

    const token = await this.ensureAccessToken();
    if (!token) {
      this.debugLog("searchDirectory: refused, ensureAccessToken returned no token");
      return { outcome: "refused", entries: [] };
    }

    const url = `${stripTrailingSlash(instanceUrl)}/api/admin/directory/search?q=${encodeURIComponent(query)}`;
    this.debugLog("searchDirectory: requesting", url);
    let response;
    try {
      response = await requestUrl({
        url,
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        throw: false,
      });
    } catch (error) {
      this.debugLog("searchDirectory: unreachable,", error);
      return { outcome: "unreachable", entries: [] };
    }
    this.debugLog("searchDirectory: response status", response.status, "body", response.text);
    if (response.status === 403) return { outcome: "refused", entries: [] };
    // Checked ahead of the `>=400` line below because it is not a failure: the
    // server has no directory data to match against yet and is building it, and
    // the body carries how far along. Only a server old enough to predate
    // `show-directory-fetch-progress` will never answer this way.
    if (response.status === 202) {
      return { outcome: "fetching", entries: [], progress: directoryProgressOf(response.json) };
    }
    if (response.status >= 400) return { outcome: "failed", entries: [] };

    const body = response.json;
    if (!Array.isArray(body)) return { outcome: "failed", entries: [] };
    return {
      outcome: "ok",
      entries: body.map((entry) => ({ name: String(entry?.name ?? ""), roles: entry?.roles ?? {} })),
    };
  }

  /**
   * What the instance holds and what it is doing about it, or `null` for
   * "cannot be determined".
   *
   * Every non-`ok` response collapses into that `null`, the `404` an instance
   * too old to carry this endpoint answers with included: a plugin released
   * ahead of a server (which happens routinely - the Obsidian store takes
   * roughly a day to reach other vaults) must degrade to saying it does not
   * know, never to reporting a failure that isn't one.
   */
  async directoryStatus(): Promise<DirectoryState | null> {
    const instanceUrl = this.instanceUrl();
    if (!instanceUrl) return null;

    const token = await this.ensureAccessToken();
    if (!token) return null;

    const url = `${stripTrailingSlash(instanceUrl)}/api/admin/directory/status`;
    let response;
    try {
      response = await requestUrl({ url, method: "GET", headers: { Authorization: `Bearer ${token}` }, throw: false });
    } catch (error) {
      this.debugLog("directoryStatus: unreachable,", error);
      return null;
    }
    this.debugLog("directoryStatus: response status", response.status, "body", response.text);
    if (response.status >= 300) return null;

    const body = response.json;
    if (!body || typeof body !== "object") return null;
    return {
      ...directoryProgressOf(body),
      fetching: body.fetching === true,
      entries: typeof body.entries === "number" ? body.entries : null,
      builtAt: typeof body.builtAt === "number" ? body.builtAt : null,
      skipped: typeof body.skipped === "number" ? body.skipped : 0,
    };
  }

  // ################### "List classes" command (6) ###################

  private async listClasses() {
    let result = await this.searchDirectory("");
    if (result.outcome === "fetching") {
      // The notice is the waiting surface here: there is no dialog to fill in,
      // so the progress replaces its own text in place until the fetch resolves.
      const notice = new Notice(directoryFetchProgressText(result.progress ?? null), 0);
      const wait = new DirectoryFetchWait(this);
      const waited = await wait.untilDone(
        () => this.searchDirectory(""),
        (progress) => notice.setMessage(directoryFetchProgressText(progress))
      );
      notice.hide();
      if (!waited) return;
      result = waited;
    }
    if (result.outcome === "unreachable") {
      new Notice("The directory could not be reached.", 0);
      return;
    }
    if (result.outcome !== "ok") {
      new Notice("The directory search failed.", 0);
      return;
    }
    const classes = classLikeValues(result.entries);
    new Notice(
      classes.length > 0
        ? `Classes in the directory: ${classes.join(", ")}`
        : "The directory currently holds no class-like role/group value.",
      0
    );
  }
}

/**
 * Waits out a directory fetch on one surface's behalf: poll the instance's
 * status every two seconds while it says a fetch is running, and re-issue the
 * search once it says one is not.
 *
 * The *status* is what is polled, never the search: a search re-issued every
 * two seconds would risk materializing and transferring some fourteen thousand
 * entries per tick, where the status endpoint reads process memory and carries
 * a handful of numbers.
 *
 * A status reporting no fetch while the caller is still being answered `202` is
 * a fetch that died or was abandoned. The search is then re-issued - which
 * starts a new one - exactly once more; a second `202` after that resolves as
 * the surface's ordinary failure indication instead. That bound is what keeps a
 * fetch that keeps dying from becoming an endless poll.
 *
 * `stop()` ends the wait for good, and is what a closing dialog calls so that
 * nothing is left polling behind it.
 */
class DirectoryFetchWait {
  private timer: number | undefined;
  private stopped = false;

  constructor(private readonly plugin: SafeLearnPlugin) {}

  stop() {
    this.stopped = true;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private tick(): Promise<void> {
    return new Promise((resolve) => {
      this.timer = window.setTimeout(resolve, DIRECTORY_POLL_MS);
    });
  }

  /**
   * Resolves with the search's result once the fetch is over, or `null` when
   * `stop()` ended the wait. `show` is called with each progress reading, so a
   * surface renders the same figures this is deciding on.
   */
  async untilDone(
    search: () => Promise<DirectorySearchResult>,
    show: (progress: DirectoryFetchProgress | null) => void
  ): Promise<DirectorySearchResult | null> {
    let reissuedOnce = false;
    for (;;) {
      await this.tick();
      if (this.stopped) return null;

      const state = await this.plugin.directoryStatus();
      if (this.stopped) return null;
      if (state?.fetching) {
        show(state);
        continue;
      }

      const result = await search();
      if (this.stopped) return null;
      if (result.outcome !== "fetching") return result;
      if (reissuedOnce) return { outcome: "failed", entries: [] };
      reissuedOnce = true;
      show(result.progress ?? null);
    }
  }
}

/**
 * The plugin's own settings: the safeLearn instance URL, its Keycloak realm,
 * and the login controls. See `design.md` for why Keycloak URL and realm are
 * settings of their own rather than derived from the instance URL.
 */
class SafeLearnSettingTab extends PluginSettingTab {
  /** The interval keeping the directory summary current, while this tab is the one on screen. */
  private directoryPoll: number | undefined;

  constructor(
    app: App,
    private readonly plugin: SafeLearnPlugin
  ) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    // `display()` runs again on the instance-URL field's blur, and the elements
    // the previous run's interval was writing into have just been emptied out
    // from under it.
    this.stopDirectoryPoll();

    new Setting(containerEl)
      .setName("safeLearn instance URL")
      .setDesc(
        "The base URL of your school's safeLearn server. Left empty, every directory feature below stays off."
      )
      .addText((text) => {
        text
          .setPlaceholder("https://safelearn.example.org")
          .setValue(this.plugin.data.instanceUrl)
          .onChange(async (value) => {
            this.plugin.data.instanceUrl = value;
            await this.plugin.saveSettings();
          });
        // Refreshed on blur, not on every keystroke: rebuilding the whole tab
        // per character would drop the field's focus while typing.
        text.inputEl.addEventListener("blur", () => this.display());
      });

    new Setting(containerEl)
      .setName("Keycloak URL")
      .setDesc("The identity provider your safeLearn instance authenticates against. Only needed for a self-hosted Keycloak.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_DATA.keycloakUrl)
          .setValue(this.plugin.data.keycloakUrl)
          .onChange(async (value) => {
            this.plugin.data.keycloakUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Realm")
      .setDesc("The Keycloak realm your safeLearn instance uses.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_DATA.realm)
          .setValue(this.plugin.data.realm)
          .onChange(async (value) => {
            this.plugin.data.realm = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Server client id")
      .setDesc(
        "The Keycloak client id your safeLearn server itself is registered under " +
          "(its own keycloak.json's \"resource\") - not this plugin's client id. " +
          "Only affects the Login status shown below, never what the server itself authorizes."
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_DATA.serverClientId)
          .setValue(this.plugin.data.serverClientId)
          .onChange(async (value) => {
            this.plugin.data.serverClientId = value;
            await this.plugin.saveSettings();
          })
      );

    // Off by default so a normal install never logs token-adjacent detail;
    // switched on only while troubleshooting a login/directory-search problem.
    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc(
        "Logs login and directory-search detail (token cache/refresh outcome, request URL, response " +
          "status/body - never the token itself) to the developer console. Off by default."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.data.debugLogging).onChange(async (value) => {
          this.plugin.data.debugLogging = value;
          await this.plugin.saveSettings();
        })
      );

    // Everything below depends on a configured instance, and stays silent -
    // not shown, not an error - while there is none. See `plugin-directory-auth`.
    if (!this.plugin.instanceUrl()) return;

    // The state, and not a boolean. `hasLogin()` is still the one question
    // everything that makes a call asks; it stopped being the question this is
    // rendered from, because four of the five situations a person has to tell
    // apart collapse into it.
    const state = this.plugin.loginState();
    const login = new Setting(containerEl).setName("Login").setDesc(loginStateInFull(state));
    login.settingEl.addClass("safelearn-login-setting");
    // Read by a check, and by the stylesheet, so that neither has to recognise
    // the state from the words it happens to be worded with.
    login.settingEl.dataset.safelearnLoginState = state.name;

    // Ending a login in progress, which before this was reachable from nowhere:
    // the tab offered "Log in" or "Log out" and had nothing in between.
    if (state.name === "logging-in") {
      login.addButton((button) => button.setButtonText("Cancel").onClick(() => this.plugin.cancelLogin()));
    }

    if (state.name === "logged-in" || state.name === "logged-in-without-role") {
      login.addButton((button) => button.setButtonText("Log out").onClick(() => this.plugin.logout()));
    }

    // Offered in every state, `plugin-login-state`'s requirement: a failed
    // login is retried without first logging out or restarting anything, and a
    // login in progress is superseded rather than added to.
    const holdsIdentity = state.name === "logged-in" || state.name === "logged-in-without-role";
    login.addButton((button) =>
      button
        .setButtonText(holdsIdentity ? "Log in again" : state.name === "logging-in" ? "Start again" : "Log in")
        .setCta()
        .onClick(() => void this.plugin.login())
    );

    // Gated on exactly what the "Show directory info" command is gated on, so
    // the two entry points appear and disappear together - the palette is
    // simply not where somebody who does not already know this view exists
    // will find it.
    if (!this.plugin.hasDirectoryRole()) return;

    const directory = new Setting(containerEl)
      .setName("Directory")
      .setDesc("Directory state unknown.")
      .addButton((button) =>
        button.setButtonText("Show directory info").onClick(() => new DirectoryInfoModal(this.plugin).open())
      );
    directory.settingEl.addClass("safelearn-directory-setting");

    // Only this one line's text is rewritten, never the tab: calling `display()`
    // on a timer would drop the focus out of whichever field was being typed
    // into, the same reason the instance-URL field refreshes on blur instead of
    // per keystroke.
    const refresh = async () => {
      directory.setDesc(directoryStateSummary(await this.plugin.directoryStatus()));
    };
    void refresh();
    this.directoryPoll = window.setInterval(() => void refresh(), DIRECTORY_POLL_MS);

    // Nothing redraws this tab from here. Every control above changes a fact
    // the state is derived from, and each of those calls the one notifier,
    // which redraws this tab among the rest. A `this.display()` next to a
    // control would be the arrangement that let four of five paths go stale.
  }

  /** Obsidian calls this when the tab stops being the one on screen - nothing should be polling for a page nobody is reading. */
  hide() {
    this.stopDirectoryPoll();
  }

  private stopDirectoryPoll() {
    if (this.directoryPoll !== undefined) window.clearInterval(this.directoryPoll);
    this.directoryPoll = undefined;
  }
}

// ################### What counts as a tag ###################

/**
 * The rules below are the renderer's rules, not this plugin's.
 *
 * The plugin enforces nothing. Its whole value is that a person writing a
 * document can see what the server will do with it before publishing - so where
 * the two disagree the marking does not merely mislead about a detail, it
 * misleads about the only thing it is for. Each rule here is written as
 * `obsidian.js` writes it, and there is one of each, used by the editor and by
 * the rendered view alike: two rules for one tag form in one plugin is what let
 * the two halves drift apart in opposite directions.
 *
 * Every rule is returned from a function rather than kept in a constant. A
 * global regular expression remembers where it last stopped, so a shared one
 * asked twice whether it matches answers differently the second time.
 */

const FRAGMENT = "##fragment";
const SIDE_BY_SIDE_START = "##side-by-side-start";
const SIDE_BY_SIDE_END = "##side-by-side-end";
const SEPARATOR = "##separator";

/** `preprocessFragments`: case-sensitive, anywhere in the line, every occurrence, wherever whitespace or the end follows. */
function fragmentPattern(): RegExp {
  return /##fragment(?=\s|$)/g;
}

/** `preprocessSideBySide`: the three markers, case-sensitive, as plain substrings. */
function blockMarkerPattern(): RegExp {
  return /##(?:side-by-side-(?:start|end)|separator)/g;
}

/** `inlinePermissionRegex`: a line that is `@@@`, with or without the roles it names. */
function permissionMarkerPattern(): RegExp {
  return /^[ \t]*@@@.*$/gm;
}

/**
 * Every `##fragment` in a line, each with the extent of what actually matched.
 *
 * The extent comes from the match and never from an assumed spelling of the tag:
 * a length computed from `"##fragment "` is one character too long for the same
 * tag at the end of a line, and reaches into the line after it.
 */
function fragmentsIn(text: string): { index: number; length: number }[] {
  const found: { index: number; length: number }[] = [];
  const pattern = fragmentPattern();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    found.push({ index: match.index, length: match[0].length });
  }
  return found;
}

/**
 * Whether a line is nothing but the given block marker.
 *
 * This is a deliberate divergence from the renderer, which would accept the
 * marker in the middle of a sentence: a block whose boundary sits inside running
 * text has no sensible marking to draw around it. It only applies to documents
 * nobody writes, but it is a divergence, and it is recorded as an observation in
 * `AI/architecture.md` rather than left to be found as a bug.
 */
function isMarkerLine(text: string, marker: string): boolean {
  return text.trim() === marker;
}

/** A first line beginning with `@@@` gates the whole file; see `resolveBlocks`. */
function isFileLevelDirective(text: string): boolean {
  return /^[ \t]*@@@/.test(text);
}

/** An opening marker names what it gates. One that names nothing opens nothing. */
function opensPermissionBlock(text: string): boolean {
  return /^[ \t]*@@@[ \t]*\S/.test(text);
}

/** A closing marker names nothing - which is also why it cannot be an opening one. */
function closesPermissionBlock(text: string): boolean {
  return /^[ \t]*@@@[ \t]*$/.test(text);
}

/** `parseFirstLineForPermissions` and `inlinePermissionRegex`: what a directive line opens with. */
function directiveOpeningPattern(): RegExp {
  return /^[ \t]*@@@/;
}

/** `parsePermissionEntry`: a role holding no brackets, and an optional bracketed window. */
function permissionEntryPattern(): RegExp {
  return /^(?<role>[^\[\]]+?)(?:\s*\[(?<window>.+)\])?$/;
}

/** `parsePermissionWindow`: a window that names an end and no start. */
function windowEndOnlyPattern(): RegExp {
  return /^to\s+/i;
}

/** `parsePermissionWindow`: what stands between the two ends of a window. */
function windowSeparatorPattern(): RegExp {
  return /\s+to\s+/i;
}

/** `parseLocalDateTime`: the suffix that sends a timestamp straight to the Date constructor. */
function timezoneSuffixPattern(): RegExp {
  return /([zZ]|[+-]\d{2}:?\d{2})$/;
}

/** `parseLocalDateTime`: what stands between the date and the time. */
function dateTimeSeparatorPattern(): RegExp {
  return /[T ]/;
}

/**
 * `hasRoles`: the three switches it resolves.
 *
 * It takes *every* entry carrying the prefix out of the role test, whatever
 * follows it, and then resolves exactly these three. An entry carrying the
 * prefix and none of these names therefore restricts nobody and switches
 * nothing, which is a third thing to be and is marked as one.
 */
const VIEW_SWITCHES = ["exam", "practice", "answer"];

/**
 * `namesReservedForRoles` (`utils.js`): the five a display name may not be.
 *
 * Being addressed by name is a feature - the session's display name enters the
 * role set as a role, so `@@@ Stu Dent` reaches one person. These five are the
 * exception: a display name equal to one of them is dropped rather than added,
 * with a warning nobody reading the document will ever see. So a block addressed
 * to `Students` is addressed to the *role*, and every student in the school
 * reads it.
 *
 * Mirrored rather than imported, like the directive grammar above it and for the
 * same reason: the plugin ships to Obsidian as a standalone bundle with no
 * safeLearn checkout anywhere near it. It carries the same risk of drifting, and
 * `AI/architecture.md` §9 records it.
 */
const NAMES_RESERVED_FOR_ROLES = ["admin", "teacher", "teachers", "student", "students"];

/** Whether the server reads this as a role rather than as the person who bears it. */
function isReservedName(name: string): boolean {
  return NAMES_RESERVED_FOR_ROLES.includes(name.trim().toLowerCase());
}

/** Where something sits in the line, and what it says. */
type Span = { index: number; length: number; text: string };

/**
 * One comma-separated entry of a directive: where it is, and what the server
 * will make of it.
 *
 * The four conclusions are independent of one another rather than one
 * enumeration, because the server's are: an entry can be a view switch and
 * carry a window, and be marked as both.
 */
type DirectiveEntry = {
  index: number;
  length: number;
  /**
   * The entry as the document writes it - trimmed, and in the author's own
   * spelling. This is what a heading shows, because a heading that restated an
   * entry would claim a reading of it, and the server discards windows that a
   * readable restatement makes look sound.
   */
  text: string;
  /** The role as the server would hold it - trimmed and lowercased. */
  role: Span | null;
  /** The text between the brackets, as written. Null when the entry has no bracketed part. */
  window: Span | null;
  /** Whether the server keeps this entry at all, or drops it before anything reads it. */
  readable: boolean;
  timed: boolean;
  brokenWindow: boolean;
  viewSwitch: boolean;
  resolvedSwitch: boolean;
};

/**
 * Whether `parseLocalDateTime` would read this as a time - never what time it
 * denotes, which nothing here needs.
 *
 * This is the riskiest thing in the file, and it is written out step for step
 * rather than reasoned about, because that function is permissive in ways a
 * careful reading gets wrong in both directions: `2025-13-45` is accepted and
 * rolled over into the next year, `2025` is rejected because `month - 1` becomes
 * NaN two steps later, `2025-11-28T08:00` is rejected because the missing
 * seconds leave `second` undefined, and `2025-11-28 ab:cd` is accepted because a
 * segment that is not a number leaves the default in place. Each of those is a
 * row in the table `test/directive-grammar.test.js` holds in the safeLearn
 * repository, which runs this function and the server's over the same lines and
 * fails on a divergence.
 */
function readsAsTime(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (timezoneSuffixPattern().test(trimmed)) {
    return !Number.isNaN(new Date(trimmed).getTime());
  }
  const [datePart, timePart] = trimmed.split(dateTimeSeparatorPattern());
  if (!datePart) return !Number.isNaN(new Date(trimmed).getTime());

  const [year, month, day] = datePart.split("-").map((segment) => Number.parseInt(segment, 10));
  if ([year, month, day].some((segment) => Number.isNaN(segment))) return false;

  // Deliberately three assignments that can be skipped rather than three
  // defaults: a segment that parses to NaN leaves the default standing, and a
  // segment that is not there at all assigns `undefined` and invalidates the
  // whole date. The two look alike and do the opposite.
  let hour = 0;
  let minute = 0;
  let second = 0;
  if (timePart) {
    const [h, m, s] = timePart.split(":").map((segment) => Number.parseInt(segment, 10));
    if (!Number.isNaN(h)) hour = h;
    if (!Number.isNaN(m)) minute = m;
    if (!Number.isNaN(s)) second = s;
  }
  return !Number.isNaN(new Date(year, month - 1, day, hour, minute, second).getTime());
}

/**
 * Whether `parsePermissionWindow` would keep this window.
 *
 * It keeps one as soon as either end reads as a time, and returns null when
 * neither does - and an entry whose window is null is permanently active. So
 * this answers the only question the marking depends on: does the restriction
 * the author wrote take effect at all.
 */
function readsAsWindow(value: string): boolean {
  const windowText = value.trim();
  if (!windowText) return false;
  if (windowEndOnlyPattern().test(windowText)) {
    return readsAsTime(windowText.replace(windowEndOnlyPattern(), ""));
  }
  const parts = windowText.split(windowSeparatorPattern());
  if (parts.length === 1) return readsAsTime(parts[0]);
  return readsAsTime(parts[0]) || readsAsTime(parts.slice(1).join(" to "));
}

/**
 * One entry of a directive, read the way `parsePermissionEntry` reads it.
 *
 * `offset` is where the token starts in the line; what is reported is the
 * trimmed extent, because the whitespace around an entry is not part of it and
 * marking it would say the server acts on characters it never sees.
 */
function readDirectiveEntry(token: string, offset: number): DirectiveEntry {
  const trimmed = token.trim();
  const index = offset + (token.length - token.trimStart().length);
  const discarded: DirectiveEntry = {
    index,
    length: trimmed.length,
    text: trimmed,
    role: null,
    window: null,
    readable: false,
    timed: false,
    brokenWindow: false,
    viewSwitch: false,
    resolvedSwitch: false,
  };
  if (!trimmed) return discarded;

  const match = permissionEntryPattern().exec(trimmed);
  const groups = match?.groups;
  if (!groups) return discarded;

  const rolePart = groups.role ?? "";
  const roleText = rolePart.trim().toLowerCase();
  if (!roleText) return discarded;

  // The role part is anchored at the start of the token, and the window group is
  // anchored to the closing bracket at its end - so both extents come from the
  // match rather than from searching the text for a bracket, which would find
  // one the server does not treat as a window.
  const windowText: string | undefined = groups.window;
  const window =
    windowText === undefined
      ? null
      : {
          index: index + trimmed.length - 1 - windowText.length,
          length: windowText.length,
          text: windowText,
        };
  const timed = window !== null && readsAsWindow(window.text);
  const viewSwitch = roleText.startsWith("#");

  return {
    index,
    length: trimmed.length,
    text: trimmed,
    role: { index, length: rolePart.trimEnd().length, text: roleText },
    window,
    readable: true,
    timed,
    brokenWindow: window !== null && !timed,
    viewSwitch,
    resolvedSwitch: viewSwitch && VIEW_SWITCHES.includes(roleText.slice(1)),
  };
}

/**
 * Every entry of a directive line, in order, or null if the line is not a
 * directive at all.
 *
 * Entry-shaped rather than one pattern over the line, because the server's own
 * decisions are per entry: one token's unreadable window does not touch its
 * neighbour, and one discarded token does not discard the rest. Entries the
 * server discards are reported too, marked as discarded - a caller that needs
 * only the surviving ones filters, and one that has to show where a discarded
 * entry sits can.
 */
function parseDirectiveEntries(text: string): DirectiveEntry[] | null {
  const opening = directiveOpeningPattern().exec(text);
  if (!opening) return null;

  const entries: DirectiveEntry[] = [];
  let offset = opening[0].length;
  for (const token of text.slice(offset).split(",")) {
    entries.push(readDirectiveEntry(token, offset));
    offset += token.length + 1; // the comma the split took out
  }
  return entries;
}

/**
 * Whether the server withholds this directive's text from every reader.
 *
 * `removeForbiddenContent` replaces a block whose directive keeps no entry with
 * the empty string, and `resolveFileVisibility` reports a file-level one
 * invisible - in both cases to everyone, an admin included. It is the harshest
 * thing a directive can do and the least visible, which is why it is a
 * conclusion about the line rather than something to infer from each entry.
 */
function withholdsFromEveryone(entries: DirectiveEntry[]): boolean {
  return !entries.some((entry) => entry.readable);
}

/** The text with every tag taken out of it, by the same rules the editor marks by. */
function withoutTags(text: string): string {
  return text
    .replace(fragmentPattern(), "")
    .replace(blockMarkerPattern(), "")
    .replace(permissionMarkerPattern(), "");
}

// ################### The heading a directive is shown as ###################

/**
 * What a restricted block is shown carrying instead of its directive line - the
 * way a table carries its header row.
 *
 * One builder for both views, because that is the whole reason the reading view
 * and the editor were settled in one change: two builders would be free to
 * disagree about the one thing both views exist to show the same way.
 *
 * Each entry becomes a chip of its own. A chip is not text in the document, so
 * it can carry visual channels an entry mark cannot - `styles.css` records why a
 * mark may only use colour, weight and line style, and none of that applies
 * here.
 */
function buildHeading(entries: DirectiveEntry[], fileLevel: boolean): HTMLElement {
  const heading = document.createElement("span");
  heading.className = "safelearn-heading";
  if (fileLevel) heading.classList.add("safelearn-heading-file");

  // Nothing on the line reads as an entry, so `removeForbiddenContent` replaces
  // the block with the empty string and `resolveFileVisibility` reports the file
  // invisible - to everyone, an admin included. A heading naming somebody would
  // claim the opposite of what happens, and no heading at all would be the one
  // line that disappears without a trace.
  if (withholdsFromEveryone(entries)) {
    heading.classList.add("safelearn-heading-withheld");
    const note = document.createElement("span");
    note.className = "safelearn-heading-note";
    note.textContent = "no reader sees this block";
    heading.appendChild(note);
    return heading;
  }

  for (const entry of entries) {
    if (entry.text === "") continue;
    heading.appendChild(buildChip(entry));
  }
  return heading;
}

/**
 * One entry of a directive, as its own element.
 *
 * The text is the entry as the document writes it, window and all. Nothing is
 * restated: the server throws away windows that a readable restatement would
 * make look sound, and the plugin's only value is that it claims nothing of an
 * entry that the server does not do with it.
 *
 * An entry the server discards is shown too, marked as discarded. Where the
 * characters are on the page, a discarded entry is shown by the marking its
 * neighbours have and it does not - but here the characters are gone, and
 * leaving the entry out would hide from the author that they wrote something the
 * server throws away.
 */
function buildChip(entry: DirectiveEntry): HTMLElement {
  const chip = document.createElement("span");
  const classes = ["safelearn-chip"];
  if (!entry.readable) classes.push("safelearn-chip-discarded");
  if (entry.timed) classes.push("safelearn-chip-timed");
  if (entry.brokenWindow) classes.push("safelearn-chip-broken");
  if (entry.viewSwitch) classes.push("safelearn-chip-switch");
  if (entry.viewSwitch && !entry.resolvedSwitch) classes.push("safelearn-chip-unresolved");
  chip.className = classes.join(" ");
  chip.textContent = entry.text;
  return chip;
}

// ################### The rendered reading view ###################

/**
 * Takes the tags out of the rendered reading view, and puts in their place what
 * they mean.
 *
 * Obsidian calls this once per rendered section and hands over a context that
 * can say which lines of the file that section was rendered from -
 * `getSectionInfo` returns the whole document text with the section's line
 * range. So what a section *is* comes from the source, resolved by the same walk
 * the editor uses, rather than from testing rendered text for something that
 * looks like a tag. That is what the function this replaced could not do: by the
 * time output is rendered the line structure is gone, so it could only ever
 * hide - never put a heading in a marker's place, never tell which content
 * belonged to which column.
 *
 * `getSectionInfo` returns null wherever there is no file section behind the
 * render: Live Preview, an embed, a hover preview, and the columns this function
 * renders itself. Then the one thing that needs no source still happens - tag
 * text goes - and nothing is asserted that cannot be established. It is also
 * what stops the column rendering below from recursing into itself.
 */
async function hideTags(el: HTMLElement, ctx: MarkdownPostProcessorContext, plugin: Plugin) {
  const info = ctx.getSectionInfo(el);
  if (!info) {
    stripTagText(el);
    return;
  }

  const lines = linesOfText(info.text);
  const { blocks, fileDirective } = resolveBlocks(lines);
  // `getSectionInfo` counts lines from zero and names the last line of the
  // section inclusive; everything else in this file counts from one.
  const from = info.lineStart + 1;
  const to = info.lineEnd + 1;

  const covering = (kind: Block["kind"]) =>
    blocks.filter((block) => block.kind === kind && block.from <= to && block.to >= from);
  const opens = (block: Block) => block.from >= from && block.from <= to;
  const closes = (block: Block) => block.to >= from && block.to <= to;

  const columns = covering("side-by-side");
  if (columns.length > 0) {
    // Every section of the block decides about itself, from the source alone.
    // The one holding the opening marker renders the whole block as columns; the
    // rest go. Nothing waits for another section to exist and nothing is moved
    // between parents, so a block scrolled half into view cannot end up half
    // built.
    //
    // A section can lie across more than one block where two of them stand with
    // no blank line between; the one that *opens* in it decides, because that is
    // the section that has to produce something.
    const opening = columns.find(opens);
    if (opening) await renderColumns(el, opening, lines, ctx, plugin);
    else el.addClass("safelearn-hidden");
    return;
  }

  // The box is drawn one section at a time, the way the editor draws it one line
  // at a time: sides on every part of it, a lid on the first, a floor on the
  // last. Every block covering this section is asked, not the first one found -
  // a paragraph holding one block's closing marker and the next one's directive
  // is the lid of the second as much as the floor of the first.
  for (const block of covering("permission")) {
    el.addClass("safelearn-read-block");
    if (opens(block)) el.addClass("safelearn-read-block-start");
    if (closes(block)) el.addClass("safelearn-read-block-end");
  }
  if (fileDirective !== null && fileDirective >= from && fileDirective <= to) {
    el.addClass("safelearn-read-file");
  }

  // Which of this section's lines are tag lines is decided here, from the walk
  // above; the text nodes below are only where those lines ended up.
  const headings = new Map<string, { entries: DirectiveEntry[]; fileLevel: boolean }>();
  const closings = new Set<string>();
  for (let line = from; line <= to; line++) {
    const text = lines.at(line);
    const opensBlock = blocks.some((b) => b.kind === "permission" && b.from === line);
    if (line === fileDirective || opensBlock) {
      const entries = parseDirectiveEntries(text);
      if (entries !== null) headings.set(text.trim(), { entries, fileLevel: line === fileDirective });
    } else if (closesPermissionBlock(text)) {
      closings.add(text.trim());
    }
  }

  replaceTagLines(el, headings, closings);
  stripTagText(el);

  // A section whose lines held nothing but tags has nothing left to show - and
  // that is asked of the source, like everything else here, rather than of the
  // rendered result. A section can be empty of text and be an image, a rule or a
  // diagram, and hiding it because nothing in it is a word would take content
  // out of a document to remove a tag that was never in it.
  //
  // Unless a heading was put there: a directive line does hold nothing but a
  // tag, and what stands in its place now is the point of the whole change.
  const held: string[] = [];
  for (let line = from; line <= to; line++) held.push(lines.at(line));
  if (withoutTags(held.join("\n")).trim() === "" && el.querySelector(".safelearn-heading") === null) {
    el.addClass("safelearn-hidden");
  }
}

/**
 * The element inside a rendered section that holds the section's own lines.
 *
 * Obsidian hands a post-processor the section's wrapper - `div.el-p` around the
 * paragraph, `div.el-ul` around the list - and the lines are one level further
 * in. The wrapper is where a frame belongs, because it is the full-width element
 * and adjacent wrappers touch; the block inside it is where the lines are. Only
 * a wrapper is stepped through, and only when it holds that one block and
 * nothing else, so a paragraph is never mistaken for the single element it
 * happens to contain.
 */
const SECTION_BLOCKS = new Set(["P", "UL", "OL", "BLOCKQUOTE", "PRE", "TABLE", "H1", "H2", "H3", "H4", "H5", "H6"]);

function sectionBody(el: HTMLElement): HTMLElement {
  if (el.tagName !== "DIV" || el.childNodes.length !== 1) return el;
  const only = el.firstElementChild;
  return only instanceof HTMLElement && SECTION_BLOCKS.has(only.tagName) ? only : el;
}

/**
 * A rendered section, cut back into the lines it was rendered from.
 *
 * A section is one paragraph and a paragraph is several lines: Obsidian renders
 * a single newline as a break, so the lines arrive as runs of nodes with `<br>`
 * between them. A run is what a line became, and each run carries the break that
 * ended it, so removing a line removes the gap it occupied with it.
 *
 * A run rather than a node, because one line is not one node. `#exam` in a
 * directive is rendered as a tag link of its own, so the line arrives as text,
 * an anchor and more text - and a rule that looked at single text nodes would
 * see three fragments of a directive and recognize none of them.
 */
function renderedLines(body: HTMLElement): ChildNode[][] {
  const runs: ChildNode[][] = [[]];
  for (const node of Array.from(body.childNodes)) {
    runs[runs.length - 1].push(node);
    if (node instanceof HTMLBRElement) runs.push([]);
  }
  if (runs[runs.length - 1].length === 0) runs.pop();
  return runs;
}

/** What a rendered line says, as one string. */
function textOfLine(run: ChildNode[]): string {
  return run.map((node) => node.textContent ?? "").join("").trim();
}

/**
 * Replaces the rendered line of a directive with its heading, and removes the
 * rendered line of a closing marker.
 *
 * Which lines are tag lines was decided by the walk over the source; this only
 * finds where they ended up, by the text of the line. That is how the
 * recognition rules match everywhere else in this file.
 */
function replaceTagLines(
  el: HTMLElement,
  headings: Map<string, { entries: DirectiveEntry[]; fileLevel: boolean }>,
  closings: Set<string>
) {
  if (headings.size === 0 && closings.size === 0) return;

  for (const run of renderedLines(sectionBody(el))) {
    const text = textOfLine(run);
    if (text === "") continue;

    const heading = headings.get(text);
    if (heading) {
      run[0].before(buildHeading(heading.entries, heading.fileLevel));
      for (const node of run) {
        if (!(node instanceof HTMLBRElement)) node.remove();
      }
      continue;
    }
    if (closings.has(text)) {
      for (const node of run) node.remove();
    }
  }
}

/**
 * Takes tag text out of the node that holds it, by rewriting that node's own
 * data.
 *
 * Deliberately not by building a replacement node: a text node replaced by a
 * fresh `<span>` loses its place in whatever wrapped it, and a tag written in a
 * line that carries emphasis or a link took that formatting with it. Rewriting
 * the data leaves the node, its parent and everything around it exactly as
 * Obsidian rendered them.
 */
function stripTagText(el: HTMLElement) {
  for (const node of textNodesOf(el)) {
    // A heading this plugin built is not rendered document text, and the entry
    // it carries is the author's own spelling rather than a tag to be removed.
    if (node.parentElement?.closest(".safelearn-heading")) continue;
    const original = node.data;
    const remaining = withoutTags(original);
    if (remaining !== original) node.data = remaining;
  }
}

/** Every text node under an element, collected before anything is changed. */
function textNodesOf(el: HTMLElement): globalThis.Text[] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const found: globalThis.Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    found.push(node as globalThis.Text);
  }
  return found;
}

/**
 * Renders a side-by-side block as the columns the server makes of it.
 *
 * The split is `preprocessSideBySide`'s (`obsidian.js:885`): the two markers are
 * taken out, what is left is split on `##separator`, and each part is trimmed.
 * The server then wraps each part in a `<div>` with blank lines around it,
 * because at that point the content is still Markdown and Markdown inside an
 * HTML block is only parsed when an empty line separates it from the tags. Here
 * each part is handed to Obsidian's renderer as Markdown directly, so there is
 * nothing for a blank line to do.
 *
 * The block's content is therefore rendered twice - once by Obsidian into the
 * sections that then hide themselves, once here. That is the price of not
 * reaching into the container Obsidian is still filling, and it is paid on the
 * two short blocks a document holds rather than on a document.
 */
async function renderColumns(
  el: HTMLElement,
  block: Block,
  lines: LineSource,
  ctx: MarkdownPostProcessorContext,
  plugin: Plugin
) {
  // A block that is never closed ends at the end of the document, and that last
  // line is content rather than a marker to step over.
  const closed = isMarkerLine(lines.at(block.to), SIDE_BY_SIDE_END);
  const content: string[] = [];
  for (let line = block.from + 1; line <= (closed ? block.to - 1 : block.to); line++) {
    content.push(lines.at(line));
  }

  const container = document.createElement("div");
  container.className = "safelearn-columns";
  for (const source of content.join("\n").split(SEPARATOR)) {
    const column = document.createElement("div");
    column.className = "safelearn-column";
    container.appendChild(column);
    await MarkdownRenderer.render(plugin.app, source.trim(), column, ctx.sourcePath, plugin);
  }

  // The section is not necessarily the block: an opening marker sits in the same
  // paragraph as the sentence above it, and a short block sits inside one
  // paragraph whole. Only the lines that are the block's are taken out, and the
  // columns go where they stood.
  el.addClass("safelearn-columns-host");
  const body = sectionBody(el);
  const runs = renderedLines(body);
  const first = runs.findIndex((run) => textOfLine(run) === SIDE_BY_SIDE_START);

  // The opening marker is not a line of its own where a list swallowed it as a
  // lazy continuation - a document nobody writes, but one that must not lose its
  // content to a guess about which runs to take out. The section goes whole and
  // the columns stand in its place.
  if (first === -1) {
    body.addClass("safelearn-hidden");
    el.appendChild(container);
    return;
  }

  const closing = runs.findIndex((run, index) => index >= first && textOfLine(run) === SIDE_BY_SIDE_END);
  const last = closing === -1 ? runs.length - 1 : closing;

  runs[first][0].before(container);
  for (let index = first; index <= last; index++) {
    for (const node of runs[index]) node.remove();
  }
  while (body.lastChild instanceof HTMLBRElement) body.lastChild.remove();
}

// ################### The blocks a document is made of ###################

type Block = {
  kind: "permission" | "side-by-side";
  from: number;
  to: number;
  /**
   * Whether `to` is the block's closing marker, or the last line of a document
   * that never closed it. The walk below knows which of the two it settled on,
   * and what stands on that line depends on the answer: a marker is the block's
   * own punctuation and is hidden as such, the last line of an unclosed block is
   * somebody's text.
   */
  closed: boolean;
  separators: number[];
};

/**
 * What one walk of the document found: its blocks, and the line of the
 * file-level directive if it has one.
 *
 * The file-level line is reported rather than left to be recognized a second
 * time where it is marked. Two places deciding which line gates the file would
 * be free to disagree about it, and the whole reason the recognition rules sit
 * in one block at the top of this file is that a tag form with two rules is what
 * let the editor and the reading view drift apart.
 */
type DocumentStructure = { blocks: Block[]; fileDirective: number | null };

/**
 * The lines of a document, however the caller happens to hold them.
 *
 * The editor has CodeMirror's `Text`; the rendered reading view has the file's
 * text as a string, handed to it with each section. Both resolve blocks by the
 * walk below, over this, so the two views cannot develop a second opinion about
 * where a block ends. Lines are numbered from 1, the way CodeMirror numbers
 * them.
 */
type LineSource = { count: number; at(line: number): string };

function linesOfText(text: string): LineSource {
  const lines = text.split("\n");
  return { count: lines.length, at: (line) => lines[line - 1] ?? "" };
}

function linesOfDocument(doc: Text): LineSource {
  return { count: doc.lines, at: (line) => doc.line(line).text };
}

/**
 * Every block in the document, resolved over all of it.
 *
 * Over all of it rather than over what is on screen, because a block opened
 * three screens up still governs the lines currently visible - the visible range
 * alone does not say what is inside a block and what is not. Walking lines is
 * cheap next to building decorations, and it keeps the marking independent of
 * where the document happens to be scrolled to. See `AI/architecture.md` for the
 * trade-off this accepts on a very large document.
 *
 * Nothing here suppresses anything after it. A marker that cannot be made sense
 * of costs its own line: the block it belongs to still ends somewhere, and the
 * tags below it are marked as they would be in a document without it.
 */
function resolveBlocks(lines: LineSource): DocumentStructure {
  const blocks: Block[] = [];

  // A first line beginning with `@@@` is the file-level form, which gates the
  // whole file and has no closing marker. The renderer splits that line off the
  // document before it looks for a block at all, so this is what it is by
  // position rather than by what follows it: read as an unclosed block instead,
  // it swallows every marking below it.
  const fileDirective = isFileLevelDirective(lines.at(1)) ? 1 : null;
  const start = fileDirective === null ? 1 : 2;

  let permissionFrom = -1;
  let sideFrom = -1;
  let separators: number[] = [];

  for (let i = start; i <= lines.count; i++) {
    const text = lines.at(i);

    if (permissionFrom === -1) {
      if (opensPermissionBlock(text)) {
        permissionFrom = i;
        continue;
      }
      // A closing marker with nothing open closes nothing and opens nothing.
    } else if (closesPermissionBlock(text)) {
      blocks.push({ kind: "permission", from: permissionFrom, to: i, closed: true, separators: [] });
      permissionFrom = -1;
      continue;
    }

    if (sideFrom === -1) {
      if (isMarkerLine(text, SIDE_BY_SIDE_START)) {
        sideFrom = i;
        separators = [];
        continue;
      }
    } else if (isMarkerLine(text, SIDE_BY_SIDE_END)) {
      blocks.push({ kind: "side-by-side", from: sideFrom, to: i, closed: true, separators });
      sideFrom = -1;
      continue;
    } else if (isMarkerLine(text, SEPARATOR)) {
      // A separator outside a block is left alone, the way the renderer leaves
      // it alone: it only means anything between a start and an end.
      separators.push(i);
    }
  }

  // A block that is never closed ends at the end of the document and marks what
  // it covered, rather than costing everything after it its marking.
  if (permissionFrom !== -1) {
    blocks.push({ kind: "permission", from: permissionFrom, to: lines.count, closed: false, separators: [] });
  }
  if (sideFrom !== -1) {
    blocks.push({ kind: "side-by-side", from: sideFrom, to: lines.count, closed: false, separators });
  }

  return { blocks, fileDirective };
}

// ################### What the editor marks ###################

/**
 * What one entry of a directive is marked with, or null for an entry the server
 * discards.
 *
 * A discarded entry is marked as nothing at all. The only thing a marking on it
 * could say is that the server acts on it, and the server does not: it is
 * dropped before anything reads it, and the entries beside it go on meaning what
 * they meant. So it is shown by the marking its neighbours have and it does not.
 *
 * The rest are attributes on one shared marking rather than a class per
 * combination: the conclusions are independent of one another - an entry can be
 * a view switch and carry a window - and a class per combination is a dozen
 * classes that mostly never occur. What each of them looks like is settled in
 * `styles.css`, which is the only place that question can honestly be answered.
 */
function entryClasses(entry: DirectiveEntry): string | null {
  if (!entry.readable) return null;
  const classes = ["safelearn-entry"];
  if (entry.timed) classes.push("safelearn-entry-timed");
  if (entry.brokenWindow) classes.push("safelearn-entry-broken");
  if (entry.viewSwitch) classes.push("safelearn-entry-switch");
  if (entry.viewSwitch && !entry.resolvedSwitch) classes.push("safelearn-entry-unresolved");
  return classes.join(" ");
}

/**
 * The heading that stands in the editor where a directive line's characters are.
 *
 * It compares equal on the text it was built from, so a rebuild that changed
 * nothing hands the editor back a widget it can keep. Without that, every cursor
 * move in the document would tear down and rebuild every heading on screen.
 *
 * Events are not ignored, so a click lands in the range the widget replaces and
 * places the cursor there - which is what lifts the replacement on the next
 * rebuild. The range is deliberately not atomic: a range the cursor cannot enter
 * would need something else to lift it, and every one of those is a way for the
 * line to become uneditable when it fails.
 */
class DirectiveHeadingWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly fileLevel: boolean
  ) {
    super();
  }

  eq(other: DirectiveHeadingWidget): boolean {
    return other.source === this.source && other.fileLevel === this.fileLevel;
  }

  toDOM(): HTMLElement {
    return buildHeading(parseDirectiveEntries(this.source) ?? [], this.fileLevel);
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** What a fragment marker is shown as. Written here rather than in `styles.css`: see below. */
const FRAGMENT_ICON = "🔀";

/**
 * The icon that stands in the editor where a fragment marker's characters are.
 *
 * A fragment says one small thing - that what follows it waits for a click - and
 * it says it about a line that is otherwise ordinary prose. Spelled out and
 * framed, the tag was the loudest thing on that line; as an icon it says the same
 * thing in the room a punctuation mark takes. What it replaces comes back the
 * moment the cursor touches it, exactly as a directive line's characters do, so
 * the tag is still there to be edited by the person who wrote it.
 *
 * The icon is a character in the element rather than `content` in the stylesheet,
 * which is where this plugin's other icons are. Those decorate text that is on
 * screen either way; this one *is* what is on screen in the tag's place, and a
 * stylesheet that failed to load would otherwise take the tag off the page
 * without leaving anything behind.
 *
 * Every fragment is shown the same way, so they all compare equal and the editor
 * keeps the elements it already built across a rebuild - and a rebuild now
 * happens on every cursor move.
 */
class FragmentIconWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const icon = document.createElement("span");
    icon.className = "fragment-icon";
    icon.textContent = FRAGMENT_ICON;
    return icon;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * What the document says about each of its lines, read once.
 *
 * There are two consumers of it and they must not answer differently: the
 * decoration set below, which reaches the elements the editor renders as lines,
 * and `frameBlocks`, which reaches the ones it does not. Both read `lineClasses`
 * rather than walking the document again - a second walk would be a second
 * opinion about where a block ends.
 */
type DocumentMarking = {
  /** Per line number, the classes the blocks covering it put on it. */
  lineClasses: Map<number, string[]>;
  /** Per line number, the entries of the directive standing on it. */
  directives: Map<number, DirectiveEntry[]>;
  /** The lines that close a permission block, and therefore hold nothing else. */
  closers: Set<number>;
  fileDirective: number | null;
};

function markLines(doc: Text): DocumentMarking {
  // What each line carries by virtue of the blocks covering it, for the whole
  // document. It becomes decorations where the editor renders a line as a line,
  // and a class written onto the element where it renders one as something else.
  const lineClasses = new Map<number, string[]>();
  const carries = (line: number, className: string) => {
    const classes = lineClasses.get(line);
    if (classes) classes.push(className);
    else lineClasses.set(line, [className]);
  };

  const { blocks, fileDirective } = resolveBlocks(linesOfDocument(doc));

  // Every line the plugin reads as a directive, with what its text comes to.
  // Which lines those are is what the walk above decided - the file-level line
  // and the line each permission block opens with - rather than something asked
  // again here.
  const directives = new Map<number, DirectiveEntry[]>();
  const readDirective = (line: number) => {
    const entries = parseDirectiveEntries(doc.line(line).text);
    if (entries !== null) directives.set(line, entries);
  };
  if (fileDirective !== null) readDirective(fileDirective);

  // The other end of the same blocks. A closing marker is punctuation and
  // nothing else - there is no text of anybody's on that line to lose - so the
  // editor is told which lines they are and shows them the way it shows the
  // directive above them. Which lines those are is again the walk's conclusion,
  // including its conclusion that a block was closed at all.
  const closers = new Set<number>();
  for (const block of blocks) {
    if (block.kind !== "permission") continue;
    readDirective(block.from);
    if (block.closed) closers.add(block.to);
  }

  // The file-level form gates the whole document and has no closing marker; the
  // same text on any other line gates the region below it. Two different
  // promises about two different amounts of text, and they are marked apart.
  if (fileDirective !== null) carries(fileDirective, "permission-file");

  for (const [line, entries] of directives) {
    if (withholdsFromEveryone(entries)) carries(line, "permission-withheld");
  }

  for (const block of blocks) {
    for (let i = block.from; i <= block.to; i++) {
      if (block.kind === "permission") {
        // Every line of the block, and its two ends besides. A box is drawn one
        // element at a time, so which side of it a line is on is something the
        // marking has to say - the side-by-side block is drawn the same way for
        // the same reason. It is no new conclusion about the document: the
        // block's first and last line are what `resolveBlocks` already found.
        carries(i, "permission-block");
        if (i === block.from) carries(i, "permission-block-start");
        if (i === block.to) carries(i, "permission-block-end");
      } else {
        carries(
          i,
          i === block.from ? "side-by-side-start" : i === block.to ? "side-by-side-end" : "side-by-side-block"
        );
      }
    }
    for (const line of block.separators) carries(line, "side-by-side-separator");
  }

  return { lineClasses, directives, closers, fileDirective };
}

function buildDecorations(view: EditorView, marking: DocumentMarking): DecorationSet {
  const doc = view.state.doc;
  const { lineClasses, directives, closers, fileDirective } = marking;

  // Only the lines on screen produce decorations. A rebuild now happens on every
  // cursor move as well as on every keystroke, and there is nothing to gain from
  // constructing decorations for lines the editor has not built an element for.
  const visibleLines = new Set<number>();
  for (const { from, to } of view.visibleRanges) {
    for (let i = doc.lineAt(from).number; i <= doc.lineAt(to).number; i++) visibleLines.add(i);
  }

  // A directive line stands as its heading while nothing is in it, and as its
  // own characters while something is. "Something" is the cursor resting in the
  // line or a selection touching it: a selection running across the block shows
  // the line, because otherwise a person copies text they cannot see. The lines
  // above and below are not consulted, so scrolling through with the cursor does
  // not make the document flicker.
  const isTouched = (from: number, to: number) =>
    view.state.selection.ranges.some((range) => range.from <= to && range.to >= from);

  const ranges: Range<Decoration>[] = [];
  for (const number of visibleLines) {
    const line = doc.line(number);
    for (const className of lineClasses.get(number) ?? []) {
      ranges.push(Decoration.line({ class: className }).range(line.from));
    }

    // Everything below marks characters, and a replaced line has none on screen.
    // A mark inside hidden text says nothing, so the two states are exactly the
    // heading and what a directive line has always shown, with nothing between.
    if (directives.has(number) && !isTouched(line.from, line.to) && line.from < line.to) {
      ranges.push(
        Decoration.replace({
          widget: new DirectiveHeadingWidget(line.text, number === fileDirective),
        }).range(line.from, line.to)
      );
      continue;
    }

    // The same rule again, for the marker that closes the block. The directive
    // above it has a heading to stand in its place; this one has nothing to say
    // that the frame around the block does not already say, so what stands in
    // its place is the blank line the frame closes on. It is hidden rather than
    // made unreachable: the line stays where it is and the cursor can still be
    // put in it, which is what brings the marker back to be edited or deleted -
    // the only way there is to open the block up again.
    if (closers.has(number) && !isTouched(line.from, line.to)) {
      ranges.push(Decoration.replace({}).range(line.from, line.to));
      continue;
    }

    // The same rule the directive line above follows, applied to a tag rather
    // than to a whole line: the icon stands for the tag while nothing is in it,
    // and the tag's own characters stand there while something is. The extent
    // asked about is the tag's, not the line's - two fragments in one line are
    // two independent answers, and a person editing one keeps the other quiet.
    for (const { index, length } of fragmentsIn(line.text)) {
      const from = line.from + index;
      const to = from + length;
      ranges.push(
        isTouched(from, to)
          ? Decoration.mark({ class: "fragment-highlight" }).range(from, to)
          : Decoration.replace({ widget: new FragmentIconWidget() }).range(from, to)
      );
    }
    for (const entry of directives.get(number) ?? []) {
      const classes = entryClasses(entry);
      if (classes === null) continue;
      ranges.push(
        Decoration.mark({ class: classes }).range(line.from + entry.index, line.from + entry.index + entry.length)
      );
    }
  }

  // The library sorts, rather than this plugin. The order a decoration set has
  // to be in is by position *and* by the side each range starts at, and the
  // second is a property of the decoration type that only the library knows - a
  // line marking and a tag marking beginning at the same offset are not
  // interchangeable. Getting it wrong is not a wrong marking but no markings at
  // all: the set is rejected whole.
  return Decoration.set(ranges, true);
}

/**
 * Every class a block puts on a line, and therefore every class the pass below
 * is allowed to take off an element again.
 *
 * It is only needed for removal: what is added comes straight out of
 * `lineClasses`, so a class this list forgot is still applied. What a forgotten
 * class would cost is the other half - a frame left standing on an element after
 * the block stopped covering it.
 */
const BLOCK_CLASSES = Object.freeze([
  "permission-file",
  "permission-withheld",
  "permission-block",
  "permission-block-start",
  "permission-block-end",
  "side-by-side-start",
  "side-by-side-block",
  "side-by-side-end",
  "side-by-side-separator",
]);

/**
 * Puts the block's classes on the elements the editor renders in place of lines.
 *
 * A block's frame is a `Decoration.line`, and Live Preview does not render every
 * line as a line: a table, a callout, a diagram, a formula and an embedded note
 * each arrive as a `div` that is a sibling of the `cm-line` elements rather than
 * one of them. A line decoration has nothing to attach to there, so the frame
 * stopped above such an element and started again below it - the block read as
 * two boxes that do not close. `posAtDOM` maps the element back to the line it
 * was built from, and that line has already been classified.
 *
 * Two children are passed over, for two different reasons. A `cm-line` is
 * already carrying its classes from the decoration set, and writing them again
 * would be a second opinion about the same element. A `cm-gap` stands for the
 * whole stretch of document the editor has scrolled away and built nothing for -
 * one element covering many lines - so framing it by the single line it resolves
 * to would paint a block's frame across an arbitrary part of the document.
 *
 * Classes are removed as well as added. That is what keeps a frame from standing
 * on an element after the block's closing marker moved above it.
 */
function frameBlocks(view: EditorView, lineClasses: Map<number, string[]>): void {
  for (const element of Array.from(view.contentDOM.children)) {
    if (element.classList.contains("cm-line") || element.classList.contains("cm-gap")) continue;

    let carried: string[];
    try {
      carried = lineClasses.get(view.state.doc.lineAt(view.posAtDOM(element)).number) ?? [];
    } catch {
      // An element the editor does not own has no line to answer for. Skipping
      // it is the whole handling: an update must not fail over a stray child.
      continue;
    }

    // `classList` writes nothing when the token is already in the state asked
    // for, so running this twice over an unchanged document touches no
    // attribute - which is what lets the observer below call it as often as it
    // likes. And a class written on a child is not a change to the child *list*,
    // so these writes cannot be what wakes that observer up.
    for (const className of carried) element.classList.add(className);
    for (const className of BLOCK_CLASSES) {
      if (!carried.includes(className)) element.classList.remove(className);
    }
  }
}

const safelearnHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    /** What each line carries, kept so the pass over the DOM reads the same answer. */
    lineClasses: Map<number, string[]>;

    /**
     * Watches for the elements Obsidian fills in after the update that produced
     * their range - a diagram and an embedded note are both built asynchronously
     * and replace the child that stood there. The pass after an update cannot
     * see those, because at that moment they do not exist yet.
     *
     * The child list of `.cm-content` and not its subtree: what arrives late is
     * a *replaced child*, and a subtree observer would fire on every keystroke
     * inside every line for nothing.
     */
    observer: MutationObserver;

    constructor(view: EditorView) {
      const marking = markLines(view.state.doc);
      this.lineClasses = marking.lineClasses;
      this.decorations = buildDecorations(view, marking);

      this.observer = new MutationObserver(() => this.frame(view));
      this.observer.observe(view.contentDOM, { childList: true });
      this.frame(view);
    }

    update(update: ViewUpdate) {
      // Text is not the only thing that changes what has to be marked. The
      // editor builds only the lines around the viewport, so scrolling brings in
      // lines nothing has looked at yet; and in Live Preview a tag is shown as
      // its own characters when the cursor enters it, which is a change in what
      // is on screen with no change to the document at all.
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        const marking = markLines(update.state.doc);
        this.lineClasses = marking.lineClasses;
        this.decorations = buildDecorations(update.view, marking);
      }
      this.frame(update.view);
    }

    destroy() {
      this.observer.disconnect();
    }

    /**
     * Runs the pass in the write phase of a measure cycle, so that nothing is
     * written to the DOM in the middle of an update the editor is still doing.
     * The key is what collapses several requests in one cycle into one pass.
     */
    frame(view: EditorView) {
      view.requestMeasure({
        key: this,
        read: () => null,
        write: () => frameBlocks(view, this.lineClasses),
      });
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

// ################### The tags the plugin writes ###################

/**
 * The tags are typed by hand today, and a side-by-side block is four lines of
 * them with a spelling nobody remembers. A marker with a typo is marked by
 * nothing and acted on by nobody: it stands in the document as text a reader
 * meets in the middle of a lecture. The plugin knows what these tags are, so it
 * can write them.
 *
 * Everything below writes the constants the recognition rules at the top of this
 * file read. A command therefore cannot produce a tag the plugin does not mark,
 * which is the only guarantee here worth having.
 */

/** One thing the plugin can write into a document. */
type AuthoringCommand = {
  id: string;
  /**
   * One name, for wherever the command is offered.
   *
   * Short enough to read in a menu, because the palette supplies the rest: it
   * shows a command as `<plugin name>: <command name>`, so the words a second,
   * longer name would add there are the ones the prefix already says. A second
   * label kept for the second surface is a label that can come to disagree with
   * the first.
   */
  name: string;
  /**
   * The icon this command is shown with, named as the running Obsidian names
   * it.
   *
   * Not optional. A menu item is laid out as an icon column and a title beside
   * it, so an entry without one does not sit further left - it leaves the column
   * empty while its title stands where the others' do, which reads as something
   * that failed to load rather than as restraint.
   *
   * Obsidian ships a subset of Lucide, frozen at the version it bundles, and a
   * name that subset does not hold draws nothing and raises nothing. So these
   * are confirmed against `getIconIds()` in the running application rather than
   * against lucide.dev.
   */
  icon: string;
  run(editor: Editor, plugin: SafeLearnPlugin): void;
};

/** Where the plugin's entry stands in a context menu it does not own. */
const MENU_SECTION = "safelearn";

/** The one entry the plugin contributes to that menu, and what it carries. */
const MENU_TITLE = "SafeLearn";

/** The one icon in Obsidian's set that says *school* rather than *some plugin*. */
const MENU_ICON = "graduation-cap";

/**
 * Whether this Obsidian can nest one menu inside another.
 *
 * `MenuItem.setSubmenu` is asked for on an item `Menu.addItem` handed out,
 * which is the only place that object exists - but on a menu of the plugin's
 * own, and before anything is added to the one somebody is waiting for. The
 * answer then decides which menu gets built, instead of being discovered
 * halfway through building it and leaving a `SafeLearn` entry that opens
 * nothing standing in the fallback.
 *
 * Asked once. Whether the application defines a method does not change while it
 * is running, and this is reached from a handler that runs at every right-click.
 */
let nestsMenus: boolean | null = null;

function canNestMenus(): boolean {
  if (nestsMenus !== null) return nestsMenus;
  let nests = false;
  new Menu().addItem((item) => {
    nests = typeof item.setSubmenu === "function";
  });
  nestsMenus = nests;
  return nests;
}

/**
 * Every authoring command, in one list.
 *
 * `onload` builds both the palette entries and the context menu from this, and
 * the permission sections that come later are entries here rather than a second
 * menu beside it.
 */
const AUTHORING_COMMANDS: AuthoringCommand[] = [
  {
    id: "insert-side-by-side",
    name: "Side-by-side block",
    // What it makes.
    icon: "columns",
    run: (editor) => insertSideBySide(editor, 2),
  },
  {
    // Three columns come up now and then, but not often enough to earn an entry
    // of their own that a person reads past every time. So: two without asking,
    // and one command that asks.
    id: "insert-side-by-side-columns",
    name: "Side-by-side, n columns…",
    // The same family as the one above, for the one that can produce more
    // than two.
    icon: "layout-grid",
    run: (editor, plugin) =>
      new ColumnCountModal(plugin.app, (columns) => insertSideBySide(editor, columns)).open(),
  },
  {
    id: "insert-fragment",
    name: "Fragment marker",
    // A fragment means nothing outside a deck, so the icon says deck.
    icon: "presentation",
    run: (editor) => insertFragment(editor),
  },
  {
    // A semester of dates, typed out by hand today. It is the part of the table
    // with no judgement in it, so it is the part a command can take over.
    id: "insert-semester-table",
    name: "Semester table…",
    // What the table is about. `table` would name the container while saying
    // nothing about a semester of dates.
    icon: "calendar-days",
    run: (editor, plugin) =>
      new SemesterTableModal(plugin.app, (start, end, weekdays, subjects) =>
        insertSemesterTable(editor, start, end, weekdays, subjects)
      ).open(),
  },
  {
    id: "insert-sections-per-name",
    name: "Restricted section per name…",
    // It is about who there is.
    icon: "users",
    run: (editor, plugin) =>
      new NameListModal(
        plugin,
        "A restricted section for each name",
        (names) => insertSectionsPerName(editor, names)
      ).open(),
  },
  {
    id: "restrict-selection",
    name: "Restrict selection…",
    // It is about what is closed.
    icon: "lock",
    run: (editor, plugin) =>
      new NameListModal(plugin, "Restrict what is selected to", (entries) =>
        restrictSelection(editor, entries)
      ).open(),
  },
];

/**
 * Writes a side-by-side block of `columns` columns, around a selection if there
 * is one.
 *
 * A selection is enclosed whole and no separator is written into it. Somebody
 * who selected several paragraphs does not want them divided at a place a
 * command guessed; the separators go after the content, where they are a line to
 * move rather than a division to undo. The block is well-formed either way -
 * `columns` columns, the first holding the selection and the rest waiting.
 *
 * Each further column is a separator and an empty line. A separator sitting
 * directly above the closing marker is an empty column with no room in it, and a
 * person would have to make that room before they could type.
 */
function insertSideBySide(editor: Editor, columns: number) {
  // Fewer than two is not a side-by-side block. The modal refuses it as well;
  // this is the rule rather than the dialog's validation.
  if (columns < 2) return;

  const selection = editor.getSelection();
  const content = selection === "" ? [""] : selection.split("\n");

  const lines = [SIDE_BY_SIDE_START, ...content];
  for (let column = 1; column < columns; column++) lines.push(SEPARATOR, "");
  lines.push(SIDE_BY_SIDE_END);

  // The first empty column either way: the content line when nothing was
  // selected, the line after the first separator when something was.
  writeLines(editor, lines, selection === "" ? 1 : content.length + 2);
}

/**
 * Writes a fragment marker on a line of its own, before the block the cursor is
 * in.
 *
 * "Before the block" rather than before the cursor's own line: in the middle of
 * a paragraph the second reading divides the paragraph and makes a fragment of
 * its second half, which is not what was asked for and is invisible until the
 * deck is opened. The block is the run of non-blank lines the cursor stands in.
 *
 * With a selection the marker goes above where the selection starts, because
 * that is the place a person pointed at.
 */
function insertFragment(editor: Editor) {
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");

  let line = from.line;
  if (editor.getSelection() === "") {
    while (line > firstWritableLine(editor) && editor.getLine(line - 1).trim() !== "") line--;
  }

  editor.replaceRange(`${FRAGMENT}\n`, { line, ch: 0 }, { line, ch: 0 });
  // Everything from the insertion down moved one line; the person is put back
  // where they were writing.
  editor.setSelection({ line: from.line + 1, ch: from.ch }, { line: to.line + 1, ch: to.ch });
}

/**
 * Puts `lines` into the document, on lines of their own, and leaves the cursor
 * on the one at `cursorLine`.
 *
 * A marker sharing a line with other text is a marker this plugin does not mark
 * - `isMarkerLine` requires the line to be nothing but the marker, which is
 * deliberately stricter than the renderer and is recorded as a divergence in
 * `AI/architecture.md`. So an insertion that starts inside a line starts with a
 * break, and one that leaves text behind it ends with one.
 *
 * The blank lines the server puts around a column are not written here.
 * `preprocessSideBySide` adds them as it builds the columns, because the content
 * is still Markdown at that point and Markdown inside an HTML block is only
 * parsed when an empty line separates it from the tags. Written into the
 * document they would be trimmed straight back off.
 */
function writeLines(editor: Editor, lines: string[], cursorLine: number) {
  let from = editor.getCursor("from");
  let to = editor.getCursor("to");

  // Nothing is written above a directive that gates the file. It gates the file
  // by standing on the first line and by nothing else, so an insertion at the
  // very top pushes it down to the second and the document becomes readable by
  // everyone - silently, and through a command somebody ran to add a column.
  //
  // Only where nothing is selected. A selection covering that line is a
  // different act: the person named it, and what happens is shown by the marking
  // that stops saying the file is gated.
  const collapsed = from.line === to.line && from.ch === to.ch;
  if (collapsed && from.line === 0 && from.ch === 0 && isFileLevelDirective(editor.getLine(0))) {
    from = { line: 0, ch: editor.getLine(0).length };
    to = from;
  }

  const trailing = editor.getLine(to.line).slice(to.ch);
  const prefix = from.ch === 0 ? "" : "\n";
  const suffix = trailing === "" ? "" : "\n";
  editor.replaceRange(prefix + lines.join("\n") + suffix, from, to);

  const start = from.line + (prefix === "" ? 0 : 1);
  editor.setCursor({ line: start + cursorLine, ch: lines[cursorLine].length });
}

/**
 * The first line anything may be written above.
 *
 * A directive on line one gates the whole file, and it does so by *being* line
 * one. Pushing it down is the difference between a document only teachers read
 * and a document everybody reads, so it is not something a command that inserts
 * a marker gets to do as a side effect.
 */
function firstWritableLine(editor: Editor): number {
  return isFileLevelDirective(editor.getLine(0)) ? 1 : 0;
}

/**
 * Asks how many columns.
 *
 * It defaults to three: two has a command of its own and does not need to be
 * asked for. Below two there is no side-by-side block to write, so the dialog
 * refuses it; above, there is no bound, because the renderer has none and a
 * person writing six columns knows what they are doing.
 */
class ColumnCountModal extends Modal {
  constructor(
    app: App,
    private readonly onChoose: (columns: number) => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Side-by-side columns" });

    const input = contentEl.createEl("input", { type: "number", value: "3" });
    input.min = "2";
    input.style.width = "100%";

    const confirm = () => {
      const columns = Number.parseInt(input.value, 10);
      this.close();
      if (Number.isFinite(columns) && columns >= 2) this.onChoose(columns);
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") confirm();
    });

    // The confirmation stands in the container Obsidian lays dialog buttons out
    // in, rather than against the lower edge of the field. What separates the two
    // is then the spacing of the theme in use, and there is no length written
    // here for a theme to disagree with.
    contentEl
      .createEl("div", { cls: "modal-button-container" })
      .createEl("button", { text: "Insert" })
      .addEventListener("click", confirm);

    input.focus();
    input.select();
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * Writes one restricted section per name, in the order the names were given.
 *
 * A section carries no heading of its own. The reading view already renders the
 * addressed name as the block's heading, so a heading written into the section's
 * content would repeat, in the document's own text, what every reader already
 * sees rendered above it.
 */
function insertSectionsPerName(editor: Editor, names: string[]) {
  if (names.length === 0) return;

  // A selection means nothing to this command, and `writeLines` replaces what is
  // selected. The sections go where the selection begins and nothing is lost.
  editor.setCursor(editor.getCursor("from"));

  const lines: string[] = [];
  for (const name of names) {
    if (lines.length > 0) lines.push("");
    lines.push(`@@@ ${name}`, "", "@@@");
  }

  // Line 1 of the first section: the blank line right after its directive,
  // which is where the person is about to write.
  writeLines(editor, lines, 1);
  reportReservedNames(names);
}

/**
 * Encloses what is selected in a directive built from the given entries.
 *
 * With nothing selected it writes an empty block rather than reaching for the
 * paragraph the cursor happens to be in. `insertFragment` does reach for it, and
 * the difference is what the mistake costs: a fragment marker in the wrong place
 * is visible the next time the deck is opened, while a restriction over text
 * nobody pointed at is invisible to the person who wrote it and shows up as
 * somebody not seeing something they should.
 */
function restrictSelection(editor: Editor, entries: string[]) {
  if (entries.length === 0) return;

  const selection = editor.getSelection();
  const content = selection === "" ? [""] : selection.split("\n");
  const lines = [`@@@ ${entries.join(", ")}`, ...content, "@@@"];
  writeLines(editor, lines, selection === "" ? 1 : lines.length - 1);
}

/**
 * Says which of the given names the server will read as a role rather than as
 * the person who bears it - and changes none of them.
 *
 * The names are written as they were given: this command inserts what it was
 * handed and decides nothing. But `hasRoles` drops a display name equal to one
 * of the five rather than adding it, so a section addressed to `Students` is
 * addressed to the role and read by every student in the school. Nothing in the
 * document says so, and no marking can: to the plugin an entry naming `teacher`
 * is an entry naming `teacher`, and marking every one of them as a collision
 * would be noise on the most common directive in the corpus.
 *
 * This command is the one place in the plugin that knows a *person* was meant,
 * because it was just handed a list of them. So it is the one place that can say
 * it, and it says it once.
 */
function reportReservedNames(names: string[]) {
  const collisions = names.filter(isReservedName);
  if (collisions.length === 0) return;
  new Notice(
    `The server reads ${collisions.join(", ")} as a role, not as a person. A display name equal ` +
      `to ${NAMES_RESERVED_FOR_ROLES.join(", ")} is dropped instead of being added to a reader's ` +
      `roles, so those sections are shown to everyone holding the role. They were written as you ` +
      `gave them; nothing was changed.`,
    0
  );
}

/**
 * Asks for a list of names, one per line - now with an optional directory
 * picker above the field, where a login is held.
 *
 * Typing or pasting stays possible either way: the directory has no entry
 * for a guest, or for a student not yet enrolled, so the field this dialog
 * used to be entirely is still all of it that is guaranteed to work. With no
 * instance configured, or with one configured but no login held, the picker
 * is not rendered at all and this dialog is pixel-for-pixel what it was
 * before `plugin-admin-directory-ui` - see `tasks.md` #8.
 */
class NameListModal extends Modal {
  /** The wait on a running directory fetch, while one is being waited on - ended in `onClose`, per `tasks.md` #5.4. */
  private fetchWait: DirectoryFetchWait | null = null;

  /**
   * Who has been chosen from the picker: insertion order, deduplicated on the
   * trimmed exact name. This is what `confirm` returns where a picker is
   * shown, in place of both the marked-result set and the textarea that set
   * used to feed.
   *
   * Insertion order because the commands write one section per name in the
   * order they were given; the trimmed exact name because that is what the
   * picker offers and what the document carries, and folding it here would
   * only have to be undone when writing.
   */
  private readonly chosenNames: string[] = [];

  constructor(
    private readonly plugin: SafeLearnPlugin,
    private readonly title: string,
    private readonly onList: (names: string[]) => void
  ) {
    super(plugin.app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });

    // Where the picker is shown it is the whole answer: a name the directory
    // has no entry for is written into the document afterwards rather than
    // typed here. Where it is not, this dialog is the field it always was.
    const showsPicker = this.plugin.hasLogin();
    contentEl.createEl("p", {
      text: showsPicker
        ? "Click a person to choose them. Click them again in the chosen list to take them back out."
        : "One name per line. Paste a class list straight in.",
    });

    // The picker and the typed/pasted field get a home each, in the order they
    // read in, before either is filled: the field is built on demand (below),
    // and a container standing in for it keeps it out from under the
    // confirmation when it is.
    const pickerHome = contentEl.createDiv({ cls: "safelearn-name-list-picker" });
    const typedHome = contentEl.createDiv({ cls: "safelearn-name-list-typed" });

    let input: HTMLTextAreaElement | null = null;

    /**
     * Builds the typed/pasted field, once.
     *
     * Called outright where no picker is shown, and from the picker where it
     * reports `unreachable` or `failed`: a command must not leave a person
     * with no way to name anybody at all (`plugin-authoring-commands`).
     */
    const revealTypedList = () => {
      if (input) return;
      input = typedHome.createEl("textarea");
      input.rows = 10;
      input.style.width = "100%";
      input.focus();
    };

    if (showsPicker) void this.buildDirectorySearch(pickerHome, revealTypedList);
    else revealTypedList();

    const confirm = () => {
      // Both sources where both exist: a picker that goes unreachable after
      // somebody has already chosen people must not drop them for having
      // revealed the field. Deduplicated the way the chosen list itself is.
      const names: string[] = [];
      for (const candidate of [...this.chosenNames, ...(input?.value.split("\n") ?? [])]) {
        const trimmed = candidate.trim();
        if (trimmed !== "" && !names.includes(trimmed)) names.push(trimmed);
      }
      this.close();
      if (names.length > 0) this.onList(names);
    };

    // On the dialog rather than on the field: where the picker is shown there
    // is no field to carry it, and Ctrl/Cmd+Enter has to confirm either way
    // (`plugin-authoring-commands`). A plain Enter stays unhandled here, so it
    // goes on belonging to the list inside the textarea where that is shown.
    contentEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) confirm();
    });

    // The confirmation in its container, as in `ColumnCountModal`: the two
    // dialogs differ in what they ask with and in nothing else.
    contentEl
      .createEl("div", { cls: "modal-button-container" })
      .createEl("button", { text: "Insert" })
      .addEventListener("click", confirm);
  }

  /**
   * The reachability status line, the search input, the searchable class
   * filter, the results list, its "Add visible" control, and the list of who
   * has been chosen so far - the whole of the dialog where a login is held.
   *
   * Nothing here is a `<button>`: the modal's confirmation is its first and
   * only one, which is how `answerNameList` and `dialogBoxes`
   * (`test/obsidian/harness.js`) address it, and a button here would be found
   * first and break both. `.safelearn-directory-result`, the chosen rows and
   * the "Add visible" control are all clickable `<div>`s for that reason.
   *
   * `revealTypedList` is the way out where the directory cannot answer at
   * all: see `NameListModal.onOpen`.
   */
  private async buildDirectorySearch(contentEl: HTMLElement, revealTypedList: () => void) {
    const container = contentEl.createDiv({ cls: "safelearn-directory-search" });

    // Hidden while the directory is reachable or the request was refused (the
    // same silence `plugin-login-state` already gives a refusal) - shown only
    // for "unreachable" and "failed". `design.md` - "The status line is a
    // plain element, not a `<button>`".
    const status = container.createDiv({ cls: "safelearn-directory-status" });
    status.hidden = true;

    const query = container.createEl("input", { type: "text", cls: "safelearn-directory-search-query" });
    query.placeholder = "Search the directory…";
    query.style.width = "100%";

    // A text input narrowing a checkbox list, replacing the old `<select>` -
    // `design.md` - "Class filter: a text input narrows a checkbox list".
    const classFilterQuery = container.createEl("input", {
      type: "text",
      cls: "safelearn-directory-class-filter",
    });
    classFilterQuery.placeholder = "Filter classes…";
    classFilterQuery.style.width = "100%";

    const classOptions = container.createDiv({ cls: "safelearn-directory-class-options" });

    const results = contentEl.createDiv({ cls: "safelearn-directory-results" });

    // A plain clickable `<div>`, following `.safelearn-directory-result`'s own
    // pattern - never a `<button>`. It takes over exactly what the result list
    // is showing, which is the one action a narrowed-to-a-class picker exists
    // for.
    const addVisible = contentEl.createDiv({ cls: "safelearn-directory-add-visible" });
    addVisible.setText("Add visible");

    // Who has been chosen, below what is on offer: the list the dialog will
    // actually return, including people chosen under a filter that no longer
    // shows them. Its own scroll box, so a long selection never pushes the
    // confirmation out of view (`design.md`, Risks).
    const chosen = contentEl.createDiv({ cls: "safelearn-directory-chosen" });
    const chosenCount = chosen.createDiv({ cls: "safelearn-directory-chosen-count" });
    const chosenList = chosen.createDiv({ cls: "safelearn-directory-chosen-list" });

    // The full, unfiltered set of class names from the one `classLikeValues()`
    // fetch below - `classFilterQuery` narrows what is *shown*, it does not
    // re-fetch (`tasks.md` #3.2).
    let allClasses: string[] = [];
    // Which classes are currently checked, surviving a re-render of the
    // checkbox list itself (`tasks.md` #3.4).
    const checkedClasses = new Set<string>();
    // What the results list currently shows, which is exactly what "Add
    // visible" takes over - the union of every checked class, not the last
    // search's full result and not the whole directory.
    let lastEntries: DirectoryEntry[] = [];

    /**
     * Shows who is chosen, and how many - a count so a selection carried over
     * from an earlier filter is legible at a glance rather than only by
     * scrolling the list it sits in.
     */
    const renderChosen = () => {
      chosenCount.setText(
        this.chosenNames.length === 0
          ? "Nobody chosen yet."
          : `${this.chosenNames.length} ${this.chosenNames.length === 1 ? "person" : "people"} chosen.`
      );
      chosenList.empty();
      for (const name of this.chosenNames) {
        const row = chosenList.createDiv({ cls: "safelearn-directory-chosen-name" });
        // The same attribute the result rows carry, for the same reason: a
        // check finds a specific person without depending on how the row is
        // worded around them.
        row.setAttribute("data-safelearn-name", name);
        row.setText(name);
        row.addEventListener("click", () => {
          const at = this.chosenNames.indexOf(name);
          if (at >= 0) this.chosenNames.splice(at, 1);
          renderChosen();
        });
      }
    };

    /** Moves one person into the chosen list, or leaves them there once if they already are. */
    const choose = (name: string) => {
      const trimmed = name.trim();
      if (trimmed === "" || this.chosenNames.includes(trimmed)) return;
      this.chosenNames.push(trimmed);
      renderChosen();
    };

    // A fetch in progress is shown in the same line, but never in the same
    // terms: it carries its own class so it reads as a wait rather than as the
    // error the other two are, which is the distinction `plugin-directory-search`
    // asks for between "still fetching", "unreachable" and "failed".
    const setStatus = (
      outcome: DirectorySearchResult["outcome"],
      progress: DirectoryFetchProgress | null = null
    ) => {
      status.removeClass("safelearn-directory-status-fetching");
      if (outcome === "fetching") {
        status.setText(directoryFetchProgressText(progress));
        status.addClass("safelearn-directory-status-fetching");
        status.hidden = false;
      } else if (outcome === "unreachable") {
        status.setText("The directory could not be reached.");
        status.hidden = false;
        revealTypedList();
      } else if (outcome === "failed") {
        status.setText("The directory search failed.");
        status.hidden = false;
        revealTypedList();
      } else {
        status.hidden = true;
      }
    };

    const renderResults = (entries: DirectoryEntry[]) => {
      lastEntries = entries;
      results.empty();
      for (const entry of entries) {
        const item = results.createDiv({ cls: "safelearn-directory-result" });
        // The display name alone, not the whole rendered text: a check needs
        // to find a specific match without depending on how the roles beside
        // it are formatted for reading.
        item.setAttribute("data-safelearn-name", entry.name);

        item.createSpan({ text: `${entry.name} — ${Object.keys(entry.roles).join(", ") || "no roles"}` });

        // The whole row moves that person down into the chosen list. There is
        // no mark to keep in step with anything: what has been chosen lives in
        // `chosenNames` alone, so a re-render from a new search leaves an
        // already-chosen person chosen, and once.
        item.addEventListener("click", () => choose(entry.name));
      }
    };

    const renderClassOptions = () => {
      const typed = classFilterQuery.value.trim().toLowerCase();
      const shown =
        typed === "" ? allClasses : allClasses.filter((value) => value.toLowerCase().includes(typed));
      classOptions.empty();
      for (const value of shown) {
        const row = classOptions.createDiv({ cls: "safelearn-directory-class-option" });
        const checkbox = row.createEl("input", {
          type: "checkbox",
          cls: "safelearn-directory-class-option-checkbox",
        });
        checkbox.checked = checkedClasses.has(value);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) checkedClasses.add(value);
          else checkedClasses.delete(value);
          void runSearch();
        });
        row.createSpan({ text: value });
        row.addEventListener("click", (event) => {
          if (event.target === checkbox) return;
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event("change"));
        });
      }
    };

    // The server takes one query, matched against a name or a role/group -
    // there is no combined "text AND class" query to send. So a class filter
    // narrows whatever the text query (or, with none typed, the class name
    // itself) came back with, client-side.
    const searchOneClass = async (text: string, className: string): Promise<DirectorySearchResult> => {
      const result = await this.plugin.searchDirectory(text !== "" ? text : className);
      if (result.outcome !== "ok" || className === "") return result;
      return {
        outcome: "ok",
        entries: result.entries.filter((entry) => Object.keys(entry.roles).includes(className)),
      };
    };

    // "fetching" outranks a plain refusal (there is something to show, and to
    // wait on) but never a failure or an unreachable instance: those say
    // something about this instance that a wait would paper over.
    const outcomeRank: Record<DirectorySearchResult["outcome"], number> = {
      ok: 0,
      refused: 1,
      fetching: 2,
      failed: 3,
      unreachable: 4,
    };

    /**
     * Waits out the running fetch and then does `whenDone`, replacing any wait
     * already under way so two of them can never render over each other.
     * `searchDirectory("")` is the probe rather than this modal's own merged
     * search: it is one call, and it is the same call the modal makes when it
     * opens.
     */
    const waitOutFetch = (
      progress: DirectoryFetchProgress | null,
      whenDone: (result: DirectorySearchResult) => void | Promise<void>
    ) => {
      setStatus("fetching", progress);
      this.fetchWait?.stop();
      const wait = new DirectoryFetchWait(this.plugin);
      this.fetchWait = wait;
      void wait
        .untilDone(
          () => this.plugin.searchDirectory(""),
          (advanced) => setStatus("fetching", advanced)
        )
        .then(async (result) => {
          if (this.fetchWait !== wait || result === null) return;
          this.fetchWait = null;
          if (result.outcome !== "ok") {
            setStatus(result.outcome, result.progress ?? null);
            return;
          }
          await whenDone(result);
        });
    };

    /**
     * What a completed `searchDirectory("")` makes of the strip: the class
     * filter's options, and the reachability line. Whichever wait finishes
     * calls this, so a picker that was opened mid-fetch ends up with the same
     * class list as one opened after it - the person never has to reopen it.
     */
    const applyDirectory = (result: DirectorySearchResult) => {
      allClasses = result.outcome === "ok" ? classLikeValues(result.entries) : [];
      setStatus(result.outcome);
      renderClassOptions();
    };

    // One `searchDirectory` call per checked class, unioned and de-duplicated
    // by name (`proposal.md`'s decided client-merge approach); with none
    // checked, today's "no class filter" behavior - a single call for the
    // text query, or the whole directory when that is also empty.
    const runSearch = async () => {
      const text = query.value.trim();
      const classes = checkedClasses.size > 0 ? [...checkedClasses] : [""];

      const outcomes = await Promise.all(classes.map((className) => searchOneClass(text, className)));
      const outcome = outcomes.reduce(
        (worst, current) => (outcomeRank[current.outcome] > outcomeRank[worst] ? current.outcome : worst),
        "ok" as DirectorySearchResult["outcome"]
      );
      // The instance has nothing to search yet. Show the fetch, and re-run this
      // very search once it finishes, so the picker fills in without the person
      // retyping anything.
      if (outcome === "fetching") {
        waitOutFetch(outcomes.find((one) => one.outcome === "fetching")?.progress ?? null, async (result) => {
          // The class filter is loaded here too: a query typed during the wait
          // supersedes the wait the modal started when it opened, and the class
          // options that wait was going to fill in must not be lost with it.
          applyDirectory(result);
          await runSearch();
        });
        return;
      }

      setStatus(outcome);

      // An unreachable instance or a failed request is additive information,
      // not a wipe of what an earlier, successful search already found -
      // `tasks.md` #2.4.
      if (outcome === "unreachable" || outcome === "failed") return;

      const merged = new Map<string, DirectoryEntry>();
      if (outcome === "ok") {
        for (const oneClass of outcomes) for (const entry of oneClass.entries) merged.set(entry.name, entry);
      }
      renderResults([...merged.values()]);
    };

    let debounceHandle: number | undefined;
    query.addEventListener("input", () => {
      window.clearTimeout(debounceHandle);
      debounceHandle = window.setTimeout(() => void runSearch(), 300);
    });

    let classFilterDebounceHandle: number | undefined;
    classFilterQuery.addEventListener("input", () => {
      window.clearTimeout(classFilterDebounceHandle);
      classFilterDebounceHandle = window.setTimeout(() => renderClassOptions(), 300);
    });

    // Exactly what the result list is showing: nobody when it is showing
    // nobody, which loses nothing already chosen, and everybody it is showing
    // otherwise, in one action.
    addVisible.addEventListener("click", () => {
      for (const entry of lastEntries) choose(entry.name);
    });

    // An empty chosen list still says so, from the moment the dialog opens.
    renderChosen();

    // The search field carries the focus the textarea used to, so the dialog
    // opens ready to be typed into and Ctrl/Cmd+Enter reaches the handler on
    // the modal's content element.
    query.focus();

    // Fetched once per modal open, not per keystroke - see `tasks.md` #7.2 of
    // the prior change. The one fetch the reachability signal piggybacks on -
    // `design.md` - no second request is added for it.
    const initial = await this.plugin.searchDirectory("");
    if (initial.outcome === "fetching") waitOutFetch(initial.progress ?? null, applyDirectory);
    else applyDirectory(initial);
  }

  onClose() {
    // A dialog nobody is looking at must leave nothing polling behind it.
    this.fetchWait?.stop();
    this.fetchWait = null;
    this.contentEl.empty();
  }
}

/**
 * The weekday names the `Day` column carries, indexed by `Date.getDay()`.
 *
 * A fixed English list, not `toLocaleDateString(undefined, { weekday: "short"
 * })`. That reads `Mo` on a German machine and `Mon` on an English one, so two
 * teachers editing the same class file would write two spellings into the one
 * column. The corpus is shared and the headings already in it are English; the
 * weekday column matches them.
 *
 * Sunday-first because `getDay()` is. The dialog offers its checkboxes
 * Monday-first, which is how a school week reads here.
 */
const WEEKDAY_SHORT_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The narrowest a generated column is written - which is what a delimiter row
 * needs in order to read as one.
 *
 * Only the marker column ever reaches for it: its heading is empty and its
 * widest cell is `x`. Three rather than one because three is what the tables in
 * the corpus carry and what Obsidian's own table editor pads to, so the first
 * edit of a generated table is not a diff of pure whitespace.
 */
const MIN_TABLE_COLUMN_WIDTH = 3;

/** Two digits, which both `dd.MM.yyyy` and `yyyy-MM-dd` want of a day and a month. */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Reads the `yyyy-MM-dd` an `<input type="date">` hands out as local midnight of
 * that calendar day - null where there is no date in it.
 *
 * Never `new Date(value)`: a bare `yyyy-MM-dd` is read as *UTC* midnight, and in
 * any timezone west of UTC `getDate()` then reports the day before. That is a
 * whole table shifted by one day, and shifted only for some of the people
 * running the command. Built from components it is local midnight, which is the
 * same calendar day everywhere. `readsAsTime` builds its dates this way, for
 * this reason.
 *
 * The two guards are not one guard twice. A segment that is not there at all
 * leaves `undefined`, which `Number.isNaN` says nothing about, and it is the
 * date built from it that comes out invalid.
 */
function readDateField(value: string): Date | null {
  const [year, month, day] = value
    .trim()
    .split("-")
    .map((segment) => Number.parseInt(segment, 10));
  if ([year, month, day].some((segment) => Number.isNaN(segment))) return null;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Today, as the `yyyy-MM-dd` an `<input type="date">` takes.
 *
 * Not `toISOString().slice(0, 10)`, which is the UTC day: east of UTC, between
 * local midnight and the UTC one, that is yesterday - and a dialog that opens on
 * yesterday is wrong in the way nobody checks.
 */
function todayAsDateFieldValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** A calendar day as one comparable number, so that comparing two dates cannot turn on the time of day either carries. */
function dayOrdinal(date: Date): number {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

/**
 * Every date from `start` to `end` inclusive whose weekday was ticked, in
 * chronological order.
 *
 * The walk advances by calendar day - `setDate(getDate() + 1)` - and not by
 * 86_400_000 milliseconds. A fixed day drifts by an hour across a
 * daylight-saving boundary, and a semester-long range crosses one nearly every
 * time: the winter term ends beside one and the summer term begins beside the
 * other. `setDate` moves the calendar field and leaves the clock to the runtime.
 * The end is compared as a calendar day for the same reason - where a zone's
 * midnight does not exist on the switching day the walk lands an hour off it,
 * and a comparison of timestamps would drop the last row for it.
 *
 * Nothing is left out. A holiday is a row like any other, because the break in
 * the teaching is written *into* the row it falls on by the person who knows
 * what the break is, and because an unbroken run of weeks is the overview the
 * table exists to give.
 *
 * Empty where the end falls before the start or nothing was ticked. The dialog
 * refuses both as well; this is the rule itself, standing in the code that would
 * otherwise build the table - as `insertSideBySide`'s `if (columns < 2) return;`
 * does.
 */
function lessonDates(start: Date, end: Date, weekdays: ReadonlySet<number>): Date[] {
  const last = dayOrdinal(end);
  if (weekdays.size === 0 || last < dayOrdinal(start)) return [];

  const dates: Date[] = [];
  const cursor = new Date(start.getTime());
  while (dayOrdinal(cursor) <= last) {
    if (weekdays.has(cursor.getDay())) dates.push(new Date(cursor.getTime()));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

/**
 * One subject heading out of the two halves the dialog asks for.
 *
 * The headings in the corpus are a subject over the teachers who take it -
 * `0WMC<br>(UNTEG)` - and that `<br>` is markup in the middle of a heading
 * nobody should have to know about to lay out a semester. So the dialog asks
 * for the two halves and this puts them together; what a person types is what
 * they would say out loud.
 *
 * Either half alone is that half, not a heading with an empty line in it: a
 * `<br>` written above nothing leaves a heading that sits oddly high in its
 * row, and somebody who filled in one field meant one line.
 */
function subjectHeading(subject: string, teachers: string): string {
  const over = subject.trim();
  const under = teachers.trim();
  if (over === "" || under === "") return over === "" ? under : over;
  return `${over}<br>${under}`;
}

/**
 * The subject headings as the author gave them, with only what would break the
 * table changed.
 *
 * They carry markup on purpose - `0WMC<br>(UNTEG)` - so nothing here normalizes
 * them: what belongs in a heading is the author's to decide, and a command that
 * reformatted them would be deciding it instead. An unescaped `|` is the
 * exception, because it ends the cell early and shifts every column after it -
 * one heading would break the table rather than itself.
 *
 * A blank line in the field is no column at all.
 */
function subjectHeadings(entries: string[]): string[] {
  return entries
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => entry.replace(/\|/g, "\\|"));
}

/**
 * The table: a heading row, a delimiter row, and one row per lesson.
 *
 * Written aligned, every cell padded to the width of the widest thing in its
 * column. That is what the tables in the corpus look like, and what Obsidian's
 * table editor would reformat an unaligned table into the first time somebody
 * edited it - so writing it unaligned only means the first edit produces a large
 * diff of pure whitespace.
 */
function semesterTableLines(dates: Date[], subjects: string[]): string[] {
  // The marker column's heading is empty. Markdown has no cell background, so
  // which lesson is next is said by a character in a column of its own - and a
  // column holding one `x` needs no name above it.
  const headings = ["", "Day", "Date", ...subjects, "Info"];
  const blankSubjects = subjects.map(() => "");
  const rows = dates.map((date, index) => [
    // At the moment the table is generated, the next lesson is its first row.
    index === 0 ? "x" : "",
    WEEKDAY_SHORT_NAMES[date.getDay()],
    `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}`,
    ...blankSubjects,
    "",
  ]);

  const widths = headings.map((heading, column) =>
    Math.max(MIN_TABLE_COLUMN_WIDTH, heading.length, ...rows.map((row) => row[column].length))
  );
  const line = (cells: string[]) =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`;

  return [line(headings), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)];
}

/**
 * The text the table will stand under, as `writeLines` is going to place it.
 *
 * Not simply the line above the cursor. With the cursor in the middle of a line
 * the insertion breaks that line, and what stands above the table is the part
 * before the cursor; at the very top of a gated file `writeLines` writes *below*
 * the directive rather than above it, so what stands above the table there is
 * the directive.
 */
function textAboveInsertion(editor: Editor): string {
  const from = editor.getCursor("from");
  const before = editor.getLine(from.line).slice(0, from.ch);
  if (before !== "") return before;
  if (from.line > 0) return editor.getLine(from.line - 1);
  return isFileLevelDirective(editor.getLine(0)) ? editor.getLine(0) : "";
}

/**
 * Writes the semester table: one row for every ticked weekday in the range, in
 * the columns the dialog was given.
 */
function insertSemesterTable(
  editor: Editor,
  start: Date,
  end: Date,
  weekdays: ReadonlySet<number>,
  subjects: string[]
) {
  const dates = lessonDates(start, end, weekdays);
  // A heading row over nothing is not a semester table; it is a thing to delete
  // before the dialog can be answered properly.
  if (dates.length === 0) return;

  // A selection means nothing to this command - a grid of empty cells has
  // nothing to enclose one with - and `writeLines` replaces what is selected.
  // Collapsed to where the selection begins, the table stands beside it and
  // nothing is lost. `insertSectionsPerName` faces this and does the same.
  editor.setCursor(editor.getCursor("from"));

  const table = semesterTableLines(dates, subjectHeadings(subjects));
  // A blank line above the table unless there is one already. `writeLines`
  // guarantees the insertion begins on a line of its own, which is not the same
  // thing: a table directly beneath a paragraph can be read as part of that
  // paragraph. Obsidian's renderer is lenient about it and the server renders
  // this same corpus, and a document should not rest on which of the two
  // forgives more.
  const lines = textAboveInsertion(editor).trim() === "" ? table : ["", ...table];

  // The cursor lands on the first data row: the row carrying the marker, and the
  // one there is anything to write in.
  writeLines(editor, lines, lines.length - dates.length);
}

/**
 * Asks what a semester table covers: the span, the weekdays the class meets, and
 * the subject columns to lay out.
 *
 * In the manner of `ColumnCountModal` - the fields built in `onOpen`, confirmed
 * on a button in `modal-button-container` and on Enter, closed before the
 * callback runs - with rather more to ask about than a number.
 */
class SemesterTableModal extends Modal {
  constructor(
    app: App,
    private readonly onGenerate: (
      start: Date,
      end: Date,
      weekdays: Set<number>,
      subjects: string[]
    ) => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Semester table" });

    // The fields say which format the table will carry, because they cannot show
    // it: `<input type="date">` draws itself in the browser's locale, so
    // somebody whose Chromium is set to US English is offered `09/21/2026` while
    // the table writes `21.09.2026`. The value behind the field is ISO either
    // way, so the table is unaffected - what was left to do about it is to say so.
    const start = this.dateField("First lesson (written as dd.MM.yyyy)", todayAsDateFieldValue());
    const end = this.dateField("Last lesson (written as dd.MM.yyyy)", "");

    contentEl.createEl("label", {
      text: "Weekdays the class meets",
      cls: "safelearn-semester-label",
    });
    const weekdayRow = contentEl.createDiv({ cls: "safelearn-semester-weekdays" });
    const ticks = new Map<number, HTMLInputElement>();
    // Monday first, which is how a school week reads here. The numbers stay the
    // ones `getDay()` hands out.
    for (const day of [1, 2, 3, 4, 5, 6, 0]) {
      const label = weekdayRow.createEl("label");
      ticks.set(day, label.createEl("input", { type: "checkbox" }));
      label.appendText(` ${WEEKDAY_SHORT_NAMES[day]}`);
    }

    contentEl.createEl("label", {
      text: "Subject columns - the subject, and who takes it",
      cls: "safelearn-semester-label",
    });
    const subjectRows = contentEl.createDiv({ cls: "safelearn-semester-subjects" });
    const subjects: { subject: HTMLInputElement; teachers: HTMLInputElement }[] = [];

    /**
     * One subject column: the two halves of its heading, side by side.
     *
     * A row is added as the last one is filled in, so the dialog is as long as
     * the class it is describing and nobody counts empty rows before starting.
     * The two halves are written into one heading by `subjectHeading`; the
     * `<br>` between them is markup, and asking a person to type markup into a
     * dialog is asking them to know about a detail of the format the dialog
     * exists to spare them.
     */
    const addSubjectRow = () => {
      const row = subjectRows.createDiv({ cls: "safelearn-semester-subject" });
      const subject = row.createEl("input", { type: "text" });
      subject.placeholder = "0WMC";
      const teachers = row.createEl("input", { type: "text" });
      teachers.placeholder = "(UNTEG)";
      subjects.push({ subject, teachers });

      for (const field of [subject, teachers]) {
        field.addEventListener("input", () => {
          const last = subjects[subjects.length - 1];
          if (last.subject.value.trim() === "" && last.teachers.value.trim() === "") return;
          addSubjectRow();
        });
        // Bound here rather than over the rows that exist when the dialog opens,
        // because rows are added while it is open and a field Enter does nothing
        // in is a field that behaves differently from the one beside it.
        field.addEventListener("keydown", (event) => {
          if (event.key === "Enter") confirm();
        });
      }
      return row;
    };

    // Three to begin with, which is as many as the fullest class file in the
    // corpus carries - and a fourth appears as soon as the third is used.
    for (let column = 0; column < 3; column++) addSubjectRow();

    // Left open rather than closed on nothing: what is wrong is a field to
    // correct, and a dialog that had vanished would have to be opened and filled
    // in again before it could be.
    const refuse = (reason: string) => {
      new Notice(reason);
    };

    const confirm = () => {
      const from = readDateField(start.value);
      const to = readDateField(end.value);
      const chosen = new Set(
        [...ticks].filter(([, tick]) => tick.checked).map(([day]) => day)
      );

      if (!from || !to) return refuse("A semester table needs a first and a last lesson.");
      if (dayOrdinal(to) < dayOrdinal(from)) return refuse("The last lesson falls before the first.");
      if (chosen.size === 0) return refuse("Tick at least one weekday for the class.");

      this.close();
      this.onGenerate(
        from,
        to,
        chosen,
        subjects.map((row) => subjectHeading(row.subject.value, row.teachers.value))
      );
    };

    // Enter confirms from either date field - the subject fields bind it as they
    // are built, since more of them appear while the dialog is open.
    for (const field of [start, end]) {
      field.addEventListener("keydown", (event) => {
        if (event.key === "Enter") confirm();
      });
    }

    contentEl
      .createEl("div", { cls: "modal-button-container" })
      .createEl("button", { text: "Generate" })
      .addEventListener("click", confirm);

    start.focus();
  }

  onClose() {
    this.contentEl.empty();
  }

  /** One labelled `<input type="date">`, since the dialog asks for two of them. */
  private dateField(text: string, value: string): HTMLInputElement {
    this.contentEl.createEl("label", { text, cls: "safelearn-semester-label" });
    const input = this.contentEl.createEl("input", { type: "date" });
    input.value = value;
    input.style.width = "100%";
    return input;
  }
}

/** Whether a directory entry's role/group set holds the teacher or admin role - the same three values `hasDirectoryRole()` checks on the held token. */
function entryHoldsTeacherOrAdmin(entry: DirectoryEntry): boolean {
  const roles = Object.keys(entry.roles).map((role) => role.toLowerCase());
  return roles.includes("teacher") || roles.includes("teachers") || roles.includes("admin");
}

/**
 * A read-only, point-in-time overview of the whole directory - every teacher,
 * every class, and a per-user role lookup - all derived from one
 * `searchDirectory("")` fetch made when the modal opens. See `design.md` of
 * `plugin-directory-info-page` for why this stays a `Modal` rather than a
 * persistent view, and why the user search filters the already-held entries
 * client-side instead of re-querying per keystroke like `NameListModal` does.
 *
 * Nothing here writes anything - not to the vault, not to the safeLearn
 * server, not to Keycloak. The one fetch is the whole of what this modal asks
 * of anything outside itself.
 */
class DirectoryInfoModal extends Modal {
  /** The wait on a running directory fetch, while one is being waited on - ended in `onClose`, per `tasks.md` #5.4. */
  private fetchWait: DirectoryFetchWait | null = null;

  constructor(private readonly plugin: SafeLearnPlugin) {
    super(plugin.app);
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Directory info" });

    // Shown only for a non-`ok` outcome, exactly as `NameListModal`'s own
    // directory status line - `design.md`, "Outcome handling reuses
    // `buildDirectorySearch`'s status-line pattern".
    const status = contentEl.createDiv({ cls: "safelearn-directory-status" });
    status.hidden = true;

    // Shown only on an `ok` outcome, alongside the Teachers/Classes/Users
    // lists below rather than instead of them - `proposal.md`, "visible as
    // soon as the one `searchDirectory("")` fetch resolves".
    const summary = contentEl.createDiv({ cls: "safelearn-directory-info-summary" });
    summary.hidden = true;

    // The state of the data the rest of the view is built from: how much of it
    // there is, how old it is, and what was lost building it. Shown in the same
    // terms whether or not a fetch is running, so "fresh" and "held since
    // yesterday" are told apart at a glance rather than assumed.
    contentEl.createEl("h4", { text: "Directory data" });
    const state = contentEl.createDiv({ cls: "safelearn-directory-info-state" });
    state.setText("Directory state unknown.");

    contentEl.createEl("h4", { text: "Teachers" });
    const teachers = contentEl.createEl("ul", { cls: "safelearn-directory-info-list" });

    contentEl.createEl("h4", { text: "Classes" });
    const classes = contentEl.createEl("ul", { cls: "safelearn-directory-info-list" });

    contentEl.createEl("h4", { text: "Users" });
    const query = contentEl.createEl("input", { type: "text", cls: "safelearn-directory-search-query" });
    query.placeholder = "Search users…";
    query.style.width = "100%";
    // A plain clickable `<div>`, never a `<button>` - `NameListModal`'s own
    // convention (`tasks.md` #3.4), so the test harness's generic first-button
    // lookup stays unambiguous here too.
    const results = contentEl.createDiv({ cls: "safelearn-directory-results" });
    const detail = contentEl.createDiv({ cls: "safelearn-directory-info-user-detail" });

    let entries: DirectoryEntry[] = [];

    const renderResults = (matches: DirectoryEntry[]) => {
      results.empty();
      for (const entry of matches) {
        const item = results.createDiv({ cls: "safelearn-directory-result" });
        item.setText(entry.name);
        item.addEventListener("click", () => {
          detail.setText(`${entry.name} — ${Object.keys(entry.roles).join(", ") || "no roles"}`);
        });
      }
    };

    query.addEventListener("input", () => {
      const typed = query.value.trim().toLowerCase();
      const matches = typed === "" ? entries : entries.filter((entry) => entry.name.toLowerCase().includes(typed));
      renderResults(matches);
    });

    /** Everything below the status line, filled in from one completed fetch - run once, whenever that fetch actually resolves. */
    const fillIn = (result: DirectorySearchResult) => {
      if (result.outcome === "unreachable") {
        status.setText("The directory could not be reached.");
        status.hidden = false;
      } else if (result.outcome !== "ok") {
        status.setText("The directory search failed.");
        status.hidden = false;
      } else {
        status.hidden = true;
        status.removeClass("safelearn-directory-status-fetching");
        entries = result.entries;
      }

      const classValues = classLikeValues(entries);
      if (result.outcome === "ok") {
        summary.setText(`${entries.length} users, ${classValues.length} classes`);
        summary.hidden = false;
      }

      teachers.empty();
      classes.empty();
      for (const entry of entries.filter(entryHoldsTeacherOrAdmin)) {
        teachers.createEl("li", { text: entry.name });
      }
      for (const value of classValues) {
        classes.createEl("li", { text: value });
      }
      renderResults(entries);
    };

    /** The "Directory data" section - its own call, so it says something even while the search is still waiting on a fetch. */
    const showState = async () => {
      state.setText(directoryStateSummary(await this.plugin.directoryStatus()));
    };
    void showState();

    const initial = await this.plugin.searchDirectory("");
    if (initial.outcome !== "fetching") {
      fillIn(initial);
      return;
    }

    // A fetch in progress is a wait, not a failure: the status line carries the
    // fetch's own wording and its own class, and the sections below stay empty
    // until it resolves - at which point they fill in, with the view still open.
    status.setText(directoryFetchProgressText(initial.progress ?? null));
    status.addClass("safelearn-directory-status-fetching");
    status.hidden = false;
    this.fetchWait = new DirectoryFetchWait(this.plugin);
    const waited = await this.fetchWait.untilDone(
      () => this.plugin.searchDirectory(""),
      (progress) => {
        status.setText(directoryFetchProgressText(progress));
        state.setText(directoryFetchProgressText(progress));
      }
    );
    this.fetchWait = null;
    if (waited === null) return;
    fillIn(waited);
    await showState();
  }

  onClose() {
    // A dialog nobody is looking at must leave nothing polling behind it.
    this.fetchWait?.stop();
    this.fetchWait = null;
    this.contentEl.empty();
  }
}
