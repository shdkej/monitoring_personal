FROM fluent/fluentd:v0.12-debian-2

RUN gem install fluent-plugin-elasticsearch --version 1.9.2
COPY fluent.conf /fluentd/etc/fluent.conf
