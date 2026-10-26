# syntax=docker/dockerfile:1.7
# The sample http MCP server vendor-directory (server.py, plan 18.2 P4). It
# is built FROM the trial image so it runs on the MCP SDK already in Hermes's
# venv and adds no dependency. Build context: this directory.
#
#   docker build -t hermes-evals/vendor-directory docker/mcp/vendor-directory
#
# Compose builds it in the `samples` profile with TRIAL_IMAGE pointing at the
# trial-image service's build, so the trial image is built first.
ARG TRIAL_IMAGE=hermes-evals/trial:v0.22.4-4d04303
FROM ${TRIAL_IMAGE}

# Root-owned and read-only to the server's uid, like the samples in the trial
# image. (COPY --chmod would also apply to the directory it creates, making it
# unreadable, so the modes are set explicitly.)
USER 0:0
COPY --chown=0:0 server.py vendors.json /opt/mcp/vendor-directory/
RUN chmod 0755 /opt/mcp/vendor-directory \
 && chmod 0644 /opt/mcp/vendor-directory/server.py /opt/mcp/vendor-directory/vendors.json

USER 10000:10000
WORKDIR /opt/mcp/vendor-directory
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EXPOSE 8000
ENTRYPOINT ["/opt/hermes/.venv/bin/python", "/opt/mcp/vendor-directory/server.py"]
CMD []
