# TASK-29 findings — correct the login-expired instruction to match the live menu

## 1. Runtime label verified on THIS machine (not from memory)

Installed runtime: `/home/kris/.local/share/pi-node/node-v22.23.1-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent`
(`pi` launcher `/home/kris/.pi/agent/bin/pi` delegates to `$HOME/.local/bin/pi`, the managed npm install).

File: `dist/modes/interactive/interactive-mode.js`
- Line 4850: `const oauthLoginLabel = oauthProvider?.method && "loginLabel" in oauthProvider.method ? oauthProvider.method.loginLabel : undefined;`
- Line 4851: `const subscriptionLabel = oauthLoginLabel ?? "Sign in with an account";`
- The literal top-level option a user sees when running bare `/login` is therefore **"Sign in with an account"** (the fallback), because the Codex account slot registers no `loginLabel`.

The Codex account provider is registered by this package (`index.ts` `registerCodexSlot` / `codexOAuthOverride`)
with `oauth: { name, usesCallbackServer, login, refreshToken, getApiKey }` and **no `loginLabel`**,
so `"loginLabel" in oauthProvider.method` is false -> `"Sign in with an account"`.

`loginLabel:"Sign in with ChatGPT"` exists only in `dist/bundle/chunks/openai-chatgpt.js`
(a *different* provider — the native ChatGPT provider), not in `openai-codex.js`
(`grep -c loginLabel dist/bundle/chunks/openai-codex.js` -> 0). So it is not the label for the
`openai-codex-account-2` slot.

Conclusion: the brief's label is CORRECT for the affected account; the notice's old text
`choose "Use a subscription"` names an option that does not exist in the live menu.

## 2. Account name is correct and unique

`index.ts` registers the slot name as `ChatGPT Plus/Pro (Codex ${id})` (registerCodexSlot),
so `/login` renders `ChatGPT Plus/Pro (Codex openai-codex-account-2)` — contains the id verbatim.

## 3. Wording choice

Described the ACTION, did NOT quote the menu label: `Run /login, then select the entry for <id> to sign in again.`
Reason: a label can be relabelled in a future runtime (`Sign in with an account` is itself only the
fallback when no `loginLabel` is set), whereas naming the account and the action stays true. Also
README documents that older Pi (0.79.3) does not accept a provider argument after `/login`, so
`/login <id>` is not version-robust either.

## 4. Occurrences in this package

`grep -n 'Use a subscription' index.ts` -> 2608, 5483, 6163 (three owner-reachable messages).
Also `README.md` lines 10 and 54. All corrected; none deliberately left.

## 5. RED / GREEN evidence

RED (`timeout 120 node --test test/task-25-login-expiry-notice.test.ts`, exit 1):
```text
not ok 1 - expired login tells the owner exactly once, in plain language, with a footer status
not ok 4 - the assistant-error kill path also tells the owner once, with the corrected wording
# tests 5
# pass 3
# fail 2
```
actual old text quoted by the runner:
`Your login for openai-codex-account-2 has expired. Run /login, choose "Use a subscription", then select openai-codex-account-2 to sign in again. Your other account still works.`

GREEN after the wording fix (`timeout 120 node --test test/task-25-login-expiry-notice.test.ts`, exit 0):
```text
# tests 5
# pass 5
# fail 0
```

## 6. Full package suite (`timeout 180 node --test test/*.test.ts`)

Exit 1:
```text
# tests 140
# pass 139
# fail 1
```
Only failure: `not ok 57 - OAuth-marked Anthropic payload gets one billing header`
(`test/failover.test.ts:2357`, unrelated pre-existing version-string assertion:
expected `/cc_version=2\.1\.172\./`, actual `cc_version=2.1.280.309`).
My diff does not touch `test/failover.test.ts` (`git diff a5611e8 --name-only` -> 0 matches).

## 7. Static check

`npm run check` -> `tsc: command not found`, exit 127 (typescript is not installed in this worktree).
The suite executing the real `index.ts` under Node 22 type stripping is the static-plus-runtime evidence.
