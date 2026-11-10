# XenMCP Docker agent

A small, **read-only** MCP server for the containers on one Docker host. Run it next to your containers, put it behind your reverse proxy, and connect it to Claude, Cursor or VS Code through [XenMCP](https://xenmcp.com): every person signs in on their own (OAuth), access can be revoked at any time, and every call is in the journal.

It can **see**, never **change**:

| Tool | What it does |
| --- | --- |
| `docker_info` | Docker version, OS, CPUs, memory, number of containers and images |
| `list_containers` | Name, image, state, uptime, ports, compose project |
| `inspect_container` | State, exit code, OOM kill, restarts, health check, limits, log driver, mounts, networks — **never environment variables or command arguments** |
| `container_logs` | Last lines, a time window (`since` / `until`: `15m`, `6h`, `2d` or an ISO time), stdout or stderr only, text or regex search; at most 500 lines per call |
| `container_stats` | CPU, memory, network, processes right now |
| `recent_events` | start, stop, die (with exit code), kill, OOM, restart, health status — up to 7 days |

There is no tool that starts, stops, restarts, removes, execs, builds or pulls. The agent sends Docker only a short list of `GET` requests ([`lib.mjs`](lib.mjs), `allowedPath`) and refuses everything else before it leaves the process.

## Install

1. In the XenMCP panel: **Add server → Docker agent**. It shows a key and the command below with the key filled in.
2. On your Docker host:

```bash
docker run -d --name xenmcp-docker-agent --restart unless-stopped \
  --read-only --cap-drop ALL --security-opt no-new-privileges --memory 128m \
  --group-add "$(stat -c %g /var/run/docker.sock)" \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e XENMCP_AGENT_KEY=<the key from the panel> \
  -p 127.0.0.1:8090:8080 \
  ghcr.io/xenmcp/docker-agent:1.0
```

3. Make it reachable over HTTPS through your reverse proxy (below), e.g. `https://docker-agent.example.com/mcp`.
4. In the panel: enter that address and press **Check and save**.

Or with Docker Compose:

```yaml
services:
  xenmcp-docker-agent:
    image: ghcr.io/xenmcp/docker-agent:1.0
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    mem_limit: 128m
    group_add: ["${DOCKER_GID}"]   # stat -c %g /var/run/docker.sock
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      XENMCP_AGENT_KEY: ${XENMCP_AGENT_KEY}
    ports:
      - 127.0.0.1:8090:8080
```

## Reverse proxy

The agent listens on plain HTTP; your proxy adds HTTPS. It must pass `X-Forwarded-For` (all three below do).

**Caddy**

```
docker-agent.example.com {
  reverse_proxy 127.0.0.1:8090
}
```

**nginx**

```nginx
server {
  listen 443 ssl;
  server_name docker-agent.example.com;
  # ssl_certificate …; ssl_certificate_key …;
  location /mcp {
    allow 46.225.57.217;   # XenMCP
    deny all;
    proxy_pass http://127.0.0.1:8090;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_read_timeout 120s;
  }
}
```

**Traefik** (labels on the agent container, without `ports`)

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.xenmcp-agent.rule=Host(`docker-agent.example.com`) && PathPrefix(`/mcp`)
  - traefik.http.routers.xenmcp-agent.tls.certresolver=letsencrypt
  - traefik.http.services.xenmcp-agent.loadbalancer.server.port=8080
```

## Without XenMCP

The agent is a plain MCP server (Streamable HTTP at `/mcp`), so any client that can send a header works. Set `XENMCP_ALLOW_IPS` to the addresses that may call it (`*` for any, only behind your own proxy or firewall) and send the key as `Authorization: Bearer <key>`. Without XenMCP there is no per-person sign-in and no journal: everyone with the key has the same access.

### Over stdio, for a local client

Started with `--stdio`, the agent talks MCP over stdin/stdout instead of HTTP: no key, no port, no address list – whoever starts it already has the Docker socket. For Claude Desktop, Cursor or VS Code on the Docker host itself:

```json
{
  "mcpServers": {
    "docker": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "--no-healthcheck", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
               "--group-add", "<stat -c %g /var/run/docker.sock>",
               "-v", "/var/run/docker.sock:/var/run/docker.sock:ro",
               "ghcr.io/xenmcp/docker-agent:1.0", "node", "server.mjs", "--stdio"]
    }
  }
}
```

Or from a checkout: `node server.mjs --stdio`. The same six read-only tools; `XENMCP_CONTAINERS` and the `xenmcp.hide` label apply.

It is listed in the official MCP Registry as `com.xenmcp/docker-agent` (`server.json` in this repository).

## Settings

| Variable | Default | |
| --- | --- | --- |
| `XENMCP_AGENT_KEY` | — | Required over HTTP, at least 32 characters; XenMCP sends it as `Authorization: Bearer`. Not used with `--stdio`. |
| `XENMCP_ALLOW_IPS` | `46.225.57.217` | Who may call, comma-separated, CIDR allowed. Behind a proxy on a private address the last `X-Forwarded-For` entry counts. |
| `XENMCP_CONTAINERS` | all | Only these containers, comma-separated, `*` as wildcard (e.g. `shop-*,nginx`). |
| `XENMCP_MAX_SCAN_MB` | `200` | How much log one search or stream filter reads at most. |
| `PORT` | `8080` | |

Hide single containers with the label `xenmcp.hide=true`: they are left out of every answer.

## Good to know

- **Logs** are what Docker keeps: with the default `json-file` driver everything since the container was created, unless you set `max-size`/`max-file`. A recreated container starts with an empty log. For history beyond that, use Grafana + Loki.
- **Logs can contain personal data and secrets.** What a tool returns goes to the AI client you connect (for Claude: Anthropic). Hide containers you do not want to share.
- The socket is mounted read-only, but Docker's API does not know read-only mounts — the limit is the agent's own allow-list, which is why it is small, open source and tested (`npm test`, `npm run e2e`).

## Develop

```bash
npm ci
npm test        # unit tests and stdio (no Docker needed)
npm run e2e     # against your local Docker (starts and removes three busybox containers)
```

## Questions and feedback

Ask in the [XenMCP community on Discord](https://discord.gg/gDpBd8vYtG) (forum `#help`, tag `docker-agent`) or open an issue here. Security issues: security@xenmcp.com, not in public.

MIT licence. Made by [Xenaxio](https://xenaxio.com) for [XenMCP](https://xenmcp.com).
