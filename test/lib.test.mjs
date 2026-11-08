import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedPath, callerIp, ipIn, logLines, summarizeInspect, summarizeStats, toUnix, visible } from '../lib.mjs';

const ID = 'a1b2c3d4e5f6a1b2c3d4e5f6';

test('only reading GET paths reach Docker', () => {
  for (const ok of ['/version', '/info', '/containers/json?all=1', `/containers/${ID}/json`, `/containers/${ID}/logs?stdout=1&stderr=1&timestamps=1&tail=100&since=1700000000`, `/containers/${ID}/stats?stream=false`, '/events?since=1&until=2&filters=%7B%22type%22%3A%5B%22container%22%5D%7D']) {
    assert.ok(allowedPath(ok), ok);
  }
  for (const bad of [`/containers/${ID}/stop`, `/containers/${ID}/exec`, `/containers/${ID}/kill`, '/containers/create', `/containers/${ID}`, '/images/json', '/exec/abc/start', `/containers/${ID}/archive?path=/etc`, `/containers/../../info`, `/containers/${ID}/logs/../stop`, '/build', '/volumes', `/containers/${ID}/json?x=/stop`]) {
    assert.ok(!allowedPath(bad), bad);
  }
});

test('times: relative and ISO', () => {
  const now = Date.UTC(2026, 10, 8, 12, 0, 0);
  assert.equal(toUnix('15m', now), now / 1000 - 900);
  assert.equal(toUnix('2d', now), now / 1000 - 172800);
  assert.equal(toUnix('2026-11-08T03:12:00Z', now), Date.UTC(2026, 10, 8, 3, 12) / 1000);
  assert.equal(toUnix(undefined, now), null);
  assert.throws(() => toUnix('yesterday', now));
});

test('caller address: peer, or the last X-Forwarded-For hop behind a local proxy', () => {
  assert.equal(callerIp('203.0.113.9', '46.225.57.217'), '203.0.113.9');
  assert.equal(callerIp('127.0.0.1', '1.2.3.4, 46.225.57.217'), '46.225.57.217');
  assert.equal(callerIp('::ffff:172.18.0.1', '46.225.57.217'), '46.225.57.217');
  assert.ok(ipIn('46.225.57.217', '46.225.57.217'));
  assert.ok(ipIn('10.1.2.3', '10.0.0.0/8'));
  assert.ok(!ipIn('11.1.2.3', '10.0.0.0/8'));
});

test('hidden containers: label and name list', () => {
  assert.ok(visible(['/web'], {}, []));
  assert.ok(!visible(['/web'], { 'xenmcp.hide': 'true' }, []));
  assert.ok(visible(['/app-web-1'], {}, ['app-*']));
  assert.ok(!visible(['/db'], {}, ['app-*', 'web']));
});

test('inspect never returns environment, command or other labels', () => {
  const out = summarizeInspect({
    Name: '/db',
    Id: ID,
    Config: { Image: 'postgres:16', Env: ['POSTGRES_PASSWORD=supersecret'], Cmd: ['--password=supersecret'], Labels: { 'com.docker.compose.project': 'shop', 'traefik.http.middlewares.auth.basicauth.users': 'admin:$apr1$hash' } },
    Args: ['--password=supersecret'],
    State: { Status: 'running', Running: true, ExitCode: 0, OOMKilled: false, Health: { Status: 'healthy', FailingStreak: 0, Log: [{ ExitCode: 0, Output: 'ok' }] } },
    HostConfig: { RestartPolicy: { Name: 'always' }, LogConfig: { Type: 'json-file' } },
    Mounts: [{ Type: 'volume', Destination: '/var/lib/postgresql/data', RW: true }],
    RestartCount: 2,
  });
  const text = JSON.stringify(out);
  assert.ok(!text.includes('supersecret') && !text.includes('apr1'));
  assert.equal(out.compose.project, 'shop');
  assert.equal(out.restartCount, 2);
  assert.equal(out.health.status, 'healthy');
});

test('log frames: stdout and stderr, split lines, TTY', () => {
  const frame = (stream, text) => {
    const body = Buffer.from(text);
    const head = Buffer.alloc(8);
    head[0] = stream;
    head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  const buf = Buffer.concat([frame(1, 'a 1\nb '), frame(1, '2\n'), frame(2, 'boom\n')]);
  assert.deepEqual([...logLines(buf, false)], [['stdout', 'a 1'], ['stdout', 'b 2'], ['stderr', 'boom']]);
  assert.deepEqual([...logLines(Buffer.from('x\ny\n'), true)], [['stdout', 'x'], ['stdout', 'y']]);
});

test('stats: CPU % and memory without cache', () => {
  const s = summarizeStats('web', { cpu_stats: { cpu_usage: { total_usage: 300 }, system_cpu_usage: 2000, online_cpus: 4 }, precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 }, memory_stats: { usage: 1000, limit: 4000, stats: { inactive_file: 200 } }, networks: { eth0: { rx_bytes: 5, tx_bytes: 7 } } });
  assert.equal(s.cpuPercent, 80);
  assert.equal(s.memoryBytes, 800);
  assert.equal(s.networkTxBytes, 7);
});
