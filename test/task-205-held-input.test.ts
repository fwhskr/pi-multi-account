import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// The real extension uses these paths at import time. Never use the installed
// agent directory, provider credentials, network, or real model identifiers.
const agentDir = mkdtempSync("/home/kris/.pi/agent/var/task-205-");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CURSOR_PROVIDER_ROOT = join(agentDir, "absent-cursor");
const { default: multiAccount } = await import("../index.ts");
const provider = "fixture-provider";
const model = { provider, id: "fixture-model" };

test("TASK-205: a hold fails boundedly if auth disappears after admission", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => { throw new Error("network forbidden in synthetic fixture"); };
	const events: Record<string, (event: any, ctx: any) => any> = {};
	const notices: string[] = [];
	const sent: unknown[] = [];
	let authenticated = true;
	const ctx: any = {
		model: { ...model }, cwd: agentDir, isIdle: () => true,
		ui: { notify: (text: string) => notices.push(text), setStatus: () => {} },
		modelRegistry: {
			find: (p: string, id: string) => p === provider && id === model.id ? { ...model } : undefined,
			getAll: () => [{ ...model }],
			authStorage: { reload: () => {}, hasAuth: () => authenticated },
			getProviderAuthStatus: () => ({ configured: true }),
		},
	};
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ [provider]: { type: "api_key", key: "synthetic" } }));
	writeFileSync(join(agentDir, "provider-failover.json"), JSON.stringify({
		enabled: true, autoDiscover: false, autoDiscoverModels: false, showUsage: false,
		fallbacks: [`${provider}/${model.id}`],
	}));
	writeFileSync(join(agentDir, "provider-failover-state.json"), JSON.stringify({
		stateVersion: 4, exhaustedUntilByProvider: { [provider]: Date.now() + 1000 },
	}));
	multiAccount({
		on: (name: string, handler: any) => { events[name] = handler; },
		registerCommand: () => {}, registerProvider: () => {},
		setModel: async () => true, appendEntry: () => {},
		sendUserMessage: (content: unknown) => { sent.push(content); },
	} as any);
	try {
		assert.deepEqual(await events.input({ source: "interactive", text: "resume fixture" }, ctx), { action: "handled" });
		assert.ok(notices.some((text) => text.includes("held in memory")), "fixture must enter the real hold path");
		authenticated = false;
		writeFileSync(join(agentDir, "auth.json"), "{}");
		for (let ms = 0; ms < 62_000; ms += 1000) {
			t.mock.timers.tick(1000);
			// Drain guarded async timer callbacks before advancing fake time again.
			for (let i = 0; i < 20; i++) await Promise.resolve();
		}
		assert.equal(sent.length, 0);
		assert.ok(notices.some((text) => /delivery failed/i.test(text)), "held input must not silently lose its wake when availability disappears");
	} finally {
		await events.session_shutdown({}, ctx);
		globalThis.fetch = originalFetch;
		t.mock.timers.reset();
		rmSync(agentDir, { recursive: true, force: true });
	}
});
