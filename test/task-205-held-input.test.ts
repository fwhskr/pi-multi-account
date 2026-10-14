import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

// Import-time paths and every mutable fixture stay outside the live install.
const agentDir = mkdtempSync("/home/kris/.pi/agent/var/task-205-");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CURSOR_PROVIDER_ROOT = join(agentDir, "absent-cursor");
const { default: multiAccount } = await import("../index.ts");
const model = { provider: "fixture-provider", id: "fixture-model" };
const fallback = { provider: "fixture-other", id: "fixture-model-other" };
const target = (m: typeof model) => `${m.provider}/${m.id}`;
test.after(() => rmSync(agentDir, { recursive: true, force: true }));

async function fixture(t: TestContext, run: (h: ReturnType<typeof harness>) => Promise<void>, opts: Parameters<typeof harness>[0] = {}) {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => { throw new Error("network forbidden in synthetic fixture"); };
	const h = harness(opts);
	try { await run(h); }
	finally {
		await h.fire("session_shutdown");
		globalThis.fetch = originalFetch;
		t.mock.timers.reset();
	}
}

function harness(opts: { send?: (content: unknown, options: unknown) => any; other?: boolean; otherAvailable?: boolean; cooldownMs?: number; modelCooldownMs?: number; activation?: () => Promise<boolean> } = {}) {
	const models = opts.other ? [model, fallback] : [model];
	const accounts = Object.fromEntries(models.map((m) => [m.provider, { type: "api_key", key: `synthetic-${m.provider}` }]));
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify(accounts));
	writeFileSync(join(agentDir, "provider-failover.json"), JSON.stringify({
		enabled: true, autoDiscover: false, autoDiscoverModels: false, showUsage: false,
		fallbacks: models.map(target),
	}));
	writeFileSync(join(agentDir, "provider-failover-state.json"), JSON.stringify({
		stateVersion: 5, exhaustedUntilByProvider: { [model.provider]: Date.now() + (opts.cooldownMs ?? 1000), ...(opts.other ? { [fallback.provider]: Date.now() + (opts.otherAvailable ? 0 : 2000) } : {}) },
		exhaustedUntilByModel: opts.modelCooldownMs ? { [target(model)]: Date.now() + opts.modelCooldownMs } : {},
	}));
	const events: Record<string, (event: any, ctx: any) => any> = {};
	const commands: Record<string, (args: string, ctx: any) => any> = {};
	const notices: string[] = [];
	const entries: Array<{ type: string; data: any }> = [];
	const signals: Array<{ channel: string; data: any }> = [];
	const sent: Array<{ content: unknown; options: unknown }> = [];
	let authenticated = true;
	let idle = true;
	let wakeError = false;
	const ctx: any = {
		model: { ...model }, cwd: agentDir, isIdle: () => { if (wakeError) throw new Error("synthetic wake failure"); return idle; },
		ui: { notify: (text: string) => notices.push(text), setStatus: () => {} },
		modelRegistry: {
			find: (p: string, id: string) => models.find((m) => p === m.provider && id === m.id),
			getAll: () => models,
			authStorage: { reload: () => {}, hasAuth: () => authenticated },
			getProviderAuthStatus: () => ({ configured: authenticated }),
		},
	};
	multiAccount({
		on: (name: string, handler: any) => { events[name] = handler; },
		registerCommand: (name: string, cmd: any) => { commands[name] = cmd.handler; },
		registerProvider: () => {},
		setModel: async (m: any) => { const ok = await (opts.activation?.() ?? Promise.resolve(true)); if (ok) ctx.model = m; return ok; },
		appendEntry: (type: string, data: any) => { entries.push({ type, data }); },
		events: { emit: (channel: string, data: unknown) => { signals.push({ channel, data }); } },
		sendUserMessage: (content: unknown, options: unknown) => {
			const result = opts.send?.(content, options);
			if (result?.then) return result.then(() => { sent.push({ content, options }); });
			sent.push({ content, options });
		},
	} as any);
	return {
		ctx, notices, entries, signals, sent,
		fire: async (name: string, payload: any = {}) => events[name]?.(payload, ctx),
		input: async (text = "resume fixture", images?: any[]) => events.input({ source: "interactive", text, images }, ctx),
		stop: async () => commands["multi-account"]("stop", ctx),
		setIdle: (value: boolean) => { idle = value; },
		loseAuth: () => { authenticated = false; writeFileSync(join(agentDir, "auth.json"), "{}"); },
		breakWake: () => { wakeError = true; },
	};
}

