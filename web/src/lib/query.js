import { QueryClient } from "@tanstack/react-query";

/** Shared TanStack Query client — stale-while-revalidate tuned for a live app. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      retry: (failureCount, error) => {
        if (error?.status && error.status < 500 && error.status !== 429) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: true,
    },
    mutations: {
      retry: false,
    },
  },
});
