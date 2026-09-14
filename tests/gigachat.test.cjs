const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const hostScript = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');

function pluginContext(api = {}) {
  const context = vm.createContext({
    console,
    setTimeout() {},
    window: { parent: { ea: {} } },
  });
  vm.runInContext(inlineScript, context);
  context.PluginAPI = api;
  if (api.getSecret || api.setSecret) {
    context.window.parent.__gigachatAssistantSecretBridge = {
      get: () => api.getSecret && api.getSecret(),
      set: value => api.setSecret && api.setSecret(value),
    };
  }
  return context;
}

function fakeDesktopTransport(responses) {
  const calls = [];
  const https = {
    request(url, options, onResponse) {
      const request = new EventEmitter();
      request.end = body => {
        calls.push({ url, options, body });
        const response = new EventEmitter();
        response.statusCode = responses[calls.length - 1].status;
        response.setEncoding = () => {};
        onResponse(response);
        queueMicrotask(() => {
          response.emit('data', responses[calls.length - 1].body);
          response.emit('end');
        });
      };
      request.destroy = error => request.emit('error', error);
      return request;
    },
  };
  const api = {
    async executeNodeScript({ script, args }) {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const result = await new AsyncFunction('require', 'args', script)(name => {
        if (name === 'https') return https;
        if (name === 'tls') return { getCACertificates: type => type === 'system' ? ['system-ca'] : ['node-ca'] };
        if (name === 'crypto') return { randomUUID: () => '123e4567-e89b-42d3-a456-426614174000' };
        throw new Error('Unexpected module');
      }, args);
      return { success: true, result };
    },
  };
  return { api, calls };
}

