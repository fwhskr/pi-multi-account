/**
 * TASK-143: anthropic-account aliases must resolve model definitions from the
 * live host catalog, not the stale bundled pi-ai.
 *
 * Each test imports only the pure helpers (anthropicModelDef +
 * snapshotHostAnthropicModel) — never the extension entry point — so the
 * fixture catalog never touches the real pi-ai on disk. The stale fixture
 * models the bundled 0.82.1 copy (haiku-5-5/sonnet-5-5 missing); the host
 * fixture models the live 1.1.0 catalog the base provider serves.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
	anthropicModelDef,
	snapshotAnthropicHostModels,
	snapshotHostAnthropicModel,
} from "../index.ts";

// Live host catalog (pi-ai 1.1.0): 1M window, full thinking map incl. xhigh/max.
const LIVE_HAIKU_5_5 = {
	id: "claude-haiku-5-5",
	name: "Claude Haiku 5.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	contextWindow: 1000000,
	maxTokens: 128000,
	thinkingLevelMap: {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	},
};

const LIVE_SONNET_5_5 = {
	...LIVE_HAIKU_5_5,
	id: "claude-sonnet-5-5",
	name: "Claude Sonnet 5.5",
};

// Stale bundled catalog (pi-ai 0.82.1): neither 5-5 id resolves.
const STALE_CATALOG: Record<string, unknown> = {
	"claude-haiku-4-5": { id: "claude-haiku-4-5", contextWindow: 200000 },
};

function staleGetModel(_provider: string, id: string): unknown {
	return STALE_CATALOG[id];
}

function hostRegistry() {
	return {
		getAll: () => [LIVE_HAIKU_5_5, LIVE_SONNET_5_5],
		find: (_provider: string, id: string) =>
			id === LIVE_HAIKU_5_5.id
				? LIVE_HAIKU_5_5
				: id === LIVE_SONNET_5_5.id
					? LIVE_SONNET_5_5
					: undefined,
	};
}

// Host's extended-thinking support rule (mirrors pi's getSupportedThinkingLevels):
// xhigh/max need an explicit map entry; without a map they clamp away.
function supportsXhigh(def: { thinkingLevelMap?: Record<string, string | null> }): boolean {
	return def.thinkingLevelMap?.xhigh === "xhigh";
}

test("TASK-143: alias def for claude-haiku-5-5 matches the base provider", () => {
	const snapshots = snapshotAnthropicHostModels(
		() => hostRegistry().getAll(),
		hostRegistry().find,
	);
	const base = { ...LIVE_HAIKU_5_5, provider: "anthropic" };
	const alias = anthropicModelDef("claude-haiku-5-5", "anthropic-account-2", {
		host: snapshots.get("claude-haiku-5-5"),
		catalog: staleGetModel("anthropic", "claude-haiku-5-5") as Record<string, unknown> | null,
		base,
	});
	assert.equal(alias.provider, "anthropic-account-2");
	assert.equal(alias.contextWindow, base.contextWindow);
	assert.equal(alias.maxTokens, base.maxTokens);
	assert.deepEqual(alias.thinkingLevelMap, base.thinkingLevelMap);
});

test("TASK-143: xhigh is supported on the alias, not clamped to high", () => {
	const snapshots = snapshotAnthropicHostModels(
		() => hostRegistry().getAll(),
		hostRegistry().find,
	);
	const alias = anthropicModelDef("claude-haiku-5-5", "anthropic-account-2", {
		host: snapshots.get("claude-haiku-5-5"),
		catalog: staleGetModel("anthropic", "claude-haiku-5-5") as Record<string, unknown> | null,
	});
	assert.ok(
		supportsXhigh(alias),
		`alias must carry xhigh in its thinking map, got ${JSON.stringify(alias.thinkingLevelMap)}`,
	);
});

test("TASK-143: unknown model id copies the base provider shape, not the 200K generic", () => {
	const base = { ...LIVE_SONNET_5_5, provider: "anthropic" };
	const alias = anthropicModelDef("claude-future-9-9", "anthropic-account-2", {
		catalog: null,
		base,
	});
	assert.equal(alias.provider, "anthropic-account-2");
	assert.equal(alias.contextWindow, base.contextWindow);
	assert.deepEqual(alias.thinkingLevelMap, base.thinkingLevelMap);
});

test("TASK-143: stale bundled catalog alone still resolves ids it knows", () => {
	const known = {
		id: "claude-haiku-4-5",
		contextWindow: 200000,
		maxTokens: 64000,
		thinkingLevelMap: { high: "high" },
	};
	const alias = anthropicModelDef("claude-haiku-4-5", "anthropic-account-2", {
		catalog: known,
	});
	assert.equal(alias.contextWindow, 200000);
	assert.equal(alias.provider, "anthropic-account-2");
});

test("TASK-143: snapshot helper keeps live fields and drops unknown shapes", () => {
	const snap = snapshotHostAnthropicModel(LIVE_HAIKU_5_5);
	assert.equal(snap?.contextWindow, 1000000);
	assert.equal(snap?.thinkingLevelMap?.xhigh, "xhigh");
	assert.equal(snap?.thinkingLevelMap?.max, "max");
	assert.equal(snapshotHostAnthropicModel(undefined), undefined);
	assert.equal(snapshotHostAnthropicModel({ id: 42 } as never), undefined);
	const snapshots = snapshotAnthropicHostModels(
		() => hostRegistry().getAll(),
		hostRegistry().find,
	);
	assert.ok(snapshots.get("claude-haiku-5-5"));
	assert.ok(snapshots.get("claude-sonnet-5-5"));
});
