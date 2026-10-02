/**
 * TASK-25 regression fixture — the owner is told when a login has expired.
 *
 * Reported defect: one OpenAI/Codex login expired (OAuth refresh permanently refused,
 * `invalid_grant`). The extension kept retrying it and logged only to the debug file, so
 * the owner was never told the login had expired or that `/login` fixes it.
 *
 * This fixture drives the REAL module (no mocks around the code under test) with an
 * isolated PI_CODING_AGENT_DIR, exactly like the TASK-24 fixture. It exercises the real
 * detection path (`session_start` → Codex catalogue 401 → terminal refresh → markInvalid)
 * and asserts the owner-facing notice.
 *
 * RED before the fix: `markInvalid` emits no notification and no footer status.
 * GREEN after: exactly one plain-language notice per expiry event, a persistent footer
 * status, no notice for a temporary cooldown or a healthy account, and both clear after
 * a fresh login changes the credential hash.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pmacct-task25-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.PI_CURSOR_PROVIDER_ROOT = join(AGENT_DIR, "cursor-provider");

const MODULE_INDEX = process.env.PI_MULTI_ACCOUNT_INDEX || "../index.ts";

const { default: piMultiAccount } = (await import(MODULE_INDEX)) as {
	default: (pi: any) => void;
};

const AUTH = join(AGENT_DIR, "auth.json");
const CONFIG = join(AGENT_DIR, "provider-failover.json");
const STATE = join(AGENT_DIR, "provider-failover-state.json");
const DEBUG_LOG = join(AGENT_DIR, "provider-failover-debug.log");

const DEAD = "openai-codex-account-2";
const MAIN = "openai-codex";

const EXPIRY_NOTICE = /has expired/i;

function readState(): Record<string, any> {
	try {
		return JSON.parse(readFileSync(STATE, "utf8"));
	} catch {
		return {};
	}
}

function resetFiles(accounts: Record<string, any>) {
	writeFileSync(AUTH, JSON.stringify(accounts));
	writeFileSync(
		CONFIG,
		JSON.stringify({
			enabled: true,
			autoContinue: false,
			autoDiscover: true,
			autoDiscoverModels: true,
			showUsage: false,
			fallbacks: [],
		}),
	);
	rmSync(STATE, { force: true });
	rmSync(DEBUG_LOG, { force: true });
}

function expiredDeadAccount(overrides: Record<string, any> = {}) {
	return {
		type: "oauth",
		access: "codex-dead",
		refresh: "r2",
		accountId: "dead-account",
		expires: Date.now() - 86_400_000,
		...overrides,
	};
}

function healthyMainAccount() {
	return {
		type: "oauth",
		access: "codex-main",
		refresh: "r1",
		accountId: "main",
		expires: Date.now() + 86_400_000,
	};
}

/**
 * One extension "pane": a fresh pi harness plus a fresh closure from the real module.
 * Records notifications and footer status calls.
 */
