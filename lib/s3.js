'use strict';
/*
 * Cliente S3 mínimo (firma AWS SigV4) para el almacenamiento en la nube de Neon.
 * Sin dependencias: usa fetch y crypto de Node.
 */
const crypto = require('crypto');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// Codificación estricta de RFC 3986 que exige SigV4.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encKey = (key) => String(key).split('/').map(enc).join('/');

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => String(s).replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return XML_ENT[e] ?? m;
});
const tag = (xml, name) => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml); return m ? unxml(m[1]) : null; };
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);

// Máximo de peticiones simultáneas al almacenamiento por instancia (el resto espera su turno).
const slots = {
  max: 12,
  busy: 0,
  queue: [],
  acquire() {
    if (this.busy < this.max) { this.busy++; return Promise.resolve(); }
    return new Promise((r) => this.queue.push(r));
  },
  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.busy--;
  },
};

class S3Error extends Error {
  constructor(status, code, message) {
    super(message || code || `S3 ${status}`);
    this.s3Status = status;
    this.code = code;
  }
}

class S3 {
  constructor({ endpoint, region, accessKeyId, secretAccessKey, bucket }) {
    this.endpoint = String(endpoint).replace(/\/+$/, '');
    this.host = new URL(this.endpoint).host;
    this.region = region || 'us-east-1';
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.bucket = bucket;
  }

  static fromEnv(bucket) {
    return new S3({
      endpoint: process.env.AWS_ENDPOINT_URL_S3,
      region: process.env.AWS_REGION,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      bucket,
    });
  }

  signingKey(date) {
    return hmac(hmac(hmac(hmac(`AWS4${this.secretAccessKey}`, date), this.region), 's3'), 'aws4_request');
  }

  canonicalQuery(query) {
    return Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [enc(k), enc(String(v))])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`).join('&');
  }

  path(key) {
    return `/${this.bucket}${key === undefined || key === null ? '' : `/${encKey(key)}`}`;
  }

  // Petición firmada. body: Buffer | string | ReadableStream | undefined.
  async request(method, key, { query = {}, headers = {}, body, ok = [200, 204, 206] } = {}) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const payloadHash = typeof body === 'string' || Buffer.isBuffer(body) ? sha256(body) : body ? 'UNSIGNED-PAYLOAD' : sha256('');
    const h = { ...headers, host: this.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
    const names = Object.keys(h).map((k) => k.toLowerCase()).sort();
    const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
    const signedHeaders = names.join(';');
    const canonical = [method, this.path(key), this.canonicalQuery(query), names.map((n) => `${n}:${lower[n]}\n`).join(''), signedHeaders, payloadHash].join('\n');
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const signature = crypto.createHmac('sha256', this.signingKey(date)).update(toSign).digest('hex');
    delete lower.host;
    lower.authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const qs = this.canonicalQuery(query);
    const init = { method, headers: lower, body };
    if (body && typeof body.getReader === 'function') init.duplex = 'half';
    const retryable = !(body && typeof body.getReader === 'function'); // un flujo no se puede volver a enviar
    // Espera creciente con algo de azar: el almacenamiento limita las peticiones por segundo (503 SlowDown).
    const backoff = (attempt) => new Promise((r) => setTimeout(r, Math.min(4000, 250 * 2 ** attempt) * (0.5 + Math.random())));
    let res;
    for (let attempt = 0; ; attempt++) {
      await slots.acquire();
      try {
        res = await fetch(`${this.endpoint}${this.path(key)}${qs ? `?${qs}` : ''}`, init);
      } catch (err) {
        if (retryable && attempt < 3) { await backoff(attempt); continue; }
        throw new S3Error(503, 'NetworkError', `No se pudo conectar con el almacenamiento en la nube: ${err.cause?.message || err.message}`);
      } finally {
        slots.release();
      }
      if (res.status >= 500 && retryable && attempt < 6) { await res.arrayBuffer().catch(() => {}); await backoff(attempt); continue; }
      break;
    }
    if (!ok.includes(res.status)) {
      const text = method === 'HEAD' ? '' : await res.text().catch(() => '');
      throw new S3Error(res.status, tag(text, 'Code') || (res.status === 404 ? 'NotFound' : 'Error'), tag(text, 'Message') || `Almacenamiento en la nube: error ${res.status}`);
    }
    return res;
  }

  // URL firmada (GET de descarga o PUT de un fragmento) para usar directamente desde el navegador.
  presign(method, key, { expires = 3600, query = {} } = {}) {
    const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const q = {
      ...query,
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expires),
      'X-Amz-SignedHeaders': 'host',
    };
    const canonical = [method, this.path(key), this.canonicalQuery(q), `host:${this.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const signature = crypto.createHmac('sha256', this.signingKey(date)).update(toSign).digest('hex');
    return `${this.endpoint}${this.path(key)}?${this.canonicalQuery(q)}&X-Amz-Signature=${signature}`;
  }

