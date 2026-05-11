import { WasmModuleSingleThread } from './wasm-module-interfaces.js';
import { SingleThreadRuntime } from './wasm-runtime.js';
export declare function createSingleThreadRuntimeFromModule(wasmModule: WasmModuleSingleThread): Promise<SingleThreadRuntime>;
