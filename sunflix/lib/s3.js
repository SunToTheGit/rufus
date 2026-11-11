'use strict';
// A small client for S3-compatible storage (Cloudflare R2, Backblaze B2, AWS S3…), enough
// for SunFlix: read, write and delete small objects, and hand the browser signed addresses
// so it can upload large videos straight to the bucket in parts. No dependencies.
const crypto = require('node:crypto');

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const stamp = (d) => d.toISOString().replace(/[-:]|\.\d{3}/g, ''); // 20240131T235959Z

class S3 {
  constructor({ endpoint, bucket, accessKeyId, secretAccessKey, region }) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.bucket = bucket || '';
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.region = region || 'auto';
  }

  _url(key) {
    const parts = [this.bucket, ...key.split('/')].filter(Boolean).map(enc);
    return new URL(`${this.endpoint}/${parts.join('/')}`);
  }

  _signature(date, toSign) {
    let key = `AWS4${this.secretAccessKey}`;
    for (const part of [date, this.region, 's3', 'aws4_request']) key = hmac(key, part);
    return hmac(key, toSign).toString('hex');
  }

  // An address that lets whoever holds it do one thing (e.g. PUT this object) for a while.
  presign(method, key, query = {}, expires = 3600, now = new Date()) {
    const url = this._url(key);
    const amzDate = stamp(now);
    const scope = `${amzDate.slice(0, 8)}/${this.region}/s3/aws4_request`;
    const all = {
      ...query,
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expires),
      'X-Amz-SignedHeaders': 'host',
    };
    const canonicalQuery = Object.keys(all).sort().map((k) => `${enc(k)}=${enc(all[k])}`).join('&');
    const request = [method, url.pathname, canonicalQuery, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(request)].join('\n');
    return `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${this._signature(amzDate.slice(0, 8), toSign)}`;
  }

  // A signed request made from here (the server side), for small bodies.
  async request(method, key, { query = {}, body = '', headers = {} } = {}) {
    const { url, headers: signed } = this.sign(method, key, { query, body, headers });
    return fetch(url, { method, headers: signed, body: method === 'GET' || method === 'DELETE' ? undefined : body, signal: AbortSignal.timeout(20000) });
  }

  // Works out the address and signed headers for a request, without sending it.
  sign(method, key, { query = {}, body = '', headers = {} } = {}, now = new Date()) {
    const url = this._url(key);
    const amzDate = stamp(now);
    const scope = `${amzDate.slice(0, 8)}/${this.region}/s3/aws4_request`;
    const payloadHash = sha256(body);
    const all = { ...headers, host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    const names = Object.keys(all).map((n) => n.toLowerCase()).sort();
    const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
    const canonicalQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
    const request = [method, url.pathname, canonicalQuery, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(request)].join('\n');
    const signature = this._signature(amzDate.slice(0, 8), toSign);
    delete lower.host; // fetch sets it
    lower.authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    return { url: `${url.origin}${url.pathname}${canonicalQuery ? `?${canonicalQuery}` : ''}`, headers: lower };
  }

  async _ok(res, what) {
    if (!res.ok) throw new Error(`Storage refused to ${what} (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return res;
  }

  // Text of an object, or null when it does not exist.
  async get(key) {
    const res = await this.request('GET', key);
    if (res.status === 404) return null;
    return (await this._ok(res, `read ${key}`)).text();
  }

  async put(key, body, contentType) {
    await this._ok(await this.request('PUT', key, { body, headers: { 'content-type': contentType } }), `write ${key}`);
  }

  async remove(key) {
    const res = await this.request('DELETE', key);
    if (res.status !== 404) await this._ok(res, `delete ${key}`);
  }

  // Large uploads go up in parts: start, upload each part to its own signed address, finish.
  async startUpload(key, contentType) {
    const res = await this._ok(await this.request('POST', key, { query: { uploads: '' }, headers: { 'content-type': contentType } }), 'start an upload');
    const m = /<UploadId>([^<]+)<\/UploadId>/.exec(await res.text());
    if (!m) throw new Error('Storage did not return an upload id.');
    return m[1];
  }

  partUrl(key, uploadId, partNumber) {
    return this.presign('PUT', key, { partNumber: String(partNumber), uploadId }, 6 * 3600);
  }

  async finishUpload(key, uploadId, parts) {
    const xml = `<CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${Number(p.n)}</PartNumber><ETag>${String(p.etag).replace(/[<>&]/g, '')}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
    const res = await this._ok(await this.request('POST', key, { query: { uploadId }, body: xml, headers: { 'content-type': 'application/xml' } }), 'finish the upload');
    const text = await res.text();
    if (/<Error>/.test(text)) throw new Error(`Storage could not finish the upload: ${text.slice(0, 200)}`);
  }

  async abortUpload(key, uploadId) {
    await this.request('DELETE', key, { query: { uploadId } }).catch(() => {});
  }
}

module.exports = { S3 };
