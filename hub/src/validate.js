// A small, explicit validator for the arguments of an MCP tool call, driven by the tool's own `inputSchema`, so the
// published contract and the enforced one are the same thing. No dependency. It supports exactly the keywords the schemas
// here use and refuses to guess at others: an unsupported keyword or type throws, and a test runs every tool's schema
// through it, so a schema that outgrows the validator fails the build instead of silently passing anything.
//
//   object   properties, required, additionalProperties: false (unknown properties are rejected)
//   string   minLength, maxLength (in characters, not UTF-16 units), pattern, enum
//   integer  exactly a JSON number with no fraction (a string such as "50" is not one); minimum, maximum
//   array    minItems, maxItems, uniqueItems, items
//
// Missing is not the same as null: a missing required property is "required", and an explicit null is a wrong type (so is
// an explicit null for an optional property: leave it out). Messages name the property and the expected type, and never
// repeat the value, because an argument can be a contributor key.

const KEYWORDS = {
  object: new Set(['type', 'properties', 'required', 'additionalProperties', 'description']),
  string: new Set(['type', 'minLength', 'maxLength', 'pattern', 'enum', 'description']),
  integer: new Set(['type', 'minimum', 'maximum', 'description']),
  array: new Set(['type', 'minItems', 'maxItems', 'uniqueItems', 'items', 'description']),
};

const MAX_ERRORS = 5;
const patterns = new Map();

const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'number' ? (Number.isInteger(v) ? 'an integer' : 'a number') : typeof v === 'object' ? 'an object' : `a ${typeof v}`);
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chars = (s) => (s.length <= 1 ? s.length : [...s].length); // JSON Schema counts characters, so a surrogate pair is one
const label = (name) => String(name).replace(/[^\w.\[\]-]/g, '?').slice(0, 40);

function checkKeywords(spec, path) {
  const allowed = KEYWORDS[spec.type];
  if (!allowed) throw new Error(`validate: unsupported schema type "${spec.type}" at ${path}`);
  for (const k of Object.keys(spec)) if (!allowed.has(k)) throw new Error(`validate: unsupported keyword "${k}" at ${path}`);
}

function checkValue(spec, value, path, errors) {
  if (errors.length >= MAX_ERRORS) return;
  checkKeywords(spec, path);
  const bad = (msg) => { if (errors.length < MAX_ERRORS) errors.push(msg); };

  if (spec.type === 'string') {
    if (typeof value !== 'string') return bad(`${path} must be a string (got ${kind(value)})`);
    if (spec.minLength !== undefined && chars(value) < spec.minLength) bad(`${path} must be at least ${spec.minLength} characters`);
    if (spec.maxLength !== undefined && chars(value) > spec.maxLength) bad(`${path} must be at most ${spec.maxLength} characters`);
    if (spec.pattern !== undefined) {
      if (!patterns.has(spec.pattern)) patterns.set(spec.pattern, new RegExp(spec.pattern));
      if (!patterns.get(spec.pattern).test(value)) bad(`${path} has the wrong format (expected ${spec.pattern})`);
    }
    if (spec.enum !== undefined && !spec.enum.includes(value)) bad(`${path} must be one of: ${spec.enum.join(', ')}`);
  } else if (spec.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return bad(`${path} must be an integer (got ${kind(value)})`);
    if (spec.minimum !== undefined && value < spec.minimum) bad(`${path} must be at least ${spec.minimum}`);
    if (spec.maximum !== undefined && value > spec.maximum) bad(`${path} must be at most ${spec.maximum}`);
  } else if (spec.type === 'array') {
    if (!Array.isArray(value)) return bad(`${path} must be an array (got ${kind(value)})`);
    if (spec.minItems !== undefined && value.length < spec.minItems) bad(`${path} must have at least ${spec.minItems} item${spec.minItems === 1 ? '' : 's'}`);
    if (spec.maxItems !== undefined && value.length > spec.maxItems) bad(`${path} must have at most ${spec.maxItems} items`);
    if (spec.uniqueItems && new Set(value.map((v) => (typeof v === 'object' ? JSON.stringify(v) : `${typeof v}:${v}`))).size !== value.length) bad(`${path} must not repeat an item`);
    if (spec.items) value.slice(0, spec.maxItems === undefined ? 1000 : spec.maxItems + 1).forEach((v, i) => checkValue(spec.items, v, `${path}[${i}]`, errors));
  } else if (spec.type === 'object') {
    if (!plain(value)) return bad(`${path} must be an object (got ${kind(value)})`);
    checkObject(spec, value, path, errors);
  }
}

function checkObject(spec, value, path, errors) {
  checkKeywords(spec, path || 'arguments');
  const props = spec.properties ?? {};
  const prefix = path ? `${path}.` : '';
  for (const name of spec.required ?? []) {
    if (!Object.hasOwn(value, name) && errors.length < MAX_ERRORS) errors.push(`${prefix}${name} is required`);
  }
  for (const name of Object.keys(value)) {
    if (Object.hasOwn(props, name)) checkValue(props[name], value[name], `${prefix}${name}`, errors);
    else if (spec.additionalProperties === false && errors.length < MAX_ERRORS) errors.push(`unknown property "${label(name)}"`);
  }
}

// null when the arguments fit the schema, otherwise one sentence listing what is wrong (at most five problems).
export function validateArgs(schema, args) {
  const errors = [];
  if (!plain(args)) return `arguments must be an object (got ${kind(args)})`;
  checkObject(schema, args, '', errors);
  return errors.length ? errors.join('; ') : null;
}
