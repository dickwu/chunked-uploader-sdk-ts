/**
 * Configuration options for the ChunkedUploader SDK
 */
export interface ChunkedUploaderConfig {
  /** Base URL of the chunked upload server */
  baseUrl: string;
  /** API key for management endpoints (init, status, complete, cancel) */
  apiKey: string;
  /** Request timeout in milliseconds (default: 30000 for management, chunk uploads use longer timeout) */
  timeout?: number;
  /** Number of concurrent chunk uploads (default: 3) */
  concurrency?: number;
  /** Retry attempts for failed chunk uploads (default: 3) */
  retryAttempts?: number;
  /** Delay between retries in milliseconds (default: 1000) */
  retryDelay?: number;
  /** Poll interval while waiting for finalization (default: 2000) */
  finalizePollIntervalMs?: number;
  /** Maximum wait for finalization before timing out (default: 7200000) */
  finalizeTimeoutMs?: number;
  /** Timeout per individual part upload in milliseconds (default: 300000 = 5 minutes) */
  partUploadTimeoutMs?: number;
  /** Custom fetch implementation (for Node.js or custom handling) */
  fetch?: typeof fetch;
}

/**
 * Request payload for initializing an upload
 */
export interface InitUploadRequest {
  /** Original filename */
  filename: string;
  /** Total file size in bytes */
  total_size: number;
  /** Optional webhook URL to notify on completion */
  webhook_url?: string;
}

/**
 * Part information returned from init
 */
export interface PartInfo {
  /** Part number (0-indexed) */
  part: number;
  /** JWT token for this specific part */
  token: string;
  /** Part status */
  status: 'pending' | 'uploaded';
}

/**
 * Response from upload initialization
 */
export interface InitUploadResponse {
  /** Unique upload identifier (UUID) */
  file_id: string;
  /** Total number of parts */
  total_parts: number;
  /** Chunk size in bytes */
  chunk_size: number;
  /** Array of part information with tokens */
  parts: PartInfo[];
  /** Expiration timestamp (ISO 8601) */
  expires_at: string;
}

/**
 * Response from uploading a single part
 */
export interface UploadPartResponse {
  /** Upload identifier */
  upload_id: string;
  /** Part number that was uploaded */
  part_number: number;
  /** Part status */
  status: 'uploaded';
  /** SHA256 checksum of the uploaded part */
  checksum_sha256: string;
  /** Number of parts uploaded so far */
  uploaded_parts: number;
  /** Total number of parts */
  total_parts: number;
}

/**
 * Part status information
 */
export interface PartStatus {
  /** Part number */
  part: number;
  /** Part status */
  status: 'pending' | 'uploaded';
  /** SHA256 checksum (null if not yet uploaded) */
  checksum_sha256: string | null;
}

/**
 * Upload phase
 */
export type UploadPhase = 'uploading' | 'finalizing' | 'complete' | 'failed';

/**
 * Response from status check
 */
export interface UploadStatusResponse {
  /** Upload identifier */
  file_id: string;
  /** Original filename */
  filename: string;
  /** Total file size in bytes */
  total_size: number;
  /** Chunk size in bytes */
  chunk_size: number;
  /** Total number of parts */
  total_parts: number;
  /** Number of parts uploaded */
  uploaded_parts: number;
  /** Upload stage progress percentage (0-100) */
  upload_progress_percent: number;
  /** Finalization progress percentage (0-100) */
  finalizing_progress_percent: number;
  /** Overall upload status */
  status: 'pending' | 'finalizing' | 'complete' | 'failed';
  /** Current phase */
  phase: UploadPhase;
  /** Finalization error, if any */
  finalization_error: string | null;
  /** Storage backend */
  storage_backend: 'local' | 's3' | 'smb';
  /** Array of part statuses (present when include_parts=true) */
  parts?: PartStatus[];
  /** Final path when complete */
  final_path?: string | null;
  /** Upload creation time */
  created_at?: string;
  /** Upload expiration time */
  expires_at?: string;
}

