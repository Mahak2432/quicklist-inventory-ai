FROM node:24-slim

WORKDIR /app

# Install only production packages. sharp ships prebuilt Linux binaries.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production \
    PORT=7860 \
    DB_PATH=/data/quicklist-inventory-ai.db \
    UPLOAD_DIR=/data/uploads

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 7860
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
