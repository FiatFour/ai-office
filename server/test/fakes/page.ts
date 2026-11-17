import type { HttpRequest, HttpResponse } from '../../githost/host.ts';

const slice = (url: URL, list: unknown[]): unknown[] => {
  const size = Number(url.searchParams.get('per_page') ?? 30);
  const page = Number(url.searchParams.get('page') ?? 1);
  return list.slice((page - 1) * size, page * size);
};

export const paged = (request: HttpRequest, response: HttpResponse, keys: readonly string[] = []): HttpResponse => {
  if (request.method !== 'GET' || response.status !== 200) return response;
  const url = new URL(request.path, 'https://host.invalid');
  if (Array.isArray(response.body)) return { ...response, body: slice(url, response.body) };
  const body = response.body as Record<string, unknown> | null;
  const key = keys.find((k) => Array.isArray(body?.[k]));
  return key === undefined ? response : { ...response, body: { ...body, [key]: slice(url, body?.[key] as unknown[]) } };
};
