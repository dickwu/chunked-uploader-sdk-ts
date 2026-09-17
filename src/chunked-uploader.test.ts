import { describe, expect, it, vi } from 'vitest';
import { ChunkedUploader } from './chunked-uploader';
import { ChunkedUploaderError } from './types';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch mock driven by a list of handlers keyed on `METHOD path-suffix`. */
function fakeFetch(routes: Record<string, Handler[] | Handler>) {
  const calls: Array<{ method: string; url: string }> = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url });
    const key = Object.keys(routes).find((k) => {
      const [m, suffix] = k.split(' ');
      return m === method && url.endsWith(suffix);
    });
    if (!key) throw new Error(`unexpected request ${method} ${url}`);
    const handlers = routes[key];
    const handler = Array.isArray(handlers) ? (handlers.length > 1 ? handlers.shift()! : handlers[0]) : handlers;
    return handler(url, init ?? {});
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

const networkError = () => {
  throw new TypeError('Failed to fetch');
};

function uploader(fetchFn: typeof fetch, extra: Record<string, unknown> = {}) {
  return new ChunkedUploader({
    baseUrl: 'http://test',
    apiKey: 'k',
    fetch: fetchFn,
    managementRetryDelay: 1,
    retryDelay: 1,
    finalizePollIntervalMs: 1,
    ...extra,
  });
}

const initResponse = (parts: number, chunkSize: number) => ({
  file_id: 'id-1',
  total_parts: parts,
  chunk_size: chunkSize,
  parts: Array.from({ length: parts }, (_, i) => ({ part: i, token: `t${i}`, status: 'pending' })),
  expires_at: '2099-01-01T00:00:00Z',
});

const partResponse = (part: number) => ({
  upload_id: 'id-1',
  part_number: part,
  status: 'uploaded',
  checksum_sha256: 'x',
  uploaded_parts: part + 1,
  total_parts: 2,
});

const completeResponse = (status: string) => ({
  file_id: 'id-1',
  filename: 'f.bin',
  total_size: 6,
  status,
  phase: status,
  finalizing_progress_percent: status === 'complete' ? 100 : 5,
  final_path: status === 'complete' ? '/final/f.bin' : null,
  storage_backend: 'local',
});

describe('management requests', () => {
  it('retries network errors and timeouts, then succeeds', async () => {
    const { fetchFn, calls } = fakeFetch({
      'POST /upload/init': [networkError, networkError, () => json(initResponse(1, 6))],
    });
    const res = await uploader(fetchFn).initUpload('f.bin', 6);
    expect(res.file_id).toBe('id-1');
    expect(calls).toHaveLength(3);
  });

  it('retries 5xx but not 4xx', async () => {
    const { fetchFn, calls } = fakeFetch({
      'POST /upload/init': [() => json({ error: 'boom' }, 502), () => json(initResponse(1, 6))],
    });
    await expect(uploader(fetchFn).initUpload('f.bin', 6)).resolves.toBeTruthy();
    expect(calls).toHaveLength(2);

    const bad = fakeFetch({ 'POST /upload/init': () => json({ error: 'nope' }, 400) });
    await expect(uploader(bad.fetchFn).initUpload('f.bin', 6)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(bad.calls).toHaveLength(1);
  });

  it('gives up after managementRetryAttempts', async () => {
    const { fetchFn, calls } = fakeFetch({ 'POST /upload/init': networkError });
    await expect(
      uploader(fetchFn, { managementRetryAttempts: 3 }).initUpload('f.bin', 6)
    ).rejects.toThrow('Failed to fetch');
    expect(calls).toHaveLength(3);
  });

  it('turns its own timeout into a retryable 408', async () => {
    let first = true;
    const { fetchFn, calls } = fakeFetch({
      'GET /status': (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          if (first) {
            first = false;
            init.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            );
            return;
          }
          resolve(json({ ...completeResponse('complete'), uploaded_parts: 1, total_parts: 1 }));
        }),
    });
    const res = await uploader(fetchFn, { timeout: 20 }).getStatus('id-1');
    expect(res.status).toBe('complete');
    expect(calls).toHaveLength(2);
  });

  it('does not retry when the caller aborts', async () => {
    const controller = new AbortController();
    const { fetchFn, calls } = fakeFetch({
      'GET /status': (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          );
          controller.abort();
        }),
    });
    await expect(
      uploader(fetchFn).getStatus('id-1', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(1);
  });

  it('treats 404 on cancel as done', async () => {
    const { fetchFn } = fakeFetch({ 'DELETE /upload/id-1': () => json({ error: 'gone' }, 404) });
    const res = await uploader(fetchFn).cancelUpload('id-1');
    expect(res.file_id).toBe('id-1');
  });
});

