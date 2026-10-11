import { setImmediate } from 'node:timers/promises';

interface Literal {
  readonly start: number;
  readonly end: number;
}
interface Choice {
  readonly alternatives: readonly Sequence[];
}
interface Group {
  readonly sequence: Sequence;
}
type Part = Literal | Choice | Group;
type Sequence = readonly Part[];
interface Task {
  readonly part: Part;
  readonly next: Task | undefined;
}
interface Chunk {
  readonly literal: Literal;
  readonly previous: Chunk | undefined;
}
interface State {
  readonly task: Task | undefined;
  readonly chunks: Chunk | undefined;
}

/**
 * Stream comma-brace alternatives without materializing a Cartesian product.
 * Public safe glob syntax excludes ranges (`..`) and normalizes backslashes
 * before this helper. Slices/choice nodes and DFS state are bounded by the input;
 * timers/cancellation also run while parsing or enumerating unmatched variants.
 */
export async function prepareBracePatterns(
  pattern: string,
  signal: AbortSignal,
): Promise<(basename?: string) => AsyncGenerator<string>> {
  // Match Node's existing glob pattern bound, rather than allocating a larger
  // plan for a pattern its matcher would reject anyway.
  if (pattern.length > 64 * 1024) throw new TypeError('Pattern is too long');
  let work = 0;
  const literalCloses = new Set<number>();
  async function checkpoint(): Promise<void> {
    signal.throwIfAborted();
    if (++work % 256 === 0) {
      await setImmediate();
      signal.throwIfAborted();
    }
  }

  async function balanced(start: number, end: number): Promise<Literal | undefined> {
    const opens: number[] = [];
    let first: Literal | undefined;
    for (let index = start; index < end; index++) {
      await checkpoint();
      if (pattern[index] === '{') opens.push(index);
      else if (pattern[index] === '}' && !literalCloses.has(index)) {
        const open = opens.pop();
        if (open === undefined) continue;
        if (!first || open < first.start) first = { start: open, end: index + 1 };
        if (opens.length === 0) return first;
      }
    }
    return first;
  }

  async function hasLaterAlternative(start: number, end: number): Promise<boolean> {
    let comma = false;
    for (let index = start; index < end; index++) {
      await checkpoint();
      if (pattern[index] === ',' && pattern[index + 1] !== ',') comma = true;
      else if (comma && pattern[index] === '}' && !literalCloses.has(index)) return true;
    }
    return false;
  }

  async function parse(start: number, end: number): Promise<Sequence> {
    await checkpoint();
    if (start === end) return [];
    const group = await balanced(start, end);
    if (!group) return [{ start, end }];
    const bodyStart = group.start + 1;
    const bodyEnd = group.end - 1;
    if (pattern[group.start - 1] === '$') {
      // Native brace expansion preserves ${...}, but can expand its suffix.
      return [{ start, end: group.end }, { sequence: await parse(group.end, end) }];
    }
    const comma = pattern.indexOf(',', bodyStart);
    if (comma < 0 || comma >= bodyEnd) {
      // Node treats a non-choice close as literal when a later comma/close
      // can form an alternative (including its unmatched-brace behavior).
      if (await hasLaterAlternative(group.end, end)) {
        literalCloses.add(bodyEnd);
        return parse(start, end);
      }
      return [{ start, end }];
    }
    const alternatives: Sequence[] = [];
    let depth = 0;
    let partStart = bodyStart;
    for (let index = bodyStart; index < bodyEnd; index++) {
      await checkpoint();
      if (pattern[index] === '{') depth++;
      else if (pattern[index] === '}' && !literalCloses.has(index)) depth--;
      else if (pattern[index] === ',' && depth === 0) {
        alternatives.push(await parse(partStart, index));
        partStart = index + 1;
      }
    }
    alternatives.push(await parse(partStart, bodyEnd));
    const middle: Sequence =
      alternatives.length === 1
        ? [
            { start: group.start, end: bodyStart },
            { sequence: alternatives[0] ?? [] },
            { start: bodyEnd, end: group.end },
          ]
        : [{ alternatives }];
    return [
      ...(start < group.start ? [{ start, end: group.start }] : []),
      ...middle,
      { sequence: await parse(group.end, end) },
    ];
  }

  // Node preserves a leading {}, even when the rest contains alternatives.
  const sequence: Sequence = pattern.startsWith('{}')
    ? [{ start: 0, end: 2 }, { sequence: await parse(2, pattern.length) }]
    : await parse(0, pattern.length);

  async function minimumLength(parts: Sequence): Promise<number> {
    let length = 0;
    for (const part of parts) {
      await checkpoint();
      if ('sequence' in part) length += await minimumLength(part.sequence);
      else if ('alternatives' in part) {
        let minimum = Infinity;
        for (const alternative of part.alternatives)
          minimum = Math.min(minimum, await minimumLength(alternative));
        length += minimum;
      } else length += part.end - part.start;
    }
    return length;
  }

  const slash = pattern.lastIndexOf('/');
  const directory = pattern.slice(0, slash + 1);
  const name = pattern.slice(slash + 1);
  // A long literal ASCII basename cannot be a DOS 8.3 alias (at most 12
  // characters). Filter impossible products by their emitted prefix, leaving
  // case acceptance to guarded lookup. Short names, Unicode and wildcard
  // components keep the unrestricted lazy path; no filesystem alias is guessed.
  const guideName =
    !/[{}*?[\]!@+()]/u.test(directory) &&
    /^[a-z\d_.,{}-]+$/iu.test(name) &&
    /[a-z\d_-]$/iu.test(name) &&
    (await minimumLength(sequence)) - directory.length > 12;

  async function prepend(parts: Sequence, next: Task | undefined): Promise<Task | undefined> {
    let task = next;
    for (let index = parts.length - 1; index >= 0; index--) {
      await checkpoint();
      const part = parts[index];
      if (part) task = { part, next: task };
    }
    return task;
  }

  return async function* variants(basename?: string): AsyncGenerator<string> {
    const guide =
      guideName && basename && /^[a-z\d_.,{}-]+$/iu.test(basename)
        ? `${directory}${basename}`.toLowerCase()
        : undefined;
    const pending: State[] = [{ task: await prepend(sequence, undefined), chunks: undefined }];
    while (pending.length > 0) {
      const state = pending.pop();
      if (!state) continue;
      let { task, chunks } = state;
      let emitted = '';
      if (guide && chunks) {
        const prefix: string[] = [];
        let previous: Chunk | undefined = chunks;
        while (previous) {
          await checkpoint();
          prefix.push(pattern.slice(previous.literal.start, previous.literal.end));
          previous = previous.previous;
        }
        emitted = prefix.reverse().join('').toLowerCase();
      }
      let rejected = false;
      while (task) {
        await checkpoint();
        const { part, next } = task;
        if ('sequence' in part) {
          task = await prepend(part.sequence, next);
        } else if ('alternatives' in part) {
          for (let index = part.alternatives.length - 1; index > 0; index--) {
            await checkpoint();
            pending.push({ task: await prepend(part.alternatives[index] ?? [], next), chunks });
          }
          task = await prepend(part.alternatives[0] ?? [], next);
        } else {
          if (guide) {
            emitted += pattern.slice(part.start, part.end).toLowerCase();
            if (!guide.startsWith(emitted)) {
              rejected = true;
              break;
            }
          }
          chunks = { literal: part, previous: chunks };
          task = next;
        }
      }
      if (rejected) continue;
      const pieces: string[] = [];
      while (chunks) {
        await checkpoint();
        pieces.push(pattern.slice(chunks.literal.start, chunks.literal.end));
        chunks = chunks.previous;
      }
      const variant = pieces.reverse().join('');
      if (variant) yield variant;
    }
    signal.throwIfAborted();
  };
}
