import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ErrorCode, FsError } from './errors.js';

const QUERY_TIMEOUT_MS = 5_000;

export type QueryValue = string | number | null;

export interface CatalogQueryInput {
  sql: string;
  params: readonly QueryValue[];
  limit: number;
}

export interface CatalogQueryRequest extends CatalogQueryInput {
  databasePath: string;
  root: string;
  generation: string;
  first: number;
  last: number;
}

interface QueryRows {
  columns: string[];
  rows: QueryValue[][];
  truncated: boolean;
}

export type CatalogQueryReply =
  ({ result: 'ok' } & QueryRows) | { result: 'stale' | 'invalid' | 'unavailable' };

export function runCatalogQuery(
  request: CatalogQueryRequest,
  signal: AbortSignal,
): Promise<QueryRows> {
  signal.throwIfAborted();
  const worker = import.meta.url.endsWith('.ts')
    ? new URL('./catalog-query-worker.ts', import.meta.url)
    : new URL('./catalog-query-worker.js', import.meta.url);
  const child = spawn(process.execPath, ['--max-old-space-size=64', fileURLToPath(worker)], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
    env: {
      SystemRoot: process.env['SystemRoot'],
      TEMP: process.env['TEMP'],
      TMP: process.env['TMP'],
    },
  });
  return new Promise((resolve, reject) => {
    let response: CatalogQueryReply | undefined;
    let failure: FsError | undefined;
    function stop(error: FsError): void {
      failure ??= error;
      child.kill();
    }
    function onAbort(): void {
      stop(new FsError(ErrorCode.CANCELLED, 'Catalog SQL query cancelled'));
    }
    const timer = setTimeout(() => {
      stop(new FsError(ErrorCode.TIMEOUT, 'Catalog SQL query exceeded its 5 second time limit'));
    }, QUERY_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('message', (message: CatalogQueryReply) => {
      response = message;
    });
    const unavailable = new FsError(ErrorCode.IO_ERROR, 'Catalog SQL query runner unavailable');
    child.on('error', () => {
      failure ??= unavailable;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (failure || code !== 0 || !response || response.result === 'unavailable') {
        reject(failure ?? unavailable);
      } else if (response.result === 'ok') {
        resolve({ columns: response.columns, rows: response.rows, truncated: response.truncated });
      } else {
        const message =
          response.result === 'stale'
            ? 'Catalog generation changed. Retry the query.'
            : 'SQL rejected. Use one SELECT over files and supported SQL functions.';
        reject(new FsError(ErrorCode.INVALID_INPUT, message));
      }
    });
    if (signal.aborted) onAbort();
    else
      child.send(request, (error) => {
        if (error) stop(unavailable);
      });
  });
}