async function advance(t: TestContext, ms: number) {
	for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
		t.mock.timers.tick(Math.min(1000, ms - elapsed));
		for (let i = 0; i < 40; i++) await Promise.resolve();
	}
}
const held = async (h: ReturnType<typeof harness>) => {
	assert.deepEqual(await h.input(), { action: "handled" });
	assert.ok(h.notices.some((text) => text.includes("held in memory")), "fixture must enter the real hold path");
};
const failed = (h: ReturnType<typeof harness>) => {
	assert.equal(h.notices.filter((text) => /delivery failed/i.test(text)).length, 1);
	assert.equal(h.signals.length, 1, "one terminal producer signal, not a claim of parent receipt");
	const signal = h.signals[0];
	assert.equal(signal.channel, "pi:held-input-delivery-failed:v1");
	assert.equal(signal.data.version, 1);
	assert.ok(signal.data.reason.length > 0 && signal.data.reason.length <= 1024);
	assert.ok(signal.data.holdId.length > 0 && signal.data.holdId.length <= 128);
	assert.ok(Number.isFinite(signal.data.queuedAt) && Number.isFinite(signal.data.deadlineAt));
	assert.equal(signal.data.deadlineAt - signal.data.queuedAt, 61_000);
	assert.deepEqual(h.entries.filter((entry) => entry.type === "held-input-delivery-failed"), [{ type: "held-input-delivery-failed", data: signal.data }]);
};

test("TASK-205: a hold fails boundedly if auth disappears after admission", async (t) => fixture(t, async (h) => {
	await held(h);
	h.loseAuth();
	await advance(t, 62_000);
	assert.equal(h.sent.length, 0);
	failed(h);
}));

test("TASK-205: cooldown expiry sends once, preserving queued images and follow-up order", async (t) => fixture(t, async (h) => {
	const image = { type: "image", data: "synthetic", mimeType: "image/png" };
	assert.deepEqual(await h.input("first", [image]), { action: "handled" });
	assert.deepEqual(await h.input("second"), { action: "handled" });
	await advance(t, 1000);
	assert.deepEqual(h.sent, [
		{ content: [{ type: "text", text: "first" }, image], options: undefined },
		{ content: "second", options: { deliverAs: "followUp" } },
	]);
	await advance(t, 62_000);
	assert.equal(h.sent.length, 2);
}));

test("TASK-205: busy wake sends once when idle before the hold bound", async (t) => fixture(t, async (h) => {
	await held(h);
	h.setIdle(false);
	await advance(t, 3000);
	assert.equal(h.sent.length, 0);
	h.setIdle(true);
	await advance(t, 1000);
	assert.equal(h.sent.length, 1);
}));

test("TASK-205: synthetic cooldown plus 60s bounds a permanently busy hold", async (t) => fixture(t, async (h) => {
	await held(h);
	h.setIdle(false);
	await advance(t, 60_000);
	assert.equal(h.notices.filter((text) => /delivery failed/i.test(text)).length, 0);
	await advance(t, 1000);
	failed(h);
	h.setIdle(true);
	await advance(t, 10_000);
	assert.equal(h.sent.length, 0);
}));

for (const asyncFailure of [false, true]) {
	test(`TASK-205: ${asyncFailure ? "rejected" : "throwing"} delivery fails once without claiming resume`, async (t) => fixture(t, async (h) => {
		await held(h);
		await advance(t, 62_000);
		assert.equal(h.sent.length, 0);
		failed(h);
		assert.equal(h.notices.filter((text) => text.includes("resumed 1 queued")).length, 0);
	}, { send: () => { const error = new Error("synthetic delivery error"); if (asyncFailure) return Promise.reject(error); throw error; } }));
}

