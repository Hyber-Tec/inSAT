// Symmetric encryption for secrets at rest (institution LLM API keys).
// AES-256-GCM with a 32-byte key derived from config.encryptionKey. The stored
// blob is base64(iv || authTag || ciphertext).

import crypto from 'node:crypto';
import { config } from './config.js';

const KEY = crypto.createHash('sha256').update(config.encryptionKey).digest();

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decrypt(blob) {
  try {
    const raw = Buffer.from(blob, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null; // wrong key / corrupt blob
  }
}
