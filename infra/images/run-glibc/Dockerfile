# UNVERIFIED. Original-binary run image. Pin by digest in production.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends faketime && rm -rf /var/lib/apt/lists/* && useradd -u 10001 -m lb
USER 10001
WORKDIR /work
