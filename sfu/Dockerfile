# mediasoup тянет prebuilt worker-бинарь; python3+build-essential оставлены на
# случай, если под платформу нет prebuilt и воркер собирается из исходников.
FROM node:20-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

CMD ["node", "dist/index.js"]
