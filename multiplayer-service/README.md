# ВПИ №15 — Multiplayer service

Изолированный сетевой сервис, не импортирующий и не изменяющий основной игровой сервер.

## Railway
- Root Directory: `/multiplayer-service`
- Start Command: `npm start`
- Healthcheck Path: `/health`
- WebSocket: `wss://<домен>/ws`
- Опциональная переменная `ALLOWED_ORIGINS`: разрешённые origin через запятую.

## WebSocket JSON protocol
- `{"type":"create_room","name":"Игрок"}`
- `{"type":"join_room","code":"ABC234","name":"Игрок","reconnectToken":"..."}`
- `{"type":"set_country","countryId":"country-id"}`
- `{"type":"start_game","state":{}}`
- `{"type":"update_state","state":{}}`
- `{"type":"ping"}`

Создатель — ведущий; только ведущий начинает игру и публикует состояние. Участники выбирают страны в лобби. Токен повторного подключения возвращается при входе.

Пока комнаты хранятся в памяти процесса и теряются при перезапуске. Для долгоживущих сессий далее добавим Redis/PostgreSQL и интеграцию интерфейса игры.