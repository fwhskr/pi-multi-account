/**
 * TASK-143: anthropic-account aliases must carry the running host's catalog metadata
 * (1M window, full thinking map), never the generic 200K/no-thinking-map fallback.
 * Upstream binds the catalog to the host SDK (no private pi-ai copy), so the alias
 * definition is resolved from the same SDK that serves the base provider.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { anthropicModelDef } from "../index.ts";
import { getModel } from "@earendil-works/pi-ai/compat";

test("alias def mirrors the host catalog window and thinking map for a model the host knows", () => {
	const host = getModel("anthropic" as any, "claude-haiku-5-5" as any) as any;
	assert.ok(host, "the matched development SDK carries claude-haiku-5-5");
	const alias = anthropicModelDef("claude-haiku-5-5", "anthropic-account-2") as any;
	assert.equal(alias.provider, "anthropic-account-2");
	assert.equal(alias.contextWindow, host.contextWindow);
	assert.ok(alias.contextWindow > 200000, "not the generic 200K fallback");
	assert.deepEqual(alias.thinkingLevelMap, host.thinkingLevelMap);
});

test("a model unknown to every source still gets a usable generic definition on the alias provider", () => {
	const alias = anthropicModelDef("claude-no-such-model-0", "anthropic-account-3") as any;
	assert.equal(alias.provider, "anthropic-account-3");
	assert.equal(alias.id, "claude-no-such-model-0");
	assert.equal(alias.api, "anthropic-messages");
});
