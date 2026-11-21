import { pathToFileURL } from 'node:url';
import * as real from '../src/lifecycle.js';

const module_ = process.env.LIFECYCLE_MODULE
  ? ((await import(pathToFileURL(process.env.LIFECYCLE_MODULE).href)) as typeof real)
  : real;

const oracle_ = process.env.LIFECYCLE_ORACLE
  ? ((await import(pathToFileURL(process.env.LIFECYCLE_ORACLE).href)) as typeof import('./oracle.js'))
  : await import('./oracle.js');

export const Oracle: typeof oracle_.Oracle = oracle_.Oracle;
export const StreamMonitor: typeof oracle_.StreamMonitor = oracle_.StreamMonitor;
export const reduce: real.Reducer = module_.reduce;
export const createReducer: typeof real.createReducer = module_.createReducer;
export const initialState: typeof real.initialState = module_.initialState;
