FROM node:18-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json* ./

# npm ci sokkal gyorsabb és determinisztikusabb productionben
RUN npm ci --only=production

COPY . .

RUN chown -R node:node /app

USER node

EXPOSE 3000

CMD ["node", "server.js"]