FROM node:18-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

COPY --chown=node:node package.json package-lock.json* ./

# npm ci sokkal gyorsabb és determinisztikusabb productionben
RUN npm ci --omit=dev

COPY . .

COPY --chown=node:node . .

USER node

EXPOSE 3000

CMD ["node", "server.js"]