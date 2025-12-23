# Chunked Uploader SDK

A TypeScript SDK for uploading large files (10GB+) to a chunked upload server. Supports parallel uploads, resume capability, and progress tracking.

## Features

- **Large File Support**: Upload files of any size (10GB+)
- **Automatic Chunking**: Files split into 50MB chunks (Cloudflare compatible)
- **Parallel Uploads**: Configurable concurrency for faster uploads
- **Resumable**: Continue interrupted uploads from where they left off
- **Progress Tracking**: Real-time progress callbacks
- **Retry Logic**: Automatic retry for failed chunks
- **TypeScript**: Full type definitions included
- **Isomorphic**: Works in both browser and Node.js

## Installation

```bash
npm install chunked-uploader-sdk
```

## Quick Start

```typescript
import { ChunkedUploader } from 'chunked-uploader-sdk';

const uploader = new ChunkedUploader({
  baseUrl: 'https://upload.example.com',
  apiKey: 'your-api-key',
});

// Upload a file with progress tracking
const result = await uploader.uploadFile(file, {
  onProgress: (event) => {
    console.log(`Progress: ${event.overallProgress.toFixed(1)}%`);
  },
});

if (result.success) {
  console.log('Upload complete:', result.finalPath);
} else {
  console.error('Upload failed:', result.error);
}
```

## API Reference

### Configuration

```typescript
interface ChunkedUploaderConfig {
  /** Base URL of the chunked upload server */
  baseUrl: string;

  /** API key for management endpoints */
  apiKey: string;

  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;

  /** Number of concurrent chunk uploads (default: 3) */
  concurrency?: number;

  /** Retry attempts for failed chunks (default: 3) */
  retryAttempts?: number;

  /** Delay between retries in milliseconds (default: 1000) */
  retryDelay?: number;

  /** Custom fetch implementation */
  fetch?: typeof fetch;
}
```

### Methods

#### `uploadFile(file, options?)`

Upload a file with automatic chunking and **parallel multi-part uploads**.

The SDK sends multiple HTTP requests concurrently for different parts, maximizing upload throughput. Chunks are read on-demand (streaming) to avoid loading the entire file into memory.

```typescript
const result = await uploader.uploadFile(file, {
  webhookUrl: 'https://your-server.com/webhook',
  concurrency: 5, // Upload 5 parts simultaneously (default: 3)
  onProgress: (event) => {
    console.log(`Part ${event.currentPart}/${event.totalParts}`);
    console.log(`Overall: ${event.overallProgress}%`);
  },
  onPartComplete: (result) => {
    console.log(`Part ${result.partNumber} ${result.success ? 'done' : 'failed'}`);
  },
  signal: abortController.signal, // For cancellation
});
```

**Parallel Upload Features:**
- **Concurrent requests**: Multiple parts upload simultaneously (configurable)
- **Streaming reads**: Chunks read on-demand, not loaded into memory
- **Independent retries**: Failed parts retry without blocking others
- **Progress tracking**: Real-time progress for each part and overall

#### `resumeUpload(uploadId, file, options?)`

Resume an interrupted upload.

```typescript
// Store part tokens from initial upload
const tokenMap = new Map<number, string>();
initResponse.parts.forEach(p => tokenMap.set(p.part, p.token));

// Later, resume the upload
const result = await uploader.resumeUpload(uploadId, file, {
  partTokens: tokenMap,
  onProgress: (event) => console.log(`${event.overallProgress}%`),
});
```

#### `initUpload(filename, totalSize, webhookUrl?)`

Initialize an upload session manually.

The `filename` parameter can include a path (e.g., `"videos/2024/december/large-video.mp4"`). When a path is included, the server will store the file at that path.

```typescript
// Simple filename (stored at default location)
const response = await uploader.initUpload('large-video.mp4', fileSize);
console.log(`Upload ID: ${response.file_id}`);
console.log(`Parts: ${response.total_parts}`);

// With custom path (stored at videos/2024/december/)
const response = await uploader.initUpload('videos/2024/december/large-video.mp4', fileSize);
console.log(`File will be stored at: ${response.file_id}`);
```

