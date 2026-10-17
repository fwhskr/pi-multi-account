import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const dir = mkdtempSync("/home/kris/.pi/agent/var/task-274-publication-");
process.env.PI_CODING_AGENT_DIR = dir;
Object.defineProperty(ModelRuntime, "generatedProviderConfig", { value: true, configurable: true });
const { provisionNativeSlot, default: extension } = await import("../index.ts");

test("native catalogs are referenced, not copied into owner configuration", () => {
  const ownerPath = join(dir, "models.json");
  const owner = JSON.stringify({ providers: { fixture: { baseUrl: "https://fixture.invalid" } } });
  writeFileSync(ownerPath, owner);
  provisionNativeSlot("anthropic", { api: "anthropic-messages", baseUrl: "http://127.0.0.1:12345", apiKey: "synthetic-local-proxy", models: [{ id: "synthetic-model" }] });
  provisionNativeSlot("anthropic-account-2", { api: "anthropic-messages", baseUrl: "http://127.0.0.1:12345", apiKey: "synthetic-local-proxy", models: [{ id: "synthetic-model" }] });
  provisionNativeSlot("openai-account-2", { api: "openai-responses", baseUrl: "http://127.0.0.1:12345/v1", apiKey: "synthetic-local-proxy", models: [{ id: "synthetic-model" }] });
  const generated = JSON.parse(readFileSync(join(dir, "models.generated.json"), "utf8"));
  assert.equal(readFileSync(ownerPath, "utf8"), owner, "startup publication cannot rewrite owner configuration");
  assert.equal(generated.providers.anthropic.models, undefined);
  assert.equal(generated.providers["anthropic-account-2"].models, undefined);
  assert.equal(generated.providers["anthropic-account-2"].catalogProvider, "anthropic");
  assert.equal(generated.providers["openai-account-2"].models, undefined);
  assert.equal(generated.providers["openai-account-2"].catalogProvider, "openai");
});

test("a bundled Cursor implementation does not invent accounts or catalogs", async () => {
  writeFileSync(join(dir, "auth.json"), "{}");
  writeFileSync(join(dir, "provider-failover.json"), JSON.stringify({ includeCursor: true, childProxy: false, autoDiscoverModels: false }));
  const ids: string[] = [];
  const events: Record<string, Array<(event: object, ctx: object) => Promise<void>>> = {};
  const pi = {
    registerProvider(provider: string | { id: string }) { ids.push(typeof provider === "string" ? provider : provider.id); },
    on(name: string, fn: (event: object, ctx: object) => Promise<void>) { (events[name] ??= []).push(fn); },
    registerCommand() {}, appendEntry() {}, getThinkingLevel() { return "high"; },
  };
  try {
    await extension(pi as any);
    assert.equal(ids.some(id => /^cursor(?:-account-\d+)?$/.test(id)), false);
    const generated = JSON.parse(readFileSync(join(dir, "models.generated.json"), "utf8"));
    assert.equal(Object.keys(generated.providers).some(id => id.startsWith("cursor")), false);
  } finally {
    for (const fn of events.session_shutdown ?? []) await fn({}, { ui: { setStatus() {} } });
  }
});

test.after(() => {
  delete (ModelRuntime as any).generatedProviderConfig;
  rmSync(dir, { recursive: true, force: true });
});
