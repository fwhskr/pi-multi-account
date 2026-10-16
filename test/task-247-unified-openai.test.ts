import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fetchUsageSnapshot, providerUsageLabel, usageFamily } from "../usage.ts";

const source = join(dirname(fileURLToPath(import.meta.url)), "..");
test("unified OpenAI slots preserve native authentication, transport, catalog and filtering", () => {
 const root = mkdtempSync(join(tmpdir(), "unified-provider-"));
 try {
  const extension = join(root, "extension");
  const ai = join(root, "node_modules/@earendil-works/pi-ai");
  mkdirSync(extension, { recursive: true });
  mkdirSync(join(ai, "dist/providers"), { recursive: true });
  writeFileSync(join(ai, "package.json"), '{"type":"module"}');
  writeFileSync(join(extension, "package.json"), '{"type":"module"}');
  for (const file of ["index.ts", "usage.ts", "model-catalog.ts", "cursor-bridge.ts"]) copyFileSync(join(source, file), join(extension, file));
  writeFileSync(join(ai, "dist/providers/openai.js"), `export function openaiProvider() {
   const model = { id: 'synthetic-chat', provider: 'openai', contextWindow: 765432, thinkingLevelMap: {max:'max'}, api:'native-responses' };
   return { id:'openai', name:'OpenAI', auth:{apiKey:{name:'API key'},oauth:{isSubscription:true,login:async()=>({type:'oauth'}),refresh:async c=>({...c,access:'new'})}},
    getModels:()=>[model], getAllModels:()=>[model], filterModels: models=>models, filterAllModels: models=>models, api:{api:'native-responses',streamSimple:()=> 'native-stream'} };
  }`);
  const driver = join(root, "driver.mjs");
  writeFileSync(driver, `import {mkdirSync,writeFileSync} from 'node:fs';
   process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(join(root, "agent"))};
   mkdirSync(process.env.PI_CODING_AGENT_DIR,{recursive:true});
   writeFileSync(process.env.PI_CODING_AGENT_DIR+'/auth.json',JSON.stringify({openai:{type:'oauth',access:'fixture',clientId:'fixture-client',scopes:['api.responses.write']},'openai-account-2':{type:'oauth',access:'fixture2',clientId:'fixture-client'},'openai-account-3':{type:'api_key',key:'fixture-api'}}));
   writeFileSync(process.env.PI_CODING_AGENT_DIR+'/provider-failover.json',JSON.stringify({showUsage:false,autoContinue:false,autoDiscoverModels:false,includeCursor:false,providerOrder:['openai']}));
   const providers=[]; const handlers={}; const commands={}; const notices=[]; const switched=[];
   const model=provider=>({provider,id:'synthetic-chat',contextWindow:765432,thinkingLevelMap:{max:'max'}});
   const ctx={model:model('openai'),isIdle:()=>true,signal:{aborted:false},ui:{notify:text=>notices.push(text),setStatus(){}},modelRegistry:{find:(provider,id)=>({...model(provider),id}),getAll:()=>[model('openai'),model('openai-account-2'),model('openai-account-3')],authStorage:{reload(){},hasAuth:()=>true},getProviderAuthStatus:()=>({configured:true})}};
   (await import('./extension/index.ts')).default({registerProvider:(...args)=>providers.push(args),registerCommand:(name,value)=>commands[name]=value.handler,on:(e,fn)=>{handlers[e]=fn},setModel:async value=>{ctx.model=value;switched.push(value.provider);return true},getThinkingLevel:()=> 'max',setThinkingLevel(){},appendEntry(){}});
   const native=providers.find(args=>args[0]?.id==='openai-account-2')?.[0];
   await commands['multi-account']('rediscover',ctx);
   await commands['multi-account']('next',ctx);
   await handlers.session_shutdown?.({},ctx);
   console.log(JSON.stringify({native:!!native, baseOverridden:providers.some(args=>args[0]==='openai'), api:native?.api?.api, auth:native?.auth?.oauth?.isSubscription, model:native?.getModels()[0], filter:!!native?.filterAllModels,notices,switched}));
  `);
  const result = JSON.parse(execFileSync("node", [driver], { encoding: "utf8", timeout: 10000 }).trim());
  assert.equal(result.native, true, "canonical numbered slot uses native Provider registration");
  assert.equal(result.baseOverridden, false, "do not replace the native base OAuth/API-key provider");
  assert.equal(result.api, "native-responses");
  assert.equal(result.auth, true);
  assert.equal(result.filter, true);
  assert.deepEqual(result.switched, ["openai-account-2"], "manual rotation chooses the canonical second OAuth slot");
  assert.ok(result.notices.some((text: string) => text.includes("Rotation: openai → openai-account-2")));
  assert.ok(result.notices.every((text: string) => !text.includes("openai-account-3")), "API keys stay outside subscription rotation");
  assert.deepEqual(result.model, { id:"synthetic-chat", provider:"openai-account-2", contextWindow:765432, thinkingLevelMap:{max:"max"}, api:"native-responses" });
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unified and legacy OpenAI usage names classify consistently; direct tokens never hit ChatGPT", async () => {
 for (const id of ["openai", "openai-account-2", "openai-codex", "openai-codex-account-2"]) assert.equal(usageFamily(id), "codex");
 assert.equal(providerUsageLabel("openai-account-2"), "OpenAI A2");
 let calls = 0;
 await assert.rejects(fetchUsageSnapshot("openai", {type:"oauth",access:"fixture",clientId:"fixture-client",scopes:["chatgpt.tokens.use.direct"]} as any, {fetchImpl:async()=>{calls++; throw Error("must not send direct token to ChatGPT")}}), /not exposed/i);
 assert.equal(calls, 0);
 await assert.rejects(fetchUsageSnapshot("openai", {type:"api_key",key:"fixture"}, {fetchImpl:async()=>{calls++; throw Error("no subscription")}}), /OAuth/);
 assert.equal(calls, 0);
});
