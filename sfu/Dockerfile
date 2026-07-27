# Node 22 обязателен: mediasoup >= 3.20 требует node>=22. На node:20 npm молча
# откатывался на mediasoup 3.19.x, у которой нет prebuilt-воркера под ядро 7.x
# (Ubuntu 26.04) — и сборка падала на попытке собрать воркер из исходников.
#
# Тег зафиксирован до патча намеренно: `node:22-bookworm` — плавающий, и на
# каждой пересборке (то есть на каждый push в main) мог бы затянуть другой
# Node без единой строчки ревью. Ровно этот класс проблемы уже случался —
# см. абзац выше. Бампить руками осознанно.
FROM node:22.23.1-bookworm

# python3/pip + компилятор нужны только как запасной путь: если под платформу нет
# prebuilt mediasoup-worker, он собирается из исходников (медленно, но не падает).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Ставим строго по лок-файлу — иначе версия mediasoup «уплывает» от протестированной.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Не root. Контейнер запускается с network_mode: host, то есть делит сетевое
# пространство с хостом — включая 127.0.0.1:8000, куда смотрит бэкенд и что
# снаружи закрыто nginx'ом. Скомпрометированный процесс mediasoup/Node не
# должен при этом быть ещё и рутом. Медиа-порты (SFU_RTC_MIN_PORT и выше,
# по умолчанию 40000+) непривилегированные — root для них не нужен.
RUN chown -R node:node /app
USER node

CMD ["node", "dist/index.js"]
