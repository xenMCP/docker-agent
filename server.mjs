// XenMCP Docker agent: a read-only MCP server for the containers on one Docker
// host. It sends Docker only the GET requests in lib.mjs (list, inspect, logs,
// stats, events, version, info) and never returns environment variables or
// command arguments. Nothing here starts, stops, removes, execs or builds.
// Callers need the key (Authorization: Bearer) and an allowed address.
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { z } from 'zod';
import { allowedPath, callerIp, ipIn, logLines, summarizeContainer, summarizeInspect, summarizeStats, toUnix, visible } from './lib.mjs';

const VERSION = '1.0.0';
const env = process.env;
const KEY = env.XENMCP_AGENT_KEY ?? '';
const ALLOW_IPS = (env.XENMCP_ALLOW_IPS ?? '46.225.57.217').split(',').map((s) => s.trim()).filter(Boolean);
const ONLY = (env.XENMCP_CONTAINERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const SOCKET = env.DOCKER_SOCKET ?? '/var/run/docker.sock';
const PORT = Number(env.PORT) || 8080;
const MAX_LINES = 500;
const MAX_LINE_CHARS = 2000;
const MAX_ANSWER_CHARS = 100_000;
/** How much log one search reads at most. */
const MAX_SCAN_BYTES = (Number(env.XENMCP_MAX_SCAN_MB) || 200) * 1024 * 1024;
if (KEY.length < 32) {
  console.error('XENMCP_AGENT_KEY must have at least 32 characters (the key XenMCP shows you)');
  process.exit(1);
}

/** One GET to Docker over its socket; `onData` streams the body instead of collecting it. */
function docker(path, { onData, maxBytes = 20 * 1024 * 1024 } = {}) {
  if (!allowedPath(path)) return Promise.reject(new Error(`refused: ${path.split('?')[0]}`));
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, path, method: 'GET', headers: { host: 'docker' }, timeout: 60_000 }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (onData) {
          if (onData(chunk) === false || size > maxBytes) res.destroy();
          return;
        }
        if (size > maxBytes) return res.destroy(new Error('answer too large'));
        chunks.push(chunk);
      });
      const done = () => {
        const body = Buffer.concat(chunks);
        if ((res.statusCode ?? 500) >= 400) {
          let message = body.toString('utf8').slice(0, 300);
          try {
            message = JSON.parse(message).message ?? message;
          } catch {}
          return reject(new Error(`Docker ${res.statusCode}: ${message}`));
        }
        resolve({ body, size, cut: size > maxBytes, headers: res.headers });
      };
      res.on('end', done);
      res.on('close', done);
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Docker did not answer in 60 seconds')));
    req.on('error', reject);
    req.end();
  });
}
const json = async (path) => JSON.parse((await docker(path)).body.toString('utf8'));

async function containers() {
  return (await json('/containers/json?all=1')).filter((c) => visible(c.Names ?? [], c.Labels, ONLY));
}

