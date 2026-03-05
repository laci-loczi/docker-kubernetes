FROM node:18-bookworm-slim

ENV NODE_ENV=production
# optimization: tell the node that there is limited memory
ENV NODE_OPTIONS="--max-old-space-size=1536"

WORKDIR /app

COPY --chown=node:node package.json package-lock.json* ./

RUN npm install --omit=dev && \
    npm cache clean --force && \
    chown -R node:node /app/node_modules

COPY --chown=node:node . .

USER node

EXPOSE 3000
EXPOSE 3001

# healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
  CMD curl -f http://localhost:3000/healthz || curl -f http://localhost:3001/healthz || exit 1

CMD ["node", "server.js"]