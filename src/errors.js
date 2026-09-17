/**
 * Typed errors. Each carries an HTTP status and a message that is safe to
 * show to end users. Internal details (stack traces, upstream error text,
 * resolved addresses) are only ever written to the server log.
 */

export class ProxyError extends Error {
  /**
   * @param {string} code    stable machine-readable code
   * @param {number} status  HTTP status to send to the client
   * @param {string} message user-safe message
   * @param {object} [extra] extra fields for the error page (never secrets)
   */
  constructor(code, status, message, extra = {}) {
    super(message);
    this.name = 'ProxyError';
    this.code = code;
    this.status = status;
    this.extra = extra;
    this.expose = true;
  }
}

export class InvalidUrlError extends ProxyError {
  constructor(message = 'That does not look like a valid web address.') {
    super('INVALID_URL', 400, message);
  }
}

export class UnsupportedProtocolError extends ProxyError {
  constructor(protocol) {
    super('UNSUPPORTED_PROTOCOL', 400, `Only http:// and https:// addresses are supported${protocol ? ` (got ${protocol})` : ''}.`);
  }
}

export class DomainNotAllowedError extends ProxyError {
  constructor(hostname, extra = {}) {
    super('DOMAIN_NOT_ALLOWED', 403, `The site "${hostname}" is not on this proxy's list of authorized websites.`, { hostname, ...extra });
  }
}

/** The destination is inside the authorized scope but an administrator blacklisted it. */
export class DomainBlockedError extends ProxyError {
  constructor(hostname, extra = {}) {
    // Deliberately generic: no reason, no rule details.
    super('DOMAIN_BLACKLISTED', 403, 'The administrator has blocked this website.', { hostname, ...extra });
  }
}

export class BlockedAddressError extends ProxyError {
  constructor(hostname) {
    // Deliberately does not reveal which address was resolved.
    super('BLOCKED_ADDRESS', 403, `The site "${hostname}" resolves to an address this proxy is not permitted to reach.`, { hostname });
  }
}

export class UpstreamError extends ProxyError {
  constructor(message = 'The website could not be reached.', code = 'UPSTREAM_ERROR', status = 502) {
    super(code, status, message);
  }
}

export class UpstreamTimeoutError extends UpstreamError {
  constructor() {
    super('The website took too long to respond.', 'UPSTREAM_TIMEOUT', 504);
  }
}

export class ResponseTooLargeError extends UpstreamError {
  constructor() {
    super('The response from the website is larger than this proxy allows.', 'RESPONSE_TOO_LARGE', 502);
  }
}

export class RequestTooLargeError extends ProxyError {
  constructor() {
    super('REQUEST_TOO_LARGE', 413, 'The request body is larger than this proxy allows.');
  }
}

export class TooManyRequestsError extends ProxyError {
  constructor(message = 'Too many requests. Please slow down and try again shortly.') {
    super('RATE_LIMITED', 429, message);
  }
}

export class ServiceBusyError extends ProxyError {
  constructor() {
    super('BUSY', 503, 'The proxy is busy right now. Please try again in a moment.');
  }
}

/** Errors thrown by the custom DNS lookup (never shown verbatim). */
export class LookupBlockedError extends Error {
  constructor(hostname, address) {
    super(`lookup blocked: ${hostname} -> ${address}`);
    this.name = 'LookupBlockedError';
    this.code = 'EBLOCKED';
    this.hostname = hostname;
    this.address = address;
  }
}
