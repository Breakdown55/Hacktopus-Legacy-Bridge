# UNVERIFIED. Runs tsc directly (never npm scripts). Pin by digest in production.
FROM node:22-bookworm-slim
RUN npm i -g typescript@5.9.3 && useradd -u 10001 -m lb
USER 10001
WORKDIR /work
