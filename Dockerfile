# bloop: one container with Node, ffmpeg and yt-dlp. Mount a volume at /app/data (db.json + all media).
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force
COPY . .
ENV NODE_ENV=production FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe
VOLUME /app/data
EXPOSE 3000
CMD ["node", "server.js"]
