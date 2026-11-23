## Encrypted host AI settings

The multiplayer service stores host AI Connections, Fallback entries and task picks on the Railway volume at `/data/ai-configs.enc.json`, encrypted with AES-256-GCM. Players receive proxy markers only; provider API keys remain server-side.

Railway production variables:

- `AI_CONFIG_ENCRYPTION_KEY`: base64-encoded 32-byte random secret. Keep it private and back it up securely. Never commit it or share it with players.
- `AI_CONFIG_FILE`: optional; defaults to `/data/ai-configs.enc.json`.

The encryption key must remain unchanged across deployments. Losing or rotating it makes existing encrypted configurations unreadable; the host can re-enter the Connections in Settings → AI to create a new encrypted copy.

Run service tests with `npm test`.

---

# ВПИ №15 — Multiplayer service

Изолированный сетевой сервис для онлайн-кампаний Political Simulator: World Power. Одиночная кампания продолжает работать без сетевого соединения.

## Railway

- Root Directory: `/multiplayer-service`
- Start Command: `npm start`
- Healthcheck Path: `/health`
- WebSocket: `wss://<домен>/ws`
- Persistent Volume: `/data` (обязателен для восстановления комнат, сохранений, сценариев и ходов)
- Опциональная переменная `ALLOWED_ORIGINS`: разрешённые origin через запятую.

## Лобби и запуск

- `create_room` — создать комнату; создатель становится хостом.
- `join_room` — войти по коду или восстановить соединение по reconnect token.
- `set_country` — закрепить страну за игроком.
- `configure_lobby` — выбрать сценарий и параметры партии.
- `scenario_ready` — подтвердить, что клиент загрузил выбранный сценарий.
- `start_game` — начать партию; сервер проверяет готовность участников и сценария.
- Сценарий передаётся отдельным HTTP-пакетом и проверяется по SHA-256.

## Синхронизация ходов

1. В игре каждый участник нажимает «Готов».
2. Клиент отправляет `ready_for_turn` и очередь приказов своей страны.
3. Сервер переводит комнату в фазу `host_turn` только после готовности всех игроков и передаёт хосту собранные приказы через `all_players_ready`.
4. Только хост рассчитывает следующий ход.
5. Хост публикует пакет состояния через `POST /turn/:code`. Сервер сохраняет его на volume и возвращает SHA-256.
6. Хост отправляет `commit_turn`; сервер фиксирует номер хода и hash и рассылает `turn_committed`.
7. Остальные клиенты загружают пакет через `GET /turn/:code`, проверяют hash и обновляют локальные документы кампании.

`commit_turn` отклоняется, пока не готовы все игроки. Пакет хода содержит игровое состояние, события, мир и очереди приказов. Максимальный размер пакета — 100 MiB.

## Дипломатия игроков

- `diplomacy_message` направляет сообщение от страны отправителя стране другого подключённого игрока.
- `diplomacy_history` возвращает историю переговоров для пары стран.
- Если страна не закреплена за подключённым игроком, обычная дипломатия с ИИ остаётся доступной.
- Сообщения между игроками сохраняются вместе с комнатой и восстанавливаются после перезапуска.

## Восстановление

- Состояние комнат атомарно записывается в `/data/rooms.json`.
- Сохранения кампаний находятся в `/data/saves.json`; загруженные сценарии — в `/data/scenarios`; снимки ходов — в `/data/turns`.
- При запуске сервер восстанавливает комнаты, reconnect tokens, выбранные страны, сценарий и последний подтверждённый ход.
- После восстановления у участников есть до 7 дней, чтобы вернуться в комнату.
- Потерянное WebSocket-соединение автоматически восстанавливается клиентом.

## Важное

Сетевой режим использует авторитетный расчёт хоста и синхронизирует подтверждённые снимки хода. Перед публичным релизом всё ещё требуется полноценная проверка в нескольких браузерах/на нескольких компьютерах: создание и восстановление комнаты, загрузка сценария, запуск, готовность, несколько последовательных ходов, отключение/возврат игрока и переговоры между игроками. Не считать сетевой режим полностью проверенным только по успешному healthcheck Railway.

CI запускает отдельный набор тестов multiplayer-service вместе с основным набором тестов репозитория.
