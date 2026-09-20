import assert from 'node:assert/strict';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';

import { parse } from 'csv-parse';
import yauzl from 'yauzl';

export interface VerifiedSnapshotCsv {
  readonly name: string;
  readonly rows: number;
  readonly paths: Set<string>;
}

export async function verifySnapshotZip(
  bytes: Buffer,
  collectPaths: boolean,
): Promise<VerifiedSnapshotCsv> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error('ZIP did not open'));
        return;
      }
      let settled = false;
      let entries = 0;
      let verified: VerifiedSnapshotCsv | undefined;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      zip.once('error', fail);
      zip.once('end', () => {
        if (settled) return;
        if (entries !== 1 || !verified) {
          fail(new Error('Snapshot ZIP must contain exactly one fully verified CSV entry'));
          return;
        }
        settled = true;
        resolve(verified);
      });
      zip.on('entry', (entry) => {
        entries += 1;
        if (entries !== 1 || !entry.fileName.endsWith('.csv')) {
          fail(new Error('Snapshot ZIP must contain exactly one CSV entry'));
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new Error('CSV entry did not open'));
            return;
          }
          void (async () => {
            const parser = parse({ bom: false, columns: true, relax_column_count: false });
            let checksum = 0;
            let rows = 0;
            const paths = new Set<string>();
            stream.on('data', (chunk: Buffer) => {
              checksum = crc32(chunk, checksum);
            });
            const parsed = (async () => {
              for await (const value of parser) {
                const record = value as Record<string, string>;
                assert.deepEqual(Object.keys(record), [
                  'RootId',
                  'RelativePath',
                  'Name',
                  'Extension',
                  'Length',
                  'LastWriteTime',
                ]);
                assert(Number.isSafeInteger(Number(record['Length'])));
                assert(!Number.isNaN(Date.parse(record['LastWriteTime'] ?? '')));
                rows += 1;
                if (collectPaths) paths.add(record['RelativePath'] ?? '');
              }
            })();
            await Promise.all([pipeline(stream, parser), parsed]);
            if (checksum >>> 0 !== entry.crc32 >>> 0) {
              throw new Error('Snapshot ZIP entry CRC-32 mismatch');
            }
            verified = { name: entry.fileName, rows, paths };
            zip.readEntry();
          })().catch(fail);
        });
      });
      zip.readEntry();
    });
  });
}
