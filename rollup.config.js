import typescript from 'rollup-plugin-typescript2';
import { nodeResolve } from '@rollup/plugin-node-resolve';

export default {
  input: 'main.ts',
  output: {
    dir: '.',
    sourcemap: false,
    format: 'cjs',
    exports: 'default',
    entryFileNames: 'main.js'
  },
  external: [
  'obsidian',
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/rangeset',
  '@codemirror/language',
  '@codemirror/text',
  'crelt'
],
  plugins: [nodeResolve(), typescript()]
};
