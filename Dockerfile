# 1) Compila la interfaz (React + Vite)
FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# 2) Imagen final: solo el servidor Node y los archivos estáticos ya compilados
FROM node:22-alpine
# Cliente ssh para las consultas de solo lectura al servidor vigilado (SSH_HOST, opcional).
RUN apk add --no-cache openssh-client
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data HOST_ROOT=/host
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY --from=web /app/web/dist /app/web/dist
RUN mkdir -p /data && chown node:node /data
# Sin root: si alguien rompiera la app, no tendría privilegios dentro del contenedor.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "index.js"]