/** A visible container by name or id (prefix); hidden ones are "not found". */
async function find(nameOrId) {
  const key = nameOrId.replace(/^\//, '');
  const all = await containers();
  const hit = all.find((c) => (c.Names ?? []).some((n) => n.replace(/^\//, '') === key)) ?? (key.length >= 4 ? all.find((c) => c.Id.startsWith(key)) : undefined);
  if (!hit) throw new Error(`no container "${key}" (or it is hidden from XenMCP)`);
  return hit;
}

function answer(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  if (text.length > MAX_ANSWER_CHARS) text = `${text.slice(0, MAX_ANSWER_CHARS)}\n… cut at ${MAX_ANSWER_CHARS} characters`;
  return { content: [{ type: 'text', text }] };
}
async function run(fn) {
  try {
    return answer(await fn());
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

async function readLogs({ container, tail, since, until, stream, contains, regex }) {
  const c = await find(container);
  const detail = await json(`/containers/${c.Id}/json`);
  const tty = Boolean(detail.Config?.Tty);
  const from = toUnix(since);
  const to = toUnix(until);
  const filter = contains ? (regex ? new RegExp(contains, 'i') : null) : null;
  const needle = contains && !regex ? contains.toLowerCase() : null;
  const matches = (line) => (!contains ? true : filter ? filter.test(line) : line.toLowerCase().includes(needle));
  // Docker cuts to the tail before it picks a stream, so with a search or one stream
  // we read the window ourselves and keep the last matching lines.
  const scan = Boolean(contains) || stream !== 'both';
  const params = new URLSearchParams({ stdout: stream === 'stderr' ? '0' : '1', stderr: stream === 'stdout' ? '0' : '1', timestamps: '1', tail: scan ? 'all' : String(tail) });
  if (from !== null) params.set('since', String(from));
  if (to !== null) params.set('until', String(to));
  const kept = [];
  let pending = Buffer.alloc(0);
  const take = (buf, final) => {
    // Complete frames only (or complete lines with a TTY); the rest waits for the next chunk.
    let usable = buf;
    if (!tty) {
      let i = 0;
      while (i + 8 <= buf.length && i + 8 + buf.readUInt32BE(i + 4) <= buf.length) i += 8 + buf.readUInt32BE(i + 4);
      usable = buf.subarray(0, i);
      pending = buf.subarray(i);
    } else {
      const end = final ? buf.length : buf.lastIndexOf(10) + 1;
      usable = buf.subarray(0, end);
      pending = buf.subarray(end);
    }
    for (const [s, line] of logLines(usable, tty)) {
      if (!matches(line)) continue;
      kept.push(`${s === 'stderr' ? 'E ' : ''}${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line}`);
      if (kept.length > tail) kept.shift();
    }
  };
  const res = await docker(`/containers/${c.Id}/logs?${params}`, { onData: (chunk) => take(Buffer.concat([pending, chunk]), false), maxBytes: MAX_SCAN_BYTES });
  if (pending.length) take(pending, true);
  const header = [`container ${detail.Name.replace(/^\//, '')}, ${kept.length} lines${contains ? ` matching "${contains}"` : ''}${res.cut ? `, search stopped after ${MAX_SCAN_BYTES / 1024 / 1024} MB: narrow the time window` : ''} (E = stderr)`];
  if (detail.HostConfig?.LogConfig?.Type && !['json-file', 'local', 'journald'].includes(detail.HostConfig.LogConfig.Type)) header.push(`log driver ${detail.HostConfig.LogConfig.Type}: Docker may keep only part of the log`);
  return [...header, ...kept].join('\n');
}

function buildServer() {
  const server = new McpServer(
    { name: 'xenmcp-docker-agent', version: VERSION },
    { instructions: 'Read-only view of the containers on one Docker host: list_containers first, then inspect_container, container_logs (time windows and text search), container_stats and recent_events. Nothing can be started, stopped or changed.' },
  );
  const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const name = z.string().min(1).max(128).describe('Container name (as in list_containers) or id');

  server.registerTool('docker_info', { description: 'Docker version, operating system, CPUs, memory and the number of containers and images.', inputSchema: z.object({}), annotations: ro }, async () =>
    run(async () => {
      const i = await json('/info');
      return { docker: i.ServerVersion, os: i.OperatingSystem, kernel: i.KernelVersion, cpus: i.NCPU, memoryBytes: i.MemTotal, containers: { total: i.Containers, running: i.ContainersRunning, stopped: i.ContainersStopped, paused: i.ContainersPaused }, images: i.Images, storageDriver: i.Driver, logDriver: i.LoggingDriver, agent: VERSION, onlyContainers: ONLY.length ? ONLY : 'all (except label xenmcp.hide=true)' };
    }),
  );

  server.registerTool(
    'list_containers',
    { description: 'Containers with image, state, status (uptime), ports and compose project. Stopped ones too unless running_only.', inputSchema: z.object({ running_only: z.boolean().default(false) }), annotations: ro },
    async ({ running_only }) => run(async () => (await containers()).filter((c) => !running_only || c.State === 'running').map(summarizeContainer)),
  );

  server.registerTool(
    'inspect_container',
    { description: 'State, exit code, OOM kill, restart count and policy, health check, limits, log driver, mounts and networks of one container. Never its environment variables.', inputSchema: z.object({ container: name }), annotations: ro },
    async ({ container }) => run(async () => summarizeInspect(await json(`/containers/${(await find(container)).Id}/json`))),
  );

  server.registerTool(
    'container_logs',
    {
      description: `Log lines of one container with timestamps, newest last: the last N lines, a time window (since/until: 15m, 6h, 2d or an ISO time), stdout or stderr only, and a text search (contains; regex with regex: true). At most ${MAX_LINES} lines per call; page back with until.`,
      inputSchema: z.object({
        container: name,
        tail: z.number().int().min(1).max(MAX_LINES).default(100),
        since: z.string().max(40).optional(),
        until: z.string().max(40).optional(),
        stream: z.enum(['both', 'stdout', 'stderr']).default('both'),
        contains: z.string().min(1).max(200).optional(),
        regex: z.boolean().default(false),
      }),
      annotations: ro,
    },
    async (args) => run(() => readLogs(args)),
  );

  server.registerTool(
    'container_stats',
    { description: 'CPU (% of one core), memory, network and processes right now: one container, or all running ones (at most 30).', inputSchema: z.object({ container: name.optional() }), annotations: ro },
    async ({ container }) =>
      run(async () => {
        const list = container ? [await find(container)] : (await containers()).filter((c) => c.State === 'running').slice(0, 30);
        const out = [];
        for (let i = 0; i < list.length; i += 5) {
          out.push(...(await Promise.all(list.slice(i, i + 5).map(async (c) => summarizeStats((c.Names?.[0] ?? '').replace(/^\//, ''), await json(`/containers/${c.Id}/stats?stream=false`))))));
        }
        return out;
      }),
  );

  server.registerTool(
    'recent_events',
    { description: 'Container events (start, stop, die with exit code, kill, oom, restart, health status) in a window, default the last 24 hours, at most 7 days and 300 events.', inputSchema: z.object({ since: z.string().max(40).default('24h'), container: name.optional() }), annotations: ro },
    async ({ since, container }) =>
      run(async () => {
        const now = Math.floor(Date.now() / 1000);
        const from = Math.max(toUnix(since) ?? now - 86400, now - 7 * 86400);
        const only = container ? (await find(container)).Id : null;
        const visibleIds = new Set((await containers()).map((c) => c.Id));
        const filters = JSON.stringify({ type: ['container'], event: ['start', 'stop', 'die', 'kill', 'oom', 'restart', 'health_status'] });
        const res = await docker(`/events?${new URLSearchParams({ since: String(from), until: String(now), filters })}`);
        const events = res.body
          .toString('utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .filter((e) => (only ? e.Actor?.ID === only : visibleIds.has(e.Actor?.ID) || !e.Actor?.ID))
          .map((e) => ({ time: new Date((e.time ?? 0) * 1000).toISOString(), container: e.Actor?.Attributes?.name, action: e.Action ?? e.status, exitCode: e.Actor?.Attributes?.exitCode }));
        return events.slice(-300);
      }),
  );
  return server;
}

function same(given, want) {
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

const handler = createMcpHandler(() => buildServer());
const app = new Hono();
app.get('/health', (c) => c.json({ ok: true }));
app.all('/mcp', async (c) => {
  const ip = callerIp(getConnInfo(c).remote.address, c.req.header('x-forwarded-for'));
  if (!ALLOW_IPS.includes('*') && !ALLOW_IPS.some((rule) => ipIn(ip, rule))) {
    console.warn(`[agent] refused ${ip}: not in XENMCP_ALLOW_IPS`);
    return c.json({ error: 'address not allowed' }, 403);
  }
  const auth = c.req.header('authorization') ?? '';
  if (!/^Bearer\s+/i.test(auth) || !same(auth.replace(/^Bearer\s+/i, ''), KEY)) return c.json({ error: 'invalid key' }, 401);
  return handler.fetch(c.req.raw);
});
app.all('*', (c) => c.json({ error: 'not found' }, 404));
serve({ fetch: app.fetch, port: PORT, hostname: env.HOST ?? '0.0.0.0' }, () => console.log(`[xenmcp-docker-agent ${VERSION}] listening on ${PORT}; allowed: ${ALLOW_IPS.join(', ')}; containers: ${ONLY.length ? ONLY.join(', ') : 'all'}`));
