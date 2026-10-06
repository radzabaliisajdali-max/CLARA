import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
export const digest = (v: string) => createHash('sha256').update(v).digest('hex');
export const token = () => randomBytes(32).toString('hex');
export async function passwordHash(password: string) {
 const salt=randomBytes(16).toString('hex'); const hash=await derive(password,salt,64) as Buffer;
 return salt+':'+hash.toString('hex');
}
export async function verifyPassword(password: string, stored: string) {
 const [salt,hex]=stored.split(':'); const actual=await derive(password,salt,64) as Buffer;
 const expected=Buffer.from(hex,'hex'); return actual.length===expected.length && timingSafeEqual(actual,expected);
}
