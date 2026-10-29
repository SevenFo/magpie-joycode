import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import plugin from './index.mjs'

const auth = { type: 'api', key: 'fixture-ticket', metadata: { tenant: 'example', loginType: 'ERP' } }
const identity = { userId: 'fixture-user', tenant: 'example', orgFullName: 'Example' }
const cases = [
  { protocol: 'chat', path: '/chat/completions', fn: 'chat_completions', model: 'Example Chat', body: { messages: [{ role: 'user', content: 'OK' }] }, json: { choices: [{ message: { role: 'assistant', content: 'OK' } }] } },
  { protocol: 'responses', path: '/responses', fn: 'responses_completions', model: 'Example Responses', body: { input: [{ role: 'user', content: 'OK' }], tools: [{ type: 'function', name: 'ping', parameters: { type: 'object', properties: {} } }] }, json: { object: 'response', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] } },
  { protocol: 'anthropic', path: '/messages', fn: 'anthropic_completions', model: 'Example Messages', body: { messages: [{ role: 'user', content: 'OK' }], max_tokens: 16, tools: [{ name: 'ping', input_schema: { type: 'object', properties: {} } }] }, json: { type: 'message', content: [{ type: 'text', text: 'OK' }] } },
]

for (const spec of cases) {
  test(`${spec.protocol} keeps native messages, tool calls and stream bytes on its signed endpoint`, async t => {
    const stream = `data: ${JSON.stringify(spec.json)}\n\ndata: [DONE]\n\n`
    const payload = { model: spec.model, ...spec.body, stream: true }
    const controller = new AbortController()
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      const u = new URL(url)
      assert.equal(init.redirect, 'error')
      if (u.searchParams.get('functionId') === 'joycode_userInfo') return Response.json({ code: 0, data: identity })
      assert.equal(u.origin, 'https://api-ai.jd.com')
      assert.equal(u.searchParams.get('functionId'), spec.fn)
      assert.deepEqual(JSON.parse(init.body), { ...payload, ...identity, language: 'UNKNOWN' })
      assert.equal(init.signal, controller.signal)
      assert.equal(init.headers.get('ptkey'), auth.key)
      for (const name of ['authorization', 'proxy-authorization', 'cookie', 'x-api-key']) assert.equal(init.headers.has(name), false)
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    })
    const hooks = await plugin.server({})
    const loader = await hooks.auth.loader(async () => auth)
    const response = await loader.fetch('https://api-ai.jd.com/v1' + spec.path, {
      method: 'POST', signal: controller.signal, body: JSON.stringify(payload),
      headers: { authorization: 'Bearer unrelated', 'proxy-authorization': 'unrelated', cookie: 'unrelated', 'x-api-key': 'unrelated' },
    })
    assert.equal(await response.text(), stream)
  })
  test(`${spec.protocol} accepts a non-streaming native success response`, async t => {
    t.mock.method(globalThis, 'fetch', async url => new URL(url).searchParams.get('functionId') === 'joycode_userInfo'
      ? Response.json({ code: 0, data: identity }) : Response.json(spec.json))
    const loader = await (await plugin.server({})).auth.loader(async () => auth)
    const response = await loader.fetch('https://api-ai.jd.com/v1' + spec.path, { method: 'POST', body: JSON.stringify({ model: spec.model, ...spec.body }) })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), spec.json)
  })
}

test('model declarations follow metadata rather than the model name', async t => {
  const list = [
    { chatApiModel: 'Arbitrary One', ext: '{"adapterType":"openai-response"}' },
    { chatApiModel: 'Arbitrary Two', extJson: { adapterType: 'anthropic' } },
    { chatApiModel: 'Arbitrary Three', ext: 'invalid JSON' },
  ]
  t.mock.method(globalThis, 'fetch', async url => Response.json({ code: 0, data: new URL(url).searchParams.get('functionId') === 'joycode_modelList' ? list : {} }))
  const hooks = await plugin.server({}), cfg = {}
  await hooks.config(cfg)
  const models = await hooks.provider.models(cfg.provider.joycode, { auth })
  assert.equal(models['Arbitrary One'].api.npm, '@ai-sdk/openai')
  assert.equal(models['Arbitrary Two'].api.npm, '@ai-sdk/anthropic')
  assert.equal(models['Arbitrary Three'].api.npm, '@ai-sdk/openai-compatible')
})

test('custom color URL keeps its path prefix for chat and account queries', async t => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const u = new URL(url)
    assert.equal(u.origin, 'https://gateway.example.test')
    assert.equal(u.pathname, '/prefix/api')
    assert.ok(u.searchParams.get('sign'))
    assert.equal(init.redirect, 'error')
    return u.searchParams.get('functionId') === 'joycode_userInfo' ? Response.json({ code: 0, data: identity }) : Response.json(cases[0].json)
  })
  const hooks = await plugin.server({}, { baseURL: 'https://gateway.example.test/prefix/' })
  const loader = await hooks.auth.loader(async () => auth)
  assert.equal((await loader.fetch('https://gateway.example.test/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'Example', messages: [] }) })).status, 200)
})

for (const spec of cases) {
  test(`direct gateway routes ${spec.protocol} while account metadata stays on its configured control plane`, async t => {
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      const u = new URL(url)
      assert.equal(init.redirect, 'error')
      if (u.origin === 'https://accounts.example.test') {
        assert.equal(u.pathname, '/control/api')
        return Response.json({ code: 0, data: identity })
      }
      assert.equal(u.href, 'https://gateway.example.test/prefix/v1' + spec.path)
      assert.equal(u.search, '')
      assert.equal(init.headers.get('ptkey'), auth.key)
      return Response.json(spec.json)
    })
    const hooks = await plugin.server({}, { gatewayMode: 'direct', baseURL: 'https://gateway.example.test/prefix/v1/', accountBaseURL: 'https://accounts.example.test/control' })
    const loader = await hooks.auth.loader(async () => auth)
    const r = await loader.fetch('https://gateway.example.test/prefix/v1' + spec.path, { method: 'POST', body: JSON.stringify({ model: spec.model, ...spec.body }) })
    assert.deepEqual(await r.json(), spec.json)
  })
}

