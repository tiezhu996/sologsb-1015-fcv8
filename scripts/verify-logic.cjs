#!/usr/bin/env node
/**
 * 无浏览器依赖的纯逻辑验证：
 * 1. 用 tsc 把引擎/存储/模型编译到 scripts/_verify_out；
 * 2. 运行 collation-engine 与 poetry-store 两套行为验证。
 * 组件级 karma 套件仍由 `npm test` 承担（需 Chrome）。
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'scripts', '_verify_out');
fs.rmSync(outDir, { recursive: true, force: true });

const tscBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
execFileSync(tscBin, [
  '--outDir', outDir,
  '--rootDir', path.join(root, 'src/app'),
  '--module', 'commonjs',
  '--target', 'es2022',
  '--moduleResolution', 'node',
  '--experimentalDecorators',
  '--skipLibCheck',
  'src/app/services/poetry-store.service.ts',
  'src/app/services/collation-engine.ts',
  'src/app/services/storage.adapter.ts',
  'src/app/models/poem.models.ts',
], { cwd: root, stdio: 'inherit' });

require(path.join(root, 'scripts', 'verify-engine.cjs'));
require(path.join(root, 'scripts', 'verify-store.cjs'));
