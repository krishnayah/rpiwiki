---
title: outline
type: docs
weight: 2
date: "2026-01-31T04:00:03.072Z"
lastmod: "2026-01-31T04:03:38.795Z"
_outline:
  id: 826d19b4-2da2-4ac8-9360-b0ca7612e512
  updatedAt: "2026-01-31T04:03:38.795Z"
---

Ironically, one of the reasons this Wiki took so long was because of the lack of documentation on a lot of the setup process.


As a result, I want to document the (near exact) process I used here.


Initially, I set up the default Outline template for Dokploy.


# Traefik Routing

One of the things that took forever to get running was proper Traefik routing (so rpi.wiki → rpi.wiki/s/wiki)


It turns out to be insanely simple here: 

```javascript
    labels:
    # 1. Define the middleware logic
      - 'traefik.http.middlewares.student-senate-redirect.redirectregex.regex=^https?://rpi\.wiki/$$'
      - 'traefik.http.middlewares.student-senate-redirect.redirectregex.replacement=https://rpi.wiki/s/wiki'
      - 'traefik.http.middlewares.student-senate-redirect.redirectregex.permanent=true'

    # 2. Attach it to the HTTP router
      - 'traefik.http.routers.rpi-wiki-outline-1bymbv-32-web.middlewares=redirect-to-https@file,student-senate-redirect'

    # 3. Attach it to the HTTPS router
      - 'traefik.http.routers.rpi-wiki-outline-1bymbv-32-websecure.middlewares=student-senate-redirect'
```


# Compose

Here's the FULL compose

```javascript
services:
  outline:
    image: docker.getoutline.com/outlinewiki/outline:latest
    env_file: ./.env
    expose:
      - "3000"
    volumes:
      - storage-data:/var/lib/outline/data
    depends_on:
      - postgres
      - redis
    labels:
    # 1. Define the middleware logic
      - 'traefik.http.middlewares.student-senate-redirect.redirectregex.regex=^https?://rpi\.wiki/$$'
      - 'traefik.http.middlewares.student-senate-redirect.redirectregex.replacement=https://rpi.wiki/s/wiki'
      - 'traefik.http.middlewares.student-senate-redirect.redirectregex.permanent=true'

    # 2. Attach it to the HTTP router
      - 'traefik.http.routers.rpi-wiki-outline-1bymbv-32-web.middlewares=redirect-to-https@file,student-senate-redirect'

    # 3. Attach it to the HTTPS router
      - 'traefik.http.routers.rpi-wiki-outline-1bymbv-32-websecure.middlewares=student-senate-redirect'

  redis:
    image: redis
    env_file: ./.env
    expose:
      - "6379"
    volumes:
      - ./redis.conf:/redis.conf
    command: ["redis-server", "/redis.conf"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s

  postgres:
    image: postgres:18
    env_file: ./.env
    expose:
      - "5432"
    volumes:
      - database-data:/var/lib/postgresql
    healthcheck:
      test: ["CMD", "pg_isready", "-d", "outline", "-U", "user"]
      interval: 30s
      timeout: 20s
      retries: 3
    environment:
      POSTGRES_USER: 'user'
      POSTGRES_PASSWORD: 'pass'
      POSTGRES_DB: 'outline'


volumes:
  storage-data:
  database-data:
```


# Environment

And here's the environment variables: 

```javascript
URL=https://rpi.wiki
FORCE_HTTPS=false
DOMAIN_NAME=rpi.wiki
DATABASE_URL=postgres://user:pass@postgres:5432/outline
REDIS_URL=redis://redis:6379
REDIS_COLLABORATION_URL=redis://redis:6379
POSTGRES_PASSWORD=[ENTER VALUE]
SECRET_KEY=VALUE
UTILS_SECRET=VALUE=-GOES-HERE
CLIENT_SECRET=VALUE=-GOES-HERE
PGSSLMODE=disable
DISCORD_CLIENT_ID=1437524952612995202
DISCORD_CLIENT_SECRET=VALUE-GOES-HERE
DISCORD_SERVER_ID=1072587144503238679
DISCORD_SERVER_ROLES="1352841142357458955,1101169115151990804"
```