#### `uploadPart(uploadId, partNumber, token, data, signal?)`

Upload a single chunk.

```typescript
const result = await uploader.uploadPart(
  uploadId,
  0,
  partToken,
  chunkData
);
```

#### `getStatus(uploadId)`

Get upload progress and status.

```typescript
const status = await uploader.getStatus(uploadId);
console.log(`Progress: ${status.progress_percent}%`);
console.log(`Uploaded: ${status.uploaded_parts}/${status.total_parts}`);

// Find pending parts
const pending = status.parts.filter(p => p.status === 'pending');
```

#### `completeUpload(uploadId)`

Complete an upload (assemble all parts).

```typescript
const result = await uploader.completeUpload(uploadId);
console.log(`File path: ${result.final_path}`);
```

#### `cancelUpload(uploadId)`

Cancel an upload and cleanup.

```typescript
await uploader.cancelUpload(uploadId);
```

#### `healthCheck()`

Check server health.

```typescript
const health = await uploader.healthCheck();
console.log(`Server status: ${health.status}`);
```

## Examples

### Basic Upload

```typescript
import { ChunkedUploader } from 'chunked-uploader-sdk';

const uploader = new ChunkedUploader({
  baseUrl: 'http://localhost:3000',
  apiKey: 'your-api-key',
});

// Browser: File input
const input = document.querySelector('input[type="file"]') as HTMLInputElement;
input.addEventListener('change', async () => {
  const file = input.files?.[0];
  if (!file) return;

  const result = await uploader.uploadFile(file);
  console.log(result);
});
```

### Upload to Custom Path

For full control over the storage path, use `initUpload` with a path-prefixed filename:

```typescript
async function uploadToPath(file: File, targetPath: string) {
  const uploader = new ChunkedUploader({
    baseUrl: 'http://localhost:3000',
    apiKey: 'your-api-key',
  });

  // Include path in filename (e.g., "videos/2024/december/my-video.mp4")
  const remoteFilename = `${targetPath}/${file.name}`;
  
  // Initialize with custom path
  const init = await uploader.initUpload(remoteFilename, file.size);
  
  // Upload using resumeUpload (handles parallel uploads)
  const tokenMap = new Map(init.parts.map(p => [p.part, p.token]));
  const result = await uploader.resumeUpload(init.file_id, file, {
    partTokens: tokenMap,
    onProgress: (event) => {
      console.log(`Progress: ${event.overallProgress.toFixed(1)}%`);
    },
  });
  
  // Result: file stored at videos/2024/december/my-video.mp4
  console.log('Final path:', result.finalPath);
}

// Usage
uploadToPath(file, 'videos/2024/december');
```

### Upload with Progress UI

```typescript
const progressBar = document.querySelector('.progress-bar') as HTMLElement;
const statusText = document.querySelector('.status') as HTMLElement;

const result = await uploader.uploadFile(file, {
  onProgress: (event) => {
    progressBar.style.width = `${event.overallProgress}%`;
    statusText.textContent = `Uploading part ${event.uploadedParts}/${event.totalParts}`;
  },
  onPartComplete: (result) => {
    if (!result.success) {
      console.error(`Part ${result.partNumber} failed:`, result.error);
    }
  },
});
```

### Resumable Upload with Token Storage

```typescript
const STORAGE_KEY = 'pending_upload';

interface StoredUpload {
  uploadId: string;
  tokens: [number, string][];
}

async function uploadWithResume(file: File) {
  // Check for existing upload
  const stored = localStorage.getItem(STORAGE_KEY);
  
  if (stored) {
    const data: StoredUpload = JSON.parse(stored);
    const tokenMap = new Map(data.tokens);
    
    try {
      const result = await uploader.resumeUpload(data.uploadId, file, {
        partTokens: tokenMap,
      });
      
      if (result.success) {
        localStorage.removeItem(STORAGE_KEY);
        return result;
      }
    } catch (error) {
      console.log('Resume failed, starting fresh');
    }
  }

  // Start new upload
  const initResponse = await uploader.initUpload(file.name, file.size);
  
  // Store tokens for resume
  const toStore: StoredUpload = {
    uploadId: initResponse.file_id,
    tokens: initResponse.parts.map(p => [p.part, p.token]),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));

  // Upload file
  const tokenMap = new Map(initResponse.parts.map(p => [p.part, p.token]));
  
  // Manual upload with stored tokens
  const result = await uploader.resumeUpload(initResponse.file_id, file, {
    partTokens: tokenMap,
  });

  if (result.success) {
    localStorage.removeItem(STORAGE_KEY);
  }

  return result;
}
```