describe('finalization polling', () => {
  it('keeps polling through a failed status request', async () => {
    const { fetchFn, calls } = fakeFetch({
      'POST /complete': () => json(completeResponse('finalizing'), 202),
      'GET /status': [
        () => json({ ...completeResponse('finalizing'), uploaded_parts: 2, total_parts: 2 }),
        networkError,
        () => json({ ...completeResponse('complete'), uploaded_parts: 2, total_parts: 2 }),
      ],
    });
    const res = await uploader(fetchFn, { managementRetryAttempts: 1 }).completeUpload('id-1');
    expect(res.status).toBe('complete');
    expect(res.final_path).toBe('/final/f.bin');
    expect(calls.filter((c) => c.url.endsWith('/status'))).toHaveLength(3);
  });

  it('returns straight away when /complete already reports complete', async () => {
    const { fetchFn, calls } = fakeFetch({
      'POST /complete': () => json(completeResponse('complete')),
    });
    const res = await uploader(fetchFn).completeUpload('id-1');
    expect(res.status).toBe('complete');
    expect(calls).toHaveLength(1);
  });
});

describe('part uploads', () => {
  const file = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6])]);

  it('counts a 409 (already stored) as success', async () => {
    const results: Array<{ partNumber: number; success: boolean }> = [];
    const { fetchFn, calls } = fakeFetch({
      'POST /upload/init': () => json(initResponse(2, 3)),
      'PUT /part/0': () => json({ error: 'Part already uploaded' }, 409),
      'PUT /part/1': () => json(partResponse(1)),
      'POST /complete': () => json(completeResponse('complete')),
    });
    const res = await uploader(fetchFn).uploadFile(file, {
      onPartComplete: (r) => results.push({ partNumber: r.partNumber, success: r.success }),
    });
    expect(res.success).toBe(true);
    expect(res.finalPath).toBe('/final/f.bin');
    expect(results.filter((r) => r.success)).toHaveLength(2);
    expect(calls.filter((c) => c.url.endsWith('/part/0'))).toHaveLength(1);
  });

  it('retries a part after a network error and a 5xx', async () => {
    const { fetchFn, calls } = fakeFetch({
      'POST /upload/init': () => json(initResponse(1, 6)),
      'PUT /part/0': [networkError, () => json({ error: 'busy' }, 503), () => json(partResponse(0))],
      'POST /complete': () => json(completeResponse('complete')),
    });
    const res = await uploader(fetchFn).uploadFile(file);
    expect(res.success).toBe(true);
    expect(calls.filter((c) => c.url.endsWith('/part/0'))).toHaveLength(3);
  });

  it('does not retry a part rejected with 400', async () => {
    const { fetchFn, calls } = fakeFetch({
      'POST /upload/init': () => json(initResponse(1, 6)),
      'PUT /part/0': () => json({ error: 'Part size mismatch' }, 400),
    });
    const res = await uploader(fetchFn).uploadFile(file);
    expect(res.success).toBe(false);
    expect(res.error).toBeInstanceOf(ChunkedUploaderError);
    expect(res.error?.message).toContain('Part size mismatch');
    expect(calls.filter((c) => c.url.endsWith('/part/0'))).toHaveLength(1);
  });

  it('resumes only the pending parts and completes', async () => {
    const { fetchFn, calls } = fakeFetch({
      'GET /status?include_parts=true': () =>
        json({
          ...completeResponse('pending'),
          chunk_size: 3,
          total_parts: 2,
          uploaded_parts: 1,
          parts: [
            { part: 0, status: 'uploaded', checksum_sha256: 'x' },
            { part: 1, status: 'pending', checksum_sha256: null },
          ],
        }),
      'PUT /part/1': () => json(partResponse(1)),
      'POST /complete': () => json(completeResponse('complete')),
    });
    const res = await uploader(fetchFn).resumeUpload('id-1', file, {
      partTokens: new Map([
        [0, 't0'],
        [1, 't1'],
      ]),
    });
    expect(res.success).toBe(true);
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.url.slice(-6))).toEqual(['part/1']);
  });
});
