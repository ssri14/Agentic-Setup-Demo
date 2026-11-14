FROM python:3.12.9-slim
ENV PYTHONUNBUFFERED=1 PIP_DEFAULT_TIMEOUT=180 PIP_RETRIES=5 TOKENIZERS_PARALLELISM=false
WORKDIR /app
# CPU wheels avoid pulling CUDA libraries; the same Dockerfile supports amd64/arm64.
ARG TARGETARCH
RUN --mount=type=bind,source=_wheels,target=/wheels,readonly --mount=type=cache,target=/root/.cache/pip if [ "$TARGETARCH" = "arm64" ]; then if ls /wheels/torch-*.whl >/dev/null 2>&1; then pip install /wheels/torch-*.whl; else pip install torch==2.6.0; fi; else pip install --find-links=/wheels --index-url https://download.pytorch.org/whl/cpu torch==2.6.0; fi
COPY requirements.txt constraints.txt ./
RUN --mount=type=bind,source=_wheels,target=/wheels,readonly --mount=type=cache,target=/root/.cache/pip if [ "$TARGETARCH" = "arm64" ] && ls /wheels/*.whl >/dev/null 2>&1; then pip install -c constraints.txt -r requirements.txt /wheels/*.whl; else pip install --find-links=/wheels -c constraints.txt -r requirements.txt; fi
COPY ingestion ./ingestion
COPY config ./config
COPY tests ./tests
ENTRYPOINT ["python", "-m", "ingestion"]
