/**
 * Content-Encoding support. The proxy advertises exactly the encodings it can
 * decode, so it can always inspect and rewrite HTML/CSS bodies.
 */
import zlib from 'node:zlib';
import { Transform, PassThrough } from 'node:stream';

const HAS_ZSTD = typeof zlib.createZstdDecompress === 'function';

/** Value for the upstream Accept-Encoding header. */
export const ACCEPT_ENCODING = HAS_ZSTD ? 'gzip, deflate, br, zstd' : 'gzip, deflate, br';

/** Normalise a Content-Encoding header value to a single canonical token. */
export function normalizeEncoding(value) {
  if (!value) return 'identity';
  const enc = String(value).trim().toLowerCase();
  if (enc === '' || enc === 'identity' || enc === 'none') return 'identity';
  if (enc === 'x-gzip') return 'gzip';
  return enc;
}

export function canDecode(encoding) {
  const enc = normalizeEncoding(encoding);
  return enc === 'identity' || enc === 'gzip' || enc === 'deflate' || enc === 'br' || (enc === 'zstd' && HAS_ZSTD);
}

/**
 * Deflate bodies may or may not carry the zlib wrapper (some servers send a
 * raw stream). Peek at the first bytes to choose the right decoder.
 */
class AutoInflate extends Transform {
  constructor() {
    super();
    this.inner = null;
  }

  _pick(first, second) {
    const zlibWrapped = (first & 0x0f) === 8 && ((first << 8) | second) % 31 === 0;
    this.inner = zlibWrapped ? zlib.createInflate() : zlib.createInflateRaw();
    this.inner.on('data', (d) => this.push(d));
    this.inner.on('error', (e) => this.destroy(e));
  }

  _transform(chunk, _enc, cb) {
    if (!this.inner) {
      if (chunk.length === 0) return cb();
      this._pick(chunk[0], chunk.length > 1 ? chunk[1] : 0);
    }
    this.inner.write(chunk, cb);
  }

  _flush(cb) {
    if (!this.inner) return cb();
    this.inner.once('end', cb);
    this.inner.end();
  }
}

/**
 * @param {string|undefined} encoding Content-Encoding value
 * @returns {import('node:stream').Duplex|null} a decoding transform, or null for identity
 */
export function createDecoder(encoding) {
  switch (normalizeEncoding(encoding)) {
    case 'identity':
      return null;
    case 'gzip':
      return zlib.createGunzip();
    case 'deflate':
      return new AutoInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    case 'zstd':
      return HAS_ZSTD ? zlib.createZstdDecompress() : null;
    default:
      return null;
  }
}

/** Does the client's Accept-Encoding header accept the given encoding? */
export function clientAccepts(acceptEncodingHeader, encoding) {
  const enc = normalizeEncoding(encoding);
  if (enc === 'identity') return true;
  if (!acceptEncodingHeader) return false;
  return String(acceptEncodingHeader)
    .toLowerCase()
    .split(',')
    .map((s) => s.trim().split(';')[0].trim())
    .some((token) => token === enc || (enc === 'gzip' && token === 'x-gzip'));
}

export { PassThrough };
