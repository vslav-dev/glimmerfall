# Деплой Glimmerfall на gf.vslav.dev — runbook

Схема: push в `release` → GitHub Actions (проверки, тесты, сборка) → тарбол по `scp` на vps-31 (`31.58.137.7`, сервер MegaApp) → распаковка в `/var/www/glimmerfall/releases/<время>-<sha>` → атомарное переключение симлинка `current` → nginx отдаёт статику на `gf.vslav.dev`. Хранятся последние 3 релиза.

Файлы в репо:
- `.github/workflows/deploy.yml` — пайплайн (триггер: push в `release` + ручной запуск)
- `deploy/activate.sh` — выполняется на сервере через `ssh` (на сервере не хранится)
- `deploy/nginx/gf.vslav.dev.conf` — конфиг nginx

## 1. DNS (Cloudflare, зона `vslav.dev`)

- DNS → Records → Add record:
  - Type: `A`
  - Name: `gf`
  - IPv4: `31.58.137.7`
  - Proxy status: **DNS only** (серое облако) — иначе Let's Encrypt не выпустит сертификат, как у `app`/`test`
  - TTL: Auto
- Проверка (через 1–5 минут): `dig +short gf.vslav.dev` → `31.58.137.7`

## 2. Сервер vps-31 (после DNS)

- Папка: `mkdir -p /var/www/glimmerfall/releases && chown -R www-data:www-data /var/www/glimmerfall`
- Сертификат: `certbot certonly --nginx -d gf.vslav.dev` (продление — общий `certbot.timer`)
- Конфиг: содержимое `deploy/nginx/gf.vslav.dev.conf` → `/etc/nginx/sites-available/glimmerfall`; `ln -s /etc/nginx/sites-available/glimmerfall /etc/nginx/sites-enabled/glimmerfall`
- Применить: `nginx -t && systemctl reload nginx`
- Ключ деплоя: отдельный `github-actions-glimmerfall` (ed25519) — публичная часть дописывается в `/root/.ssh/authorized_keys`

До первого деплоя `current` нет — домен отвечает ошибкой, это нормально.

## 3. GitHub

- Репозиторий `glimmerfall` (private), ветка по умолчанию `release`
- Settings → Environments → `VPS_31` → Secrets:
  - `SSH_KEY` — приватный ключ `github-actions-glimmerfall`
  - `HOST` — `31.58.137.7`
  - `USER` — `root`
- `git push -u origin release` → Actions → Deploy

## 4. Проверка

- Actions: job `deploy` зелёный, в конце `active: <release>`
- `curl -sI https://gf.vslav.dev | head -1` → `200`
- `curl -s https://gf.vslav.dev/build-info.json` → коммит совпадает с последним в `release`

## Откат

- На сервере: `ls /var/www/glimmerfall/releases` → `ln -sfn releases/<прошлый> /var/www/glimmerfall/current.next && mv -Tf /var/www/glimmerfall/current.next /var/www/glimmerfall/current`
- Или: Actions → Deploy → Run workflow на нужном коммите

## Чеклист
- ✅ Workflow, скрипт активации, конфиг nginx в репо
- ✅ Локальный git, ветка `release`, первый коммит
- ✅ Репозиторий на GitHub, push
- ✅ Ключ деплоя и secrets окружения `VPS_31`
- ✅ Папка, сертификат, nginx на сервере

## Переезд на games.vslav.dev/glimmerfall (22.11.2026)
- Новый адрес: `https://games.vslav.dev/glimmerfall/`. `gf.vslav.dev` удалён без редиректа: игроков мало, установят заново (прогресс — в хранилище старого домена, не переносится).
- DNS: `games.vslav.dev` → A `31.58.137.7`, DNS only. Сертификат: `certbot certonly --nginx -d games.vslav.dev`.
- nginx: сайт `games` (`deploy/nginx/games.vslav.dev.conf`), `root /var/www/games`; каждая игра — симлинк `/var/www/games/<игра>` → её `current`. Сайт `glimmerfall` отключён.
- Деплой не менялся: CI пишет в `/var/www/glimmerfall`, симлинк `current` переключается так же.
- Телеметрия: веб шлёт на относительный `./api/ingest/glimmerfall` (= `/glimmerfall/api/ingest/glimmerfall`), натив — на полный адрес нового домена; nginx проксирует в `/api/ingest/glimmerfall` megaback.

## Конфиг nginx уходит из репо (26.11.2026)
- `deploy/nginx/games.vslav.dev.conf` удалён: это настройка сервера на весь домен, не игры. Хранить его здесь значило тащить в репо маршруты других игр.
- Источник теперь — `configs/vps-31/nginx/games.vslav.dev.conf` в `/Users/user/code/SERVERS`. Отменяет упоминания `deploy/nginx/...` выше.
- На сервере ничего не менялось: живой конфиг совпадал с перенесённым байт в байт.
