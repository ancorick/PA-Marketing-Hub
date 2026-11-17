// Uploaded images: local disk normally, Netlify Blobs when serverless.
import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR, SERVERLESS } from '../config.js';

const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const safe = (name) => path.basename(String(name));
async function blobStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: 'marketing-hub-uploads', consistency: 'strong' });
}

export async function saveUpload(name, buf) {
  if (SERVERLESS) await (await blobStore()).set(safe(name), buf, { metadata: { size: buf.length } });
  else fs.writeFileSync(path.join(UPLOAD_DIR, safe(name)), buf);
}

export async function readUpload(name) {
  const n = safe(name);
  const type = TYPES[n.split('.').pop()] || 'application/octet-stream';
  if (SERVERLESS) {
    const data = await (await blobStore()).get(n, { type: 'arrayBuffer' });
    return data ? { type, body: Buffer.from(data) } : null;
  }
  const p = path.join(UPLOAD_DIR, n);
  return fs.existsSync(p) ? { type, body: fs.readFileSync(p) } : null;
}

export async function uploadSize(name) {
  const n = safe(name);
  if (SERVERLESS) return (await (await blobStore()).getMetadata(n))?.metadata?.size ?? null;
  const p = path.join(UPLOAD_DIR, n);
  return fs.existsSync(p) ? fs.statSync(p).size : null;
}
