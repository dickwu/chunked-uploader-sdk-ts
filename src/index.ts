/**
 * Chunked Uploader SDK
 *
 * A TypeScript SDK for uploading large files (10GB+) with:
 * - Automatic chunking (50MB default, Cloudflare compatible)
 * - Parallel uploads with concurrency control
 * - Resume capability for interrupted uploads
 * - Progress tracking and callbacks
 * - Retry logic for failed chunks
 *
 * @packageDocumentation
 */

export { ChunkedUploader } from './chunked-uploader';

export type {
  // Configuration
  ChunkedUploaderConfig,

  // Request/Response types
  InitUploadRequest,
  InitUploadResponse,
  PartInfo,
  UploadPartResponse,
  PartStatus,
  UploadStatusResponse,
  CompleteUploadResponse,
  CancelUploadResponse,
  HealthCheckResponse,

  // Upload types
  FileSource,
  UploadOptions,
  ResumeOptions,
  UploadResult,
  PartUploadResult,
  UploadProgressEvent,

  // Error types
  ApiErrorResponse,
} from './types';

export { ChunkedUploaderError } from './types';


