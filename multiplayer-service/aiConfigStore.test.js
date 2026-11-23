import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AiConfigStore } from "./aiConfigStore.js";

const key = randomBytes(32).toString("base64");

test("AI configs survive a process restart and are encrypted at rest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vpi15-ai-config-"));
  const filePath = join(dir, "configs.enc.json");
  const config = {
    connections: [{ id: "primary", provider: "openai", apiKey: "secret-test-key" }],
    fallbackList: [{ id: "main", connectionId: "primary", model: "gpt-test" }],
    taskPicks: { diplomacy: "main" },
  };
  try {
    const first = new AiConfigStore({ filePath, encryptionKey: key });
    await first.ready;
    await first.set("ABC123", config);

    const stored = await readFile(filePath, "utf8");
    assert.equal(stored.includes("secret-test-key"), false);
    assert.equal(stored.includes("gpt-test"), false);

    const restarted = new AiConfigStore({ filePath, encryptionKey: key });
    await restarted.ready;
    assert.deepEqual(await restarted.get("ABC123"), config);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AI config store rejects a wrong encryption key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vpi15-ai-config-"));
  const filePath = join(dir, "configs.enc.json");
  try {
    const first = new AiConfigStore({ filePath, encryptionKey: key });
    await first.ready;
    await first.set("ABC123", { connections: [], fallbackList: [], taskPicks: {} });
    const wrongKey = randomBytes(32).toString("base64");
    const restarted = new AiConfigStore({ filePath, encryptionKey: wrongKey });
    await assert.rejects(restarted.ready);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleting an AI config is persisted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vpi15-ai-config-"));
  const filePath = join(dir, "configs.enc.json");
  try {
    const first = new AiConfigStore({ filePath, encryptionKey: key });
    await first.ready;
    await first.set("ABC123", { connections: [], fallbackList: [], taskPicks: {} });
    await first.delete("ABC123");
    const restarted = new AiConfigStore({ filePath, encryptionKey: key });
    await restarted.ready;
    assert.equal(await restarted.get("ABC123"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
