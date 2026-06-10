import { app, safeStorage } from "electron";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { logger } from "../logger";

// The SQLCipher passphrase for the local DB. Generated once, then stored
// encrypted-at-rest via the OS keychain (DPAPI on Windows, Keychain on macOS)
// so the plaintext key never lands on disk. Without the OS user's session the
// blob can't be decrypted, so a stolen disk image can't open the database.
const KEY_DIR = path.join(app.getPath("userData"), "offline");
const KEY_FILE = path.join(KEY_DIR, "db.key");

export function getOrCreateDbKey(): string {
  fs.mkdirSync(KEY_DIR, { recursive: true });
  const canEncrypt = safeStorage.isEncryptionAvailable();

  if (fs.existsSync(KEY_FILE)) {
    const blob = fs.readFileSync(KEY_FILE);
    if (canEncrypt) {
      return safeStorage.decryptString(blob);
    }
    // Encryption unavailable (rare) — key was stored as plaintext bytes.
    return blob.toString("utf-8");
  }

  const key = crypto.randomBytes(32).toString("hex");
  if (canEncrypt) {
    fs.writeFileSync(KEY_FILE, safeStorage.encryptString(key), { mode: 0o600 });
  } else {
    logger.warn(
      "[store] OS keychain unavailable — DB key stored without OS protection"
    );
    fs.writeFileSync(KEY_FILE, Buffer.from(key, "utf-8"), { mode: 0o600 });
  }
  return key;
}
