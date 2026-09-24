# syntax=docker/dockerfile:1

# The Kru Bot box: the computer every bot works on, and a small Linux
# desktop for each person. The full (not slim) Node image brings git,
# Python 3 and a C toolchain; Bun, ripgrep and a browser are added. Extend
# this file if your bots need more tooling. The `agent` user made here is
# the admin's; everyone else's user is made at run time by server.mjs
# (accounts.mjs), with a home under /home.
FROM oven/bun:1.4.2 AS bun

FROM node:24-bookworm
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ripgrep jq \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1001 --user-group agent \
 && mkdir -p /home/agent/.bots /home/agent/.cache /home/agent/.claude /home/agent/.codex /home/agent/.grok /state \
 && chown agent:agent /home/agent/.bots /home/agent/.cache /home/agent/.claude /home/agent/.codex /home/agent/.grok

# Claude Code, as published and unmodified. Every bot runs on it; each
# person signs in to it once from a terminal on the box, in their own
# account, and the login stays in their ~/.claude (the admin's is a
# volume). Kru Bot never sees it.
RUN mkdir -p /opt/claude && cd /opt/claude \
 && bun add --trust @anthropic-ai/claude-code \
 && ln -sf /opt/claude/node_modules/.bin/claude /usr/local/bin/claude \
 && rm -rf /root/.bun/install/cache

# OpenAI Codex and xAI's Grok Build, as published: the other two CLIs a bot
# can run on (Settings → AI). Each person signs in the same way, once, from
# a terminal on the box (`codex login --device-auth`, `grok login
# --device-auth`), and keeps it in their own ~/.codex or ~/.grok; or their
# bots use an API key of theirs that stays in Kru Bot's API.
RUN mkdir -p /opt/codex /opt/grok \
 && cd /opt/codex && bun add --trust @openai/codex \
 && ln -sf /opt/codex/node_modules/.bin/codex /usr/local/bin/codex \
 && cd /opt/grok && bun add --trust @xai-official/grok \
 && ln -sf /opt/grok/node_modules/.bin/grok /usr/local/bin/grok \
 && rm -rf /root/.bun/install/cache

