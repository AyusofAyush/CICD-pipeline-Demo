# ---- Stage 1: install production dependencies ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Stage 2: runtime image ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# node:alpine ships a non-root "node" user; run as it.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js app.js index.html ./

USER node
EXPOSE 8080
CMD ["node", "server.js"]
