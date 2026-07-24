# Node 22 обязателен: mediasoup >= 3.20 требует node>=22. На node:20 npm молча
# откатывался на mediasoup 3.19.x, у которой нет prebuilt-воркера под ядро 7.x
# (Ubuntu 26.04) — и сборка падала на попытке собрать воркер из исходников.
FROM node:22-bookworm

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

CMD ["node", "dist/index.js"]
