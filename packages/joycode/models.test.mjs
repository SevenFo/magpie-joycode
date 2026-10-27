import test from 'node:test'
import assert from 'node:assert/strict'
import plugin from './index.mjs'

const catalogue = [
  { chatApiModel: 'Example Chat', label: 'Example Chat', maxTotalTokens: 200000, respMaxTokens: 64000, features: ['function_call'] },
  { chatApiModel: 'Example Reasoner', label: 'Example Reasoner', maxTotalTokens: 200000, respMaxTokens: 64000, features: ['function_call'] },
]
const billingRate = { excludeTenants: ['JD'], billingRates: [
  { chatApiModel: 'Example Chat', billingRate: '0x' },
  { chatApiModel: 'Example Reasoner', billingRate: '0.6x' },
  { chatApiModel: 'unavailable-model', billingRate: '0.2x' },
] }
async function load(t, { tenant = 'personal', failRates = false, failList = false, list = catalogue } = {}) {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const fn = new URL(url).searchParams.get('functionId')
    assert.equal(init.headers.tenant, tenant)
    if (fn === 'joycode_modelList') {
      if (failList) throw new Error('offline')
      assert.equal(init.body, '{}')
      return Response.json({ code: 0, data: list })
    }
    assert.equal(fn, 'plugin_config')
    assert.deepEqual(JSON.parse(init.body), { sceneType: 'billingRate' })
    if (failRates) throw new Error('offline')
    return Response.json({ code: 0, data: { billingRate } })
  })
  const hooks = await plugin.server({})
  const cfg = {}
  await hooks.config(cfg)
  const provider = cfg.provider.joycode
  assert.equal(typeof hooks.provider?.models, 'function')
  return { provider, models: await hooks.provider.models(provider, { auth: { type: 'api', key: 'fake', metadata: { tenant } } }) }
}

test('sync current model multipliers including zero without adding pricing-only models', async t => {
  const { models } = await load(t)
  assert.deepEqual(Object.keys(models), ['Example Chat', 'Example Reasoner'])
  assert.equal(models['Example Chat'].rate, 0)
  assert.equal(models['Example Chat'].free, true)
  assert.equal(models['Example Reasoner'].rate, 0.6)
  assert.equal(models['Example Reasoner'].capabilities.input.image, false)
})
test('excluded tenants do not inherit public pricing', async t => {
  const { models } = await load(t, { tenant: 'JD' })
  assert.equal(models['Example Reasoner'].rate, undefined)
  assert.notEqual(models['Example Chat'].free, true)
})
test('model-specific billing rate takes priority', async t => {
  const { models } = await load(t, { list: [{ ...catalogue[1], billingRate: '0.3x' }] })
  assert.equal(models['Example Reasoner'].rate, 0.3)
})
test('pricing fetch failure retains models without invented rates', async t => {
  const { models } = await load(t, { failRates: true })
  assert.equal(Object.keys(models).length, 2)
  assert.equal(models['Example Reasoner'].rate, undefined)
})
test('catalogue fetch failure returns an empty model list', async t => {
  const { models } = await load(t, { failList: true })
  assert.deepEqual(models, {})
})

test('unsigned providers have no model list and do not query the account', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No account query before sign-in'))
  const hooks = await plugin.server({}), cfg = {}
  await hooks.config(cfg)
  assert.deepEqual(cfg.provider.joycode.models, {})
  const staleProvider = { models: { 'Stale Model': { reasoning: true } } }
  for (const auth of [undefined, { type: 'api', key: '' }, { type: 'oauth', access: 'fixture' }]) {
    assert.deepEqual(await hooks.provider.models(staleProvider, { auth }), {})
  }
})

for (const [name, list] of [
  ['empty', []], ['null', null], ['malformed', {}],
  ['hidden', [{ chatApiModel: 'Hidden Model', hidden: true }]],
]) {
  test(`${name} account lists never restore old model declarations`, async t => {
    const { models } = await load(t, { list })
    assert.deepEqual(models, {})
  })
}

test('old provider declarations cannot add models or override current account capabilities', async t => {
  t.mock.method(globalThis, 'fetch', async url => Response.json({ code: 0,
    data: new URL(url).searchParams.get('functionId') === 'joycode_modelList' ? [catalogue[0]] : {} }))
  const hooks = await plugin.server({})
  const models = await hooks.provider.models({ models: {
    'Old Model': {},
    'Example Chat': { reasoning: true, free: true, rate: 0, variants: { max: {} },
      options: { reasoningEffort: 'max' }, capabilities: { reasoning: true } },
  } }, { auth: { type: 'api', key: 'fixture' } })
  assert.deepEqual(Object.keys(models), ['Example Chat'])
  assert.equal(models['Example Chat'].reasoning, undefined)
  assert.equal(models['Example Chat'].variants, undefined)
  assert.equal(models['Example Chat'].options, undefined)
  assert.equal(models['Example Chat'].capabilities.reasoning, undefined)
  assert.equal(models['Example Chat'].free, undefined)
})

test('expired account tickets still request sign-in instead of returning an empty catalogue', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 401 }, { status: 401 }))
  const hooks = await plugin.server({})
  await assert.rejects(hooks.provider.models({ models: {} }, { auth: { type: 'api', key: 'fixture' } }),
    error => error.signIn === 'expired')
})
