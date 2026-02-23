FROM node:18-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

COPY --chown=node:node package.json package-lock.json* ./

RUN npm install --omit=dev && \
    npm cache clean --force && \
    chown -R node:node /app/node_modules

COPY --chown=node:node . .

USER node

EXPOSE 3000

CMD ["node", "server.js"]