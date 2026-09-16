/**
 * Stream helpers enforcing size limits.
 */
import { Transform } from 'node:stream';
import { ResponseTooLargeError } from '../errors.js';

/**
 * A pass-through transform that counts bytes and fails the stream once more
 * than `limit` bytes have flowed through it.
 */
export class ByteLimit extends Transform {
  /**
   * @param {number} limit maximum number of bytes allowed
   * @param {() => Error} [makeError] factory for the error raised on overflow
   */
  constructor(limit, makeError = () => new ResponseTooLargeError()) {
    super();
    this.limit = limit;
    this.makeError = makeError;
    this.bytes = 0;
  }

  _transform(chunk, _encoding, callback) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.bytes += buf.length;
    if (this.bytes > this.limit) {
      callback(this.makeError());
      return;
    }
    callback(null, buf);
  }
}

/**
 * Collect a readable stream into a Buffer, rejecting once it exceeds `limit`.
 * @param {import('node:stream').Readable} stream
 * @param {number} limit
 * @param {() => Error} [makeError]
 * @returns {Promise<Buffer>}
 */
export function collect(stream, limit, makeError = () => new ResponseTooLargeError()) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      if (err) reject(err);
      else resolve(value);
    };
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = makeError();
        stream.destroy(err);
        finish(err);
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', (err) => finish(err));
    stream.on('end', () => finish(null, Buffer.concat(chunks)));
  });
}