/**
 * Response from completing an upload
 */
export interface CompleteUploadResponse {
  /** Upload identifier */
  file_id: string;
  /** Original filename */
  filename: string;
  /** Total file size in bytes */
  total_size: number;
  /** Upload status */
  status: 'complete' | 'finalizing' | 'failed' | 'pending';
  /** Current phase */
  phase: UploadPhase;
  /** Finalization progress percentage (0-100) */
  finalizing_progress_percent: number;
  /** Final path to the assembled file */
  final_path?: string | null;
  /** Storage backend used */
  storage_backend: 'local' | 's3' | 'smb';
}

/**
 * Response from cancelling an upload
 */
export interface CancelUploadResponse {
  /** Upload identifier */
  file_id: string;
  /** Cancellation message */
  message: string;
}

/**
 * Health check response
 */
export interface HealthCheckResponse {
  /** Server status */
  status: 'ok';
  /** Optional additional info */
  [key: string]: unknown;
}

/**
 * Progress event data
 */
export interface UploadProgressEvent {
  /** Upload identifier */
  fileId: string;
  /** Current phase */
  phase: UploadPhase;
  /** Current part being uploaded (0-indexed) */
  currentPart: number;
  /** Total number of parts */
  totalParts: number;
  /** Number of parts uploaded */
  uploadedParts: number;
  /** Bytes uploaded in current part */
  bytesUploaded: number;
  /** Total bytes of current part */
  bytesTotal: number;
  /** Current phase progress percentage (0-100) */
  phaseProgress: number;
  /** Upload phase progress percentage (0-100) */
  uploadProgress: number;
  /** Finalization phase progress percentage (0-100) */
  finalizingProgress: number;
  /** Aggregate progress percentage (0-100) */
  overallProgress: number;
}

/**
 * Part upload result
 */
export interface PartUploadResult {
  /** Part number */
  partNumber: number;
  /** Whether the upload succeeded */
  success: boolean;
  /** Response data if successful */
  response?: UploadPartResponse;
  /** Error if failed */
  error?: Error;
}

/**
 * Upload result
 */
export interface UploadResult {
  /** Upload identifier */
  fileId: string;
  /** Original filename */
  filename: string;
  /** Total file size */
  totalSize: number;
  /** Final path (after completion) */
  finalPath?: string;
  /** Storage backend */
  storageBackend?: 'local' | 's3' | 'smb';
  /** Whether the upload completed successfully */
  success: boolean;
  /** Error if failed */
  error?: Error;
}

/**
 * File source - can be a File (browser), Buffer (Node.js), or Blob
 */
export type FileSource = File | Blob | ArrayBuffer | Buffer;

/**
 * Options for uploading a file
 */
export interface UploadOptions {
  /** Optional webhook URL for completion notification */
  webhookUrl?: string;
  /** Progress callback */
  onProgress?: (event: UploadProgressEvent) => void;
  /** Called when a part upload completes */
  onPartComplete?: (result: PartUploadResult) => void;
  /** Called when a part upload fails (before retry) */
  onPartError?: (partNumber: number, error: Error, attempt: number) => void;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Override default concurrency for this upload (number of parallel part uploads) */
  concurrency?: number;
}

/**
 * Options for resuming an upload
 */
export interface ResumeOptions extends Omit<UploadOptions, 'webhookUrl'> {
  /** Part tokens (required if not fetching from status) */
  partTokens?: Map<number, string>;
}

/**
 * API error response
 */
export interface ApiErrorResponse {
  /** Error message */
  error: string;
  /** Error code */
  code?: string;
  /** Additional details */
  details?: unknown;
}

/**
 * SDK Error class
 */
export class ChunkedUploaderError extends Error {
  /** HTTP status code */
  public readonly statusCode?: number;
  /** Error code from server */
  public readonly code?: string;
  /** Additional details */
  public readonly details?: unknown;

  constructor(
    message: string,
    statusCode?: number,
    code?: string,
    details?: unknown
  ) {
    super(message);
    this.name = 'ChunkedUploaderError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