function makeInstance(opts: {
	accounts: Record<string, any>;
	current: { provider: string; id: string };
	forceRefreshResults?: Record<string, any>;
}) {
	const known = new Set<string>(Object.keys(opts.accounts));
	const mkModel = (provider: string, id: string) => ({ provider, id });
	const rec = {
		notifies: [] as Array<{ message: string; level?: string }>,
		statuses: [] as Array<{ key: string; text: unknown }>,
	};
	const events: Record<string, (event: any, ctx?: any) => any> = {};

	const ctx: any = {
		model: mkModel(opts.current.provider, opts.current.id),
		isIdle: () => true,
		signal: { aborted: false },
		hasPendingMessages: () => false,
		abort: () => {},
		ui: {
			notify: (message: string, level?: string) =>
				rec.notifies.push({ message, level }),
			setStatus: (key: string, text: unknown) =>
				rec.statuses.push({ key, text }),
		},
		modelRegistry: {
			find: (provider: string, id: string) =>
				known.has(provider) ? mkModel(provider, id) : undefined,
			getAll: () => [...known].map((provider) => mkModel(provider, "gpt-5.5")),
			authStorage: {
				reload: () => {},
				forceRefreshProvider: async (provider: string) =>
					opts.forceRefreshResults?.[provider] ?? {
						status: "terminal",
						error: "invalid_grant: refresh token expired",
					},
				hasAuth: (provider: string) => {
					const entry = JSON.parse(readFileSync(AUTH, "utf8"))[provider];
					return !!(entry?.key || entry?.access);
				},
			},
			getProviderAuthStatus: (provider: string) => ({ configured: known.has(provider) }),
			getApiKeyAndHeaders: async () => ({ ok: false as const, error: "no key in test" }),
		},
		getContextUsage: () => undefined,
	};

	const pi: any = {
		registerProvider: (name: string, providerConfig?: { models?: any[] }) => {
			known.add(name);
			if (providerConfig?.models) {
				registeredModels.set(
					name,
					providerConfig.models.map((model) => ({ ...model, provider: name })),
				);
			}
		},
		registerCommand: () => {},
		on: (event: string, handler: any) => {
			events[event] = handler;
		},
		setModel: async (model: any) => {
			ctx.model = mkModel(model.provider, model.id);
			return true;
		},
		sendUserMessage: () => {},
		continueAgent: async () => {},
		appendEntry: () => {},
		getThinkingLevel: () => "high",
		setThinkingLevel: () => {},
	};

	const registeredModels = new Map<string, any[]>();
	piMultiAccount(pi);
	const fire = async (event: string, payload: any = {}) => events[event]?.(payload, ctx);
	return { ctx, rec, fire, registeredModels, opts };
}

function expiryNotices(rec: { notifies: Array<{ message: string }> }) {
	return rec.notifies.filter((n) => EXPIRY_NOTICE.test(n.message));
}

function lastStatus(rec: { statuses: Array<{ key: string; text: unknown }> }, key: string) {
	for (let i = rec.statuses.length - 1; i >= 0; i--) {
		if (rec.statuses[i].key === key) return rec.statuses[i].text;
	}
	return undefined;
}

