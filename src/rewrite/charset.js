/**
 * Character-set detection and streaming decoding for text bodies.
 *
 * Priority: BOM → Content-Type charset → `<meta charset>` in the first 1024
 * bytes → UTF-8. Output is always UTF-8 (the rewriters declare it).
 */
import { Transform } from 'node:stream';

const META_CHARSET_RE = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9._:-]+)/i;
const SNIFF_BYTES = 1024;

/** Extract the charset parameter of a Content-Type header, if any. */
export function charsetFromContentType(contentType) {
  if (!contentType) return null;
  const m = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return m ? m[1].toLowerCase() : null;
}

/** Is the label understood by TextDecoder? */
export function isSupportedCharset(label) {
  if (!label) return false;
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide the charset of an HTML document given its first bytes.
 * @param {Buffer} head first bytes of the body
 * @param {string|null} headerCharset charset from Content-Type
 */
export function sniffHtmlCharset(head, headerCharset) {
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return 'utf-8';
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return 'utf-16be';
  if (isSupportedCharset(headerCharset)) return headerCharset;
  const m = META_CHARSET_RE.exec(head.subarray(0, SNIFF_BYTES).toString('latin1'));
  if (m && isSupportedCharset(m[1])) return m[1].toLowerCase();
  return 'utf-8';
}

/**
 * Bytes-in → string-out transform. Buffers up to 1024 bytes before deciding
 * the charset (only when it has to sniff) so multi-byte sequences are decoded
 * correctly across chunk boundaries.
 */
export class DecodeStream extends Transform {
  /**
   * @param {object} opts
   * @param {string|null} opts.headerCharset charset from Content-Type
   * @param {boolean} [opts.sniff] look for <meta charset> when the header has none
   */
  constructor({ headerCharset, sniff = true }) {
    super({ readableObjectMode: false, decodeStrings: true, encoding: 'utf8' });
    this.headerCharset = headerCharset;
    this.sniff = sniff;
    this.decoder = null;
    this.pending = [];
    this.pendingBytes = 0;
    this.charset = null;
  }

  _start(head) {
    this.charset = this.sniff ? sniffHtmlCharset(head, this.headerCharset) : isSupportedCharset(this.headerCharset) ? this.headerCharset : 'utf-8';
    this.decoder = new TextDecoder(this.charset, { fatal: false, ignoreBOM: false });
    const text = this.decoder.decode(head, { stream: true });
    if (text) this.push(text);
  }

  _transform(chunk, _enc, cb) {
    if (this.decoder) {
      const text = this.decoder.decode(chunk, { stream: true });
      if (text) this.push(text);
      return cb();
    }
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes >= SNIFF_BYTES || !this.sniff) {
      this._start(Buffer.concat(this.pending));
      this.pending = [];
    }
    cb();
  }

  _flush(cb) {
    if (!this.decoder) this._start(Buffer.concat(this.pending));
    const tail = this.decoder.decode();
    if (tail) this.push(tail);
    cb();
  }
}

/** Decode a complete buffer with the given charset (falls back to UTF-8). */
export function decodeBuffer(buf, charset) {
  const label = isSupportedCharset(charset) ? charset : 'utf-8';
  return new TextDecoder(label, { fatal: false }).decode(buf);
}
