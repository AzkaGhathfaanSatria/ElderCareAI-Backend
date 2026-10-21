FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt requirements-pose.txt ./
RUN pip install --no-cache-dir -r requirements.txt
ARG INSTALL_POSE=false
RUN if [ "$INSTALL_POSE" = "true" ]; then pip install --no-cache-dir -r requirements-pose.txt; fi
COPY app ./app
COPY models ./models
EXPOSE 5000
CMD ["gunicorn", "-w", "2", "-b", "0.0.0.0:5000", "app.main:app"]