/** A catalogue fetch that 401s for the dead account, 200 for everyone else. */
function installCatalogFetch(deadFetches: string[]) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (_input: any, init?: RequestInit) => {
		const account = new Headers(init?.headers).get("ChatGPT-Account-Id");
		if (account === "dead-account") {
			deadFetches.push(new Date().toISOString());
			return new Response("unauthorized", { status: 401 });
		}
		return new Response(
			JSON.stringify({
				models: [
					{
						slug: "gpt-5.5",
						display_name: "5.5",
						visibility: "list",
						priority: 10,
						supported_reasoning_levels: [{ effort: "high" }],
					},
				],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;
	return () => {
		globalThis.fetch = originalFetch;
	};
}

test("expired login tells the owner exactly once, in plain language, with a footer status", async () => {
	const restore = installCatalogFetch([]);
	try {
		resetFiles({ [MAIN]: healthyMainAccount(), [DEAD]: expiredDeadAccount() });
		const pane = makeInstance({
			accounts: { [MAIN]: healthyMainAccount(), [DEAD]: expiredDeadAccount() },
			current: { provider: MAIN, id: "gpt-5.5" },
			forceRefreshResults: { [DEAD]: { status: "terminal", error: "invalid_grant" } },
		});

		await pane.fire("session_start");

		const notices = expiryNotices(pane.rec);
		assert.equal(
			notices.length,
			1,
			`expected exactly one owner login-expiry notice, got ${notices.length}: ${JSON.stringify(notices)}`,
		);
		const text = notices[0].message;
		assert.match(text, /has expired/i, "the notice must say the login expired");
		assert.match(text, /openai-codex-account-2/, "the notice must name the account");
		assert.match(text, /\/login/, "the notice must give the exact action /login");
		assert.match(text, /other account/i, "the notice must reassure that other accounts still work");
		assert.doesNotMatch(
			text,
			/\bdead\b|invalid|remove|revoked|bad account/i,
			"the notice must not suggest the account itself is bad",
		);
		assert.doesNotMatch(text, /\.json|\/home\/|auth\.json/, "no file paths in owner-facing text");

		const invalidated = readState().invalidatedByProvider ?? {};
		assert.ok(invalidated[DEAD], "the expiry must be recorded in the state file");

		const footer = lastStatus(pane.rec, "multi-account-login");
		assert.equal(typeof footer, "string", "a persistent footer status must be set");
		assert.match(String(footer), /expired/i);
		assert.match(String(footer), /\/login/);

		// A second session start in the SAME process must not repeat the notice.
		await pane.fire("session_start");
		assert.equal(
			expiryNotices(pane.rec).length,
			1,
			"the notice must be emitted once per expiry event, not on every session start",
		);

		await pane.fire("session_shutdown");
	} finally {
		restore();
	}
});

test("a temporary cooldown does not raise the login-expired notice", async () => {
	const restore = installCatalogFetch([]);
	try {
		resetFiles({ [MAIN]: healthyMainAccount(), [DEAD]: expiredDeadAccount() });
		const pane = makeInstance({
			accounts: { [MAIN]: healthyMainAccount(), [DEAD]: expiredDeadAccount() },
			current: { provider: MAIN, id: "gpt-5.5" },
			forceRefreshResults: { [DEAD]: { status: "transient", error: "temporary" } },
		});

		await pane.fire("session_start");

		assert.equal(
			expiryNotices(pane.rec).length,
			0,
			"a temporary cooldown is not an expired login",
		);
		const state = readState();
		assert.ok(
			!(state.invalidatedByProvider ?? {})[DEAD],
			"a temporary cooldown must not invalidate the account",
		);
		assert.ok(
			(state.exhaustedUntilByProvider ?? {})[DEAD] > Date.now(),
			"the account must carry a temporary cooldown instead",
		);
		const footer = lastStatus(pane.rec, "multi-account-login");
		assert.ok(
			footer === undefined || !EXPIRY_NOTICE.test(String(footer)),
			"the footer must not claim an expired login for a temporary cooldown",
		);

		await pane.fire("session_shutdown");
	} finally {
		restore();
	}
});

test("a healthy account raises no login-expired notice", async () => {
	const restore = installCatalogFetch([]);
	try {
		resetFiles({ [MAIN]: healthyMainAccount(), [DEAD]: healthyMainAccount() });
		const pane = makeInstance({
			accounts: { [MAIN]: healthyMainAccount(), [DEAD]: healthyMainAccount() },
			current: { provider: MAIN, id: "gpt-5.5" },
		});

		await pane.fire("session_start");

		assert.equal(expiryNotices(pane.rec).length, 0, "a healthy account must not raise a notice");
		assert.deepEqual(readState().invalidatedByProvider ?? {}, {}, "nothing may be invalidated");

		await pane.fire("session_shutdown");
	} finally {
		restore();
	}
});

test("the notice clears after a fresh login restores the account", async () => {
	const restore = installCatalogFetch([]);
	try {
		resetFiles({ [MAIN]: healthyMainAccount(), [DEAD]: expiredDeadAccount() });
		const pane = makeInstance({
			accounts: { [MAIN]: healthyMainAccount(), [DEAD]: expiredDeadAccount() },
			current: { provider: MAIN, id: "gpt-5.5" },
			forceRefreshResults: { [DEAD]: { status: "terminal", error: "invalid_grant" } },
		});

		await pane.fire("session_start");
		assert.equal(expiryNotices(pane.rec).length, 1, "the first expiry must notify");
		assert.ok((readState().invalidatedByProvider ?? {})[DEAD], "the expiry must be recorded");

		// Fresh login: a NEW access token (different credential hash) with a live expiry.
		writeFileSync(
			AUTH,
			JSON.stringify({
				[MAIN]: healthyMainAccount(),
				[DEAD]: expiredDeadAccount({ access: "codex-dead-fresh", expires: Date.now() + 86_400_000 }),
			}),
		);
		pane.opts.forceRefreshResults![DEAD] = { status: "refreshed" };
		await pane.fire("session_start");

		assert.ok(
			!(readState().invalidatedByProvider ?? {})[DEAD],
			"a fresh login must clear the invalidation from the state file",
		);
		assert.equal(
			expiryNotices(pane.rec).length,
			1,
			"a restored login must not raise a new notice",
		);
		assert.equal(
			lastStatus(pane.rec, "multi-account-login"),
			undefined,
			"the footer notice must clear once the login is restored",
		);

		await pane.fire("session_shutdown");
	} finally {
		restore();
	}
});
