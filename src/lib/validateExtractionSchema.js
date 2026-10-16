// Strict local validator for the exact JSON Schema subset used by extraction.
// No defaults, coercion, removal, or repair. Schema extensions fail closed.
export class ExtractionValidationError extends Error {
  constructor(diagnostics) {
    super(`Invalid extraction response: ${diagnostics.join('; ')}`)
    this.name = 'ExtractionValidationError'
    this.diagnostics = diagnostics
    this.retryable = false
  }
}
export function compileExtractionSchema(schema) {
  const keywords = new Set(['type', 'anyOf', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'enum', 'description'])
  const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
  function inspect(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).some(k => !keywords.has(k))) throw new Error('Unsupported extraction schema keyword or node')
    if (s.anyOf !== undefined) {
      if (Object.keys(s).some(k => !['anyOf', 'description'].includes(k)) || !Array.isArray(s.anyOf) || !s.anyOf.length) throw new Error('Unsupported extraction schema union')
      s.anyOf.forEach(inspect); return
    }
    if (!types.has(s.type)) throw new Error('Unsupported extraction schema type')
    const appropriate = { properties: 'object', required: 'object', additionalProperties: 'object', items: 'array', minItems: 'array' }
    if (Object.entries(appropriate).some(([key, type]) => key in s && s.type !== type)) throw new Error('Misplaced extraction schema keyword')
    if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length || s.enum.some(x => x !== null && !['string', 'number', 'boolean'].includes(typeof x)))) throw new Error('Unsupported extraction schema enum')
    if (s.type === 'object') {
      if (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties) || s.additionalProperties !== false || !Array.isArray(s.required)
        || s.required.length !== Object.keys(s.properties).length || new Set(s.required).size !== s.required.length || s.required.some(k => !Object.hasOwn(s.properties, k))) throw new Error('Unsupported extraction object schema')
      Object.values(s.properties).forEach(inspect)
    }
    if (s.type === 'array') {
      if (s.minItems !== undefined && (!Number.isSafeInteger(s.minItems) || s.minItems < 0)) throw new Error('Unsupported extraction array schema')
      inspect(s.items)
    }
  }
  inspect(schema)
  function check(s, v, path) {
    if (s.anyOf) return s.anyOf.some(branch => check(branch, v, path).length === 0) ? [] : [`${path}: no union alternative matches`]
    const matches = s.type === 'null' ? v === null : s.type === 'array' ? Array.isArray(v)
      : s.type === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v)
        : s.type === 'number' ? typeof v === 'number' && Number.isFinite(v)
          : s.type === 'integer' ? Number.isSafeInteger(v) : typeof v === s.type
    if (!matches) return [`${path}: expected ${s.type}`]
    const errors = []
    if (s.enum && !s.enum.includes(v)) errors.push(`${path}: invalid enum`)
    if (s.type === 'object') {
      for (const key of s.required) if (!Object.hasOwn(v, key)) errors.push(`${path}.${key}: missing required field`)
      for (const key of Object.keys(v)) {
        if (!Object.hasOwn(s.properties, key)) errors.push(`${path}.${key}: unexpected field`)
        else errors.push(...check(s.properties[key], v[key], `${path}.${key}`))
      }
    }
    if (s.type === 'array') {
      if (v.length < (s.minItems || 0)) errors.push(`${path}: too few items`)
      for (let i = 0; i < v.length; i++) errors.push(...check(s.items, v[i], `${path}[${i}]`))
    }
    return errors
  }
  return value => {
    const errors = check(schema, value, '$')
    if (errors.length) throw new ExtractionValidationError(errors)
    return value
  }
}

export function validateExtractionSchema(schema, value) {
  return compileExtractionSchema(schema)(value)
}
