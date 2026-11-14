# UNVERIFIED (not built on the authoring machine). Worker supervisor; needs the Docker socket and, in production, a host with gVisor.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends docker.io && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Production by default: the worker refuses to start until the build step is sandboxed or you opt in explicitly for development.
ENV NODE_ENV=production
CMD ["npx", "tsx", "workers/run.ts"]
