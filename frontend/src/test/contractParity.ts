import ts from 'typescript'

/**
 * Compares the TypeScript contract mirror (`src/types/api.ts`) with the JSON Schema the
 * backend's Pydantic models produce, so the two hand-written mirrors of §8.1 cannot drift
 * silently (§3.2-9). Test-only; uses the TypeScript compiler API.
 *
 * Rules (property names, optionality, nullability, primitive kinds, enum values, arrays and
 * nested objects are compared recursively):
 * - Response models (backend → UI): property sets are equal; a property the backend always
 *   sends is required in TS with exactly the backend's nullability; a property the backend
 *   may omit is optional in TS. Optional response properties are omitted rather than sent
 *   as null, so their nullability is not compared.
 * - Request models (UI → backend): property sets are equal (the backend forbids unknown
 *   fields) and optionality matches; TS may be stricter than the backend about null, never
 *   looser.
 */

export type Direction = 'response' | 'request'

export interface JsonSchema {
  $ref?: string
  $defs?: Record<string, JsonSchema>
  type?: string | string[]
  format?: string
  default?: unknown
  enum?: unknown[]
  const?: unknown
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  allOf?: JsonSchema[]
  items?: JsonSchema
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean | JsonSchema
  discriminator?: { propertyName: string }
}

export interface ApiTypes {
  /** The exported type or interface with this name, if any. */
  get(name: string): ts.Type | undefined
  names(): string[]
  checker: ts.TypeChecker
}

/** Type-checks one module and exposes its exported types. */
export function loadApiTypes(fileName: string): ApiTypes {
  const program = ts.createProgram([fileName], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2023.d.ts'],
    types: [],
  })
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(fileName)
  const moduleSymbol = source ? checker.getSymbolAtLocation(source) : undefined
  if (!moduleSymbol) throw new Error(`Cannot load module ${fileName}`)
  const exports = new Map(checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.name, symbol]))
  return {
    checker,
    names: () => [...exports.keys()],
    get: (name) => {
      const symbol = exports.get(name)
      return symbol ? checker.getDeclaredTypeOfSymbol(symbol) : undefined
    },
  }
}

const NULLISH = ts.TypeFlags.Null | ts.TypeFlags.Undefined

interface SchemaParts {
  nullable: boolean
  variants: JsonSchema[]
}

interface TsParts {
  nullable: boolean
  members: ts.Type[]
}

class Comparison {
  readonly problems: string[] = []
  private readonly checker: ts.TypeChecker
  private readonly defs: Record<string, JsonSchema>
  private readonly direction: Direction

  constructor(checker: ts.TypeChecker, defs: Record<string, JsonSchema>, direction: Direction) {
    this.checker = checker
    this.defs = defs
    this.direction = direction
  }

