# Продовый образ backend: собирает веб-клиент (multi-stage) и кладёт его
# рядом с backend/, чтобы core.views.spa (BASE_DIR.parent/web/dist) нашёл статику.
# Собирается с контекстом = корень репозитория:
#   docker build -f deploy/backend.Dockerfile ..

# ---- этап 1: сборка веб-клиента ----
# Теги зафиксированы до патча: плавающие node:20-alpine / python:3.12-slim
# могли затянуть в прод другую версию на любой пересборке (то есть на каждый
# push в main) без единой строчки ревью. Бампить руками осознанно.
FROM node:20.20.2-alpine AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- этап 2: backend ----
FROM python:3.14.7-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app/backend

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .
COPY --from=web-build /web/dist /app/web/dist

RUN chmod +x entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["./entrypoint.sh"]
