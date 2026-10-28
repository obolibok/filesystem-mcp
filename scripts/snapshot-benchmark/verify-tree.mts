// Independent readback: no production CSV encoder, walker or path helpers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';

import { parse } from 'csv-parse';
import yauzl from 'yauzl';

export interface VerifiedTree {
  root: string;
  rows: number;
  rawBytes: number;
  files: number;
  directories: number;
  contextRecords: number;
  errorRecords: number;
  /** Keys encode arrays of exact basenames, including legal CR/LF/backslashes. */
  nodes: Map<string, { type: 'D' | 'F'; length: string; lastWriteTime: string }>;
  servicePaths: Set<string>;
}

export async function verifyTreeZip(
  bytes: Buffer,
  sha256: string,
  collect = true,
): Promise<VerifiedTree> {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, 'SHA-256');
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error('ZIP did not open'));
      let entries = 0;
      let verified: VerifiedTree | undefined;
      let failed = false;
      const fail = (error: unknown) => {
        failed = true;
        zip.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      zip.once('error', fail);
      zip.once('end', () => {
        if (failed) return;
        if (entries !== 1 || !verified)
          return fail(new Error('Expected one fully verified CSV entry'));
        resolve(verified);
      });
      zip.on('entry', (entry) => {
        entries += 1;
        if (entries !== 1 || !entry.fileName.endsWith('.csv'))
          return fail(new Error('Expected one CSV entry'));
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return fail(error ?? new Error('Missing ZIP stream'));
          void (async () => {
            const result: VerifiedTree = {
              root: '',
              rows: 0,
              rawBytes: 0,
              files: 0,
              directories: 0,
              contextRecords: 0,
              errorRecords: 0,
              nodes: new Map(),
              servicePaths: new Set(),
            };
            const stack: string[] = [];
            let checksum = 0;
            let inContext = true;
            const parser = parse({
              bom: false,
              relax_column_count: true,
              record_delimiter: '\r\n',
            });
            stream.on('data', (chunk: Buffer) => {
              checksum = crc32(chunk, checksum);
              result.rawBytes += chunk.length;
            });
            const consume = (async () => {
              for await (const value of parser) {
                const row = value as string[];
                result.rows += 1;
                if (result.rows === 1) {
                  assert.equal(row.length, 1);
                  result.root = row[0] ?? '';
                  assert(posix.isAbsolute(result.root) || win32.isAbsolute(result.root));
                  continue;
                }
                if (result.rows === 2) {
                  assert.deepEqual(row, ['Type', 'Depth', 'Name', 'Length', 'LastWriteTime']);
                  continue;
                }
                assert.equal(row.length, 5);
                const [type, rawDepth, name, length, lastWriteTime] = row;
                assert(type === 'D' || type === 'F' || type === 'C' || type === 'U');
                assert(rawDepth && /^(0|[1-9][0-9]*)$/u.test(rawDepth));
                const depth = Number(rawDepth);
                assert(
                  Number.isSafeInteger(depth) && depth <= stack.length,
                  'Missing ancestor context',
                );
                assert(
                  name &&
                    name !== '.' &&
                    name !== '..' &&
                    !name.includes('/') &&
                    !name.includes('\0'),
                );
                if (type === 'C') {
                  assert(
                    inContext && depth === stack.length,
                    'Context must be an initial ancestor chain',
                  );
                  result.contextRecords += 1;
                } else inContext = false;
                stack.length = depth;
                const path = JSON.stringify([...stack, name]);
                if (type === 'F') {
                  assert(
                    length &&
                      /^(0|[1-9][0-9]*)$/u.test(length) &&
                      Number.isSafeInteger(Number(length)),
                  );
                  assert(lastWriteTime && new Date(lastWriteTime).toISOString() === lastWriteTime);
                  result.files += 1;
                } else {
                  assert.equal(length, '');
                  assert.equal(lastWriteTime, '');
                  stack.push(name);
                  if (type === 'D') result.directories += 1;
                  if (type === 'U') result.errorRecords += 1;
                }
                if (collect) {
                  if (type === 'D' || type === 'F') {
                    assert(!result.nodes.has(path), 'Duplicate object in part');
                    result.nodes.set(path, {
                      type,
                      length: length ?? '',
                      lastWriteTime: lastWriteTime ?? '',
                    });
                  } else result.servicePaths.add(path);
                }
              }
            })();
            await Promise.all([pipeline(stream, parser), consume]);
            assert(result.rows >= 2);
            assert.equal(checksum >>> 0, entry.crc32 >>> 0, 'CRC-32');
            assert.equal(result.rawBytes, entry.uncompressedSize);
            verified = result;
            zip.readEntry();
          })().catch(fail);
        });
      });
      zip.readEntry();
    });
  });
}

export function mergeTrees(parts: readonly VerifiedTree[]): VerifiedTree['nodes'] {
  const nodes: VerifiedTree['nodes'] = new Map();
  for (const part of parts) {
    assert.equal(part.root, parts[0]?.root);
    for (const [path, node] of part.nodes) {
      assert(!nodes.has(path), 'Duplicate object across parts');
      nodes.set(path, node);
    }
  }
  for (const part of parts) {
    for (const path of part.servicePaths)
      assert.equal(nodes.get(path)?.type, 'D', 'C/U must reference a directory');
  }
  return nodes;
}
