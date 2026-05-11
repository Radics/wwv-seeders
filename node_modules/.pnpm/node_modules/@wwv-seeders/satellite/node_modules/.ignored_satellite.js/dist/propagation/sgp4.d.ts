import { PositionAndVelocity } from '../common-types.js';
import { SatRec } from './SatRec.js';
export declare function sgp4(satrec: SatRec, tsince: number): PositionAndVelocity | null;
