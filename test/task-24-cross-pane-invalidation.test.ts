/**
 * TASK-24 regression fixture — cross-pane propagation of a dead-account invalidation.
 *
 * TASK-21 made ONE process stop probing an account after it records it as invalid.
 * But several Pi panes share one state file, and each pane's `invalidatedByProvider`
 * Map is loaded once at construction. A pane that did not itself discover the dead
 * account therefore keeps issuing the per-account catalogue fetch and logging
 * `model_catalog_error` HTTP 401s — the live symptom.
 *
 * This fixture stands up TWO independent extension instances (two closures from the
 * same module = two panes) over ONE state file. Instance A discovers the dead account
 * and writes the invalidation; instance B was constructed BEFORE that write, so its
 * in-memory copy is empty. B must still skip the fetch once the record is on disk.
 *
 * RED before the fix: B logs a `model_catalog_error` / performs the catalogue fetch
 * for the dead account. GREEN after: B performs none.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pmacct-task24-"));
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

function readDebugLog(): Array<Record<string, any>> {
	try {
		return readFileSync(DEBUG_LOG, "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

function readState(): Record<string, any> {
	try {
		return JSON.parse(readFileSync(STATE, "utf8"));
	} catch {
		return {};
	}
}

/**
 * Build one extension "pane": a fresh pi harness plus a fresh closure from the real
 * module. Nothing is reset on disk here — the caller controls the shared state file.
 */
function makeInstance(opts: {
	accounts: Record<string, any>;
	current: { provider: string; id: string };
	config?: Record<string, unknown>;
	forceRefreshResults?: Record<string, any>;
}) {
	const known = new Set<string>(Object.keys(opts.accounts));
	const registeredModels = new Map<string, any[]>();
	const mkModel = (provider: string, id: string) => ({ provider, id });
	const rec = { setModels: [] as string[], notifies: [] as string[] };
	const events: Record<string, (event: any, ctx?: any) => any> = {};

	const ctx: any = {
		model: mkModel(opts.current.provider, opts.current.id),
		isIdle: () => true,
		signal: { aborted: false },
		hasPendingMessages: () => false,
		abort: () => {},
		ui: { notify: (m: string) => rec.notifies.push(m), setStatus: () => {} },
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
			rec.setModels.push(`${model.provider}/${model.id}`);
			ctx.model = mkModel(model.provider, model.id);
			return true;
		},
		sendUserMessage: () => {},
		continueAgent: async () => {},
		appendEntry: () => {},
		getThinkingLevel: () => "high",
		setThinkingLevel: () => {},
	};

	piMultiAccount(pi);
	const fire = async (event: string, payload: any = {}) => events[event]?.(payload, ctx);
	return { ctx, rec, fire };
}

test("a second pane stops probing an account another pane already invalidated (TASK-24)", async () => {
	const now = Date.now();
	const deadFetches: string[] = [];
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

	try {
		const accounts = {
			"openai-codex": {
				type: "oauth",
				access: "codex-main",
				refresh: "r1",
				accountId: "main",
			},
			[DEAD]: {
				type: "oauth",
				access: "codex-dead",
				refresh: "r2",
				accountId: "dead-account",
				expires: now - 86_400_000,
			},
		};
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

		const instanceOpts = {
			accounts,
			current: { provider: "openai-codex", id: "gpt-5.5" },
			forceRefreshResults: { [DEAD]: { status: "terminal", error: "invalid_grant" } },
		};
		// Both panes exist before either one has written an invalidation, exactly like a
		// machine where several panes were launched against an empty state file.
		const paneA = makeInstance(instanceOpts);
		const paneB = makeInstance(instanceOpts);

		// Pane A discovers the dead account and records the invalidation on disk.
		await paneA.fire("session_start");
		const invalidation = readState().invalidatedByProvider?.[DEAD];
		assert.ok(
			invalidation,
			"pane A must persist the dead-account invalidation to the shared state file",
		);

		// Now pane B runs. Its in-memory map never saw A's write; it must still skip the
		// dead account because the record is on disk.
		const beforeB = deadFetches.length;
		const logBeforeB = readDebugLog().filter(
			(event) => event.kind === "model_catalog_error" && event.provider === DEAD,
		).length;
		await paneB.fire("session_start");
		const bFetches = deadFetches.length - beforeB;
		const bErrors =
			readDebugLog().filter(
				(event) => event.kind === "model_catalog_error" && event.provider === DEAD,
			).length - logBeforeB;

		assert.equal(
			bFetches,
			0,
			`pane B must not issue a catalogue fetch for an account invalidated on disk; got ${bFetches}`,
		);
		assert.equal(
			bErrors,
			0,
			`pane B must not log a model_catalog_error for the invalidated account; got ${bErrors}`,
		);

		await paneA.fire("session_shutdown");
		await paneB.fire("session_shutdown");
	} finally {
		globalThis.fetch = originalFetch;
	}
});