test('invalid gateway settings fail before sending any credentials', async () => {
  for (const options of [
    { gatewayMode: 'unknown' }, { gatewayMode: 'direct' }, { baseURL: 'file:///tmp/example' },
    { baseURL: 'https://user:password@gateway.example.test' }, { baseURL: 'https://gateway.example.test/?key=fixture' },
    { baseURL: 'https://gateway.example.test/#fragment' }, { accountBaseURL: 'data:text/plain,example' },
  ]) await assert.rejects(plugin.server({}, options))
})

test('flatten refuses native Responses instead of dropping its tool calls', async () => {
  const hooks = await plugin.server({}, { flatten: true })
  const loader = await hooks.auth.loader(async () => auth)
  await assert.rejects(loader.fetch('https://api-ai.jd.com/v1/responses', { body: '{}' }), /flatten/)
})

test('custom gateways remain isolated between plugin instances', async t => {
  const visited = []
  t.mock.method(globalThis, 'fetch', async url => {
    const u = new URL(url); visited.push(u.hostname)
    return u.searchParams.get('functionId') === 'joycode_userInfo' ? Response.json({ code: 0, data: identity }) : Response.json(cases[0].json)
  })
  for (const baseURL of ['https://first.example.test', 'https://second.example.test']) {
    const hooks = await plugin.server({}, { baseURL })
    const loader = await hooks.auth.loader(async () => auth)
    await loader.fetch(baseURL + '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'Example', messages: [] }) })
  }
  assert.deepEqual(visited, ['first.example.test', 'first.example.test', 'second.example.test', 'second.example.test'])
})

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
test('real redirects never deliver a ticket to another origin, for chat or account queries', async () => {
  let leaked = false, redirectIdentity = false
  const target = createServer((req, res) => { leaked ||= Boolean(req.headers.ptkey); res.end('unexpected') })
  const targetPort = await listen(target)
  const source = createServer((req, res) => {
    const fn = new URL(req.url, 'http://localhost').searchParams.get('functionId')
    if (fn === 'joycode_userInfo' && !redirectIdentity) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 0, data: identity })); return }
    res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/collect` }); res.end()
  })
  const sourcePort = await listen(source)
  try {
    const hooks = await plugin.server({}, { baseURL: `http://127.0.0.1:${sourcePort}` })
    const loader = await hooks.auth.loader(async () => auth)
    await assert.rejects(loader.fetch('https://placeholder.example.test/v1/chat/completions', { method: 'POST', body: '{"model":"Example","messages":[]}' }))
    redirectIdentity = true
    const otherLoader = await hooks.auth.loader(async () => auth)
    await assert.rejects(otherLoader.fetch('https://placeholder.example.test/v1/responses', { method: 'POST', body: '{"model":"Example","input":[]}' }))
    await hooks.auth.usage(async () => auth)
    assert.equal(leaked, false)
  } finally { source.closeAllConnections(); target.closeAllConnections(); await Promise.all([new Promise(r => source.close(r)), new Promise(r => target.close(r))]) }
})

for (const [protocol, path, native] of [
  ['responses', '/responses', 'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"ping","arguments":"{\\"text\\":\\"测试\\"}"}}\r\n\r\ndata: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n'],
  ['anthropic', '/messages', 'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"ping"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'],
]) {
  test(`${protocol} unwraps duplicate SSE fields even across UTF-8 and prefix chunk boundaries`, async t => {
    const wrapped = native.replace(/^(data:|event:)/gm, 'data: $1')
    const bytes = new TextEncoder().encode(wrapped)
    const body = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3)); c.close() } })
    t.mock.method(globalThis, 'fetch', async url => new URL(url).searchParams.get('functionId') === 'joycode_userInfo'
      ? Response.json({ code: 0, data: identity }) : new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
    const loader = await (await plugin.server({})).auth.loader(async () => auth)
    const r = await loader.fetch('https://api-ai.jd.com/v1' + path, { method: 'POST', body: '{"model":"Example","stream":true}' })
    assert.equal(await r.text(), native)
  })
}

test('anthropic count_tokens is answered locally with 404, nothing goes upstream', async t => {
  let upstreamCalls = 0
  t.mock.method(globalThis, 'fetch', async () => { upstreamCalls++; throw new Error('count_tokens must not call upstream') })
  const loader = await (await plugin.server({})).auth.loader(async () => auth)
  const r = await loader.fetch('https://api-ai.jd.com/v1/messages/count_tokens', {
    method: 'POST', body: JSON.stringify({ model: 'Example', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(r.status, 404)
  assert.equal((await r.json()).error.type, 'unsupported_endpoint')
  assert.equal(upstreamCalls, 0)
})
