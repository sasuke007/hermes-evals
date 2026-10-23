# syntax=docker/dockerfile:1.7
# The image every trial runs. It is the published Hermes Agent image, pinned
# by digest to revision 4d04303 (v0.22.4), with its s6 entrypoint replaced:
# trials start Hermes directly as uid 10000 with a config the worker writes.
ARG HERMES_IMAGE=nousresearch/hermes-agent:v0.22.4@sha256:7a69201726bc64db2072a1371557137c23312d29705cda2b8ea2a0214a50a4cf
FROM ${HERMES_IMAGE}
LABEL org.hermes-evals.hermes-version="0.22.4" \
      org.hermes-evals.hermes-revision="4d04303818b61bf3aa09278af48356315515965b"
USER 10000:10000
WORKDIR /opt/data
ENTRYPOINT ["/opt/hermes/.venv/bin/hermes"]
CMD ["--version"]
