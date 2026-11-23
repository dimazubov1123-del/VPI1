/*! Political World — curated Russian names for common political and institutional records. */
import { translateLabel } from "./translator.js";

const keyOf = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");

const RU = new Map(Object.entries({
  "semi-presidential federal republic": "Полупрезидентская федеративная республика",
  "semi-presidential republic": "Полупрезидентская республика",
  "federal republic": "Федеративная республика",
  "federal parliamentary republic": "Федеративная парламентская республика",
  "parliamentary republic": "Парламентская республика",
  "presidential republic": "Президентская республика",
  "constitutional monarchy": "Конституционная монархия",
  "absolute monarchy": "Абсолютная монархия",
  "unitary parliamentary republic": "Унитарная парламентская республика",
  "consolidate putin's election victory path in march 2000": "Закрепить победу Владимира Путина на выборах в марте 2000 года",
  "restore the federal 'vertical of power' against regions and oligarchs": "Восстановить федеральную «вертикаль власти», ограничив влияние регионов и олигархов",
  "win the chechen campaign and reassert state authority": "Добиться победы в Чеченской кампании и восстановить государственную власть",
  "yedinstvo (unity)": "Единство",
  "kommunisticheskaya partiya rf (kprf)": "Коммунистическая партия Российской Федерации (КПРФ)",
  "otechestvo — vsya rossiya (ovr)": "Отечество — Вся Россия (ОВР)",
  "otechestvo - vsya rossiya (ovr)": "Отечество — Вся Россия (ОВР)",
  "soiuz pravykh sil (sps)": "Союз правых сил (СПС)",
  "liberalno-demokraticheskaya partiya rossii (ldpr)": "Либерально-демократическая партия России (ЛДПР)",
  "yabloko (yabloko)": "Яблоко",
  "vladimir putin": "Владимир Путин",
  "sergei shoigu": "Сергей Шойгу",
  "sergey shoigu": "Сергей Шойгу",
  "gennady zyuganov": "Геннадий Зюганов",
  "yuri luzhkov": "Юрий Лужков",
  "yevgeny primakov": "Евгений Примаков",
  "evgeny primakov": "Евгений Примаков",
  "anatoly chubais": "Анатолий Чубайс",
  "vladimir zhirinovsky": "Владимир Жириновский",
  "grigory yavlinsky": "Григорий Явлинский",
  "asia-pacific economic cooperation": "Азиатско-Тихоокеанское экономическое сотрудничество (АТЭС)",
  "commonwealth of independent states": "Содружество Независимых Государств (СНГ)",
  "council of europe": "Совет Европы",
  "group of eight": "Группа восьми (G8)",
  "international monetary fund": "Международный валютный фонд (МВФ)",
  "organization for security and co-operation in europe": "Организация по безопасности и сотрудничеству в Европе (ОБСЕ)",
  "organization for security and cooperation in europe": "Организация по безопасности и сотрудничеству в Европе (ОБСЕ)",
  "shanghai five": "Шанхайская пятёрка",
  "united nations": "Организация Объединённых Наций (ООН)",
  "world bank group": "Группа Всемирного банка",
  "world trade organization": "Всемирная торговая организация (ВТО)",
  "international_organization": "Международная организация",
  "economic_union": "Экономическое объединение",
  "member": "участник",
  "leader": "руководитель",
  "left": "вышел из организации",
  "withdrawn": "отозвал заявку",
  "expelled": "исключён",
  "pending": "на рассмотрении",
  "negotiating": "на переговорах",
  "pending-approval": "ожидает одобрения",
  "institution": "организация",
  "member / leader": "участник / руководитель",
  "observer": "наблюдатель",
  "candidate": "кандидат",
  "historical": "историческое членство",
  "former member": "бывший участник",
  "opposition": "Оппозиция",
  "ruling": "Правящая",
  "governing": "Правящая",
  "coalition": "Коалиция",
}));

export const russianPoliticalText = (value, { translateUnknown = false } = {}) => {
  const source = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!source) return source;
  if (typeof document !== "undefined" && document.documentElement?.lang?.toLowerCase().startsWith("ru")) {
    const translated = RU.get(keyOf(source));
    if (translated) return translated;
  }
  return translateUnknown ? translateLabel(source) : source;
};

export const russianPartyName = (name) => russianPoliticalText(name, { translateUnknown: true });
export const russianPoliticalDescription = (value) => russianPoliticalText(value, { translateUnknown: true });
