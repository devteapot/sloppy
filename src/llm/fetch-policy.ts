export const rejectRedirectFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): ReturnType<typeof fetch> =>
  globalThis.fetch(input, {
    ...init,
    redirect: "error",
  });
