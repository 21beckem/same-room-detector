const ID_OFFSET = -8;
const SIZE_OFFSET = -4;
const ARRAYBUFFER_ID = 1;
const STRING_ID = 2;
const ARRAYBUFFERVIEW = 1 << 0;
const ARRAY = 1 << 1;
const STATICARRAY = 1 << 2;
const VAL_ALIGN_OFFSET = 6;
const VAL_SIGNED = 1 << 11;
const VAL_FLOAT = 1 << 12;
const VAL_MANAGED = 1 << 14;
const ARRAYBUFFERVIEW_DATASTART_OFFSET = 4;
const ARRAYBUFFERVIEW_BYTELENGTH_OFFSET = 8;
const ARRAYBUFFERVIEW_SIZE = 12;
const ARRAY_LENGTH_OFFSET = 12;
const ARRAY_SIZE = 16;

function getString(memory, ptr) {
  if (!memory || !ptr) return "<unknown>";
  const len = new Uint32Array(memory.buffer)[ptr + SIZE_OFFSET >>> 2] >>> 1;
  return String.fromCharCode(...new Uint16Array(memory.buffer, ptr, len));
}

function getView(align, signed, floating, buffer) {
  if (floating) return align === 2 ? new Float32Array(buffer) : new Float64Array(buffer);
  if (align === 0) return new (signed ? Int8Array : Uint8Array)(buffer);
  if (align === 1) return new (signed ? Int16Array : Uint16Array)(buffer);
  if (align === 2) return new (signed ? Int32Array : Uint32Array)(buffer);
  throw new Error(`Unsupported AssemblyScript alignment: ${align}`);
}

function prepareImports(imports, extended) {
  const env = imports.env || (imports.env = {});
  env.abort ||= (message, file, line, column) => {
    const memory = extended.memory || env.memory;
    throw new Error(`WASM abort: ${getString(memory, message)} at ${getString(memory, file)}:${line}:${column}`);
  };
  env.trace ||= () => {};
  env.seed ||= Date.now;
  imports.Math ||= Math;
  imports.Date ||= Date;
}

function attachExports(instance) {
  const raw = instance.exports;
  const memory = raw.memory;
  const extended = { ...raw, memory };
  const allocate = raw.__new;
  const pin = raw.__pin;
  const unpin = raw.__unpin;
  const collect = raw.__collect;
  const rtti = raw.__rtti_base;
  if (!memory || !allocate || !pin || !unpin || !collect || rtti === undefined) {
    throw new Error("WASM module does not expose the AssemblyScript runtime required by MeshedPeers");
  }
  extended.__pin = pin;
  extended.__unpin = unpin;
  extended.__collect = collect;

  const typeInfo = (id) => new Uint32Array(memory.buffer)[(rtti + 4 >>> 2) + id];
  const alignment = (info) => 31 - Math.clz32((info >>> VAL_ALIGN_OFFSET) & 31);

  extended.__newArray = (id, valuesOrCapacity = 0) => {
    const info = typeInfo(id);
    if (!(info & (ARRAYBUFFERVIEW | ARRAY | STATICARRAY))) throw new Error(`Not an array type: ${id}`);
    const align = alignment(info);
    const arrayLike = typeof valuesOrCapacity !== "number";
    const length = arrayLike ? valuesOrCapacity.length : valuesOrCapacity;
    const bufferPtr = allocate(length << align, info & STATICARRAY ? id : ARRAYBUFFER_ID);
    let result = bufferPtr;
    if (!(info & STATICARRAY)) {
      pin(bufferPtr);
      const arrayPtr = allocate(info & ARRAY ? ARRAY_SIZE : ARRAYBUFFERVIEW_SIZE, id);
      unpin(bufferPtr);
      const u32 = new Uint32Array(memory.buffer);
      u32[arrayPtr + 0 >>> 2] = bufferPtr;
      u32[arrayPtr + ARRAYBUFFERVIEW_DATASTART_OFFSET >>> 2] = bufferPtr;
      u32[arrayPtr + ARRAYBUFFERVIEW_BYTELENGTH_OFFSET >>> 2] = length << align;
      if (info & ARRAY) u32[arrayPtr + ARRAY_LENGTH_OFFSET >>> 2] = length;
      result = arrayPtr;
    }
    if (arrayLike) {
      const view = getView(align, info & VAL_SIGNED, info & VAL_FLOAT, memory.buffer);
      const target = bufferPtr >>> align;
      if (info & VAL_MANAGED) {
        for (let i = 0; i < length; i += 1) view[target + i] = valuesOrCapacity[i];
      } else view.set(valuesOrCapacity, target);
    }
    return result;
  };

  return extended;
}

export async function instantiate(source, imports = {}) {
  const bytes = source instanceof Response ? await source.arrayBuffer() : await source;
  const module = bytes instanceof WebAssembly.Module ? bytes : await WebAssembly.compile(bytes);
  const extended = {};
  prepareImports(imports, extended);
  const instance = await WebAssembly.instantiate(module, imports);
  extended.memory = instance.exports.memory;
  return { module, instance, exports: attachExports(instance) };
}

export default { instantiate };
