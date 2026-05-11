import { SatRec } from '../propagation/SatRec.js';
import { WasmModuleBase } from './runtimes/wasm-module-interfaces.js';
export declare function allocateNativeStructArray(module: WasmModuleBase, count: number): number;
export declare function writeNativeStructArrayFromSatrecArray(module: WasmModuleBase, pointer: number, satrecArray: SatRec[]): void;
