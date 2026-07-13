FROM node:20-bookworm-slim

# FFmpeg from Debian repos — includes libx264/aac support.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]