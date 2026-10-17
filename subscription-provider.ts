import { isChildFacingPlaceholderForSlot, type AuthBlob } from "./slot-proxy-auth.ts";

/** Keep browser-login identity separate from the non-secret child transport key. */
export function withBrowserLoginStatus<T extends { auth: { apiKey?: any; oauth?: any } }>(
  provider: T,
  slotId: string,
  readParentAuth: () => Readonly<Record<string, AuthBlob>>,
): T {
  const apiKey = provider.auth.apiKey;
  if (!apiKey) return provider;
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        ...apiKey,
        async check(input: any) {
          input.signal?.throwIfAborted();
          if (isChildFacingPlaceholderForSlot(input.credential, slotId)) {
            const real = readParentAuth()[slotId];
            return real?.type === "oauth" && typeof real.access === "string" && real.access.length > 0
              ? { type: "oauth", source: "Browser login" }
              : undefined;
          }
          if (apiKey.check) return apiKey.check(input);
          const result = await apiKey.resolve(input);
          return result ? { type: "api_key", source: result.source } : undefined;
        },
      },
    },
  };
}
