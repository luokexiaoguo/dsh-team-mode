/**
 * Dependency-free stand-in for `defineTool` from `@deepseek-ai/dsh-tools`.
 *
 * A bundle installed into a profile is loaded from wherever it lives, so a
 * workspace package cannot resolve the private `@deepseek-ai/*` packages that
 * only exist inside the application archive. The tool registry does not need
 * that package at runtime either: `ToolDefinition.parameters` and
 * `ToolDefinition.output.schema` are plain JSON Schema nodes. This module
 * compiles the same author-facing dialect `defineTool` accepts (per-property
 * `required: true`, implicit object root for parameters) into those nodes.
 *
 * Supported author nodes: `string`, `number`, `integer`, `boolean`, `null`,
 * `array` (with `items`), `object` (with `properties` / `additionalProperties`)
 * and `json` (annotation-only). Annotations are copied through.
 *
 * @module @local/team-mode/schema
 */

/** Annotation keys copied verbatim onto the compiled node. */
const ANNOTATIONS = ['title', 'description', 'default', 'examples', 'deprecated']

/**
 * Copy author annotations onto a compiled node.
 * @param source - author node.
 * @param node - compiled node being built.
 * @returns Nothing; `node` is mutated.
 */
function copyAnnotations(source, node) {
  for (const key of ANNOTATIONS) {
    if (Object.hasOwn(source, key) && source[key] !== undefined) node[key] = source[key]
  }
}

/**
 * Compile one property map plus its author-level required flags.
 * @param properties - author property map.
 * @param path - diagnostic path.
 * @returns Compiled properties and the required name list.
 */
function compileProperties(properties, path) {
  const compiled = {}
  const required = []
  for (const [key, spec] of Object.entries(properties)) {
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new TypeError(`${path}.${key} must be an author schema object`)
    }
    compiled[key] = compileValue(spec, `${path}.${key}`)
    if (spec.required === true) required.push(key)
  }
  return { properties: compiled, required }
}

/**
 * Compile one author value node into a raw JSON Schema node.
 * @param spec - author node.
 * @param path - diagnostic path.
 * @returns Raw JSON Schema node.
 */
function compileValue(spec, path) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError(`${path} must be an author schema object`)
  }

  if (Object.hasOwn(spec, 'oneOf')) {
    const branches = spec.oneOf
    if (!Array.isArray(branches) || branches.length === 0) {
      throw new TypeError(`${path}.oneOf must be a non-empty array`)
    }
    const node = { oneOf: branches.map((branch, index) => compileValue(branch, `${path}.oneOf[${index}]`)) }
    copyAnnotations(spec, node)
    return node
  }

  const type = spec.type
  if (type === 'json') {
    const node = {}
    copyAnnotations(spec, node)
    return node
  }

  if (type === 'object') {
    const node = { type: 'object' }
    if (typeof spec.additionalProperties === 'boolean') node.additionalProperties = spec.additionalProperties
    if (spec.properties !== undefined) {
      const { properties, required } = compileProperties(spec.properties, `${path}.properties`)
      node.properties = properties
      if (required.length > 0) node.required = required
    }
    copyAnnotations(spec, node)
    return node
  }

  if (type === 'array') {
    const node = { type: 'array' }
    if (spec.items !== undefined) node.items = compileValue(spec.items, `${path}.items`)
    copyAnnotations(spec, node)
    return node
  }

  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean' || type === 'null') {
    const node = { type }
    if (Object.hasOwn(spec, 'enum')) {
      if (!Array.isArray(spec.enum) || spec.enum.length === 0) throw new TypeError(`${path}.enum must be a non-empty array`)
      node.enum = Array.from(spec.enum)
    }
    if (Object.hasOwn(spec, 'const')) node.const = spec.const
    copyAnnotations(spec, node)
    return node
  }

  throw new TypeError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`)
}

/**
 * Compile a per-property parameter declaration into the implicit object root
 * the tool registry expects (open root: `additionalProperties` is not forced).
 * @param spec - author parameter map.
 * @returns Raw JSON Schema object node.
 */
export function parameterSchemaSpecToJsonSchema(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError('parameters must be an author schema object map')
  }
  const { properties, required } = compileProperties(spec, 'parameters')
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

/**
 * Identity-plus-compile wrapper: returns a tool definition whose parameter and
 * output schemas are already raw JSON Schema.
 * @param definition - author-facing definition.
 * @returns Definition ready for `ctx.tools.register`.
 */
export function defineTool(definition) {
  const { parameters, output, ...rest } = definition
  return {
    ...rest,
    parameters: parameterSchemaSpecToJsonSchema(parameters ?? {}),
    output: { ...output, schema: compileValue(output.schema, 'output.schema') },
  }
}
