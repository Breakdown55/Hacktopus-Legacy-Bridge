# syntax=docker/dockerfile:1
FROM eclipse-temurin:21-jdk-jammy@sha256:549af77544e75ce2a20ee69454e365485de0f1524947f5ab0b08d5ef3a9d26a3 AS jdk

FROM node:24.22.3-bookworm-slim@sha256:0e2646ab57e77b7a384a0cb59b6815b182c77e1f9c3ba36bd8435bd9c4e6680e
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates fontconfig procps unzip \
    && rm -rf /var/lib/apt/lists/*
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
ADD --checksum=sha256:aa5cbcbbf48f41ca185fce900e19592f1ade4cd5994eb6e0ede468dac8a6f302 \
    https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1_build/ghidra_12.1_PUBLIC_20260513.zip \
    /tmp/ghidra.zip
RUN unzip -q /tmp/ghidra.zip -d /opt && rm /tmp/ghidra.zip \
    && npm install --prefix /opt/rea --no-audit --no-fund --ignore-scripts --engine-strict --save-exact rea-agents@6.9.0 \
    && mkdir -p /fixtures /results /spec
ENV JAVA_HOME=/opt/java/openjdk \
    GHIDRA_INSTALL_DIR=/opt/ghidra_12.1_PUBLIC \
    HOME=/tmp/lb-analysis \
    JAVA_TOOL_OPTIONS="-XX:ActiveProcessorCount=4"
ENV PATH="${JAVA_HOME}/bin:${PATH}"
USER node
WORKDIR /tmp
