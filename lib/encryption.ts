import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getKey(secretName = "NEXTAUTH_SECRET"): Buffer {
  const secret = process.env[secretName];
  if (!secret) throw new Error(`${secretName} is required for encryption`);
  return createHash("sha256").update(secret).digest();
}

function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    iv.toString("base64"),
    encrypted.toString("base64"),
    tag.toString("base64"),
  ].join(":");
}

function decryptWithKey(encoded: string, key: Buffer): string {
  const [ivB64, ciphertextB64, tagB64] = encoded.split(":");

  if (!ivB64 || !ciphertextB64 || !tagB64) {
    throw new Error("Invalid encrypted value");
  }

  const iv = Buffer.from(ivB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const tag = Buffer.from(tagB64, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

/** Encrypt legacy user-owned API keys with the existing application secret. */
export function encrypt(plaintext: string): string {
  return encryptWithKey(plaintext, getKey());
}

/** Decrypt legacy user-owned API keys with the existing application secret. */
export function decrypt(encoded: string): string {
  return decryptWithKey(encoded, getKey());
}

/** Encrypt provider credentials with a key independent from browser sessions. */
export function encryptCredential(plaintext: string): string {
  return encryptWithKey(plaintext, getKey("CREDENTIAL_ENCRYPTION_KEY"));
}

/** Decrypt provider credentials with the dedicated integration key. */
export function decryptCredential(encoded: string): string {
  return decryptWithKey(encoded, getKey("CREDENTIAL_ENCRYPTION_KEY"));
}