  private resolve(schema: JsonSchema): JsonSchema {
    let current = schema
    for (let depth = 0; current.$ref; depth += 1) {
      const name = current.$ref.replace(/^#\/\$defs\//, '')
      const target = this.defs[name]
      if (!target || depth > 20) throw new Error(`Unresolvable schema reference ${current.$ref}`)
      current = target
    }
    if (current.allOf?.length === 1 && current.allOf[0]) return this.resolve(current.allOf[0])
    return current
  }

  private schemaParts(schema: JsonSchema): SchemaParts {
    const resolved = this.resolve(schema)
    const alternatives = resolved.anyOf ?? resolved.oneOf
    if (alternatives) {
      const parts = alternatives.map((alternative) => this.schemaParts(alternative))
      return {
        nullable: parts.some((part) => part.nullable),
        variants: parts.flatMap((part) => part.variants),
      }
    }
    if (Array.isArray(resolved.type)) {
      return {
        nullable: resolved.type.includes('null'),
        variants: resolved.type.filter((type) => type !== 'null').map((type) => ({ ...resolved, type })),
      }
    }
    if (resolved.type === 'null') return { nullable: true, variants: [] }
    return { nullable: false, variants: [resolved] }
  }

  private tsParts(type: ts.Type): TsParts {
    const members = type.isUnion() ? type.types : [type]
    return {
      nullable: members.some((member) => (member.flags & ts.TypeFlags.Null) !== 0),
      members: members.filter((member) => (member.flags & NULLISH) === 0),
    }
  }

  private describe(members: readonly ts.Type[]): string {
    const names = members.map((member) => this.checker.typeToString(member))
    // `boolean` is the union `false | true` once null has been split off.
    const booleans = names.filter((name) => name === 'false' || name === 'true')
    const rest = names.filter((name) => name !== 'false' && name !== 'true')
    return [...rest, ...(booleans.length === 2 ? ['boolean'] : booleans)].join(' | ') || 'never'
  }

  private fail(path: string, message: string): void {
    this.problems.push(`${path}: ${message}`)
  }

  /** Compares a schema (null already split off) with the TS members (null already removed). */
  private compareCore(variants: JsonSchema[], members: readonly ts.Type[], path: string): void {
    if (variants.length > 1) {
      this.compareDiscriminatedUnion(variants, members, path)
      return
    }
    const schema = variants[0]
    if (!schema) {
      this.fail(path, `backend allows only null, frontend has ${this.describe(members)}`)
      return
    }

    const literals = schema.enum ?? (schema.const !== undefined ? [schema.const] : undefined)
    if (literals) {
      const expected = [...literals].map(String).toSorted()
      const actual = members
        .map((member) => (member.isStringLiteral() ? member.value : `<${this.checker.typeToString(member)}>`))
        .toSorted()
      if (expected.join('|') !== actual.join('|')) {
        this.fail(path, `backend values [${expected.join(', ')}], frontend [${actual.join(', ')}]`)
      }
      return
    }

    const single = members.length === 1 ? members[0] : undefined
    switch (schema.type) {
      case 'string':
        if (!single || (single.flags & ts.TypeFlags.String) === 0) this.fail(path, `backend string, frontend ${this.describe(members)}`)
        return
      case 'integer':
      case 'number':
        if (!single || (single.flags & ts.TypeFlags.Number) === 0) this.fail(path, `backend number, frontend ${this.describe(members)}`)
        return
      case 'boolean': {
        const isBoolean = members.length === 2 && members.every((member) => (member.flags & ts.TypeFlags.BooleanLiteral) !== 0)
        if (!isBoolean && !(single && single.flags & ts.TypeFlags.Boolean)) {
          this.fail(path, `backend boolean, frontend ${this.describe(members)}`)
        }
        return
      }
      case 'array': {
        if (!single || !this.checker.isArrayType(single)) {
          this.fail(path, `backend array, frontend ${this.describe(members)}`)
          return
        }
        const element = this.checker.getTypeArguments(single as ts.TypeReference)[0]
        if (element && schema.items) this.compareValue(schema.items, element, `${path}[]`, true)
        return
      }
      case 'object':
      case undefined:
        if (!single || (single.flags & ts.TypeFlags.Object) === 0) {
          this.fail(path, `backend object, frontend ${this.describe(members)}`)
          return
        }
        if (schema.properties) this.compareObject(schema, single, path)
        else if (!this.checker.getIndexInfoOfType(single, ts.IndexKind.String)) {
          this.fail(path, `backend free-form object, frontend has no string index signature`)
        }
        return
      default:
        this.fail(path, `unsupported schema type ${String(schema.type)}`)
    }
  }

  /** Pydantic discriminated unions (e.g. check-in request methods) ⇄ TS unions of object types. */
  private compareDiscriminatedUnion(variants: JsonSchema[], members: readonly ts.Type[], path: string): void {
    const discriminator = variants
      .map((variant) => Object.entries(variant.properties ?? {}).find(([, property]) => this.resolve(property).const !== undefined)?.[0])
      .find(Boolean)
    if (!discriminator) {
      this.fail(path, 'backend union without a discriminator property')
      return
    }
    const tag = (member: ts.Type) => {
      const property = member.getProperty(discriminator)
      const type = property ? this.checker.getTypeOfSymbol(property) : undefined
      return type?.isStringLiteral() ? type.value : undefined
    }
    const byTag = new Map(members.map((member) => [tag(member), member]))
    const seen = new Set<string>()
    for (const variant of variants) {
      const value = String(this.resolve(variant.properties?.[discriminator] ?? {}).const)
      seen.add(value)
      const member = byTag.get(value)
      if (member) this.compareObject(variant, member, `${path}<${discriminator}=${value}>`)
      else this.fail(path, `frontend union has no member with ${discriminator} = ${value}`)
    }
    for (const value of byTag.keys()) {
      if (value === undefined || !seen.has(value)) this.fail(path, `frontend union member ${String(value)} does not exist in the backend`)
    }
  }

  private compareObject(schema: JsonSchema, type: ts.Type, path: string): void {
    const properties = schema.properties ?? {}
    const required = new Set(schema.required ?? [])
    const tsProperties = new Map(this.checker.getPropertiesOfType(type).map((symbol) => [symbol.name, symbol]))

    for (const name of Object.keys(properties)) {
      if (!tsProperties.has(name)) this.fail(`${path}.${name}`, 'missing in the frontend')
    }
    for (const name of tsProperties.keys()) {
      if (!(name in properties)) this.fail(`${path}.${name}`, 'does not exist in the backend')
    }

    for (const [name, property] of Object.entries(properties)) {
      const symbol = tsProperties.get(name)
      if (!symbol) continue
      const propertyPath = `${path}.${name}`
      const optional = (symbol.flags & ts.SymbolFlags.Optional) !== 0
      const backendRequired = required.has(name)
      if (backendRequired === optional) {
        this.fail(
          propertyPath,
          this.direction === 'response'
            ? backendRequired
              ? 'always sent by the backend but optional in the frontend'
              : 'may be omitted by the backend but required in the frontend'
            : backendRequired
              ? 'required by the backend but optional in the frontend'
              : 'optional in the backend but required in the frontend',
        )
      }
      // An optional response property is omitted rather than sent as null.
      const compareNullability = this.direction === 'request' || backendRequired
      this.compareValue(property, this.checker.getTypeOfSymbol(symbol), propertyPath, compareNullability)
    }
  }

  compareValue(schema: JsonSchema, type: ts.Type, path: string, compareNullability: boolean): void {
    const schemaParts = this.schemaParts(schema)
    const tsParts = this.tsParts(type)
    if (compareNullability) {
      if (this.direction === 'response' && schemaParts.nullable !== tsParts.nullable) {
        this.fail(path, schemaParts.nullable ? 'nullable in the backend, not in the frontend' : 'nullable in the frontend, never null from the backend')
      }
      if (this.direction === 'request' && tsParts.nullable && !schemaParts.nullable) {
        this.fail(path, 'the frontend may send null, which the backend rejects')
      }
    }
    this.compareCore(schemaParts.variants, tsParts.members, path)
  }
}

/**
 * Problems found between one backend model schema and one exported TS type ([] when they
 * agree). `defs` are shared definitions for `$ref`s; defaults to the schema's own `$defs`.
 */
export function compareWithSchema(
  api: ApiTypes,
  typeName: string,
  schema: JsonSchema,
  direction: Direction,
  defs: Record<string, JsonSchema> = schema.$defs ?? {},
): string[] {
  const type = api.get(typeName)
  if (!type) return [`${typeName}: not exported from the frontend contract`]
  const comparison = new Comparison(api.checker, defs, direction)
  comparison.compareValue(schema, type, typeName, true)
  return comparison.problems
}

/** String literal members of an exported union type (e.g. ApiErrorCode). */
export function stringLiterals(api: ApiTypes, typeName: string): string[] {
  const type = api.get(typeName)
  if (!type) return []
  const members = type.isUnion() ? type.types : [type]
  return members.flatMap((member) => (member.isStringLiteral() ? [member.value] : [])).toSorted()
}
