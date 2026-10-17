import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const start = source.indexOf('function registerAnthropicSlot(');
const end = source.indexOf('\nfunction ', start + 1);
const code = source.slice(start, end).replace(/^function registerAnthropicSlot/, 'function registerAnthropicSlot');
// Run the exact production registration body with synthetic SDK boundaries.
// Strip only its parameter type annotations, not its executable body.
const js = code.replace('pi: ExtensionAPI', 'pi').replace('id: string', 'id')
  .replace('modelIds: string[]', 'modelIds').replace('liveCatalog?: () => readonly any[]', 'liveCatalog')
  .replace(/: any/g, '').replace(/\(pi\.registerProvider as any\)/g, 'pi.registerProvider')
  .replace(/ as any/g, '');

function harness() {
  const base = [{ id: 'fixture-chat', provider: 'anthropic', contextWindow: 777, type: 'chat' }];
  const providers = [];
  let depth = 0, queries = 0;
  const registry = { getAll() {
    if (++depth > 4) { depth--; throw new Error('recursive registry catalog'); }
    queries++;
    try { return [...base, ...providers.flatMap(p => p.getAllModels())]; } finally { depth--; }
  } };
  const pi = { registerProvider(provider) { providers.push(provider); } };
  const native = { id: 'anthropic', auth: { oauth: { login() {} } }, getModels: () => base };
  const register = new Function('builtinProviders', 'ANTHROPIC_BASE', 'GENERATED_PROVIDER_CONFIG',
    'DEFAULT_ANTHROPIC_MODELS', 'anthropicPayloadStream', 'withBrowserLoginStatus', 'readAuthFile',
    `${js}; return registerAnthropicSlot;`)(() => [native], 'anthropic', true, [], () => {}, p => p, () => ({}));
  return { base, providers, registry, register, pi, queries: () => queries };
}

test('provider catalogs do not call back into the enumerating registry', () => {
  const h = harness();
  h.register(h.pi, 'anthropic-account-2', [], 'https://fixture.invalid', () => h.registry.getAll().filter(m => m.provider === 'anthropic'));
  const before = h.queries();
  const models = h.registry.getAll();
  assert.equal(h.queries(), before + 1, 'only the explicit enumeration reads the registry');
  assert.equal(models.length, 2);
  assert.equal(models[1].provider, 'anthropic-account-2');
  assert.equal(models[1].contextWindow, 777);
  assert.deepEqual(h.providers[0].getModels(), h.providers[0].getAllModels());
});

test('multiple aliases and native fallback stay finite and return fresh model objects', () => {
  const h = harness();
  for (let i = 2; i < 5; i++) h.register(h.pi, `anthropic-account-${i}`, [], 'https://fixture.invalid', () => h.registry.getAll().filter(m => m.provider === 'anthropic'));
  assert.equal(h.registry.getAll().length, 4);
  const p = h.providers[0];
  p.getModels()[0].contextWindow = 1;
  assert.equal(p.getModels()[0].contextWindow, 777);
  const f = harness();
  f.register(f.pi, 'anthropic-account-2');
  assert.equal(f.registry.getAll().length, 2);
});
