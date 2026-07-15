/**
 * encode.ts — pure, dependency-light conversion between the console's text
 * inputs and the typed values viem needs (and back, for display). Kept separate
 * from the panel component so the arg coercion + result formatting are unit-
 * testable without a browser or a wallet.
 *
 * Design: a scalar field is a plain string; a complex type (array or tuple) is
 * entered as JSON and coerced recursively. Every integer type becomes a
 * `bigint`, addresses are validated, and a bad value throws a SHORT, human
 * message the panel surfaces inline — never a silent wrong-typed call.
 */
import { isAddress, type AbiParameter } from 'viem'

/** Human label for a param in an error message (its name, else its type). */
function label(param: AbiParameter): string {
  return param.name && param.name.length > 0 ? param.name : param.type
}

/** Is this ABI type a JSON-entered complex value (array or tuple)? */
export function isComplexType(type: string): boolean {
  return type.endsWith(']') || type === 'tuple' || type.startsWith('tuple')
}

/**
 * Parse ONE function argument from its raw form string into the value viem
 * expects. Scalars come straight from the string; arrays/tuples are JSON-parsed
 * first, then coerced element-by-element. Throws an `Error` with a short,
 * inline-friendly message on any mismatch.
 */
export function parseArg(param: AbiParameter, raw: string): unknown {
  const trimmed = raw.trim()
  if (isComplexType(param.type)) {
    let json: unknown
    try {
      json = JSON.parse(trimmed)
    } catch {
      throw new Error(`${label(param)}: enter ${param.type} as JSON (e.g. ["0x…", 1]).`)
    }
    return coerce(param, json)
  }
  return coerceScalar(param.type, trimmed, label(param))
}

/** Recursively coerce a (possibly JSON-parsed) value to the param's ABI type. */
function coerce(param: AbiParameter, value: unknown): unknown {
  const t = param.type
  // Array: strip the trailing [] / [N] and coerce each element as the base type.
  if (t.endsWith(']')) {
    if (!Array.isArray(value)) throw new Error(`${label(param)}: expected an array for ${t}.`)
    const baseType = t.replace(/\[\d*\]$/, '')
    const baseParam = { ...param, type: baseType } as AbiParameter
    return value.map((v) => coerce(baseParam, v))
  }
  // Tuple: map the JSON object/array onto the declared components, in order.
  if (t === 'tuple' || t.startsWith('tuple')) {
    const components = (param as { components?: readonly AbiParameter[] }).components
    if (!components) throw new Error(`${label(param)}: tuple has no components.`)
    if (Array.isArray(value)) {
      if (value.length !== components.length) {
        throw new Error(`${label(param)}: expected ${components.length} tuple fields.`)
      }
      return components.map((c, i) => coerce(c, value[i]))
    }
    if (value !== null && typeof value === 'object') {
      const obj = value as Record<string, unknown>
      return components.map((c) => coerce(c, obj[c.name ?? '']))
    }
    throw new Error(`${label(param)}: expected an object or array for the tuple.`)
  }
  return coerceScalar(t, value, label(param))
}

/** Coerce a single scalar (from a form string or a JSON primitive) to its ABI type. */
function coerceScalar(type: string, value: unknown, lbl: string): unknown {
  if (type === 'address') {
    const s = String(value).trim()
    // strict:false so a pasted lowercase address is accepted (checksum optional);
    // normalize to lowercase, which viem accepts everywhere.
    if (!isAddress(s, { strict: false })) throw new Error(`${lbl}: not a valid address.`)
    return s.toLowerCase()
  }
  if (type === 'bool') {
    if (typeof value === 'boolean') return value
    const s = String(value).trim().toLowerCase()
    if (s === 'true' || s === '1') return true
    if (s === 'false' || s === '0') return false
    throw new Error(`${lbl}: expected true or false.`)
  }
  if (type.startsWith('uint') || type.startsWith('int')) {
    const s = typeof value === 'string' ? value.trim() : String(value)
    let bi: bigint
    try {
      bi = BigInt(s)
    } catch {
      throw new Error(`${lbl}: expected a whole number for ${type}.`)
    }
    if (type.startsWith('uint') && bi < 0n) throw new Error(`${lbl}: ${type} can’t be negative.`)
    return bi
  }
  if (type === 'string') return String(value)
  if (type.startsWith('bytes')) {
    const s = String(value).trim()
    if (!/^0x[0-9a-fA-F]*$/.test(s)) throw new Error(`${lbl}: expected 0x-hex for ${type}.`)
    const fixed = /^bytes(\d+)$/.exec(type)
    if (fixed) {
      const wantChars = Number(fixed[1]) * 2 + 2
      if (s.length !== wantChars) {
        throw new Error(`${lbl}: ${type} must be exactly ${fixed[1]} bytes.`)
      }
    }
    return s
  }
  // Exotic/unknown type — pass the raw string through rather than guess-coerce.
  return String(value)
}

/**
 * Render a read's return value as readable text. Bigints (and bigints nested in
 * arrays/structs) print as plain decimal strings; `undefined` (a void return)
 * reads as an explicit "ok" rather than the literal word undefined.
 */
export function formatResult(value: unknown): string {
  if (value === undefined) return 'ok — no return value'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return value
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
}

/**
 * Reduce any thrown call/tx error to a short, honest one-liner for the panel.
 * viem attaches a `shortMessage` (the decoded revert reason / rejection) — prefer
 * it, fall back to the raw message, and cap the length so a giant stack never
 * fills the card.
 */
export function humanizeError(err: unknown): string {
  const raw =
    err && typeof err === 'object'
      ? ((err as { shortMessage?: string; message?: string }).shortMessage ??
        (err as { message?: string }).message ??
        String(err))
      : String(err)
  return raw.length > 280 ? `${raw.slice(0, 280)}…` : raw
}
