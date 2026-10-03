/** Real Pi session integration: account preflight must not reset selected effort. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.env.PI_TASK45_SCRATCH;
assert.ok(root, "PI_TASK45_SCRATCH must name an isolated evidence directory");
mkdirSync(root, { recursive: true });
const agentDir = mkdtempSync(join(root, "thinking-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_SUBAGENT_AGENT = "Halo";
delete process.env.PI_HERDR_PERSONA;
delete process.env.SULA_DESKTOP_AGENT;

// No credentials, provider calls, or live user configuration participate.
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
	"openai-codex": { type: "oauth", access: "fixture-primary", refresh: "fixture-refresh1", accountId: "fixture1", expires: Date.now() + 3_600_000 },
	"openai-codex-account-2": { type: "oauth", access: "fixture-account2", refresh: "fixture-refresh2", accountId: "fixture2", expires: Date.now() + 3_600_000 },
}));
writeFileSync(join(agentDir, "provider-failover.json"), JSON.stringify({
	enabled: true, autoDiscover: true, autoDiscoverModels: false,
	showUsage: false, includeCursor: false, autoContinue: false,
	preferredModels: { "openai-codex": ["gpt-6.1-sol"] },
}));
mkdirSync(join(agentDir, "agents"));
writeFileSync(join(agentDir, "agents", "Halo.md"),
	"---\nmodel: openai-codex/gpt-6.1-sol\nthinking: high\nfallbacks: []\n---\nfixture\n");

// Use the installed host SDK when validating a fork against newer Pi releases.
const sdk = await import(process.env.PI_TASK45_HOST_ENTRY ?? "@earendil-works/pi-coding-agent");
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = sdk;
const { default: multiAccount } = await import("../index.ts");

test("startup account2 preflight preserves profile high with global max", { timeout: 15_000 }, async () => {
	writeFileSync(join(agentDir, "provider-failover-state.json"), JSON.stringify({
		stateVersion: 5,
		exhaustedUntilByProvider: { "openai-codex": Date.now() + 60_000 },
		lastProbeAtByProvider: {}, invalidatedByProvider: {}, lastSwitches: [],
	}));
	const settingsManager = SettingsManager.inMemory({
		defaultThinkingLevel: "max", compaction: { enabled: false },
	});
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false,
	});
	modelRuntime.registerProvider("openai-codex", {
		api: "openai-responses", apiKey: "fixture-primary", baseUrl: "https://fixture.invalid/v1",
		models: [{ id: "gpt-6.1-sol", name: "fixture", reasoning: true,
			thinkingLevelMap: { max: "max", xhigh: "xhigh" }, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: agentDir, agentDir, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, extensionFactories: [multiAccount],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const sessionManager = SessionManager.create(agentDir, join(agentDir, "sessions"));
	const { session } = await createAgentSession({
		cwd: agentDir, agentDir, settingsManager, modelRuntime, resourceLoader, sessionManager,
		model: modelRuntime.getModel("openai-codex", "gpt-6.1-sol"), thinkingLevel: "high", noTools: "all",
	});
	try {
		// Provider registration queues availability refreshes; settle local auth first.
		await modelRuntime.refresh({ allowNetwork: false });
		assert.equal(modelRuntime.hasConfiguredAuth("openai-codex-account-2"), true);
		assert.equal(session.thinkingLevel, "high", "profile/CLI selection before extensions");
		await session.bindExtensions({});
		assert.equal(session.model?.provider, "openai-codex-account-2", "real preflight chose account2");
		console.log("runtime entries:", JSON.stringify(sessionManager.getBranch().filter(
			(entry) => ["model_change", "thinking_level_change", "custom"].includes(entry.type))));
		assert.equal(session.thinkingLevel, "high", "account selection must not escalate high to global max");
	} finally {
		session.dispose();
	}
});
