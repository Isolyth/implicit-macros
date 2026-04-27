// AES-GCM at-rest encryption for the API key.
//
// The encryption key is a 32-byte random value generated on first use and
// kept in the renderer's localStorage. localStorage lives in Electron's
// per-app data directory (not in the vault), so it never travels with the
// vault — `data.json` ends up holding only ciphertext.
//
// Threat model: protect against accidental disclosure (vault sync, cloud
// backups, screenshots of `data.json`, casual inspection of synced files).
// NOT a defense against an attacker with full read access to the device's
// app data — they get the key, and `data.json` together with the key is
// trivially decryptable. For real OS-keychain encryption we'd need
// Electron `safeStorage`, which Obsidian doesn't expose to plugin code.

const KEY_STORAGE = 'implicitMacrosKey';
const KEY_BITS = 256;
const IV_BYTES = 12;

export interface EncryptedBlob {
  iv: string; // base64
  ct: string; // base64 (ciphertext + 16-byte AES-GCM auth tag)
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let cachedKey: CryptoKey | null = null;

async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  let raw = localStorage.getItem(KEY_STORAGE);
  let bytes: Uint8Array;
  if (!raw) {
    bytes = crypto.getRandomValues(new Uint8Array(KEY_BITS / 8));
    localStorage.setItem(KEY_STORAGE, toBase64(bytes));
  } else {
    bytes = fromBase64(raw);
  }
  cachedKey = await crypto.subtle.importKey(
    'raw',
    bytes as BufferSource,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
  return cachedKey;
}

export async function encryptString(plain: string): Promise<EncryptedBlob> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plain) as BufferSource,
  );
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

// Returns the plaintext on success, or null if the blob can't be decrypted
// on this device (key was rotated / vault was copied to a new device).
export async function decryptString(blob: EncryptedBlob): Promise<string | null> {
  try {
    const key = await getKey();
    const iv = fromBase64(blob.iv);
    const ct = fromBase64(blob.ct);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      ct as BufferSource,
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
