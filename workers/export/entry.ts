// Bundled (esbuild) into every export as harness/lib.mjs, so replay needs neither the product nor REA.
export { compare, judge, COMPARE_ENGINE_VERSION } from '@lb/compare';
export { runCase } from '../execution/harness';
export { REPLACEMENT_CONTROLS } from '../execution/runners';
export { hardeningArgs } from '../execution/runners';
export { parseReplayArgs, replayInDocker, replayOriginal } from './replay';
