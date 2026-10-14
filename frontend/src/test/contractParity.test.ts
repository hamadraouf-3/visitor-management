// @vitest-environment node
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { compareWithSchema, loadApiTypes, stringLiterals, type ApiTypes, type JsonSchema } from './contractParity'

// The comparator guards api.ts; these tests prove it reports each kind of drift.
let api: ApiTypes

beforeAll(() => {
  api = loadApiTypes(fileURLToPath(new URL('./contractSample.ts', import.meta.url)))
}, 30_000)

const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] })

const variant = (kind: string, extra: Record<string, JsonSchema> = {}): JsonSchema => ({
  type: 'object',
  properties: { kind: { const: kind, type: 'string' }, ...extra },
  required: ['kind', ...Object.keys(extra)],
})

const union = (variants: JsonSchema[]): JsonSchema => ({ oneOf: variants, discriminator: { propertyName: 'kind' } })

function itemSchema(): JsonSchema & { properties: Record<string, JsonSchema>; required: string[] } {
  return {
    type: 'object',
    $defs: {
      Colour: { enum: ['RED', 'GREEN'], type: 'string' },
      Owner: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } }, required: ['id', 'name'] },
    },
    properties: {
      id: { type: 'string', format: 'uuid' },
      colour: { $ref: '#/$defs/Colour' },
      note: nullable({ type: 'string' }),
      count: { type: 'integer' },
      tags: { type: 'array', items: { type: 'string' } },
      flag: { type: 'boolean' },
      extra: { ...nullable({ type: 'integer' }), default: null },
      meta: { type: 'object', additionalProperties: true },
      owner: { $ref: '#/$defs/Owner' },
    },
    required: ['id', 'colour', 'note', 'count', 'tags', 'flag', 'meta', 'owner'],
  }
}

/** Pydantic's `Paginated[Item]`: the item model moves into the shared `$defs`. */
function page(item: JsonSchema): JsonSchema {
  const { $defs, ...itemModel } = item
  return {
    type: 'object',
    $defs: { ...$defs, Item: itemModel },
    properties: { items: { type: 'array', items: { $ref: '#/$defs/Item' } }, total: { type: 'integer' } },
    required: ['items', 'total'],
  }
}

describe('contract parity comparator', () => {
  it('accepts a matching response model (optional properties may be omitted instead of null)', () => {
    expect(compareWithSchema(api, 'Item', itemSchema(), 'response')).toEqual([])
  })

  it('reports nullability drift in both directions for responses', () => {
    const schema = itemSchema()
    schema.properties.note = { type: 'string' }
    schema.properties.count = nullable({ type: 'integer' })
    expect(compareWithSchema(api, 'Item', schema, 'response')).toEqual([
      'Item.note: nullable in the frontend, never null from the backend',
      'Item.count: nullable in the backend, not in the frontend',
    ])
  })

  it('reports optionality drift and missing or extra properties', () => {
    const schema = itemSchema()
    schema.required = schema.required.filter((name) => name !== 'flag')
    delete schema.properties.tags
    schema.properties.renamed = { type: 'string' }
    schema.required.push('renamed')
    expect(compareWithSchema(api, 'Item', schema, 'response')).toEqual([
      'Item.renamed: missing in the frontend',
      'Item.tags: does not exist in the backend',
      'Item.flag: may be omitted by the backend but required in the frontend',
    ])
  })

  it('reports enum, primitive, array element and nested object drift', () => {
    const schema = itemSchema()
    schema.$defs = {
      ...schema.$defs,
      Colour: { enum: ['RED', 'GREEN', 'BLUE'], type: 'string' },
      Owner: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    }
    schema.properties.tags = { type: 'array', items: { type: 'integer' } }
    schema.properties.flag = { type: 'string' }
    expect(compareWithSchema(api, 'Item', schema, 'response')).toEqual([
      'Item.colour: backend values [BLUE, GREEN, RED], frontend [GREEN, RED]',
      'Item.tags[]: backend number, frontend string',
      'Item.flag: backend string, frontend boolean',
      'Item.owner.name: does not exist in the backend',
    ])
  })

  it('lets requests be stricter than the backend about null, never looser', () => {
    const accepting: JsonSchema = {
      type: 'object',
      additionalProperties: false,
      properties: { note: nullable({ type: 'string' }), count: nullable({ type: 'integer' }) },
    }
    expect(compareWithSchema(api, 'ItemUpdate', accepting, 'request')).toEqual([])

    const rejectingNull: JsonSchema = { ...accepting, properties: { note: { type: 'string' }, count: { type: 'integer' } } }
    expect(compareWithSchema(api, 'ItemUpdate', rejectingNull, 'request')).toEqual([
      'ItemUpdate.note: the frontend may send null, which the backend rejects',
    ])

    expect(compareWithSchema(api, 'ItemUpdate', { ...accepting, required: ['count'] }, 'request')).toEqual([
      'ItemUpdate.count: required by the backend but optional in the frontend',
    ])
  })

  it('matches discriminated unions member by member', () => {
    expect(compareWithSchema(api, 'Command', union([variant('RENAME', { name: { type: 'string' } }), variant('ARCHIVE')]), 'request')).toEqual([])
    expect(
      compareWithSchema(api, 'Command', union([variant('RENAME', { name: { type: 'integer' } }), variant('DELETE')]), 'request'),
    ).toEqual([
      'Command<kind=RENAME>.name: backend number, frontend string',
      'Command: frontend union has no member with kind = DELETE',
      'Command: frontend union member ARCHIVE does not exist in the backend',
    ])
  })

  it('compares a named instantiation of a generic envelope, including its item type', () => {
    expect(compareWithSchema(api, 'ItemPage', page(itemSchema()), 'response')).toEqual([])

    const drifted = itemSchema()
    drifted.properties.count = { type: 'string' }
    expect(compareWithSchema(api, 'ItemPage', page(drifted), 'response')).toEqual([
      'ItemPage.items[].count: backend string, frontend number',
    ])
  })

  it('reports a filter that also takes a scalar where the backend takes a list, and an open-ended literal union', () => {
    const schema: JsonSchema = {
      type: 'object',
      additionalProperties: false,
      $defs: { Colour: { enum: ['RED', 'GREEN'], type: 'string' } },
      properties: {
        colour: { type: 'array', items: { $ref: '#/$defs/Colour' } },
        code: { ...nullable({ type: 'string' }), default: null },
      },
    }
    expect(compareWithSchema(api, 'ItemListParams', schema, 'request')).toEqual([
      expect.stringMatching(/^ItemListParams\.colour: backend array, frontend /),
      expect.stringMatching(/^ItemListParams\.code: backend string, frontend /),
    ])
  })

  it('reports a model the frontend does not export, and reads string literal unions', () => {
    expect(compareWithSchema(api, 'Missing', { type: 'object', properties: {} }, 'response')).toEqual([
      'Missing: not exported from the frontend contract',
    ])
    expect(stringLiterals(api, 'Colour')).toEqual(['GREEN', 'RED'])
  })
})