### Cancellable Upload

```typescript
const abortController = new AbortController();

// Cancel button
cancelButton.addEventListener('click', () => {
  abortController.abort();
});

const result = await uploader.uploadFile(file, {
  signal: abortController.signal,
  onProgress: (event) => {
    console.log(`${event.overallProgress}%`);
  },
});

if (!result.success && result.error?.message === 'Upload aborted') {
  console.log('Upload was cancelled');
}
```

### High-Concurrency Parallel Upload

For maximum throughput on fast connections:

```typescript
const uploader = new ChunkedUploader({
  baseUrl: 'http://localhost:3000',
  apiKey: 'your-api-key',
  concurrency: 10, // Default concurrency
});

// Override per-upload for even more parallelism
const result = await uploader.uploadFile(largeFile, {
  concurrency: 20, // 20 simultaneous part uploads!
  onProgress: (event) => {
    const mbUploaded = (event.uploadedParts * 50).toFixed(0);
    console.log(`${mbUploaded}MB uploaded (${event.overallProgress.toFixed(1)}%)`);
  },
});
```

### Node.js Usage

```typescript
import { ChunkedUploader } from 'chunked-uploader-sdk';
import { readFile } from 'fs/promises';

const uploader = new ChunkedUploader({
  baseUrl: 'http://localhost:3000',
  apiKey: 'your-api-key',
  concurrency: 5, // More concurrent uploads for server-side
});

async function uploadFromDisk(filePath: string) {
  const buffer = await readFile(filePath);
  
  const result = await uploader.uploadFile(buffer, {
    onProgress: (event) => {
      process.stdout.write(`\rProgress: ${event.overallProgress.toFixed(1)}%`);
    },
  });

  console.log('\nUpload complete:', result);
}
```

### Custom Chunk Upload (Advanced)

For full control over the upload process:

```typescript
async function manualUpload(file: File) {
  // 1. Initialize
  const init = await uploader.initUpload(file.name, file.size);
  const chunkSize = init.chunk_size;

  // 2. Upload parts manually
  for (const part of init.parts) {
    const start = part.part * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const chunk = file.slice(start, end);
    
    const result = await uploader.uploadPart(
      init.file_id,
      part.part,
      part.token,
      chunk
    );
    
    console.log(`Part ${result.part_number} uploaded`);
  }

  // 3. Complete
  const complete = await uploader.completeUpload(init.file_id);
  console.log('File path:', complete.final_path);
}
```

## Error Handling

The SDK throws `ChunkedUploaderError` for API errors:

```typescript
import { ChunkedUploaderError } from 'chunked-uploader-sdk';

try {
  await uploader.uploadFile(file);
} catch (error) {
  if (error instanceof ChunkedUploaderError) {
    console.error('Upload error:', error.message);
    console.error('Status code:', error.statusCode);
    console.error('Error code:', error.code);
  }
}
```

## Server Requirements

This SDK is designed to work with the [Chunked Upload Server](https://github.com/dickwu/chunked-uploader).

**Server API Endpoints:**

- `POST /upload/init` - Initialize upload (API Key auth)
- `PUT /upload/{id}/part/{n}` - Upload chunk (JWT auth per part)
- `GET /upload/{id}/status` - Get progress (API Key auth)
- `POST /upload/{id}/complete` - Complete upload (API Key auth)
- `DELETE /upload/{id}` - Cancel upload (API Key auth)
- `GET /health` - Health check

## Reference

- **Server**: [chunked-uploader](https://github.com/dickwu/chunked-uploader) - A production-ready Rust HTTP server for resumable chunked uploads (10GB+) with support for local filesystem, SMB/NAS, and S3-compatible storage backends.

## License

MIT

