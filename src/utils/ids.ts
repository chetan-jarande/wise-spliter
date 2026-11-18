/** Bare RFC 4122 v4 UUID. Falls back to getRandomValues where randomUUID needs a secure context. */
export function newUuid(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Collision-free client id (M7). */
export function newId(prefix: string): string {
  return `${prefix}_${newUuid()}`;
}

/** Uppercase hex from `bytes` of crypto randomness (8 bytes = 64 bits). */
export function randomHex(bytes: number): string {
  return [...globalThis.crypto.getRandomValues(new Uint8Array(bytes))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}
