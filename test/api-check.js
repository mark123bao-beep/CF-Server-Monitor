#!/usr/bin/env node
// node --check test/api-check.js
// node test/api-check.js --help

const DEFAULT_BASE_URL = 'http://localhost:8787';
const MOCK_SERVER_ID = '550e8400-e29b-41d4-a716-446655440002';

const args = new Set(process.argv.slice(2));
const baseUrl = normalizeBaseUrl(getArgValue('--base-url') || process.env.BASE_URL || DEFAULT_BASE_URL);
const apiSecret = getArgValue('--api-secret') || process.env.API_SECRET || '';
const adminUsername = getArgValue('--admin-user') || process.env.ADMIN_USER || process.env.API_USER_NAME || 'admin';
const adminPassword = getArgValue('--admin-password') || process.env.ADMIN_PASSWORD || apiSecret;
const explicitServerId = getArgValue('--server-id') || process.env.SERVER_ID || '';
const includeWrite = args.has('--include-write') || process.env.INCLUDE_WRITE === 'true';
const timeoutMs = Number(getArgValue('--timeout') || process.env.TIMEOUT_MS || 10000);

const state = {
  token: '',
  turnstileEnabled: false,
  cookieAuth: false,
  serverId: explicitServerId,
  results: []
};

function getArgValue(name) {
  const prefix = `${name}=`;
  const arg = process.argv.slice(2).find(item => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

function normalizeBaseUrl(url) {
  return String(url || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function jsonBody(body) {
  return JSON.stringify(body ?? {});
}

function authHeaders() {
  return state.token ? { Authorization: `Bearer ${state.token}` } : {};
}

function isExpectedStatus(status, expected) {
  if (Array.isArray(expected)) return expected.includes(status);
  return status === expected;
}

function expectedText(expected) {
  return Array.isArray(expected) ? expected.join('/') : String(expected);
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      redirect: 'manual',
      ...options,
      headers: {
        ...(options.headers || {})
      },
      signal: controller.signal
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = text;
    }

    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      data,
      text
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error.name === 'AbortError' ? `请求超时：${timeoutMs}ms` : error.message
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runCase(testCase) {
  if (typeof testCase.skip === 'function') {
    const reason = testCase.skip();
    if (reason) {
      record('skip', testCase.name, '-', reason);
      return;
    }
  }

  const result = await testCase.run();
  const expected = testCase.expectedStatus;
  const pass = result.ok && isExpectedStatus(result.status, expected);

  if (pass) {
    record('pass', testCase.name, result.status, testCase.note || '');
  } else {
    const detail = result.ok
      ? `期望 ${expectedText(expected)}，实际 ${result.status}${result.text ? `，响应：${truncate(result.text)}` : ''}`
      : result.error;
    record('fail', testCase.name, result.status || '-', detail);
  }

  if (typeof testCase.after === 'function') {
    await testCase.after(result);
  }
}

function record(status, name, code, detail) {
  state.results.push({ status, name, code, detail });
  const label = status.toUpperCase().padEnd(4);
  const codeText = String(code).padEnd(3);
  console.log(`[${label}] ${codeText} ${name}${detail ? ` - ${detail}` : ''}`);
}

function truncate(text, max = 180) {
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function printUsage() {
  console.log(`本地接口测试工具\n\n用法：\n  node test/api-check.js [选项]\n\n选项：\n  --base-url=http://localhost:8787       本地服务地址，默认 ${DEFAULT_BASE_URL}\n  --api-secret=xxx                       API_SECRET，用于登录和可选写入测试\n  --admin-user=admin                     管理员用户名，默认 admin\n  --admin-password=xxx                   管理员密码，默认使用 API_SECRET\n  --server-id=uuid                       指定服务器 ID\n  --include-write                        启用会写入数据的 /update 成功测试\n  --timeout=10000                        单个请求超时时间\n\n环境变量同名可用：BASE_URL、API_SECRET、ADMIN_USER、ADMIN_PASSWORD、SERVER_ID、INCLUDE_WRITE、TIMEOUT_MS\n\n说明：\n  默认只执行安全或只读检查；重建数据库、清理历史、删除服务器等破坏性接口不会执行。\n  Cloudflare Turnstile 开启时，只验证未携带 token 会失败，不尝试绕过人机验证。`);
}

async function bootstrap() {
  if (args.has('--help') || args.has('-h')) {
    printUsage();
    process.exit(0);
  }

  console.log(`接口测试目标：${baseUrl}`);
  console.log(`写入测试：${includeWrite ? '开启' : '关闭'}`);
  console.log('');

  await runCase({
    name: 'GET /api/config',
    expectedStatus: 200,
    run: () => request('/api/config'),
    after: async result => {
      const data = result.data && result.data.data ? result.data.data : result.data;
      state.turnstileEnabled = data && data.turnstile_enabled === true;
      state.cookieAuth = data && data.cookie_auth === true;
    }
  });

  await runCase({
    name: 'POST /admin/api login 缺少密码',
    expectedStatus: 400,
    run: () => request('/admin/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonBody({ action: 'login', username: adminUsername })
    })
  });

  await runCase({
    name: 'POST /admin/api login 无效密码',
    expectedStatus: state.turnstileEnabled ? 403 : 401,
    run: () => request('/admin/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonBody({ action: 'login', username: adminUsername, password: '__invalid__' })
    }),
    note: state.turnstileEnabled ? 'Turnstile 开启，预期验证失败' : ''
  });

  await runCase({
    name: 'POST /admin/api login 成功',
    expectedStatus: 200,
    skip: () => {
      if (state.turnstileEnabled) return 'Turnstile 开启，跳过真实登录，仅测试验证失败';
      if (!adminPassword) return '缺少 --admin-password 或 --api-secret';
      return '';
    },
    run: () => request('/admin/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonBody({ action: 'login', username: adminUsername, password: adminPassword })
    }),
    after: async result => {
      if (result.status === 200 && result.data && result.data.token) {
        state.token = result.data.token;
      }
    }
  });

  const tests = [
    {
      name: 'GET /api/servers',
      expectedStatus: state.turnstileEnabled ? 403 : [200, 401],
      run: () => request('/api/servers'),
      note: state.turnstileEnabled ? 'Turnstile 开启，预期验证失败' : '',
      after: async result => {
        const data = result.data && result.data.data ? result.data.data : result.data;
        if (!state.serverId && data && Array.isArray(data.servers) && data.servers.length > 0) {
          state.serverId = data.servers[0].id;
        }
      }
    },
    {
      name: 'GET /api/server 缺少 ID',
      expectedStatus: state.turnstileEnabled ? 403 : [400, 401],
      run: () => request('/api/server'),
      note: state.turnstileEnabled ? 'Turnstile 开启，预期验证失败' : ''
    },
    {
      name: 'GET /api/history 缺少 ID',
      expectedStatus: state.turnstileEnabled ? 403 : [400, 401],
      run: () => request('/api/history'),
      note: state.turnstileEnabled ? 'Turnstile 开启，预期验证失败' : ''
    },
    {
      name: 'GET /api/history/all 缺少 ID',
      expectedStatus: state.turnstileEnabled ? 403 : [400, 401],
      run: () => request('/api/history/all'),
      note: state.turnstileEnabled ? 'Turnstile 开启，预期验证失败' : ''
    },
    {
      name: 'GET /api/ws HTTP 探测',
      expectedStatus: state.turnstileEnabled ? 403 : [101, 400, 426, 500, 503],
      run: () => request('/api/ws'),
      note: state.turnstileEnabled ? 'Turnstile 开启，预期验证失败' : 'WebSocket 仅做 HTTP 探测'
    },
    {
      name: 'GET /updateDatabase 未授权',
      expectedStatus: 401,
      run: () => request('/updateDatabase')
    },
    {
      name: 'GET /rebuild 未授权',
      expectedStatus: 401,
      run: () => request('/rebuild')
    },
    {
      name: 'GET /__do/health',
      expectedStatus: 200,
      run: () => request('/__do/health')
    },
    {
      name: 'POST /update 无效 secret',
      expectedStatus: 401,
      run: () => request('/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonBody({ id: state.serverId || MOCK_SERVER_ID, secret: '__invalid__', metrics: {} })
      })
    },
    {
      name: 'GET 不存在路径回退前端',
      expectedStatus: [200, 404],
      run: () => request('/__api_check_not_found__'),
      note: 'Worker 未命中 API 路由时会回退前端'
    }
  ];

  for (const test of tests) {
    await runCase(test);
  }

  if (state.token) {
    await runAuthorizedAdminCases();
  } else {
    record('skip', '后台已授权接口', '-', '未登录成功，跳过需要 Bearer Token 的只读/校验接口');
  }

  if (!state.serverId && state.token) {
    await tryLoadServerIdFromAdminList();
  }

  await runCase({
    name: 'GET /api/server 指定 ID',
    expectedStatus: state.turnstileEnabled ? 403 : [200, 401, 404],
    skip: () => state.serverId ? '' : '未发现服务器 ID，可通过 --server-id 指定',
    run: () => request(`/api/server?id=${encodeURIComponent(state.serverId)}`),
    note: state.turnstileEnabled ? 'Turnstile 开启，预期验证失败' : ''
  });

  await runCase({
    name: 'GET /api/history 指定 ID',
    expectedStatus: state.turnstileEnabled ? 403 : [200, 401, 404],
    skip: () => state.serverId ? '' : '未发现服务器 ID，可通过 --server-id 指定',
    run: () => request(`/api/history?id=${encodeURIComponent(state.serverId)}&metric=cpu&hours=1`),
    note: state.turnstileEnabled ? 'Turnstile 开启，预期验证失败' : ''
  });

  await runCase({
    name: 'GET /api/history/all 指定 ID',
    expectedStatus: state.turnstileEnabled ? 403 : [200, 401, 404],
    skip: () => state.serverId ? '' : '未发现服务器 ID，可通过 --server-id 指定',
    run: () => request(`/api/history/all?id=${encodeURIComponent(state.serverId)}&hours=1`),
    note: state.turnstileEnabled ? 'Turnstile 开启，预期验证失败' : ''
  });

  await runCase({
    name: 'POST /update 成功上报',
    expectedStatus: 200,
    skip: () => {
      if (!includeWrite) return '默认跳过写入测试，使用 --include-write 开启';
      if (!apiSecret) return '缺少 --api-secret 或 API_SECRET';
      if (!state.serverId) return '未发现服务器 ID，可通过 --server-id 指定';
      return '';
    },
    run: () => request('/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonBody({
        id: state.serverId,
        secret: apiSecret,
        metrics: buildMockMetrics()
      })
    })
  });

  printSummary();
}