test('OAuth request uses Basic, UUIDv4, PERS scope and desktop transport', async () => {
  const transport = fakeDesktopTransport([{ status: 200, body: '{}' }]);
  const ctx = pluginContext(transport.api);
  const reply = await ctx.nodeRequest('oauth', 'encoded-key', 'scope=GIGACHAT_API_PERS');
  assert.equal(reply.status, 200);
  assert.equal(transport.calls[0].url, 'https://api.giga.chat/api/v2/oauth');
  assert.equal(transport.calls[0].options.headers.Authorization, 'Basic encoded-key');
  assert.equal(transport.calls[0].options.headers.RqUID, '123e4567-e89b-42d3-a456-426614174000');
  assert.equal(transport.calls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(transport.calls[0].options.headers['User-Agent'], 'SuperProductivity-GigaChat-Assistant');
  assert.deepEqual(transport.calls[0].options.ca, ['node-ca', 'system-ca']);
  assert.equal(transport.calls[0].body, 'scope=GIGACHAT_API_PERS');
});

test('legacy OAuth transport keeps Basic auth and PERS body', async () => {
  const transport = fakeDesktopTransport([{ status: 200, body: '{}' }]);
  const ctx = pluginContext(transport.api);
  await ctx.nodeRequest('oauth-legacy', 'dummy-key', 'scope=GIGACHAT_API_PERS');
  assert.equal(transport.calls[0].url, 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth');
  assert.equal(transport.calls[0].options.headers.Authorization, 'Basic dummy-key');
  assert.equal(transport.calls[0].body, 'scope=GIGACHAT_API_PERS');
});

test('HTML gateway 403 falls back to legacy OAuth and remembers the working route', async () => {
  const ctx = pluginContext();
  const calls = [];
  ctx.nodeRequest = async kind => {
    calls.push(kind);
    return kind === 'oauth'
      ? { status: 403, body: '<html><h1>403 Forbidden</h1></html>' }
      : { status: 200, body: JSON.stringify({ access_token: 'fresh', expires_at: Math.ceil(Date.now() / 1000) + 1800 }) };
  };
  assert.equal((await ctx.requestAccessToken('dummy-key')).token, 'fresh');
  await ctx.requestAccessToken('dummy-key');
  assert.deepEqual(calls, ['oauth', 'oauth-legacy', 'oauth-legacy']);
});

test('JSON authorization 403 does not fall back or mislabel the gateway', async () => {
  const ctx = pluginContext();
  const calls = [];
  ctx.nodeRequest = async kind => { calls.push(kind); return { status: 403, body: '{"message":"Permission denied"}' }; };
  await assert.rejects(ctx.requestAccessToken('dummy-key'), /Check the Authorization Key and PERS access/);
  assert.deepEqual(calls, ['oauth']);
});

test('host-side bridge saves secrets and removes itself on unload', async () => {
  const secrets = new Map();
  let cleanup;
  const host = vm.createContext({
    window: {},
    PluginAPI: {
      getSecret: async key => secrets.get(key) || null,
      setSecret: async (key, value) => { secrets.set(key, value); },
      onUnload: callback => { cleanup = callback; },
    },
  });
  vm.runInContext(hostScript, host);
  const bridge = host.window.__gigachatAssistantSecretBridge;
  await bridge.set('dummy-key');
  assert.equal(await bridge.get(), 'dummy-key');
  assert.equal(secrets.get('gigachat-authorization-key'), 'dummy-key');
  cleanup();
  assert.equal(host.window.__gigachatAssistantSecretBridge, undefined);
});

test('chat request uses Bearer and GigaChat endpoint', async () => {
  const transport = fakeDesktopTransport([{ status: 200, body: '{}' }]);
  const ctx = pluginContext(transport.api);
  await ctx.nodeRequest('chat', 'access-token', '{"test":true}');
  assert.equal(transport.calls[0].url, 'https://api.giga.chat/v1/chat/completions');
  assert.equal(transport.calls[0].options.headers.Authorization, 'Bearer access-token');
  assert.equal(transport.calls[0].body, '{"test":true}');
});

test('models request uses GET without a body and does not embed credentials in source', async () => {
  const transport = fakeDesktopTransport([{ status: 200, body: '{"data":[]}' }]);
  let source;
  const execute = transport.api.executeNodeScript;
  transport.api.executeNodeScript = async request => { source = request.script; return execute(request); };
  const ctx = pluginContext(transport.api);
  await ctx.nodeRequest('models', 'test-access-token');
  assert.equal(transport.calls[0].url, 'https://api.giga.chat/v1/models');
  assert.equal(transport.calls[0].options.method, 'GET');
  assert.equal(transport.calls[0].options.headers.Authorization, 'Bearer test-access-token');
  assert.equal(transport.calls[0].body, undefined);
  assert.doesNotMatch(source, /test-access-token/);
  assert.doesNotMatch(source, /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/);
});

test('Node transport surfaces a useful error and redacts credentials', async () => {
  const ctx = pluginContext({ executeNodeScript: async () => ({ success: false, error: 'Permission denied for dummy-key' }) });
  await assert.rejects(ctx.nodeRequest('oauth', 'dummy-key', ''), /Permission denied for \[redacted\]/);
});

test('Node transport unwraps certificate errors without disabling TLS verification', async () => {
  const ctx = pluginContext({ executeNodeScript: async () => ({ success: false, error: '{"__error":"unable to get local issuer certificate"}' }) });
  await assert.rejects(ctx.nodeRequest('oauth', 'dummy-key', ''), /unable to get local issuer certificate.*trusted root certificates/);
});

test('model list includes only unique chat models and retries a stale token once', async () => {
  const ctx = pluginContext();
  let oauth = 0;
  let models = 0;
  ctx.requestAccessToken = async () => ({ token: `fresh-${++oauth}`, expiresAt: Date.now() + 1800000 });
  ctx.nodeRequest = async kind => {
    if (kind !== 'models') throw new Error('Unexpected request');
    models++;
    return models === 1 ? { status: 401, body: '{}' } : { status: 200, body: JSON.stringify({ data: [
      { id: 'GigaChat-2-Max', type: 'chat' }, { id: 'Embeddings', type: 'embedder' },
      { id: 'GigaChat-2-Max', type: 'chat' }, { id: 'GigaChat-2-Lite', type: 'chat' },
    ] }) };
  };
  const result = await ctx.loadAvailableModels('dummy-key');
  assert.equal(oauth, 2);
  assert.equal(models, 2);
  assert.deepEqual(Array.from(result.models), ['GigaChat-2-Max', 'GigaChat-2-Lite']);
});

test('checking a new key loads models into the selector without storing the key', async () => {
  let stored = false;
  const ctx = pluginContext({ setSecret: async () => { stored = true; } });
  const fields = {
    'cfg-authKey': { value: 'new-key' },
    'cfg-model': { value: '' },
    'cfg-connection-status': {},
  };
  ctx.document = { getElementById: id => fields[id] };
  ctx.loadAvailableModels = async key => {
    assert.equal(key, 'new-key');
    return { models: ['GigaChat-2-Lite', 'GigaChat-2-Max'], token: 'token', expiresAt: Date.now() + 1800000 };
  };
  ctx.renderModelOptions = models => { fields['cfg-model'].value = models[0]; };
  await ctx.checkSettingsKey(true);
  assert.equal(fields['cfg-model'].value, 'GigaChat-2-Lite');
  assert.match(fields['cfg-connection-status'].textContent, /Key works/);
  assert.equal(stored, false);
});

test('model dropdown renders only returned model IDs and preserves a valid choice', () => {
  const ctx = pluginContext();
  const select = { options: [], value: '', appendChild(option) { this.options.push(option); } };
  ctx.document = {
    getElementById: () => select,
    createElement: tag => { assert.equal(tag, 'option'); return {}; },
  };
  ctx.renderModelOptions(['GigaChat-2-Lite', 'GigaChat-2-Max'], 'GigaChat-2-Max');
  assert.equal(select.disabled, false);
  assert.deepEqual(select.options.map(option => option.value), ['GigaChat-2-Lite', 'GigaChat-2-Max']);
  assert.equal(select.value, 'GigaChat-2-Max');
});

test('saving a new key validates it and persists the selected available model', async () => {
  const ctx = pluginContext({ executeNodeScript: async () => {} });
  let savedKey = null;
  ctx.window.parent.__gigachatAssistantSecretBridge = {
    get: async () => savedKey,
    set: async value => { savedKey = value; },
  };
  const fields = {
    'cfg-authKey': { value: 'new-key' },
    'cfg-model': { value: '' },
    'cfg-maxTokens': { value: '1024' },
    'cfg-temperature': { value: '0.5' },
    'cfg-connection-status': {},
    'chat-container': {},
  };
  ctx.document = { getElementById: id => fields[id] };
  ctx.loadAvailableModels = async () => ({ models: ['GigaChat-2-Max'], token: 'token', expiresAt: Date.now() + 1800000 });
  ctx.renderModelOptions = models => { fields['cfg-model'].value = models[0]; };
  ctx.saveConfig = async cfg => { ctx.savedConfig = cfg; };
  ctx.closeSettings = () => {};
  ctx.showWelcome = () => {};
  ctx.showSnack = () => {};
  await ctx.doSaveSettings();
  assert.equal(savedKey, 'new-key');
  assert.equal(ctx.savedConfig.model, 'GigaChat-2-Max');
  assert.equal(ctx.accessToken, 'token');
});

test('an invalid new key cannot be saved', async () => {
  const ctx = pluginContext({ executeNodeScript: async () => {} });
  let writes = 0;
  ctx.window.parent.__gigachatAssistantSecretBridge = {
    get: async () => null,
    set: async () => { writes++; },
  };
  const fields = {
    'cfg-authKey': { value: 'bad-key' },
    'cfg-model': { value: '' },
    'cfg-connection-status': {},
  };
  ctx.document = { getElementById: id => fields[id] };
  ctx.loadAvailableModels = async () => { throw new Error('GigaChat OAuth failed (HTTP 401).'); };
  await ctx.doSaveSettings();
  assert.equal(writes, 0);
  assert.match(fields['cfg-connection-status'].textContent, /HTTP 401/);
});

test('token expiry is normalized and concurrent refreshes share one OAuth call', async () => {
  let oauthCalls = 0;
  const ctx = pluginContext({ getSecret: async () => 'encoded-key', executeNodeScript: async () => {} });
  ctx.nodeRequest = async () => {
    oauthCalls++;
    await Promise.resolve();
    return { status: 200, body: JSON.stringify({ access_token: 'fresh', expires_at: Math.ceil(Date.now() / 1000) + 1800 }) };
  };
  const tokens = await Promise.all([ctx.getAccessToken(), ctx.getAccessToken()]);
  assert.equal(tokens[0], 'fresh');
  assert.equal(tokens[1], 'fresh');
  assert.equal(oauthCalls, 1);
  assert.ok(ctx.expiresAt > Date.now() + 1700000);
  await ctx.getAccessToken();
  assert.equal(oauthCalls, 1);
  ctx.expiresAt = Date.now() + 1000;
  await ctx.getAccessToken();
  assert.equal(oauthCalls, 2);
});

test('chat payload uses functions and retries one 401 with a new token', async () => {
  const ctx = pluginContext({ executeNodeScript: async () => {} });
  ctx.config = { model: 'GigaChat', maxTokens: 1024, temperature: 0.5 };
  const tokens = ['old', 'new'];
  ctx.getAccessToken = async () => tokens.shift();
  const requests = [];
  ctx.nodeRequest = async (kind, token, body) => {
    requests.push({ kind, token, body: JSON.parse(body) });
    return requests.length === 1
      ? { status: 401, body: '{}' }
      : { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) };
  };
  await ctx.callGigaChat([{ role: 'user', content: 'hello' }]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].token, 'old');
  assert.equal(requests[1].token, 'new');
  assert.equal(requests[0].body.function_call, 'auto');
  assert.equal(requests[0].body.functions[0].name, 'create_task');
  assert.equal(requests[0].body.tools, undefined);
  assert.equal(requests[0].body.messages[0].role, 'system');
});

