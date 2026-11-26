import { ErrorCode, FsError } from './errors.js';
import type { PageSnapshot, PageSnapshotStore } from './page-store.js';
import { invalidCursor } from './page-store.js';

type PageSizeSelector<T, M> = (params: {
  items: readonly T[];
  metadata: M;
  offset: number;
  cursorAfter: (shown: number) => string | undefined;
}) => number;

// A fresh page is sized before we know whether it needs a stored snapshot.
// This placeholder has the same encoded length as an actual snapshot UUID.
const PREVIEW_SNAPSHOT_ID = '00000000-0000-0000-0000-000000000000';

interface PageCursor {
  readonly snapshotId: string;
  readonly offset: number;
}

function encodePageCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function cursorAfter(snapshotId: string, nextOffset: number, total: number): string | undefined {
  return nextOffset < total ? encodePageCursor({ snapshotId, offset: nextOffset }) : undefined;
}

function selectPageSize<T, M>(
  snapshot: PageSnapshot<T, M>,
  offset: number,
  pageSize: number,
  snapshotId: string,
  select: PageSizeSelector<T, M> | undefined,
): number {
  if (!select) return pageSize;
  return select({
    items: snapshot.items.slice(offset, offset + pageSize),
    metadata: snapshot.metadata,
    offset,
    cursorAfter: (shown) => cursorAfter(snapshotId, offset + shown, snapshot.items.length),
  });
}

function pageResult<T, M>(
  snapshotId: string,
  offset: number,
  pageSize: number,
  snapshot: PageSnapshot<T, M>,
): Page<T, M> {
  const page = snapshot.items.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  return {
    page,
    metadata: snapshot.metadata,
    offset,
    nextCursor: cursorAfter(snapshotId, nextOffset, snapshot.items.length),
  };
}

/**
 * The full result set a paged tool produced, before slicing. `truncated` is the
 * engine's own stop state — the hard result cap or a timeout cut the set — and
 * says nothing about page size.
 */
export interface ProducedPage<T, M> {
  readonly items: readonly T[];
  readonly metadata: M;
  readonly truncated: boolean;
}

interface Page<T, M> {
  readonly page: readonly T[];
  readonly metadata: M;
  readonly nextCursor: string | undefined;
  /**
   * Index of this page's first item in the full set. A tool that reports
   * progress in its text needs it: without it every page can only say how many
   * rows it holds, which is the same number on page 1 and page 9.
   */
  readonly offset: number;
}

export interface PaginatedPage<T, M, R> extends Page<T, M> {
  /** The externalized full set. First page only, and only when incomplete. */
  readonly resource?: R;
}

/**
 * The single home of the pagination cache-key rule: `JSON.stringify` of a
 * flat object whose `method` names the tool and whose remaining fields
 * identify the query. The literal's field order fixes key stability;
 * `method` keeps tool key spaces disjoint. Byte-identical to the three
 * hand-written tool builders it replaces.
 */
export function pageQueryKey(
  query: { readonly method: string; readonly path: string } & Record<string, unknown>,
): string {
  return JSON.stringify(query);
}

/**
 * The one replay-or-produce branch every paged tool runs. A cursor replays a
 * stored snapshot; without one, `produce` runs the query and its result is
 * snapshotted for later pages.
 *
 * The response is incomplete when the set spans more than one page or the
 * engine truncated it. Then — and only on the first page — `externalize`
 * stores the full set and its handle rides back as `resource`. Replayed pages
 * never carry it: the stored entry expires on the resource store's own TTL and
 * LRU, not this snapshot's, so replaying its URI would hand back a dead
 * pointer. Nor do they mint a new one; the set was already stored whole.
 */
export async function paginate<T, M, R>(params: {
  store: PageSnapshotStore;
  queryKey: string;
  cursor: string | undefined;
  pageSize: number;
  selectPageSize?: PageSizeSelector<T, M>;
  produce: () => Promise<ProducedPage<T, M>>;
  externalize?: ((items: readonly T[], metadata: M) => R) | undefined;
}): Promise<PaginatedPage<T, M, R>> {
  if (params.cursor !== undefined) {
    const decoded = decodePageCursor(params.cursor);
    const snapshot = params.store.read<T, M>(decoded.snapshotId, params.queryKey);
    if (decoded.offset >= snapshot.items.length) throw invalidCursor();
    const pageSize = selectPageSize(
      snapshot,
      decoded.offset,
      params.pageSize,
      decoded.snapshotId,
      params.selectPageSize,
    );
    return pageResult(decoded.snapshotId, decoded.offset, pageSize, snapshot);
  }
  const produced = await params.produce();
  const { items, metadata } = produced;
  const pageSize = selectPageSize(
    produced,
    0,
    params.pageSize,
    PREVIEW_SNAPSHOT_ID,
    params.selectPageSize,
  );
  const incomplete = items.length > pageSize || produced.truncated;
  const first: Page<T, M> =
    items.length <= pageSize
      ? { page: items, metadata, nextCursor: undefined, offset: 0 }
      : pageResult(
          params.store.create({
            queryKey: params.queryKey,
            items,
            metadata,
          }),
          0,
          pageSize,
          produced,
        );
  if (!incomplete || params.externalize === undefined) return first;
  return { ...first, resource: params.externalize(produced.items, produced.metadata) };
}

/** Recover the query only. The caller must reauthorize its scope before paging. */
export function readPageQuery(
  store: PageSnapshotStore,
  cursor: string,
  method: string,
): Record<string, unknown> {
  const { snapshotId } = decodePageCursor(cursor);
  const { method: storedMethod, ...query } = JSON.parse(store.getQueryKey(snapshotId)) as {
    method: string;
  } & Record<string, unknown>;
  if (storedMethod !== method) throw invalidCursor();
  return query;
}

function decodePageCursor(cursor: string): PageCursor {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf-8');
    const parsed = JSON.parse(text) as { snapshotId?: unknown; offset?: unknown };
    if (
      typeof parsed.snapshotId === 'string' &&
      parsed.snapshotId.length > 0 &&
      typeof parsed.offset === 'number' &&
      Number.isInteger(parsed.offset) &&
      parsed.offset >= 0
    ) {
      return { snapshotId: parsed.snapshotId, offset: parsed.offset };
    }
    throw new Error('Invalid page cursor');
  } catch (error) {
    if (error instanceof FsError) throw error;
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      invalidCursor().message,
      undefined,
      error instanceof Error ? error : undefined,
    );
  }
}