async function runAuthorizedAdminCases() {
  const headers = {
    'Content-Type': 'application/json',
    ...authHeaders()
  };

  const tests = [
    {
      name: 'POST /admin/api get_settings',
      expectedStatus: 200,
      run: () => request('/admin/api', {
        method: 'POST',
        headers,
        body: jsonBody({ action: 'get_settings' })
      })
    },
    {
      name: 'POST /admin/api list',
      expectedStatus: 200,
      run: () => request('/admin/api', {
        method: 'POST',
        headers,
        body: jsonBody({ action: 'list' })
      }),
      after: async result => {
        if (!state.serverId && result.data && Array.isArray(result.data.servers) && result.data.servers.length > 0) {
          state.serverId = result.data.servers[0].id;
        }
      }
    },
    {
      name: 'POST /admin/api 未知 action',
      expectedStatus: 400,
      run: () => request('/admin/api', {
        method: 'POST',
        headers,
        body: jsonBody({ action: '__unknown__' })
      })
    },
    {
      name: 'POST /admin/api add 参数校验',
      expectedStatus: 400,
      run: () => request('/admin/api', {
        method: 'POST',
        headers,
        body: jsonBody({ action: 'add', name: '' })
      })
    },
    {
      name: 'POST /admin/api edit 参数校验',
      expectedStatus: 400,
      run: () => request('/admin/api', {
        method: 'POST',
        headers,
        body: jsonBody({ action: 'edit', id: 'invalid-id' })
      })
    },
    {
      name: 'POST /admin/api delete 参数校验',
      expectedStatus: 400,
      run: () => request('/admin/api', {
        method: 'POST',
        headers,
        body: jsonBody({ action: 'delete', id: 'invalid-id' })
      })
    },
    {
      name: 'POST /admin/api batch_delete 参数校验',
      expectedStatus: 400,
      run: () => request('/admin/api', {
        method: 'POST',
        headers,
        body: jsonBody({ action: 'batch_delete', ids: [] })
      })
    },
    {
      name: 'POST /admin/api save_order 参数校验',
      expectedStatus: 400,
      run: () => request('/admin/api', {
        method: 'POST',
        headers,
        body: jsonBody({ action: 'save_order', orders: [] })
      })
    },
    {
      name: 'POST /admin/api clean_history 参数校验',
      expectedStatus: 400,
      run: () => request('/admin/api', {
        method: 'POST',
        headers,
        body: jsonBody({ action: 'clean_history', days: 0 })
      })
    }
  ];

  for (const test of tests) {
    await runCase(test);
  }
}