function chatContext(responses) {
  const ctx = pluginContext({ executeNodeScript: async () => {} });
  ctx.config = { model: 'GigaChat' };
  ctx.hasAuthKey = true;
  ctx.messages = [];
  ctx.buildContext = async () => '{}';
  ctx.displayMessage = () => {};
  ctx.displayActions = () => {};
  ctx.showThinking = () => ({});
  ctx.removeThinking = () => {};
  ctx.updateSendBtn = () => {};
  ctx.autoNameConversation = () => {};
  ctx.updateConvSelector = () => {};
  ctx.saveConversations = () => {};
  ctx.displayError = message => { ctx.lastError = message; };
  let index = 0;
  ctx.callGigaChat = async () => responses[Math.min(index++, responses.length - 1)];
  return ctx;
}

test('function result follows assistant state and is valid JSON', async () => {
  const ctx = chatContext([
    { choices: [{ finish_reason: 'function_call', message: {
      role: 'assistant', content: '', functions_state_id: 'state-id',
      function_call: { name: 'create_task', arguments: { title: 'Example' } },
    } }] },
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Done' } }] },
  ]);
  let calls = 0;
  ctx.executeTool = async () => { calls++; return { success: true }; };
  await ctx.sendMessage('Create a task');
  assert.equal(calls, 1);
  assert.equal(ctx.messages[1].functions_state_id, 'state-id');
  assert.equal(ctx.messages[1].function_call.name, 'create_task');
  assert.equal(ctx.messages[2].role, 'function');
  assert.equal(ctx.messages[2].name, 'create_task');
  assert.equal(JSON.parse(ctx.messages[2].content).success, true);
});

