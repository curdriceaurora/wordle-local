FROM node:20-alpine

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY data ./data
COPY server.js ./server.js

EXPOSE 3000

CMD ["node", "server.js"]
