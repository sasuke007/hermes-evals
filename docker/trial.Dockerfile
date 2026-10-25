# syntax=docker/dockerfile:1.7
# The image every trial runs. It is the published Hermes Agent image, pinned
# by digest to revision 4d04303 (v0.22.4), with its s6 entrypoint replaced:
# trials start Hermes directly as uid 10000 with a config the worker writes.
ARG HERMES_IMAGE=nousresearch/hermes-agent:v0.22.4@sha256:7a69201726bc64db2072a1371557137c23312d29705cda2b8ea2a0214a50a4cf
FROM ${HERMES_IMAGE}
LABEL org.hermes-evals.hermes-version="0.22.4" \
      org.hermes-evals.hermes-revision="4d04303818b61bf3aa09278af48356315515965b"

# The sample stdio MCP server (docker/mcp/invoice-db). Stdio servers run inside
# the trial with no network, so samples are baked in here rather than fetched
# at run time. Root-owned and read-only to the trial user; it runs on the MCP
# SDK already in Hermes's venv. Its data file is file:///opt/mcp/invoice-db/invoices.csv.
# (COPY --chmod would also apply to the directories it creates, making them
# unreadable, so the modes are set explicitly.)
COPY --chown=0:0 docker/mcp/invoice-db/server.py docker/mcp/invoice-db/invoices.csv /opt/mcp/invoice-db/
COPY --chown=0:0 docker/mcp/invoice-db/invoice-db-mcp /usr/local/bin/invoice-db-mcp
# nous-login (plan 6.1): the Nous Portal device login the UI drives. The
# nous-login service runs it from this image with the nous-home volume, as
# `/opt/hermes/.venv/bin/python /opt/nous-login/nous-login.py`, so it calls
# the same Hermes as nous-proxy. Root-owned and read-only, like the samples.
COPY --chown=0:0 docker/nous-login.py /opt/nous-login/nous-login.py
RUN chmod 0755 /opt/mcp /opt/mcp/invoice-db /usr/local/bin/invoice-db-mcp /opt/nous-login \
 && chmod 0644 /opt/mcp/invoice-db/server.py /opt/mcp/invoice-db/invoices.csv /opt/nous-login/nous-login.py

USER 10000:10000
WORKDIR /opt/data
ENTRYPOINT ["/opt/hermes/.venv/bin/hermes"]
CMD ["--version"]