test('invalid function arguments never execute a tool', async () => {
  const ctx = chatContext([{ choices: [{ finish_reason: 'function_call', message: {
    function_call: { name: 'create_task', arguments: '{invalid' },
  } }] }]);
  let calls = 0;
  ctx.executeTool = async () => { calls++; return {}; };
  await ctx.sendMessage('Create a task');
  assert.equal(calls, 0);
  assert.match(ctx.lastError, /invalid function arguments/);
});

test('schema-invalid arguments never execute a tool', async () => {
  const ctx = chatContext([{ choices: [{ finish_reason: 'function_call', message: {
    function_call: { name: 'create_task', arguments: {} },
  } }] }]);
  let calls = 0;
  ctx.executeTool = async () => { calls++; return {}; };
  await ctx.sendMessage('Create a task');
  assert.equal(calls, 0);
  assert.match(ctx.lastError, /invalid function arguments/);
});

test('function loop stops after ten executions', async () => {
  const ctx = chatContext([{ choices: [{ finish_reason: 'function_call', message: {
    function_call: { name: 'get_tasks', arguments: {} },
  } }] }]);
  let calls = 0;
  ctx.executeTool = async () => { calls++; return {}; };
  await ctx.sendMessage('Repeat');
  assert.equal(calls, 10);
  assert.match(ctx.lastError, /Maximum number/);
});

test('migration removes synced OpenAI key and conversations once', async () => {
  let stored = JSON.stringify({
    'ai-assistant-config': { apiKey: 'old-secret', model: 'gpt-4o' },
    'ai-assistant-conversations': { list: [{ messages: [] }] },
    'ai-assistant-conversation': [{ role: 'user', content: 'old' }],
    unrelated: 1,
  });
  const ctx = pluginContext({
    loadSyncedData: async () => stored,
    persistDataSynced: async value => { stored = value; },
  });
  await ctx.migrateLegacyData();
  const data = JSON.parse(stored);
  assert.equal(data['ai-assistant-config'], undefined);
  assert.equal(data['ai-assistant-conversations'], undefined);
  assert.equal(data['ai-assistant-conversation'], undefined);
  assert.equal(data.unrelated, 1);
  assert.equal(data['gigachat-migration-v1'], true);
  const afterFirstMigration = stored;
  await ctx.migrateLegacyData();
  assert.equal(stored, afterFirstMigration);
});

