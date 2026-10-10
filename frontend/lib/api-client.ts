import type {
  ApiErrorResponse,
  ConnectionListResponse,
  RunInspection,
  RunListResponse,
  WorkflowListResponse,
} from "~/types/api";

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

interface ApiClientOptions {
  readonly baseUrl: string;
}

/**
 * Browser-side Fastify API client.
 *
 * The browser never talks to Fastify directly: it calls the same-origin Nuxt
 * Nitro BFF at `<baseUrl>/<path>`. On the `/v1/*` data plane the BFF reads the
 * HttpOnly `aw_session` cookie server-side and forwards the human's session as a
 * Bearer token — never a machine API key, and never anything the browser could
 * set. This client therefore sends no Authorization header of its own; it relies
 * on the same-origin request carrying the HttpOnly session cookie to the BFF
 * (fetch's default `credentials: 'same-origin'`), which the browser's JS cannot
 * read.
 */
export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  async getRun(runId: string): Promise<RunInspection> {
    return this.request<RunInspection>(
      `/v1/runs/${encodeURIComponent(runId)}`,
    );
  }

  async listWorkflows(
    limit?: number,
    cursor?: string,
  ): Promise<WorkflowListResponse> {
    return this.request<WorkflowListResponse>(
      this.withQuery("/v1/workflows", { limit, cursor }),
    );
  }

  async listRuns(
    options: {
      limit?: number;
      cursor?: string;
      status?: string;
      workflowId?: string;
    } = {},
  ): Promise<RunListResponse> {
    return this.request<RunListResponse>(
      this.withQuery("/v1/runs", options),
    );
  }

  async listConnections(
    limit?: number,
    cursor?: string,
  ): Promise<ConnectionListResponse> {
    return this.request<ConnectionListResponse>(
      this.withQuery("/v1/connections", { limit, cursor }),
    );
  }

  private withQuery(
    path: string,
    query: Record<string, string | number | undefined>,
  ): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") params.set(key, String(value));
    }
    const rendered = params.toString();
    return rendered === "" ? path : `${path}?${rendered}`;
  }

  private async request<T>(path: string): Promise<T> {
    const headers = new Headers({ Accept: "application/json" });

    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}${path}`, { headers });
    } catch {
      throw new ApiClientError(
        0,
        "The backend could not be reached. Start the Fastify API and try again.",
      );
    }

    if (response.ok) return (await response.json()) as T;

    const body = (await response
      .json()
      .catch(() => null)) as ApiErrorResponse | null;
    throw new ApiClientError(
      response.status,
      body?.error.message ??
        "The request could not be completed. Please try again.",
    );
  }
}