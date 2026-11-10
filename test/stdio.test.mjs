// The agent over stdio, as a local client or a directory's checker (Glama) starts it:
// no key and no Docker are needed to start and list the tools.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('stdio: starts without a key, lists six read-only tools, reports a missing Docker as a tool error', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['server.mjs', '--stdio'],
    env: { PATH: process.env.PATH ?? '', DOCKER_SOCKET: '/nonexistent/docker.sock' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '1' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['container_logs', 'container_stats', 'docker_info', 'inspect_container', 'list_containers', 'recent_events']);
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint));
    const info = await client.callTool({ name: 'docker_info', arguments: {} });
    assert.equal(info.isError, true);
    assert.match(info.content[0].text, /^Error: /);
  } finally {
    await client.close();
  }
});

test('http: still refuses to start without a key', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['server.mjs'], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /XENMCP_AGENT_KEY must have at least 32 characters/);
});
