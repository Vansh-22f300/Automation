import type { ApiErrorResponse, HealthStatus, RunInspection } from '~/types/api';

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

interface ApiClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
}

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  async getHealth(): Promise<HealthStatus> {
    return this.request<HealthStatus>('/healthz', false);
  }

  async getRun(runId: string): Promise<RunInspection> {
    return this.request<RunInspection>(`/v1/runs/${encodeURIComponent(runId)}`, true);
  }

  private async request<T>(path: string, requiresAuthentication: boolean): Promise<T> {
    const headers = new Headers({ Accept: 'application/json' });
    if (requiresAuthentication) {
      if (this.options.apiKey === '') {
        throw new ApiClientError(0, 'Add NUXT_PUBLIC_API_KEY to frontend/.env to inspect runs.');
      }
      headers.set('Authorization', `Bearer ${this.options.apiKey}`);
    }

    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}${path}`, { headers });
    } catch {
      throw new ApiClientError(0, 'The backend could not be reached. Start the Fastify API and try again.');
    }

    if (response.ok) return (await response.json()) as T;

    const body = await response.json().catch(() => null) as ApiErrorResponse | null;
    throw new ApiClientError(
      response.status,
      body?.error.message ?? 'The request could not be completed. Please try again.',
    );
  }
}
