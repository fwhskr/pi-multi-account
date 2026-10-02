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
