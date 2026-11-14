# Analysis sandbox: runs model-written pandas/NumPy/matplotlib code with no network and tight limits.
FROM python:3.12.9-slim
ENV PYTHONUNBUFFERED=1 PIP_DEFAULT_TIMEOUT=180
WORKDIR /sandbox
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin analyst
COPY policy.py runner.py server.py ./
COPY tests ./tests
# Source files can arrive readable only by their owner (e.g. from a synced folder); the sandbox user must read them.
RUN chmod -R a+rX /sandbox
# Build matplotlib's font cache once, read-only at run time, so each analysis starts quickly.
ENV MPL_CACHE_DIR=/sandbox/mplcache
RUN MPLCONFIGDIR=/sandbox/mplcache python -c "import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt; plt.figure()" && chmod -R a+rX /sandbox/mplcache
USER analyst
EXPOSE 8097
HEALTHCHECK --interval=15s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8097/health', timeout=3)"
CMD ["python", "server.py"]
