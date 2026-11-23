import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Russian political glossary covers the Russian 2000 scenario's government, parties and institutions", () => {
  const source = read("./politicalRussian.js");
  for (const phrase of [
    "Полупрезидентская федеративная республика",
    "Закрепить победу Владимира Путина на выборах в марте 2000 года",
    "Восстановить федеральную «вертикаль власти»",
    "Коммунистическая партия Российской Федерации (КПРФ)",
    "Содружество Независимых Государств (СНГ)",
    "Организация Объединённых Наций (ООН)",
    "Всемирная торговая организация (ВТО)",
  ]) {
    assert.ok(source.includes(phrase), `missing Russian political translation: ${phrase}`);
  }
});

test("Political overview does not hide translatable labels behind data-no-translate", () => {
  const source = read("../Game/GameUI/PoliticalOverview.jsx");
  assert.match(source, /<span data-no-translate>\{formatSupport\(party\.support\)\}<\/span> <span>support<\/span>/);
  assert.match(source, /russianPoliticalDescription\(goal\)/);
  assert.match(source, /russianPartyName\(party\.name\)/);
  assert.match(source, /russianPoliticalText\(institution\.name \|\| institution\.id\)/);
});
