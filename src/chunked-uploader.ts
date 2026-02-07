import {
  ChunkedUploaderConfig,
  InitUploadRequest,
  InitUploadResponse,
  UploadPartResponse,
  UploadStatusResponse,
  CompleteUploadResponse,
  CancelUploadResponse,
  HealthCheckResponse,
  UploadProgressEvent,
  PartUploadResult,
  UploadResult,
  FileSource,
  UploadOptions,
  ResumeOptions,
  ChunkedUploaderError,
} from './types';

/** Default chunk size: 50MB (Cloudflare compatible) */
const DEFAULT_CHUNK_SIZE = 50 * 1024 * 1024;

/** Default configuration values */
const DEFAULT_CONFIG = {
  timeout: 30000,
  concurrency: 3,
  retryAttempts: 3,
  retryDelay: 1000,
  finalizePollIntervalMs: 2000,
  finalizeTimeoutMs: 7200000,
} as const;

interface CompleteUploadOptions {
  onProgress?: (event: UploadProgressEvent) => void;
  signal?: AbortSignal;
  totalParts?: number;
  uploadedParts?: number;
}

export class ChunkedUploader {
  private readonly config: Required<ChunkedUploaderConfig>;
  private readonly fetchFn: typeof fetch;

  constructor(config: ChunkedUploaderConfig) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      fetch: config.fetch ?? globalThis.fetch.bind(globalThis),
    };
    this.fetchFn = this.config.fetch;

    if (!this.config.baseUrl) {
      throw new ChunkedUploaderError('baseUrl is required');
    }
    if (!this.config.apiKey) {
      throw new ChunkedUploaderError('apiKey is required');
    }
  }

  async initUpload(
    filename: string,
    totalSize: number,
    webhookUrl?: string
  ): Promise<InitUploadResponse> {
    const payload: InitUploadRequest = {
      filename,
      total_size: totalSize,
      ...(webhookUrl && { webhook_url: webhookUrl }),
    };

    return this.request<InitUploadResponse>('POST', '/upload/init', payload, {
      useApiKey: true,
    });
  }

  async uploadPart(
    uploadId: string,
    partNumber: number,
    token: string,
    data: Blob | ArrayBuffer | Buffer,
    signal?: AbortSignal
  ): Promise<UploadPartResponse> {
    const url = `${this.config.baseUrl}/upload/${uploadId}/part/${partNumber}`;
    const body = this.toBlob(data);

    const response = await this.fetchFn(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      body,
      signal,
    });

    if (!response.ok) {
      const errorBody = await this.parseErrorResponse(response);
      throw new ChunkedUploaderError(
        errorBody.error || `Part upload failed: ${response.statusText}`,
        response.status,
        errorBody.code
      );
    }

    return response.json();
  }

  async getStatus(
    uploadId: string,
    options: { includeParts?: boolean; signal?: AbortSignal } = {}
  ): Promise<UploadStatusResponse> {
    const params = new URLSearchParams();
    if (options.includeParts) {
      params.set('include_parts', 'true');
    }
    const query = params.toString();
    const path = `/upload/${uploadId}/status${query ? `?${query}` : ''}`;

    return this.request<UploadStatusResponse>('GET', path, undefined, {
      useApiKey: true,
      signal: options.signal,
    });
  }

  async completeUpload(
    uploadId: string,
    options: CompleteUploadOptions = {}
  ): Promise<CompleteUploadResponse> {
    const initial = await this.request<CompleteUploadResponse>(
      'POST',
      `/upload/${uploadId}/complete`,
      undefined,
      { useApiKey: true, signal: options.signal }
    );

    if (initial.status === 'complete') {
      options.onProgress?.(
        this.buildProgressEvent({
          fileId: uploadId,
          phase: 'complete',
          phaseProgress: 100,
          uploadProgress: 100,
          finalizingProgress: 100,
          totalParts: options.totalParts ?? 0,
          uploadedParts: options.uploadedParts ?? options.totalParts ?? 0,
        })
      );
      return initial;
    }

    return this.waitForCompletion(uploadId, options);
  }

  async cancelUpload(uploadId: string): Promise<CancelUploadResponse> {
    return this.request<CancelUploadResponse>(
      'DELETE',
      `/upload/${uploadId}`,
      undefined,
      { useApiKey: true }
    );
  }

  async healthCheck(): Promise<HealthCheckResponse> {
    return this.request<HealthCheckResponse>('GET', '/health');
  }

  async uploadFile(file: FileSource, options: UploadOptions = {}): Promise<UploadResult> {
    const {
      webhookUrl,
      onProgress,
      onPartComplete,
      onPartError,
      signal,
      concurrency,
    } = options;

    const { filename, size, getChunk } = this.normalizeFileSourceStreaming(file);
    const initResponse = await this.initUpload(filename, size, webhookUrl);
    const { file_id, parts, chunk_size } = initResponse;

    try {
      const partTokens = new Map<number, string>();
      for (const part of parts) {
        partTokens.set(part.part, part.token);
      }

      await this.uploadPartsParallel(file_id, getChunk, size, chunk_size, partTokens, {
        onProgress,
        onPartComplete,
        onPartError,
        signal,
        concurrency: concurrency ?? this.config.concurrency,
      });

      const totalParts = Math.ceil(size / chunk_size);
      onProgress?.(
        this.buildProgressEvent({
          fileId: file_id,
          phase: 'finalizing',
          phaseProgress: 0,
          uploadProgress: 100,
          finalizingProgress: 0,
          totalParts,
          uploadedParts: totalParts,
        })
      );

      const completeResponse = await this.completeUpload(file_id, {
        onProgress,
        signal,
        totalParts,
        uploadedParts: totalParts,
      });

      if (completeResponse.status !== 'complete' || !completeResponse.final_path) {
        throw new ChunkedUploaderError(
          `Upload did not complete successfully (status=${completeResponse.status})`
        );
      }

      return {
        fileId: file_id,
        filename,
        totalSize: size,
        finalPath: completeResponse.final_path,
        storageBackend: completeResponse.storage_backend,
        success: true,
      };
    } catch (error) {
      return {
        fileId: file_id,
        filename,
        totalSize: size,
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  async resumeUpload(
    uploadId: string,
    file: FileSource,
    options: ResumeOptions = {}
  ): Promise<UploadResult> {
    const {
      partTokens,
      onProgress,
      onPartComplete,
      onPartError,
      signal,
      concurrency,
    } = options;

    const status = await this.getStatus(uploadId, { includeParts: true, signal });

    if (status.status === 'complete') {
      return {
        fileId: uploadId,
        filename: status.filename,
        totalSize: status.total_size,
        finalPath: status.final_path ?? undefined,
        storageBackend: status.storage_backend,
        success: true,
      };
    }

    const { filename, size, getChunk } = this.normalizeFileSourceStreaming(file);

    if (size !== status.total_size) {
      throw new ChunkedUploaderError(
        `File size mismatch: expected ${status.total_size}, got ${size}`
      );
    }

    const pendingParts = (status.parts ?? [])
      .filter((p) => p.status === 'pending')
      .map((p) => p.part);

    if (pendingParts.length === 0) {
      const completeResponse = await this.completeUpload(uploadId, {
        onProgress,
        signal,
        totalParts: status.total_parts,
        uploadedParts: status.uploaded_parts,
      });

      if (completeResponse.status !== 'complete' || !completeResponse.final_path) {
        throw new ChunkedUploaderError(
          `Upload did not complete successfully (status=${completeResponse.status})`
        );
      }

      return {
        fileId: uploadId,
        filename: status.filename,
        totalSize: status.total_size,
        finalPath: completeResponse.final_path,
        storageBackend: completeResponse.storage_backend,
        success: true,
      };
    }

    if (!partTokens || partTokens.size === 0) {
      throw new ChunkedUploaderError(
        'Part tokens required for resume. Store tokens from initial upload or re-initialize.'
      );
    }

    const chunkSize = status.chunk_size || Math.ceil(status.total_size / status.total_parts);

    try {
      await this.uploadPartsParallel(uploadId, getChunk, size, chunkSize, partTokens, {
        onProgress,
        onPartComplete,
        onPartError,
        signal,
        concurrency: concurrency ?? this.config.concurrency,
        pendingParts: new Set(pendingParts),
        uploadedCount: status.uploaded_parts,
      });

      onProgress?.(
        this.buildProgressEvent({
          fileId: uploadId,
          phase: 'finalizing',
          phaseProgress: 0,
          uploadProgress: 100,
          finalizingProgress: 0,
          totalParts: status.total_parts,
          uploadedParts: status.total_parts,
        })
      );

      const completeResponse = await this.completeUpload(uploadId, {
        onProgress,
        signal,
        totalParts: status.total_parts,
        uploadedParts: status.total_parts,
      });

      if (completeResponse.status !== 'complete' || !completeResponse.final_path) {
        throw new ChunkedUploaderError(
          `Upload did not complete successfully (status=${completeResponse.status})`
        );
      }

      return {
        fileId: uploadId,
        filename,
        totalSize: size,
        finalPath: completeResponse.final_path,
        storageBackend: completeResponse.storage_backend,
        success: true,
      };
    } catch (error) {
      return {
        fileId: uploadId,
        filename,
        totalSize: size,
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  private async uploadPartsParallel(
    uploadId: string,
    getChunk: (partNumber: number, chunkSize: number) => Promise<Blob>,
    totalSize: number,
    chunkSize: number,
    partTokens: Map<number, string>,
    options: {
      onProgress?: (event: UploadProgressEvent) => void;
      onPartComplete?: (result: PartUploadResult) => void;
      onPartError?: (partNumber: number, error: Error, attempt: number) => void;
      signal?: AbortSignal;
      concurrency: number;
      pendingParts?: Set<number>;
      uploadedCount?: number;
    }
  ): Promise<void> {
    const {
      onProgress,
      onPartComplete,
      onPartError,
      signal,
      concurrency,
      pendingParts,
      uploadedCount = 0,
    } = options;

    const totalParts = Math.ceil(totalSize / chunkSize);

    const partsToUpload: number[] = [];
    for (let i = 0; i < totalParts; i++) {
      if (!pendingParts || pendingParts.has(i)) {
        partsToUpload.push(i);
      }
    }

    let uploadedParts = uploadedCount;
    const errors: Array<{ partNumber: number; error: Error }> = [];
    const queue = [...partsToUpload];

    const uploadSinglePart = async (partNumber: number): Promise<void> => {
      const token = partTokens.get(partNumber);
      if (!token) {
        throw new ChunkedUploaderError(`No token found for part ${partNumber}`);
      }

      const partSize = this.getPartSize(partNumber, chunkSize, totalSize);
      let lastError: Error | undefined;

      for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
        try {
          if (signal?.aborted) {
            throw new ChunkedUploaderError('Upload aborted');
          }

          const chunk = await getChunk(partNumber, chunkSize);
          const response = await this.uploadPart(uploadId, partNumber, token, chunk, signal);

          uploadedParts++;

          const result: PartUploadResult = {
            partNumber,
            success: true,
            response,
          };
          onPartComplete?.(result);

          const uploadProgress = (uploadedParts / totalParts) * 100;
          onProgress?.(
            this.buildProgressEvent({
              fileId: uploadId,
              phase: 'uploading',
              phaseProgress: uploadProgress,
              uploadProgress,
              finalizingProgress: 0,
              totalParts,
              uploadedParts,
              currentPart: partNumber,
              bytesUploaded: partSize,
              bytesTotal: partSize,
            })
          );

          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));

          if (signal?.aborted) {
            throw lastError;
          }

          onPartError?.(partNumber, lastError, attempt);

          if (attempt < this.config.retryAttempts) {
            await this.delay(this.config.retryDelay * attempt);
          }
        }
      }

      const result: PartUploadResult = {
        partNumber,
        success: false,
        error: lastError,
      };
      onPartComplete?.(result);
      errors.push({ partNumber, error: lastError! });
    };

    const runWorkerPool = async (): Promise<void> => {
      const workers: Promise<void>[] = [];

      const worker = async (): Promise<void> => {
        while (queue.length > 0) {
          if (signal?.aborted) {
            return;
          }

          const partNumber = queue.shift();
          if (partNumber === undefined) {
            return;
          }

          await uploadSinglePart(partNumber);
        }
      };

      for (let i = 0; i < concurrency; i++) {
        workers.push(worker());
      }

      await Promise.all(workers);
    };

    await runWorkerPool();

    if (signal?.aborted) {
      throw new ChunkedUploaderError('Upload aborted');
    }

    if (errors.length > 0) {
      const failedParts = errors.map((e) => e.partNumber).join(', ');
      throw new ChunkedUploaderError(
        `Upload failed: ${errors.length} part(s) failed [${failedParts}]. First error: ${errors[0].error.message}`
      );
    }
  }

  private async waitForCompletion(
    uploadId: string,
    options: CompleteUploadOptions
  ): Promise<CompleteUploadResponse> {
    const startedAt = Date.now();

    while (true) {
      if (options.signal?.aborted) {
        throw new ChunkedUploaderError('Upload aborted');
      }

      if (Date.now() - startedAt > this.config.finalizeTimeoutMs) {
        throw new ChunkedUploaderError(
          `Finalization timed out after ${this.config.finalizeTimeoutMs}ms`
        );
      }

      const status = await this.getStatus(uploadId, {
        includeParts: false,
        signal: options.signal,
      });

      const totalParts = options.totalParts ?? status.total_parts;
      const uploadedParts = options.uploadedParts ?? status.uploaded_parts;

      if (status.status === 'complete') {
        options.onProgress?.(
          this.buildProgressEvent({
            fileId: uploadId,
            phase: 'complete',
            phaseProgress: 100,
            uploadProgress: 100,
            finalizingProgress: 100,
            totalParts,
            uploadedParts,
          })
        );

        return {
          file_id: status.file_id,
          filename: status.filename,
          total_size: status.total_size,
          status: 'complete',
          phase: 'complete',
          finalizing_progress_percent: 100,
          final_path: status.final_path ?? null,
          storage_backend: status.storage_backend,
        };
      }

      if (status.status === 'failed') {
        throw new ChunkedUploaderError(
          status.finalization_error || 'Upload finalization failed'
        );
      }

      const finalizingProgress = Math.max(0, status.finalizing_progress_percent || 0);
      options.onProgress?.(
        this.buildProgressEvent({
          fileId: uploadId,
          phase: 'finalizing',
          phaseProgress: finalizingProgress,
          uploadProgress: 100,
          finalizingProgress,
          totalParts,
          uploadedParts,
        })
      );

      await this.delayWithSignal(this.config.finalizePollIntervalMs, options.signal);
    }
  }

  private buildProgressEvent(params: {
    fileId: string;
    phase: UploadProgressEvent['phase'];
    phaseProgress: number;
    uploadProgress: number;
    finalizingProgress: number;
    totalParts: number;
    uploadedParts: number;
    currentPart?: number;
    bytesUploaded?: number;
    bytesTotal?: number;
  }): UploadProgressEvent {
    return {
      fileId: params.fileId,
      phase: params.phase,
      currentPart: params.currentPart ?? 0,
      totalParts: params.totalParts,
      uploadedParts: params.uploadedParts,
      bytesUploaded: params.bytesUploaded ?? 0,
      bytesTotal: params.bytesTotal ?? 0,
      phaseProgress: Math.max(0, Math.min(100, params.phaseProgress)),
      uploadProgress: Math.max(0, Math.min(100, params.uploadProgress)),
      finalizingProgress: Math.max(0, Math.min(100, params.finalizingProgress)),
      overallProgress:
        params.phase === 'uploading'
          ? Math.max(0, Math.min(100, params.uploadProgress))
          : 100,
    };
  }

  private getPartSize(partNumber: number, chunkSize: number, totalSize: number): number {
    const start = partNumber * chunkSize;
    return Math.min(chunkSize, totalSize - start);
  }

  private normalizeFileSourceStreaming(source: FileSource): {
    filename: string;
    size: number;
    getChunk: (partNumber: number, chunkSize: number) => Promise<Blob>;
  } {
    if (typeof File !== 'undefined' && source instanceof File) {
      return {
        filename: source.name,
        size: source.size,
        getChunk: (partNumber, chunkSize) => {
          const start = partNumber * chunkSize;
          const end = Math.min(start + chunkSize, source.size);
          return Promise.resolve(source.slice(start, end));
        },
      };
    }

    if (typeof Blob !== 'undefined' && source instanceof Blob) {
      return {
        filename: 'blob',
        size: source.size,
        getChunk: (partNumber, chunkSize) => {
          const start = partNumber * chunkSize;
          const end = Math.min(start + chunkSize, source.size);
          return Promise.resolve(source.slice(start, end));
        },
      };
    }

    if (source instanceof ArrayBuffer) {
      return {
        filename: 'file',
        size: source.byteLength,
        getChunk: (partNumber, chunkSize) => {
          const start = partNumber * chunkSize;
          const end = Math.min(start + chunkSize, source.byteLength);
          const chunk = source.slice(start, end);
          return Promise.resolve(new Blob([chunk]));
        },
      };
    }

    if (Buffer.isBuffer(source)) {
      return {
        filename: 'file',
        size: source.byteLength,
        getChunk: (partNumber, chunkSize) => {
          const start = partNumber * chunkSize;
          const end = Math.min(start + chunkSize, source.byteLength);
          const chunk = source.subarray(start, end);
          const copy = new ArrayBuffer(chunk.byteLength);
          new Uint8Array(copy).set(
            new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          );
          return Promise.resolve(new Blob([copy]));
        },
      };
    }

    throw new ChunkedUploaderError('Unsupported file source type');
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { useApiKey?: boolean; signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const headers: Record<string, string> = {};

    if (options.useApiKey) {
      headers['X-API-Key'] = this.config.apiKey;
    }

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.config.timeout;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const abortListener = () => controller.abort();
    options.signal?.addEventListener('abort', abortListener, { once: true });

    try {
      const response = await this.fetchFn(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await this.parseErrorResponse(response);
        throw new ChunkedUploaderError(
          errorBody.error || `Request failed: ${response.statusText}`,
          response.status,
          errorBody.code,
          errorBody.details
        );
      }

      return response.json();
    } finally {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', abortListener);
    }
  }

  private async parseErrorResponse(
    response: Response
  ): Promise<{ error?: string; code?: string; details?: unknown }> {
    try {
      return await response.json();
    } catch {
      return { error: response.statusText };
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new ChunkedUploaderError('Upload aborted'));
        return;
      }

      const timeoutId = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
        reject(new ChunkedUploaderError('Upload aborted'));
      };

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private toBlob(data: Blob | ArrayBuffer | Buffer): Blob {
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      return data;
    }

    if (Buffer.isBuffer(data)) {
      const copy = new ArrayBuffer(data.byteLength);
      const view = new Uint8Array(copy);
      view.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      return new Blob([copy]);
    }

    if (data instanceof ArrayBuffer) {
      const copy = new ArrayBuffer(data.byteLength);
      new Uint8Array(copy).set(new Uint8Array(data));
      return new Blob([copy]);
    }

    throw new ChunkedUploaderError('Unsupported binary data type');
  }
}
