# Orbit Remote — Signaling Server

WebRTC **сигнальный сервер** для Orbit Remote: регистрация устройств, хранение ID,
связывание агента и контроллера по ID + коду подключения, ретрансляция WebRTC-сигналов
(SDP/ICE) и логирование подключений. Медиапоток (экран, управление) идёт напрямую между
устройствами через WebRTC — через сервер проходят только служебные сообщения.

Это **отдельный проект**, разворачивается независимо от сайта, Android-агента и
Windows-клиента. На Railway деплоится сам сигнальный сервер (WebSocket/HTTP); coturn
(STUN/TURN) разворачивается на VPS через docker-compose, т.к. TURN требует публичный IP
и широкий диапазон UDP-портов.

## Структура

```
server/
├── src/
│   ├── signaling.js   # Чистое ядро протокола (реестр, сессии, маршрутизация) — без зависимостей
│   ├── server.js      # Транспорт: WebSocket (/ws) + HTTP (/health, /ice-servers)
│   └── config.js      # Конфиг из ENV (порт, ICE-серверы)
├── test/
│   └── signaling.test.js   # Юнит-тесты ядра (node --test)
├── coturn/
│   └── turnserver.conf     # Конфиг coturn (STUN/TURN)
├── docker-compose.yml      # VPS: сигнальный сервер + coturn
├── Dockerfile              # Образ сигнального сервера (используется Railway)
├── railway.json
├── .env.example
└── package.json
```

## Протокол (WebSocket `/ws`, JSON-сообщения)

При подключении сервер шлёт `welcome` с `connId` и `iceServers`.

Агент (Android):

```json
{ "type": "register", "role": "agent", "name": "Pixel 7", "platform": "android" }
// ← { "type": "registered", "deviceId": "123456789", "code": "456123" }
```

Повторное подключение — передать известный `deviceId`, код сохранится.

Контроллер (Windows):

```json
{ "type": "connect", "targetId": "123456789", "code": "456123" }
// ← { "type": "connected", "sessionId": "s1", "device": {...} }
// агенту уходит { "type": "peer-join", "sessionId": "s1", "role": "controller" }
```

Обмен WebRTC (в обе стороны, сервер просто ретранслирует `data` второму участнику):

```json
{ "type": "signal", "sessionId": "s1", "data": { "type": "offer", "sdp": "..." } }
{ "type": "signal", "sessionId": "s1", "data": { "candidate": "..." } }
```

Завершение: `{ "type": "hangup", "sessionId": "s1" }`. Heartbeat — `{ "type": "ping" }` → `pong`.

Ошибки: `{ "type": "error", "code": "not_found" | "bad_code" | "no_session" | ... }`.

## HTTP эндпоинты

| Метод | Путь            | Назначение                                  |
|-------|-----------------|---------------------------------------------|
| GET   | `/health`       | Статус + живая статистика (устройства, сессии) |
| GET   | `/ice-servers`  | ICE-конфиг (STUN/TURN) для клиентов          |

## Локальный запуск

```bash
cd server
npm install
npm start            # http://localhost:8080, ws://localhost:8080/ws
npm test             # юнит-тесты ядра
```

## Деплой на Railway (сигнальный сервер)

1. Запушить репозиторий на GitHub.
2. Railway → New Project → Deploy from GitHub repo → выбрать репозиторий.
3. Railway соберёт по `Dockerfile` (builder указан в `railway.json`).
4. Settings → Networking → Generate Domain.
5. Клиенты подключаются к `wss://<домен>/ws`. ICE берётся с `GET /ice-servers`.

Переменные окружения (Railway → Variables): задайте `TURN_URLS`, `TURN_USERNAME`,
`TURN_PASSWORD`, указывающие на ваш coturn на VPS — тогда сервер начнёт выдавать TURN
клиентам. Без них работает только STUN (P2P в нестрогих сетях).

## Деплой coturn + сервера на VPS (Ubuntu 22.04 / Debian 12)

См. `DEPLOY-VPS.md`. Кратко:

```bash
cp .env.example .env     # указать EXTERNAL_IP и TURN-секреты
docker compose up -d
```

Откройте порты: TCP/UDP 3478, 5349 и UDP 49160–49200 (диапазон relay).