test("TASK-205: stop drops a hold without sending or reporting delivery failure", async (t) => fixture(t, async (h) => {
	await held(h);
	await h.stop();
	await advance(t, 62_000);
	assert.equal(h.sent.length, 0);
	assert.equal(h.signals.length, 0);
	assert.equal(h.notices.filter((text) => /delivery failed/i.test(text)).length, 0);
}));

test("TASK-205: a wake exception cannot strand the hold", async (t) => fixture(t, async (h) => {
	await held(h);
	h.breakWake();
	await advance(t, 62_000);
	assert.equal(h.sent.length, 0);
	failed(h);
}));

test("TASK-205: stop during model activation cannot resurrect a drained hold", async (t) => {
	let release!: (value: boolean) => void;
	const activation = new Promise<boolean>((resolve) => { release = resolve; });
	await fixture(t, async (h) => {
		await held(h);
		h.loseAuth();
		// Keep the second account usable while making the selected one unavailable.
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ [fallback.provider]: { type: "api_key", key: "synthetic" } }));
		h.ctx.modelRegistry.authStorage.hasAuth = (p: string) => p === fallback.provider;
		h.ctx.modelRegistry.getProviderAuthStatus = (p: string) => ({ configured: p === fallback.provider });
		await advance(t, 2000);
		await h.stop();
		release(true);
		await advance(t, 62_000);
		assert.equal(h.sent.length, 0);
		assert.equal(h.signals.length, 0);
		assert.equal(h.notices.filter((text) => /delivery failed/i.test(text)).length, 0);
	}, { other: true, activation: () => activation });
});

test("TASK-205: a multi-day quota hold does not fail or probe before its reported reset", async (t) => fixture(t, async (h) => {
	await held(h);
	await advance(t, 70_000);
	assert.equal(h.sent.length, 0);
	assert.equal(h.notices.filter((text) => /delivery failed/i.test(text)).length, 0);
	await h.stop();
}, { cooldownMs: 3 * 86_400_000 }));

test("TASK-205: model cooldown is honored even after provider cooldown expires", async (t) => fixture(t, async (h) => {
	await held(h);
	await advance(t, 2000);
	assert.equal(h.sent.length, 0);
	await advance(t, 1000);
	assert.equal(h.sent.length, 1);
}, { modelCooldownMs: 3000 }));

test("TASK-205: hanging activation fails at the original bound and cannot deliver late", async (t) => {
	let release!: (value: boolean) => void;
	const activation = new Promise<boolean>((resolve) => { release = resolve; });
	await fixture(t, async (h) => {
		await held(h);
		h.loseAuth();
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ [fallback.provider]: { type: "api_key", key: "synthetic" } }));
		h.ctx.modelRegistry.authStorage.hasAuth = (p: string) => p === fallback.provider;
		h.ctx.modelRegistry.getProviderAuthStatus = (p: string) => ({ configured: p === fallback.provider });
		await advance(t, 61_000);
		failed(h);
		release(true);
		await advance(t, 10_000);
		assert.equal(h.sent.length, 0);
	}, { other: true, activation: () => activation });
});

test("TASK-205: a rejected follow-up never retries the already delivered first message", async (t) => {
	let calls = 0;
	await fixture(t, async (h) => {
		await h.input("first");
		await h.input("second");
		await advance(t, 62_000);
		assert.deepEqual(h.sent, [{ content: "first", options: undefined }]);
		assert.equal(calls, 2);
		failed(h);
	}, { send: () => { if (++calls === 2) throw new Error("synthetic follow-up delivery error"); } });
});

test("TASK-205: healthy fallback remains usable without waiting for current quota", async (t) => fixture(t, async (h) => {
	assert.deepEqual(await h.input(), { action: "continue" });
	assert.equal(h.ctx.model.provider, fallback.provider);
	await advance(t, 62_000);
	assert.equal(h.sent.length, 0, "host owns delivery when preflight returns continue");
	assert.equal(h.notices.filter((text) => text.includes("held in memory")).length, 0);
}, { other: true, otherAvailable: true }));
