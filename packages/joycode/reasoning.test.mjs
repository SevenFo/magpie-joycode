import test from 'node:test'
import assert from 'node:assert/strict'
import plugin, { _internal } from './index.mjs'

const levels = ['low', 'medium', 'high', 'xhigh', 'max']
const auth = { type: 'api', key: 'fixture', metadata: { tenant: 'example' } }
const meta = { adapterType: 'openai-response', reasoning: { defaultEffort: 'medium', efforts: levels.map(value => ({ value })) } }

test('reads declared efforts from object or JSON metadata without inventing levels', () => {
  for (const model of [{ extJson: meta }, { ext: JSON.stringify(meta) }]) {
    assert.deepEqual(_internal.modelReasoning(model), { levels, defaultEffort: 'medium', sendThinking: false, toggle: false })
  }
  for (const ext of ['invalid', 'null', '[]', '{}']) assert.equal(_internal.modelReasoning({ ext }), undefined)
  const actual = _internal.modelReasoning({ extJson: { reasoning: { efforts: [{ value: 'max' }, { value: 'max' }, {}, { value: 'unknown' }], defaultEffort: 'medium' } } })
  assert.deepEqual(actual.levels, ['max'])
  assert.equal(actual.defaultEffort, undefined)
})

test('dynamic account models advertise their own reasoning capabilities and keep protocol/tools/limits', async t => {
  const list = [{ chatApiModel: 'Vendor Alias', label: 'Vendor Alias', features: ['function_call'], maxTotalTokens: 123456, extJson: meta },
    { chatApiModel: 'Different Chat', features: [], extJson: { reasoning: { efforts: [{ value: 'high' }, { value: 'max' }], defaultEffort: 'max', sendThinking: true, toggle: true } } },
    { chatApiModel: 'Plain Model', features: [] }]
  t.mock.method(globalThis, 'fetch', async url => Response.json({ code: 0, data: new URL(url).searchParams.get('functionId') === 'joycode_modelList' ? list : {} }))
  const hooks = await plugin.server({}), cfg = {}
  await hooks.config(cfg)
  const models = await hooks.provider.models(cfg.provider.joycode, { auth })
  const model = models['Vendor Alias']
  assert.equal(model.capabilities.reasoning, true)
  assert.deepEqual(Object.keys(model.variants), levels)
  assert.equal(model.options.reasoningEffort, 'medium')
  assert.equal(model.api.npm, '@ai-sdk/openai')
  assert.equal(model.capabilities.toolcall, true)
  assert.equal(model.limit.context, 123456)
  assert.deepEqual(Object.keys(models['Different Chat'].variants), ['high', 'max'])
  assert.equal(models['Plain Model'].variants, undefined)
  assert.equal(models['Plain Model'].capabilities.reasoning, undefined)
})

for (const [effort, thinking, forwarded] of [['max', 'enabled', 'max'], ['none', 'disabled', undefined]]) {
  test(`Chat ${effort} applies the thinking switch only when its model declares it`, async t => {
    const sent = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      const fn = new URL(url).searchParams.get('functionId')
      if (fn === 'joycode_userInfo') return Response.json({ code: 0, data: { userId: 'fixture-user' } })
      if (fn === 'joycode_modelList') return Response.json({ code: 0, data: [
        { chatApiModel: 'Deep Chat', extJson: { reasoning: { sendThinking: true, efforts: [{ value: 'high' }, { value: 'max' }], toggle: true } } },
        { chatApiModel: 'Ordinary Chat', extJson: { reasoning: { efforts: [{ value: 'high' }] } } },
      ] })
      sent.push(JSON.parse(init.body))
      return Response.json({ choices: [{ message: { content: 'OK' } }] })
    })
    const loader = await (await plugin.server({})).auth.loader(async () => auth)
    const messages = [{ role: 'user', content: 'Synthetic query' }]
    for (const model of ['Deep Chat', 'Ordinary Chat']) await loader.fetch('https://api-ai.jd.com/v1/chat/completions', {
      method: 'POST', body: JSON.stringify({ model, messages, reasoning_effort: effort, tools: [{ type: 'function', function: { name: 'ping' } }] }),
    })
    assert.deepEqual(sent[0].thinking, { type: thinking })
    assert.equal(sent[0].reasoning_effort, forwarded)
    assert.deepEqual(sent[0].messages, messages)
    assert.equal(sent[0].tools[0].function.name, 'ping')
    assert.equal(sent[1].thinking, undefined)
    assert.equal(sent[1].reasoning_effort, effort)
  })
}

test('Responses effort is forwarded unchanged without fetching Chat-only metadata', async t => {
  const payload = { model: 'GPT Alias', input: [{ role: 'user', content: 'OK' }], reasoning: { effort: 'xhigh' } }
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const fn = new URL(url).searchParams.get('functionId')
    if (fn === 'joycode_userInfo') return Response.json({ code: 0, data: { userId: 'fixture-user' } })
    assert.equal(fn, 'responses_completions')
    const sent = JSON.parse(init.body)
    assert.deepEqual(sent.reasoning, payload.reasoning)
    assert.deepEqual(sent.input, payload.input)
    assert.equal(sent.thinking, undefined)
    return Response.json({ object: 'response', output: [] })
  })
  const loader = await (await plugin.server({})).auth.loader(async () => auth)
  await loader.fetch('https://api-ai.jd.com/v1/responses', { method: 'POST', body: JSON.stringify(payload) })
})
