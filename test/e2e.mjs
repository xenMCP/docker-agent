// The agent against a real Docker (run as a user who may read the socket):
// starts two test containers, the agent, then calls every tool as XenMCP does.
//   node test/e2e.mjs
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const KEY = 'e2e-key-0123456789abcdef0123456789abcdef';
const PORT = 18090;
const sh = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const ok = (cond, msg) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok - ${msg}`);
};
const IMAGE = process.env.TEST_IMAGE ?? 'busybox:1.36';

/** A raw MCP POST: status code and body (fetch would not let us set X-Forwarded-For freely). */
function post(body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${KEY}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

let agent;
try {
  for (const n of ['xa-web', 'xa-crash', 'xa-hidden']) execFileSync('docker', ['rm', '-f', n], { stdio: 'ignore' });
  sh('run', '-d', '--name', 'xa-web', '-e', 'DB_PASSWORD=supersecret', IMAGE, 'sh', '-c', 'i=0; while true; do i=$((i+1)); echo "request $i ok"; [ $((i % 5)) -eq 0 ] && echo "ERROR timeout on db" >&2; sleep 0.05; done');
  sh('run', '-d', '--name', 'xa-crash', IMAGE, 'sh', '-c', 'echo starting; exit 3');
  sh('run', '-d', '--name', 'xa-hidden', '--label', 'xenmcp.hide=true', IMAGE, 'sleep', '600');
  // Wait for enough log lines and for the crash, not a fixed time (image pulls vary).
  for (let i = 0; i < 150; i++) {
    const lines = execFileSync('docker', ['logs', 'xa-web'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').length;
    if (lines > 30 && sh('inspect', '-f', '{{.State.Status}}', 'xa-crash') === 'exited') break;
    await new Promise((r) => setTimeout(r, 100));
  }

  agent = spawn('node', ['server.mjs'], { env: { PATH: process.env.PATH, XENMCP_AGENT_KEY: KEY, XENMCP_ALLOW_IPS: '127.0.0.1,46.225.57.217', PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => agent.stdout.on('data', (d) => d.toString().includes('listening') && resolve()));

  const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
  const c = new Client({ name: 'e2e', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), { requestInit: { headers: { authorization: `Bearer ${KEY}` } } }));
  const call = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    return { r, t: r.content.map((x) => x.text).join('') };
  };
  const tools = (await c.listTools()).tools;
  ok(tools.length === 6 && tools.every((t) => t.annotations?.readOnlyHint), 'six tools, all read-only');

  ok(JSON.parse((await call('docker_info')).t).docker, 'docker_info');
  const list = JSON.parse((await call('list_containers')).t);
  const names = list.map((x) => x.name);
  ok(names.includes('xa-web') && names.includes('xa-crash') && !names.includes('xa-hidden'), 'list_containers: hidden one left out');
  const crash = JSON.parse((await call('inspect_container', { container: 'xa-crash' })).t);
  ok(crash.state.exitCode === 3 && crash.state.status === 'exited', 'inspect_container: exit code');
  const web = await call('inspect_container', { container: 'xa-web' });
  ok(!web.t.includes('supersecret') && !web.t.includes('DB_PASSWORD'), 'inspect_container: no environment');
  ok((await call('inspect_container', { container: 'xa-hidden' })).r.isError, 'hidden container is not found');

  const tail = (await call('container_logs', { container: 'xa-web', tail: 5 })).t.split('\n');
  ok(tail.length === 6 && /request \d+ ok/.test(tail.at(-1)), 'container_logs: last 5 lines with timestamps');
  const errText = (await call('container_logs', { container: 'xa-web', stream: 'stderr', tail: 3 })).t;
  if (process.env.DEBUG) console.log(errText);
  const errors = errText.split('\n').slice(1);
  ok(errors.length === 3 && errors.every((l) => l.startsWith('E ') && l.includes('ERROR timeout')), 'container_logs: stderr only');
  const found = (await call('container_logs', { container: 'xa-web', contains: 'timeout', since: '10m', tail: 2 })).t;
  ok(found.includes('matching "timeout"') && found.split('\n').length === 3, 'container_logs: search in a window');
  const rx = (await call('container_logs', { container: 'xa-web', contains: 'request \\d+0 ok', regex: true, tail: 1 })).t;
  ok(/request \d+0 ok/.test(rx), 'container_logs: regex');
  ok((await call('container_logs', { container: 'xa-crash' })).t.includes('starting'), 'container_logs: a stopped container');
  ok((await call('container_logs', { container: 'xa-web', tail: 501 })).r.isError, 'container_logs: more than 500 lines refused');

  const stats = JSON.parse((await call('container_stats', { container: 'xa-web' })).t);
  ok(stats[0].name === 'xa-web' && stats[0].memoryBytes > 0, 'container_stats');
  const events = JSON.parse((await call('recent_events', { since: '1h' })).t);
  ok(events.some((e) => e.container === 'xa-crash' && e.action === 'die' && e.exitCode === '3') && !events.some((e) => e.container === 'xa-hidden'), 'recent_events: die with exit code, hidden left out');
  await c.close();

  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } };
  ok((await post(init, { authorization: 'Bearer wrong' })).status === 401, 'wrong key refused');
  ok((await post(init, { 'x-forwarded-for': '203.0.113.5' })).status === 403, 'behind a local proxy: a foreign address refused');
  ok((await post(init, { 'x-forwarded-for': '203.0.113.5, 46.225.57.217' })).status === 200, 'behind a local proxy: XenMCP’s address allowed');
  const stop = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'stop_container', arguments: { container: 'xa-web' } } });
  ok(!/"result":\{"content"/.test(stop.text) && sh('inspect', '-f', '{{.State.Running}}', 'xa-web') === 'true', 'no tool can stop a container');
  console.log('all agent checks passed');
} finally {
  agent?.kill();
  for (const n of ['xa-web', 'xa-crash', 'xa-hidden']) execFileSync('docker', ['rm', '-f', n], { stdio: 'ignore' });
}
