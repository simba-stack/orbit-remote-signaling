# Деплой сервера Orbit Remote на VPS (Ubuntu 22.04 / Debian 12)

Разворачивает сигнальный сервер + coturn (STUN/TURN) одной командой.

## 1. Подготовка сервера

```bash
sudo apt update && sudo apt -y upgrade
# Docker + compose plugin
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER     # перелогиниться после этого
```

## 2. Код

```bash
git clone https://github.com/<USERNAME>/<REPO>.git
cd <REPO>/server
cp .env.example .env
```

Отредактируйте `.env`:
- `EXTERNAL_IP` — публичный IP VPS (`curl ifconfig.me`).
- `TURN_REALM` — ваш домен или IP.
- `TURN_USERNAME` / `TURN_PASSWORD` — придумайте надёжные значения.

Также впишите в `turnserver.conf` пароль в строке `user=orbit:...` (или он будет
переопределён значением из docker-compose `--user`).

## 3. Firewall

```bash
sudo ufw allow 22/tcp
sudo ufw allow 8080/tcp           # сигнальный сервер (или проксируйте через 443)
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 5349/udp
sudo ufw allow 49160:49200/udp    # диапазон relay coturn
sudo ufw enable
```

## 4. Запуск

```bash
docker compose up -d
docker compose ps
docker compose logs -f signaling
```

Проверка:
```bash
curl http://localhost:8080/health
curl http://localhost:8080/ice-servers
```

## 5. HTTPS/WSS (рекомендуется)

WebRTC и `wss://` требуют TLS. Поставьте перед сигнальным сервером обратный прокси
(Caddy проще всего — авто-TLS):

```caddyfile
signal.example.com {
    reverse_proxy localhost:8080
}
```

После этого клиенты используют `wss://signal.example.com/ws`.

## 6. Проверка TURN

```bash
# с любой машины
docker run --rm instrumentisto/coturn turnutils_uclient -v -u orbit -w <PASSWORD> <EXTERNAL_IP>
```

## Обновление

```bash
git pull
docker compose up -d --build
```
