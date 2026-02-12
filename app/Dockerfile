# app/Dockerfile
FROM node:18-alpine
WORKDIR /app
RUN npm init -y && npm install express
COPY server.js .
EXPOSE 3000
CMD ["node", "server.js"]