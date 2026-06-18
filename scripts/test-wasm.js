import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const bytes = await readFile("public/wasm/tile_decode.wasm");
const { instance } = await WebAssembly.instantiate(bytes, {});

new Uint16Array(instance.exports.memory.buffer, 0, 3).set([0, 2000, 65535]);
instance.exports.decode_u16(0, 8, 3, Math.fround(0.5), Math.fround(-1000), 65535);
const u16 = new Float32Array(instance.exports.memory.buffer, 8, 3);
assert.deepEqual([...u16.slice(0, 2)], [-1000, 0]);
assert.ok(Number.isNaN(u16[2]));

new Int16Array(instance.exports.memory.buffer, 0, 3).set([-32767, 0, -32768]);
instance.exports.decode_i16(0, 8, 3, Math.fround(0.25), Math.fround(10), -32768);
const i16 = new Float32Array(instance.exports.memory.buffer, 8, 3);
assert.deepEqual([...i16.slice(0, 2)], [-8181.75, 10]);
assert.ok(Number.isNaN(i16[2]));

console.log("wasm tests passed");