# The desktop: GNOME Flashback (GNOME's session for machines without 3D
# acceleration) on a TigerVNC X server, reached through the Kru UI. It only
# starts when someone opens it and needs no ports: the VNC socket is bound
# to loopback and bridged by server.mjs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tigervnc-standalone-server xfonts-base dbus-x11 \
      gnome-session-flashback gnome-flashback gnome-panel metacity \
      gnome-settings-daemon gnome-terminal nautilus gnome-text-editor \
      adwaita-icon-theme fonts-dejavu-core fonts-cantarell dconf-cli \
 && rm -rf /var/lib/apt/lists/*

# A browser, for repos whose tests drive one and for the desktop. Google
# builds Chrome for amd64 only, so arm64 gets Debian's Chromium; both answer
# to `google-chrome`, and the packages bring the fonts and libraries a
# headless browser needs. Either one adds a few hundred MB to the image.
ARG TARGETARCH
RUN set -eux; \
    if [ "${TARGETARCH:-amd64}" = "amd64" ]; then \
      curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg; \
      echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list; \
      apt-get update; \
      apt-get install -y --no-install-recommends google-chrome-stable; \
    else \
      apt-get update; \
      apt-get install -y --no-install-recommends chromium; \
      ln -sf /usr/bin/chromium /usr/bin/google-chrome; \
      ln -sf /usr/bin/chromium /usr/bin/google-chrome-stable; \
    fi; \
    rm -rf /var/lib/apt/lists/*

# Chrome's sandbox cannot start in the box: Docker's seccomp profile denies
# the user namespaces it asks for, and no-new-privileges disables its setuid
# helper, so Chrome dies before it draws a window. The container and its
# unprivileged user are the isolation here, so a wrapper passes --no-sandbox
# for every way Chrome gets launched: the desktop menu, CHROME_BIN and the
# `google-chrome` on PATH. The profile lives in the container, so every
# restart would be a first run again; the wrapper skips that dialog and the
# default-browser prompt, and a policy file turns off what flags don't reach
# (metrics, welcome tabs, sign-in, sync, the save-password bar, and the
# infobar warning about --no-sandbox, which is expected here). Chrome and
# Chromium read policies from different directories; both get the file.
COPY chrome-policy.json /etc/opt/chrome/policies/managed/kru.json
COPY chrome-policy.json /etc/chromium/policies/managed/kru.json
RUN set -eux; \
    printf '%s\n' '#!/bin/sh' \
      '# The box denies the namespaces and setuid helper the sandbox needs;' \
      '# the container and its unprivileged user are the isolation.' \
      'exec /usr/bin/google-chrome --no-sandbox --no-first-run --no-default-browser-check "$@"' \
      > /usr/local/bin/google-chrome; \
    chmod 755 /usr/local/bin/google-chrome; \
    ln -s google-chrome /usr/local/bin/google-chrome-stable; \
    for entry in /usr/share/applications/google-chrome.desktop \
                 /usr/share/applications/com.google.Chrome.desktop \
                 /usr/share/applications/chromium.desktop; do \
      if [ -f "$entry" ]; then \
        sed -i -E 's#^Exec=/usr/bin/(google-chrome-stable|chromium)#Exec=/usr/local/bin/google-chrome#' "$entry"; \
      fi; \
    done

# The skills library mirror: one folder, root's, linked as ~/.skills in
# every home. The API fills it at start and on every change.
RUN mkdir -p /srv/kru/skills && chmod 755 /srv/kru/skills

ENV PORT=8787 \
    AGENT_HOME=/home/agent \
    HOMES_DIR=/home \
    SKILLS_DIR=/srv/kru/skills \
    BOTS_DIR=/home/agent/.bots \
    CACHE_DIR=/home/agent/.cache \
    CLAUDE_CONFIG_DIR=/home/agent/.claude \
    CODEX_HOME=/home/agent/.codex \
    GROK_HOME=/home/agent/.grok \
    GROK_DISABLE_AUTOUPDATER=1 \
    STATE_DIR=/state \
    DESKTOP_DISPLAY=1 \
    DESKTOP_VNC_PORT=5901 \
    CHROME_BIN=/usr/local/bin/google-chrome \
    CHROME_PATH=/usr/local/bin/google-chrome

# node-pty backs the interactive terminals in the Kru Bot UI.
WORKDIR /box
COPY package.json bun.lock* ./
RUN bun install --production && rm -rf /root/.bun/install/cache
# Every module at the root: named one by one, a new one is forgotten until the box won't start.
COPY *.mjs desktop.sh update.sh ./
RUN chmod 755 desktop.sh update.sh
# The session gnome-session runs: Flashback without the daemons that need
# logind or hardware (see kru.session).
COPY kru.session /usr/share/gnome-session/sessions/kru.session

# The box is not a throwaway: /home/agent as a whole is a volume, so what the
# admin's bots install for themselves (global packages, tools, dotfiles,
# browser profiles) is still there after a restart or a new image. Inside it:
# /home/agent/.bots holds every one of their bots' homes: MEMORY.md, notes, scripts, clones.
# /home/agent/.team is the team space; /home/agent/.skills links to the skills
# library; hidden like the bots' homes so the home looks like a person's.
# /home/agent/.cache holds package caches (bun, npm, pnpm, yarn, pip, uv).
# /home/agent/.claude holds the Claude Code sign-in; .codex and .grok hold
# Codex's and Grok's.
# Everyone else's home is /home/<name> with the same layout inside it;
# docker-compose.yml mounts a volume at /home for them. /state keeps the
# API token and the register of accounts.
VOLUME ["/state", "/home/agent", "/home/agent/.bots", "/home/agent/.cache", "/home/agent/.claude"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# tini reaps processes a timeout killed. Root only to run commands as the
# agent user; see server.mjs.
ENTRYPOINT ["tini", "--"]
CMD ["node", "/box/server.mjs"]
