import assert from 'node:assert/strict';
import { isProcessAlive, pruneClosedSessions } from '../liveness.js';

if (typeof global.gc !== 'function') {
  throw new Error('запусти с --expose-gc');
}

const PID_CHECKS = 1_000_000;
const PHASES = 5;
const CYCLES_PER_PHASE = 200_000;
const CPU_BUDGET_MS = 1_000;
const STEADY_HEAP_BUDGET = 2 * 1024 * 1024;
const STEADY_RSS_BUDGET = 8 * 1024 * 1024;

global.gc();
const pidCpuStart = process.cpuUsage();
const pidWallStart = process.hrtime.bigint();
for (let i = 0; i < PID_CHECKS; i += 1) assert.equal(isProcessAlive(process.pid), true);
const pidWallMs = Number(process.hrtime.bigint() - pidWallStart) / 1e6;
const pidCpu = process.cpuUsage(pidCpuStart);
const pidCpuMs = (pidCpu.user + pidCpu.system) / 1000;
assert.ok(pidCpuMs < CPU_BUDGET_MS, `PID checks заняли ${pidCpuMs.toFixed(1)} ms CPU`);

let missing = new Map();
const samples = [];
for (let phase = 0; phase < PHASES; phase += 1) {
  for (let j = 0; j < CYCLES_PER_PHASE; j += 1) {
    const i = phase * CYCLES_PER_PHASE + j;
    const id = `s${i}`;
    const sessions = { [id]: { agent: 'codex', processPid: i + 100 } };
    const first = pruneClosedSessions(sessions, new Set(), missing, i * 2, 1);
    const second = pruneClosedSessions(sessions, new Set(), first.missingSince, i * 2 + 1, 1);
    missing = second.missingSince;
  }
  global.gc();
  samples.push(process.memoryUsage());
}

assert.equal(missing.size, 0, 'реестр закрытых сессий вырос');
// Первые две фазы прогревают и расширяют арены V8. После прогрева heap и RSS должны выйти
// на плато; сравниваем третью и пятую точки, а не холодный старт процесса.
const heapGrowth = samples.at(-1).heapUsed - samples[2].heapUsed;
const rssGrowth = samples.at(-1).rss - samples[2].rss;
assert.ok(heapGrowth < STEADY_HEAP_BUDGET, `heap продолжил расти: ${heapGrowth} bytes`);
assert.ok(rssGrowth < STEADY_RSS_BUDGET, `RSS продолжил расти: ${rssGrowth} bytes`);

console.log(JSON.stringify({
  pidChecks: PID_CHECKS,
  pidWallMs: +pidWallMs.toFixed(2),
  pidCpuMs: +pidCpuMs.toFixed(2),
  nsPerPidCheck: +(pidWallMs * 1e6 / PID_CHECKS).toFixed(0),
  churnCycles: PHASES * CYCLES_PER_PHASE,
  finalMapSize: missing.size,
  steadyHeapGrowthKb: +(heapGrowth / 1024).toFixed(1),
  steadyRssGrowthMb: +(rssGrowth / 1048576).toFixed(1),
}, null, 2));
