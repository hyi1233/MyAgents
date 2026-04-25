/**
 * Pattern 2 §G — large-value-store unit tests.
 *
 * Covers:
 *  (a) maybeSpill returns inline for values <= inlineMaxBytes
 *  (b) maybeSpill returns a ref for oversize values; preview = head N bytes
 *  (c) fetchRef returns the spilled bytes
 *  (d) fetchRef returns null after clearExpiredRefs() runs past TTL
 *  (e) clearSessionRefs removes only that session's refs
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearExpiredRefs,
  clearSessionRefs,
  fetchRef,
  maybeSpill,
  type LargeValueRef,
} from '../utils/large-value-store';

let scratch: string;
const ORIGINAL_REFS_DIR = process.env.MYAGENTS_REFS_DIR;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'myagents-refs-'));
  process.env.MYAGENTS_REFS_DIR = scratch;
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (ORIGINAL_REFS_DIR === undefined) {
    delete process.env.MYAGENTS_REFS_DIR;
  } else {
    process.env.MYAGENTS_REFS_DIR = ORIGINAL_REFS_DIR;
  }
});

describe('maybeSpill', () => {
  it('returns inline for small values (<= inlineMaxBytes)', async () => {
    const value = 'small text under threshold';
    const out = await maybeSpill(value, {
      inlineMaxBytes: 1024,
      previewBytes: 64,
      mimetype: 'text/plain',
    });
    expect('inline' in out).toBe(true);
    if ('inline' in out) {
      expect(out.inline).toBe(value);
    }
  });

  it('returns a ref for oversize values; preview is the head bytes', async () => {
    const head = 'HEAD-PREVIEW-XYZ';
    const value = head + 'A'.repeat(2048);
    const out = await maybeSpill(value, {
      inlineMaxBytes: 256,
      previewBytes: 16,
      mimetype: 'text/plain',
    });
    expect('inline' in out).toBe(false);
    const ref = out as LargeValueRef;
    expect(ref.kind).toBe('ref');
    expect(ref.sizeBytes).toBe(Buffer.byteLength(value, 'utf-8'));
    expect(ref.mimetype).toBe('text/plain');
    expect(ref.preview).toBe(head); // head 16 chars
    expect(ref.id).toMatch(/^[a-f0-9]+$/i);
    expect(ref.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe('fetchRef', () => {
  it('returns the spilled bytes', async () => {
    const value = 'B'.repeat(4096);
    const out = await maybeSpill(value, {
      inlineMaxBytes: 256,
      previewBytes: 64,
      mimetype: 'text/plain',
    });
    const ref = out as LargeValueRef;
    const fetched = await fetchRef(ref.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.mimetype).toBe('text/plain');
    expect(Buffer.from(fetched!.data).toString('utf-8')).toBe(value);
  });

  it('returns null for unknown id', async () => {
    const fetched = await fetchRef('deadbeef');
    expect(fetched).toBeNull();
  });

  it('rejects ids with path-traversal patterns', async () => {
    const fetched = await fetchRef('../etc/passwd');
    expect(fetched).toBeNull();
  });
});

describe('clearExpiredRefs', () => {
  it('removes refs whose expiresAt has passed', async () => {
    const value = 'C'.repeat(2048);
    const out = await maybeSpill(value, {
      inlineMaxBytes: 256,
      previewBytes: 16,
      mimetype: 'text/plain',
      ttlMs: -1, // already expired
    });
    const ref = out as LargeValueRef;

    // Body & meta exist before GC.
    expect(existsSync(join(scratch, ref.id))).toBe(true);
    expect(existsSync(join(scratch, `${ref.id}.meta.json`))).toBe(true);

    await clearExpiredRefs();

    // After GC, fetchRef should return null and the body file should be gone.
    expect(await fetchRef(ref.id)).toBeNull();
    expect(existsSync(join(scratch, ref.id))).toBe(false);
    expect(existsSync(join(scratch, `${ref.id}.meta.json`))).toBe(false);
  });
});

describe('clearSessionRefs', () => {
  it('removes only refs tagged with the given sessionId', async () => {
    const tagA = 'session-A';
    const tagB = 'session-B';

    const refA = await maybeSpill('A'.repeat(2048), {
      inlineMaxBytes: 256,
      mimetype: 'text/plain',
      sessionId: tagA,
    }) as LargeValueRef;
    const refB = await maybeSpill('B'.repeat(2048), {
      inlineMaxBytes: 256,
      mimetype: 'text/plain',
      sessionId: tagB,
    }) as LargeValueRef;

    await clearSessionRefs(tagA);

    expect(await fetchRef(refA.id)).toBeNull();
    expect(await fetchRef(refB.id)).not.toBeNull();
  });
});
