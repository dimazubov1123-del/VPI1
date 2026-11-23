import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "@babel/parser";

test("multiplayer AI integration JSX modules parse", async () => {
  for (const path of ["src/Game/AI/main.jsx", "src/Game/GameUI/main.jsx"]) {
    const source = await readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
    assert.doesNotThrow(() => parse(source, { sourceType: "module", plugins: ["jsx"] }), path);
  }
});
