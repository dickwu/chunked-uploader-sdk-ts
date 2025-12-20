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
} as const;

/**
 * ChunkedUploader SDK
 *
 * A TypeScript SDK for uploading large files (10GB+) to a chunked upload server.
 * Supports parallel uploads, resume capability, and progress tracking.
 *
 * @example
 * ```typescript
 * const uploader = new ChunkedUploader({
 *   baseUrl: 'https://upload.example.com',
 *   apiKey: 'your-api-key',
 * });
 *
 * // Upload a file
 * const result = await uploader.uploadFile(file, {
 *   onProgress: (event) => console.log(`${event.overallProgress}%`),
 * });
 * ```
 */
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

  /**
   * Initialize a new upload session
   *
   * @param filename - Original filename
   * @param totalSize - Total file size in bytes
   * @param webhookUrl - Optional webhook URL for completion notification
   * @returns Upload session info with part tokens
   */
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

    const response = await this.request<InitUploadResponse>(
      'POST',
      '/upload/init',
      payload,
      { useApiKey: true }
    );

    return response;
  }

  /**
   * Upload a single part/chunk
   *
   * @param uploadId - Upload session ID
   * @param partNumber - Part number (0-indexed)
   * @param token - JWT token for this part
   * @param data - Chunk data to upload
   * @param signal - Optional AbortSignal for cancellation
   * @returns Part upload result
   */
  async uploadPart(
    uploadId: string,
    partNumber: number,
    token: string,
    data: Blob | ArrayBuffer | Buffer,
    signal?: AbortSignal
  ): Promise<UploadPartResponse> {
    const url = `${this.config.baseUrl}/upload/${uploadId}/part/${partNumber}`;

    // Convert to Blob for universal fetch compatibility
    const body = this.toBlob(data);

    const response = await this.fetchFn(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
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

  /**
   * Get upload status and progress
   *
   * @param uploadId - Upload session ID
   * @returns Upload status with part details
   */
  async getStatus(uploadId: string): Promise<UploadStatusResponse> {
    return this.request<UploadStatusResponse>(
      'GET',
      `/upload/${uploadId}/status`,
      undefined,
      { useApiKey: true }
    );
  }

  /**
   * Complete an upload (assemble all parts)
   *
   * @param uploadId - Upload session ID
   * @returns Completion result with final file path
   */
  async completeUpload(uploadId: string): Promise<CompleteUploadResponse> {
    return this.request<CompleteUploadResponse>(
      'POST',
      `/upload/${uploadId}/complete`,
      undefined,
      { useApiKey: true }
    );
  }

  /**
   * Cancel an upload and cleanup
   *
   * @param uploadId - Upload session ID
   * @returns Cancellation confirmation
   */
  async cancelUpload(uploadId: string): Promise<CancelUploadResponse> {
    return this.request<CancelUploadResponse>(
      'DELETE',
      `/upload/${uploadId}`,
      undefined,
      { useApiKey: true }
    );
  }

  /**
   * Health check endpoint
   *
   * @returns Server health status
   */
  async healthCheck(): Promise<HealthCheckResponse> {
    return this.request<HealthCheckResponse>('GET', '/health');
  }

  /**
   * Upload a file with automatic chunking, parallel uploads, and progress tracking
   *
   * @param file - File to upload (File, Blob, or ArrayBuffer)
   * @param options - Upload options
   * @returns Upload result
   */
  async uploadFile(
    file: FileSource,
    options: UploadOptions = {}
  ): Promise<UploadResult> {
    const { webhookUrl, onProgress, onPartComplete, onPartError, signal, concurrency } = options;

    // Get file info with streaming support
    const { filename, size, getChunk } = this.normalizeFileSourceStreaming(file);

    // Initialize upload
    const initResponse = await this.initUpload(filename, size, webhookUrl);
    const { file_id, parts, chunk_size } = initResponse;

    try {
      // Create part token map
      const partTokens = new Map<number, string>();
      for (const part of parts) {
        partTokens.set(part.part, part.token);
      }

      // Upload all parts in parallel
      await this.uploadPartsParallel(
        file_id,
        getChunk,
        size,
        chunk_size,
        partTokens,
        {
          onProgress,
          onPartComplete,
          onPartError,
          signal,
          concurrency: concurrency ?? this.config.concurrency,
        }
      );

      // Complete upload
      const completeResponse = await this.completeUpload(file_id);

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

  /**
   * Resume an interrupted upload
   *
   * @param uploadId - Upload session ID to resume
   * @param file - File to upload (must match original file)
   * @param options - Resume options
   * @returns Upload result
   */
  async resumeUpload(
    uploadId: string,
    file: FileSource,
    options: ResumeOptions = {}
  ): Promise<UploadResult> {
    const { partTokens, onProgress, onPartComplete, onPartError, signal, concurrency } = options;

    // Get current status
    const status = await this.getStatus(uploadId);

    if (status.status === 'complete') {
      return {
        fileId: uploadId,
        filename: status.filename,
        totalSize: status.total_size,
        success: true,
      };
    }

    // Get file info with streaming support
    const { filename, size, getChunk } = this.normalizeFileSourceStreaming(file);

    // Verify file matches
    if (size !== status.total_size) {
      throw new ChunkedUploaderError(
        `File size mismatch: expected ${status.total_size}, got ${size}`
      );
    }

    // Get pending parts
    const pendingParts = status.parts
      .filter((p) => p.status === 'pending')
      .map((p) => p.part);

    if (pendingParts.length === 0) {
      // All parts uploaded, just complete
      const completeResponse = await this.completeUpload(uploadId);
      return {
        fileId: uploadId,
        filename: status.filename,
        totalSize: status.total_size,
        finalPath: completeResponse.final_path,
        storageBackend: completeResponse.storage_backend,
        success: true,
      };
    }

    // We need tokens for pending parts
    if (!partTokens || partTokens.size === 0) {
      throw new ChunkedUploaderError(
        'Part tokens required for resume. Store tokens from initial upload or re-initialize.'
      );
    }

    // Calculate chunk size from total size and parts
    const chunkSize = Math.ceil(status.total_size / status.total_parts);

    try {
      // Upload pending parts only in parallel
      await this.uploadPartsParallel(
        uploadId,
        getChunk,
        size,
        chunkSize,
        partTokens,
        {
          onProgress,
          onPartComplete,
          onPartError,
          signal,
          concurrency: concurrency ?? this.config.concurrency,
          pendingParts: new Set(pendingParts),
          uploadedCount: status.uploaded_parts,
        }
      );

      // Complete upload
      const completeResponse = await this.completeUpload(uploadId);

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

  /**
   * Upload multiple parts in parallel with streaming chunk reads
   * 
   * This method reads chunks on-demand (streaming) to avoid loading the entire
   * file into memory, and uses a worker pool pattern for efficient parallel uploads.
   */
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

    // Calculate total parts
    const totalParts = Math.ceil(totalSize / chunkSize);

    // Determine which parts to upload
    const partsToUpload: number[] = [];
    for (let i = 0; i < totalParts; i++) {
      if (!pendingParts || pendingParts.has(i)) {
        partsToUpload.push(i);
      }
    }

    let uploadedParts = uploadedCount;
    let bytesUploaded = uploadedCount * chunkSize;
    const errors: Array<{ partNumber: number; error: Error }> = [];
    const activeUploads = new Map<number, Promise<void>>();

    // Create a queue of parts to upload
    const queue = [...partsToUpload];

    /**
     * Upload a single part with streaming chunk read
     */
    const uploadSinglePart = async (partNumber: number): Promise<void> => {
      const token = partTokens.get(partNumber);
      if (!token) {
        throw new ChunkedUploaderError(`No token found for part ${partNumber}`);
      }

      const partSize = this.getPartSize(partNumber, chunkSize, totalSize);
      let lastError: Error | undefined;

      for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
        try {
          // Check for abort before each attempt
          if (signal?.aborted) {
            throw new ChunkedUploaderError('Upload aborted');
          }

          // Read chunk on-demand (streaming)
          const chunk = await getChunk(partNumber, chunkSize);
          
          // Upload the chunk
          const response = await this.uploadPart(uploadId, partNumber, token, chunk, signal);

          // Success
          uploadedParts++;
          bytesUploaded += partSize;

          const result: PartUploadResult = {
            partNumber,
            success: true,
            response,
          };
          onPartComplete?.(result);
          onProgress?.({
            fileId: uploadId,
            currentPart: partNumber,
            totalParts,
            uploadedParts,
            bytesUploaded: partSize,
            bytesTotal: partSize,
            overallProgress: (uploadedParts / totalParts) * 100,
          });

          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          
          // Don't retry on abort
          if (signal?.aborted) {
            throw lastError;
          }

          onPartError?.(partNumber, lastError, attempt);

          if (attempt < this.config.retryAttempts) {
            await this.delay(this.config.retryDelay * attempt);
          }
        }
      }

      // All retries exhausted
      const result: PartUploadResult = {
        partNumber,
        success: false,
        error: lastError,
      };
      onPartComplete?.(result);
      errors.push({ partNumber, error: lastError! });
    };

    /**
     * Worker pool: Process queue with N concurrent workers
     */
    const runWorkerPool = async (): Promise<void> => {
      const workers: Promise<void>[] = [];

      // Create worker function
      const worker = async (): Promise<void> => {
        while (queue.length > 0) {
          // Check for abort
          if (signal?.aborted) {
            return;
          }

          const partNumber = queue.shift();
          if (partNumber === undefined) {
            return;
          }

          const uploadPromise = uploadSinglePart(partNumber);
          activeUploads.set(partNumber, uploadPromise);

          try {
            await uploadPromise;
          } finally {
            activeUploads.delete(partNumber);
          }
        }
      };

      // Start N workers
      for (let i = 0; i < concurrency; i++) {
        workers.push(worker());
      }

      // Wait for all workers to complete
      await Promise.all(workers);
    };

    // Execute the worker pool
    await runWorkerPool();

    // Check for abort
    if (signal?.aborted) {
      throw new ChunkedUploaderError('Upload aborted');
    }

    // Check for errors
    if (errors.length > 0) {
      const failedParts = errors.map(e => e.partNumber).join(', ');
      throw new ChunkedUploaderError(
        `Upload failed: ${errors.length} part(s) failed [${failedParts}]. First error: ${errors[0].error.message}`
      );
    }
  }

  /**
   * Calculate the size of a specific part
   */
  private getPartSize(partNumber: number, chunkSize: number, totalSize: number): number {
    const start = partNumber * chunkSize;
    return Math.min(chunkSize, totalSize - start);
  }

  /**
   * Normalize different file source types with streaming support
   * 
   * Returns a getChunk function that reads chunks on-demand, avoiding
   * loading the entire file into memory for large files.
   */
  private normalizeFileSourceStreaming(source: FileSource): {
    filename: string;
    size: number;
    getChunk: (partNumber: number, chunkSize: number) => Promise<Blob>;
  } {
    if (source instanceof File) {
      return {
        filename: source.name,
        size: source.size,
        getChunk: (partNumber, chunkSize) => {
          const start = partNumber * chunkSize;
          const end = Math.min(start + chunkSize, source.size);
          // File.slice() is synchronous and doesn't load data into memory
          return Promise.resolve(source.slice(start, end));
        },
      };
    }

    if (source instanceof Blob) {
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

    // Buffer (Node.js)
    if (Buffer.isBuffer(source)) {
      return {
        filename: 'file',
        size: source.byteLength,
        getChunk: (partNumber, chunkSize) => {
          const start = partNumber * chunkSize;
          const end = Math.min(start + chunkSize, source.byteLength);
          // Create a view into the buffer without copying
          const chunk = source.subarray(start, end);
          // Convert to Blob
          const copy = new ArrayBuffer(chunk.byteLength);
          new Uint8Array(copy).set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          return Promise.resolve(new Blob([copy]));
        },
      };
    }

    throw new ChunkedUploaderError('Unsupported file source type');
  }

  /**
   * Make an HTTP request
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { useApiKey?: boolean } = {}
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
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

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
    }
  }

  /**
   * Parse error response body
   */
  private async parseErrorResponse(
    response: Response
  ): Promise<{ error?: string; code?: string; details?: unknown }> {
    try {
      return await response.json();
    } catch {
      return { error: response.statusText };
    }
  }

  /**
   * Delay utility
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Convert various data types to Blob for fetch compatibility
   */
  private toBlob(data: Blob | ArrayBuffer | Buffer): Blob {
    if (data instanceof Blob) {
      return data;
    }

    if (Buffer.isBuffer(data)) {
      // Create a copy to ensure we have a proper ArrayBuffer (not SharedArrayBuffer)
      const copy = new ArrayBuffer(data.byteLength);
      const view = new Uint8Array(copy);
      view.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      return new Blob([copy]);
    }

    // ArrayBuffer - may be SharedArrayBuffer, so copy to be safe
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(new Uint8Array(data));
    return new Blob([copy]);
  }
}

