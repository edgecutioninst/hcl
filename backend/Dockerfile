FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm i --no-save prisma@6.19.3
COPY . .
RUN npx prisma generate
ENV NODE_ENV=production PORT=4000 DATA_DIR=/data UPLOAD_DIR=/storage
EXPOSE 4000
# Apply migrations, seed once if SEED_ON_START=1 (wipes and reloads demo data), then start API + worker + cron.
CMD ["sh", "-c", "npx prisma migrate deploy && if [ \"$SEED_ON_START\" = 1 ]; then node prisma/seed.js; fi && node src/server.js"]
