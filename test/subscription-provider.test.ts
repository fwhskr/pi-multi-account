import assert from "node:assert/strict";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ApiKeyCredential, Credential } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { withBrowserLoginStatus } from "../subscription-provider.ts";
import { childFacingAuthEntryForSlot, mergeParentAuth, type AuthBlob } from "../slot-proxy-auth.ts";

const slot = "anthropic-account-2";
const placeholder = childFacingAuthEntryForSlot(slot)!;
const oauth = { type: "oauth" as const, access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3600000 };

test("browser status follows the real login, without changing child transport auth", async () => {
  const native = builtinProviders().find(provider => provider.id === "anthropic")!;
  const auth: Record<string, AuthBlob> = { [slot]: placeholder };
  const sidecar: Record<string, AuthBlob> = { [slot]: oauth };
  const provider = withBrowserLoginStatus({ ...native, id: slot,
    getModels: () => native.getModels().map(model => ({ ...model, provider: slot })),
  }, slot, () => mergeParentAuth(auth, sidecar));
  let stored: Credential | undefined = placeholder as ApiKeyCredential;
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false,
    credentials: {
      read: async id => id === slot ? stored : undefined,
      list: async () => stored ? [{ providerId: slot, type: stored.type }] : [],
      modify: async (_id, fn) => { stored = await fn(stored) ?? stored; return stored; },
      delete: async () => { stored = undefined; },
    } });
  runtime.registerNativeProvider(provider);
  await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.isUsingOAuth(slot), true, "selector must identify the browser login, not the proxy API-key envelope");
  assert.equal((await runtime.checkAuth(slot))?.source, "Browser login");
  assert.equal((await runtime.getAuth(slot))?.auth.apiKey, placeholder.key, "the existing child transport is unchanged");
  delete sidecar[slot];
  await runtime.refresh({ allowNetwork: false });
  assert.equal(await runtime.checkAuth(slot), undefined, "a transport marker without its real login is not an account");
  assert.equal(runtime.isUsingOAuth(slot), false);
});

test("genuine API-key status is never converted using a stale browser sidecar", async () => {
  const native = builtinProviders().find(provider => provider.id === "anthropic")!;
  const provider = withBrowserLoginStatus(native, slot, () => ({ [slot]: oauth }));
  const input = { credential: { type: "api_key", key: "synthetic-real-key" }, ctx: { env: async () => undefined }, signal: new AbortController().signal };
  assert.equal((await provider.auth.apiKey!.check!(input as any))?.type, "api_key");
  assert.equal((await provider.auth.apiKey!.resolve(input as any))?.auth.apiKey, "synthetic-real-key");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.auth.apiKey!.check!({ ...input, signal: controller.signal } as any));
});
