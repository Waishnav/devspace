export interface EndpointHealth {
  ok: boolean;
  status?: number;
  error?: string;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export async function checkEndpoint(
  url: string,
  fetcher: Fetch = fetch,
): Promise<EndpointHealth> {
  try {
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}`,
      };
    }

    return { ok: true, status: response.status };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatEndpointHealth(health: EndpointHealth): string {
  return health.ok
    ? `reachable (HTTP ${health.status})`
    : `unreachable (${health.error ?? "unknown error"})`;
}