test('history truncation does not start with an orphan function result', () => {
  const ctx = pluginContext();
  const history = Array.from({ length: 49 }, (_, i) => ({ role: 'user', content: String(i) }));
  history.unshift({ role: 'assistant', function_call: { name: 'get_tasks', arguments: {} } });
  history.unshift({ role: 'function', name: 'get_tasks', content: '{}' });
  const trimmed = ctx.trimMessages(history);
  assert.equal(trimmed[0].role, 'user');
});

test('function arrays, nulls and long outputs serialize as valid JSON objects', () => {
  const ctx = pluginContext();
  assert.deepEqual(JSON.parse(ctx.serializeFunctionResult([1, 2])).result, [1, 2]);
  assert.equal(JSON.parse(ctx.serializeFunctionResult(null)).result, null);
  const longResult = ctx.serializeFunctionResult({ data: 'x'.repeat(8000) });
  assert.equal(JSON.parse(longResult).truncated, true);
});

test('web UI blocks sending without any OAuth request', async () => {
  const ctx = chatContext([]);
  ctx.window.parent = {};
  let requests = 0;
  ctx.nodeRequest = async () => { requests++; };
  let notice = false;
  ctx.showDesktopWarning = () => { notice = true; };
  await ctx.sendMessage('hello');
  assert.equal(notice, true);
  assert.equal(requests, 0);
});

test('web notice explains the desktop requirement', () => {
  const ctx = pluginContext({});
  const container = {};
  ctx.document = { getElementById: () => container };
  ctx.showDesktopWarning();
  assert.match(container.innerHTML, /Desktop Required/);
  assert.match(container.innerHTML, /Android/);
  assert.match(container.innerHTML, /nodeExecution/);
});

test('Android settings never attempt to save a secret', async () => {
  let secretWrites = 0;
  const ctx = pluginContext({ setSecret: async () => { secretWrites++; } });
  ctx.window.parent = {};
  let notice = false;
  ctx.showDesktopWarning = () => { notice = true; };
  ctx.closeSettings = () => {};
  await ctx.doSaveSettings();
  assert.equal(notice, true);
  assert.equal(secretWrites, 0);
});

test('desktop settings identify secret-storage failure without exposing the key', async () => {
  const ctx = pluginContext({
    executeNodeScript: async () => {},
    setSecret: async () => { throw new Error('internal error containing credential'); },
    getSecret: async () => null,
  });
  const fields = {
    'cfg-authKey': { value: 'dummy-key' },
    'cfg-model': { value: 'GigaChat' },
    'cfg-maxTokens': { value: '4096' },
    'cfg-temperature': { value: '0.7' },
    'cfg-connection-status': {},
  };
  ctx.document = { getElementById: id => fields[id] };
  ctx.settingsVerified = {key:'dummy-key',token:'token',expiresAt:Date.now()+1800000,models:['GigaChat']};
  await ctx.doSaveSettings();
  assert.match(fields['cfg-connection-status'].textContent, /store the Authorization Key locally/);
  assert.doesNotMatch(fields['cfg-connection-status'].textContent, /dummy-key|credential/);
});

test('desktop settings save through host bridge when iframe has no secret API', async () => {
  const ctx = pluginContext({ executeNodeScript: async () => {} });
  let savedKey = null;
  ctx.window.parent.__gigachatAssistantSecretBridge = {
    get: async () => savedKey,
    set: async value => { savedKey = value; },
  };
  const fields = {
    'cfg-authKey': { value: 'dummy-key' },
    'cfg-model': { value: 'GigaChat' },
    'cfg-maxTokens': { value: '4096' },
    'cfg-temperature': { value: '0.7' },
    'chat-container': {},
  };
  ctx.document = { getElementById: id => fields[id] };
  ctx.settingsVerified = {key:'dummy-key',token:'token',expiresAt:Date.now()+1800000,models:['GigaChat']};
  ctx.saveConfig = async value => { ctx.savedConfig = value; };
  ctx.closeSettings = () => {};
  ctx.showWelcome = () => {};
  ctx.showSnack = () => {};
  await ctx.doSaveSettings();
  assert.equal(savedKey, 'dummy-key');
  assert.equal(ctx.savedConfig.model, 'GigaChat');
  assert.equal(ctx.savedConfig.apiKey, undefined);
});
