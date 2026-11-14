# UNVERIFIED (not built on the authoring machine). Next.js app + API. Pin the base image by digest in production.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
USER node
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
