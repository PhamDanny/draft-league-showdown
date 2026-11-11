// Sealed battle logs: AES-256-GCM with a key that never leaves data/keys.
// Logs with exact sets are only ever stored in this form until their series is final.
import crypto from 'node:crypto';
import { keys } from './config.ts';

export function seal(value: unknown): string {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', keys.seal, iv);
	const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
	return [iv, cipher.getAuthTag(), body].map(b => b.toString('base64')).join('.');
}

export function unseal<T = any>(sealed: string): T {
	const [iv, tag, body] = sealed.split('.').map(s => Buffer.from(s, 'base64'));
	const decipher = crypto.createDecipheriv('aes-256-gcm', keys.seal, iv);
	decipher.setAuthTag(tag);
	return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
}
