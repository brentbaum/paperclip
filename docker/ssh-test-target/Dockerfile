FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-server git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash brewuser \
  && mkdir -p /var/run/sshd /home/brewuser/.ssh /home/brewuser/paperclip-remote-worker/dist \
  && chown -R brewuser:brewuser /home/brewuser \
  && chmod 700 /home/brewuser/.ssh

COPY docker/ssh-test-target/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22

ENTRYPOINT ["/entrypoint.sh"]
