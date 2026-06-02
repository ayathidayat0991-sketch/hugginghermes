# HuggingMes - Hermes Agent Gateway for Hugging Face Spaces
ARG HERMES_AGENT_VERSION=latest
FROM nousresearch/hermes-agent:${HERMES_AGENT_VERSION}

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/* \
    && uv pip install --python /opt/hermes/.venv/bin/python --no-cache-dir huggingface_hub

COPY --chown=hermes:hermes start.sh /opt/huggingmes/start.sh
COPY --chown=hermes:hermes health-server.js /opt/huggingmes/health-server.js
COPY --chown=hermes:hermes services /opt/huggingmes/services
COPY --chown=hermes:hermes hermes-sync.py /opt/huggingmes/hermes-sync.py
COPY --chown=hermes:hermes cloudflare-proxy-setup.py /opt/huggingmes/cloudflare-proxy-setup.py
COPY --chown=hermes:hermes cloudflare-keepalive-setup.py /opt/huggingmes/cloudflare-keepalive-setup.py

RUN chmod +x \
    /opt/huggingmes/start.sh \
    /opt/huggingmes/hermes-sync.py \
    /opt/huggingmes/cloudflare-proxy-setup.py \
    /opt/huggingmes/cloudflare-keepalive-setup.py

ENV HERMES_HOME=/opt/data \
    HUGGINGMES_APP_DIR=/opt/huggingmes \
    HERMES_AGENT_VERSION=${HERMES_AGENT_VERSION} \
    WHATSAPP_PROVIDER=cloud \
    WHATSAPP_GRAPH_API_VERSION=v20.0 \
    PYTHONUNBUFFERED=1

EXPOSE 7861

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s \
  CMD curl -fsS http://localhost:7861/health || exit 1

CMD ["/opt/huggingmes/start.sh"]