async function tryLoadServerIdFromAdminList() {
  const result = await request('/admin/api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders()
    },
    body: jsonBody({ action: 'list' })
  });

  if (result.status === 200 && result.data && Array.isArray(result.data.servers) && result.data.servers.length > 0) {
    state.serverId = result.data.servers[0].id;
  }
}

function buildMockMetrics() {
  return {
    cpu: 12.3,
    ram: 45.6,
    disk: 37.8,
    load_avg: '0.12 0.20 0.18',
    net_in_speed: 1024,
    net_out_speed: 2048,
    net_rx: 123456789,
    net_tx: 987654321,
    processes: 128,
    tcp_conn: 32,
    udp_conn: 8,
    ping_ct: 30,
    ping_cu: 40,
    ping_cm: 50,
    ping_bd: 60,
    ram_total: 8192,
    ram_used: 3735,
    swap_total: 1024,
    swap_used: 64,
    disk_total: 102400,
    disk_used: 38707,
    cpu_cores: 2,
    cpu_info: 'Local API Check CPU',
    arch: process.arch,
    os: process.platform,
    ip_v4: '127.0.0.1',
    ip_v6: '::1',
    boot_time: new Date(Date.now() - 3600000).toISOString()
  };
}

function printSummary() {
  const counts = state.results.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});

  console.log('');
  console.log(`汇总：通过 ${counts.pass || 0}，失败 ${counts.fail || 0}，跳过 ${counts.skip || 0}`);

  if (counts.fail > 0) {
    process.exitCode = 1;
  }
}

bootstrap().catch(error => {
  console.error(error);
  process.exit(1);
});
