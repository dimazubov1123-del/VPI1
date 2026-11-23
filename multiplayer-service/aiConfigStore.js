import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const ALGORITHM = "aes-256-gcm";

export class AiConfigStore {
  constructor({
    filePath = process.env.AI_CONFIG_FILE || "/data/ai-configs.enc.json",
    encryptionKey = process.env.AI_CONFIG_ENCRYPTION_KEY || "",
  } = {}) {
    this.filePath = filePath;
    this.key = Buffer.from(String(encryptionKey), "base64");
    if (this.key.length !== 32) {
      throw new Error("AI_CONFIG_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
    }
    this.configs = new Map();
    this.writeQueue = Promise.resolve();
    this.ready = this.#load();
  }

  async #load() {
    await mkdir(dirname(this.filePath), { recursive: true });
    let raw;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    const envelope = JSON.parse(raw);
    if (envelope?.version !== 1 || !envelope.iv || !envelope.tag || !envelope.data) {
      throw new Error("AI_CONFIG_STORE_FORMAT_INVALID");
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const entries = JSON.parse(plaintext);
    if (!Array.isArray(entries)) throw new Error("AI_CONFIG_STORE_FORMAT_INVALID");
    this.configs = new Map(entries.filter((entry) =>
      Array.isArray(entry) && typeof entry[0] === "string" && entry[1] && typeof entry[1] === "object"
    ));
  }

  async #persist() {
    const plaintext = JSON.stringify([...this.configs.entries()]);
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const envelope = JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64"),
    });
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temp = this.filePath + ".tmp";
      await writeFile(temp, envelope, { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.filePath);
    });
    await this.writeQueue;
  }

  async get(code) {
    await this.ready;
    return this.configs.get(String(code)) || null;
  }

  async set(code, config) {
    await this.ready;
    const key = String(code);
    const previous = this.configs.get(key);
    if (previous && JSON.stringify(previous) === JSON.stringify(config)) return false;
    this.configs.set(key, config);
    try {
      await this.#persist();
    } catch (error) {
      if (previous) this.configs.set(key, previous);
      else this.configs.delete(key);
      throw error;
    }
    return true;
  }

  async delete(code) {
    await this.ready;
    const key = String(code);
    if (!this.configs.has(key)) return false;
    const previous = this.configs.get(key);
    this.configs.delete(key);
    try {
      await this.#persist();
    } catch (error) {
      this.configs.set(key, previous);
      throw error;
    }
    return true;
  }
}
