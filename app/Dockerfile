FROM node:18-alpine

WORKDIR /app

COPY package.json .

# --omit=dev keeps devDependencies out of the image
RUN npm ci --omit=dev

COPY . .

RUN chown -R node:node /app

USER node

EXPOSE 3000

# --expose-gc lets the stress-mode GC call actually work
CMD ["node", "--expose-gc", "server.js"]