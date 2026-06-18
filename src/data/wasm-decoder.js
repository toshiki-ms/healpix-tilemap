const WASM_URL = "/wasm/tile_decode.wasm";
const INPUT_PTR = 0;

let instance = null;
let loadPromise = null;
let failed = false;

export function warmWasmDecoder() {
  if (instance || failed) {
    return Promise.resolve(instance);
  }
  if (!loadPromise) {
    loadPromise = loadWasmDecoder()
      .then((loaded) => {
        instance = loaded;
        return instance;
      })
      .catch((error) => {
        failed = true;
        console.warn("WASM tile decoder unavailable; using JS fallback.", error);
        return null;
      });
  }
  return loadPromise;
}

export function decodeQuantizedTileWasm(tileData) {
  if (!instance || tileData.encoding.dtype === "float32") {
    return null;
  }
  const values = tileData.values;
  const count = values.length;
  const inputBytes = values.byteLength;
  const outputPtr = align4(INPUT_PTR + inputBytes);
  const outputBytes = count * 4;
  ensureMemory(outputPtr + outputBytes);

  const memory = new Uint8Array(instance.exports.memory.buffer);
  memory.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), INPUT_PTR);
  const nodata = tileData.encoding.nodata ?? noDataSentinel(tileData.encoding.dtype);
  const decode = tileData.encoding.dtype === "uint16" ? instance.exports.decode_u16 : instance.exports.decode_i16;
  decode(INPUT_PTR, outputPtr, count, Math.fround(tileData.encoding.scale), Math.fround(tileData.encoding.offset), nodata);

  const decodedView = new Float32Array(instance.exports.memory.buffer, outputPtr, count);
  const decoded = new Float32Array(count);
  decoded.set(decodedView);
  return decoded;
}

async function loadWasmDecoder() {
  if (typeof WebAssembly === "undefined") {
    return null;
  }
  if (WebAssembly.instantiateStreaming) {
    try {
      const result = await WebAssembly.instantiateStreaming(fetch(WASM_URL), {});
      return result.instance;
    } catch {
      // Some development servers return application/octet-stream. Fall through.
    }
  }
  const response = await fetch(WASM_URL);
  if (!response.ok) {
    throw new Error(`WASM decoder request failed with ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  const result = await WebAssembly.instantiate(bytes, {});
  return result.instance;
}

function ensureMemory(requiredBytes) {
  const memory = instance.exports.memory;
  const currentBytes = memory.buffer.byteLength;
  if (currentBytes >= requiredBytes) {
    return;
  }
  const pageSize = 64 * 1024;
  memory.grow(Math.ceil((requiredBytes - currentBytes) / pageSize));
}

function align4(value) {
  return (value + 3) & ~3;
}

function noDataSentinel(dtype) {
  return dtype === "uint16" ? -1 : -2147483648;
}