  // ── Objetos
  async head(key) {
    try {
      const r = await this.request('HEAD', key);
      return { size: Number(r.headers.get('content-length')), mtime: Date.parse(r.headers.get('last-modified')) || Date.now(), etag: r.headers.get('etag') };
    } catch (err) {
      if (err.s3Status === 404 || err.s3Status === 403) return null;
      throw err;
    }
  }

  async get(key, start, end) {
    const headers = start !== undefined ? { range: `bytes=${start}-${end ?? ''}` } : {};
    return this.request('GET', key, { headers });
  }

  async getBuffer(key, start, end) {
    return Buffer.from(await (await this.get(key, start, end)).arrayBuffer());
  }

  async put(key, body, contentType) {
    await this.request('PUT', key, { body: body ?? Buffer.alloc(0), headers: contentType ? { 'content-type': contentType } : {} });
  }

  async del(key) {
    await this.request('DELETE', key, { ok: [200, 204, 404] });
  }

  async delMany(keys) {
    for (let i = 0; i < keys.length; i += 1000) {
      const part = keys.slice(i, i + 1000);
      const xml = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${part.map((k) => `<Object><Key>${k.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Key></Object>`).join('')}</Delete>`;
      const md5 = crypto.createHash('md5').update(xml).digest('base64');
      await this.request('POST', null, { query: { delete: '' }, body: xml, headers: { 'content-md5': md5, 'content-type': 'application/xml' } });
    }
  }

  async copy(fromKey, toKey) {
    await this.request('PUT', toKey, { headers: { 'x-amz-copy-source': `/${this.bucket}/${encKey(fromKey)}` } });
  }

  // Lista una "carpeta" (con delimitador) o todo un prefijo (sin delimitador).
  async list(prefix, { delimiter, limit = Infinity } = {}) {
    const objects = [];
    const prefixes = [];
    let token;
    do {
      const r = await this.request('GET', null, { query: { 'list-type': '2', prefix, delimiter, 'continuation-token': token, 'max-keys': '1000' } });
      const xml = await r.text();
      for (const c of tags(xml, 'Contents')) {
        objects.push({ key: tag(c, 'Key'), size: Number(tag(c, 'Size')) || 0, mtime: Date.parse(tag(c, 'LastModified')) || 0 });
      }
      for (const p of tags(xml, 'CommonPrefixes')) prefixes.push(tag(p, 'Prefix'));
      token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : null;
    } while (token && objects.length < limit);
    return { objects, prefixes };
  }

  // ── Subidas multiparte
  async createMultipart(key, contentType) {
    const r = await this.request('POST', key, { query: { uploads: '' }, headers: contentType ? { 'content-type': contentType } : {} });
    return tag(await r.text(), 'UploadId');
  }

  async listParts(key, uploadId) {
    const parts = [];
    let marker;
    do {
      const r = await this.request('GET', key, { query: { uploadId, 'part-number-marker': marker } });
      const xml = await r.text();
      for (const p of tags(xml, 'Part')) parts.push({ n: Number(tag(p, 'PartNumber')), etag: tag(p, 'ETag'), size: Number(tag(p, 'Size')) });
      marker = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextPartNumberMarker') : null;
    } while (marker);
    return parts.sort((a, b) => a.n - b.n);
  }

  async completeMultipart(key, uploadId, parts) {
    const xml = `<CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${p.etag.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
    const r = await this.request('POST', key, { query: { uploadId }, body: xml, headers: { 'content-type': 'application/xml' } });
    const text = await r.text();
    if (/<Error>/.test(text)) throw new S3Error(500, tag(text, 'Code'), tag(text, 'Message'));
  }

  async abortMultipart(key, uploadId) {
    await this.request('DELETE', key, { query: { uploadId }, ok: [200, 204, 404] });
  }

  async putCors(rules) {
    const xml = `<CORSConfiguration>${rules.map((r) => `<CORSRule>${r.origins.map((o) => `<AllowedOrigin>${o}</AllowedOrigin>`).join('')}${r.methods.map((m) => `<AllowedMethod>${m}</AllowedMethod>`).join('')}${(r.headers || []).map((x) => `<AllowedHeader>${x}</AllowedHeader>`).join('')}${(r.expose || []).map((x) => `<ExposeHeader>${x}</ExposeHeader>`).join('')}<MaxAgeSeconds>${r.maxAge || 3600}</MaxAgeSeconds></CORSRule>`).join('')}</CORSConfiguration>`;
    const md5 = crypto.createHash('md5').update(xml).digest('base64');
    await this.request('PUT', null, { query: { cors: '' }, body: xml, headers: { 'content-md5': md5, 'content-type': 'application/xml' } });
  }
}

module.exports = { S3, S3Error };
