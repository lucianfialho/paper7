FROM node:24-bookworm

ENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

RUN apt-get update && apt-get install -y \
  git \
  curl \
  && rm -rf /var/lib/apt/lists/*

RUN usermod -d /home/agent -m -l agent node
RUN mkdir -p /home/agent/.local/share /home/agent/.local/state /home/agent/.config \
  && chmod -R 0777 /home/agent

RUN npm install -g opencode-ai@latest

USER agent
WORKDIR /home/agent

ENTRYPOINT ["sleep", "infinity"]
