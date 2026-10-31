# Builds the React client and serves it from the API (single container).
# NOTE: not NODE_ENV=production by default, because production mode makes the session cookie
# HTTPS-only. Set NODE_ENV=production and CLIENT_URL only when you serve over HTTPS.
FROM node:22-alpine AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY --from=client /app/client/dist /app/client/dist
ENV HOST=0.0.0.0 PORT=5000
EXPOSE 5000
USER node
CMD ["node", "src/index.js"]
