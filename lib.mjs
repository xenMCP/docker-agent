// Pure helpers of the Docker agent: what may be asked of Docker, who may call,
// and how Docker's answers are cut down (no environment variables, ever).

/** The only Docker API paths the agent sends, all GET. Everything else is refused before it leaves. */
const ALLOWED = [
  /^\/version$/,
  /^\/info$/,
  /^\/containers\/json\?all=1$/,
  /^\/containers\/[A-Za-z0-9]{12,64}\/json$/,
  /^\/containers\/[A-Za-z0-9]{12,64}\/logs\?[A-Za-z0-9=&%._:-]*$/,
  /^\/containers\/[A-Za-z0-9]{12,64}\/stats\?stream=false$/,
  /^\/events\?[A-Za-z0-9=&%._:-]*$/,
];

export function allowedPath(path) {
  return ALLOWED.some((re) => re.test(path));
}

/** "90s", "15m", "6h", "2d" or an ISO time → Unix seconds; null when empty. Throws on anything else. */
export function toUnix(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null;
  const rel = /^(\d{1,6})\s*(s|m|h|d)$/i.exec(String(value).trim());
  if (rel) {
    const unit = { s: 1, m: 60, h: 3600, d: 86400 }[rel[2].toLowerCase()];
    return Math.floor(now / 1000) - Number(rel[1]) * unit;
  }
  const t = Date.parse(String(value));
  if (Number.isNaN(t)) throw new Error(`not a time: ${value} (use 15m, 6h, 2d or an ISO time)`);
  return Math.floor(t / 1000);
}

/** IPv4 in a CIDR ("46.225.57.217" or "10.0.0.0/8"); IPv6 only by exact match. */
export function ipIn(ip, rule) {
  const clean = ip.replace(/^::ffff:/, '');
  if (!rule.includes('/')) return clean === rule.replace(/^::ffff:/, '');
  const [base, bitsRaw] = rule.split('/');
  const bits = Number(bitsRaw);
  const num = (a) => a.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(clean) || !/^\d+\.\d+\.\d+\.\d+$/.test(base)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (num(clean) & mask) === (num(base) & mask);
}

const PRIVATE = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '::1'];

/**
 * The caller's address: the TCP peer, or, when the peer is a reverse proxy on a
 * private address, the last address it added to X-Forwarded-For.
 */
export function callerIp(peer, forwardedFor) {
  const p = (peer ?? '').replace(/^::ffff:/, '');
  if (forwardedFor && PRIVATE.some((r) => ipIn(p, r))) {
    const last = forwardedFor.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
    if (last) return last.replace(/^::ffff:/, '');
  }
  return p;
}

/** Names may be shown when listed (glob with *), when no list is set, and never with the label xenmcp.hide=true. */
export function visible(names, labels, only) {
  if (labels?.['xenmcp.hide'] === 'true') return false;
  if (!only.length) return true;
  const plain = names.map((n) => n.replace(/^\//, ''));
  return only.some((pattern) => {
    const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return plain.some((n) => re.test(n));
  });
}

const COMPOSE = ['com.docker.compose.project', 'com.docker.compose.service'];

/** One line per container for list_containers (labels: only compose project and service). */
export function summarizeContainer(c) {
  return {
    name: (c.Names?.[0] ?? '').replace(/^\//, ''),
    id: (c.Id ?? '').slice(0, 12),
    image: c.Image,
    state: c.State,
    status: c.Status,
    created: c.Created ? new Date(c.Created * 1000).toISOString() : null,
    ports: (c.Ports ?? []).map((p) => (p.PublicPort ? `${p.IP ?? ''}:${p.PublicPort}->${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`)),
    compose: Object.fromEntries(COMPOSE.filter((k) => c.Labels?.[k]).map((k) => [k.split('.').at(-1), c.Labels[k]])),
  };
}

/** inspect_container without what may hold secrets: no Env, no Cmd/Entrypoint arguments, no other labels. */
export function summarizeInspect(d) {
  const health = d.State?.Health;
  const lastCheck = health?.Log?.at(-1);
  return {
    name: (d.Name ?? '').replace(/^\//, ''),
    id: (d.Id ?? '').slice(0, 12),
    image: d.Config?.Image,
    created: d.Created,
    state: {
      status: d.State?.Status,
      running: d.State?.Running,
      restarting: d.State?.Restarting,
      oomKilled: d.State?.OOMKilled,
      exitCode: d.State?.ExitCode,
      error: d.State?.Error || null,
      startedAt: d.State?.StartedAt,
      finishedAt: d.State?.FinishedAt,
    },
    restartCount: d.RestartCount,
    restartPolicy: d.HostConfig?.RestartPolicy?.Name,
    health: health ? { status: health.Status, failingStreak: health.FailingStreak, lastExitCode: lastCheck?.ExitCode, lastOutput: lastCheck?.Output?.slice(0, 300) } : null,
    limits: { memoryBytes: d.HostConfig?.Memory || null, nanoCpus: d.HostConfig?.NanoCpus || null },
    logDriver: d.HostConfig?.LogConfig?.Type,
    mounts: (d.Mounts ?? []).map((m) => ({ type: m.Type, destination: m.Destination, readWrite: m.RW })),
    networks: Object.entries(d.NetworkSettings?.Networks ?? {}).map(([name, n]) => ({ name, ip: n.IPAddress || null })),
    ports: Object.keys(d.NetworkSettings?.Ports ?? {}),
    compose: Object.fromEntries(COMPOSE.filter((k) => d.Config?.Labels?.[k]).map((k) => [k.split('.').at(-1), d.Config.Labels[k]])),
  };
}

/** Docker's log stream: 8-byte frames (stream, size) unless the container has a TTY. Yields [stream, line]. */
export function* logLines(buffer, tty) {
  if (tty) {
    for (const line of buffer.toString('utf8').split('\n')) if (line) yield ['stdout', line];
    return;
  }
  let i = 0;
  let rest = { stdout: '', stderr: '' };
  while (i + 8 <= buffer.length) {
    const stream = buffer[i] === 2 ? 'stderr' : 'stdout';
    const size = buffer.readUInt32BE(i + 4);
    const text = rest[stream] + buffer.subarray(i + 8, i + 8 + size).toString('utf8');
    const parts = text.split('\n');
    rest[stream] = parts.pop() ?? '';
    for (const line of parts) yield [stream, line];
    i += 8 + size;
  }
  for (const [stream, line] of Object.entries(rest)) if (line) yield [stream, line];
  rest = null;
}

/** CPU in % of one core, memory without the page cache, from one stats sample. */
export function summarizeStats(name, s) {
  const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = s.cpu_stats?.online_cpus || s.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.cache ?? 0;
  const used = Math.max(0, (s.memory_stats?.usage ?? 0) - cache);
  const net = Object.values(s.networks ?? {}).reduce((a, n) => ({ rx: a.rx + (n.rx_bytes ?? 0), tx: a.tx + (n.tx_bytes ?? 0) }), { rx: 0, tx: 0 });
  return {
    name,
    cpuPercent: sysDelta > 0 ? Math.round((cpuDelta / sysDelta) * cpus * 1000) / 10 : 0,
    memoryBytes: used,
    memoryLimitBytes: s.memory_stats?.limit ?? null,
    networkRxBytes: net.rx,
    networkTxBytes: net.tx,
    pids: s.pids_stats?.current ?? null,
  };
}
