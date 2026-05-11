import type { WasmModuleBase } from '../runtimes/wasm-module-interfaces.js';
import type { SatRecError } from '../../propagation/SatRec.js';
import type { Calculator } from './calculator-interface.js';
import type { EciVec3, Kilometer, KilometerPerSecond } from '../../common-types.js';
export interface EciBaseFormattedOutput {
    position: EciVec3<Kilometer>;
    velocity: EciVec3<KilometerPerSecond>;
    error: SatRecError;
}
/**
 * Performs SGP4 propagation, producing ECI (Earth-Centered Fixed) position
 * and velocity vectors. Base calculator with no dependencies.
 *
 * Raw outputs are always sorted by satellite index first, then by date index, and packed as:
 *   - `position`: `Float64Array`, packed as [x0, y0, z0, x1, y1, z1, ...]
 * for each satellite/date pair
 *   - `velocity`: `Float64Array`, packed as [vx0, vy0, vz0, vx1, vy1, vz1, ...]
 * for each satellite/date pair
 *   - `error`: `Int8Array`, equal to SatRec.error, packed as [err0, err1, ...]
 * for each satellite/date pair
 *
 * Provides formatted output under `eci` property, @see EciBaseFormattedOutput.
 */
export declare class EciBaseCalculator implements Calculator<'eci', 0, [], {
    position: Float64Array;
    velocity: Float64Array;
    error: Int8Array;
}, EciBaseFormattedOutput> {
    readonly name = "eci";
    readonly dependencies: [];
    private satellitesCount;
    private datesCount;
    private module;
    private outputPointer;
    init(module: WasmModuleBase, outputPointer: number, satellitesCount: number, datesCount: number): void;
    getFormattedOutput(satelliteIndex: number, dateIndex: number): EciBaseFormattedOutput;
    getRawOutput(): {
        position: Float64Array;
        velocity: Float64Array;
        error: Int8Array;
    };
    getOutputBufferSize(satellitesCount: number, datesCount: number): number;
    getExecutionDescriptor(): {
        eciPositions: number;
        eciVelocities: number;
        sgp4Errors: number;
    };
}
