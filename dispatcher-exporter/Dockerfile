FROM python:3.12-alpine

RUN apk add --no-cache git
RUN addgroup -S exporter && adduser -S exporter -G exporter
WORKDIR /app
COPY exporter.py ./
USER exporter
EXPOSE 9102
CMD ["python", "exporter.py"]
