const os = require("node:os");
const { performance } = require("node:perf_hooks");

function createEncoderBudget(limit = 2) {
  const running = new Map();
  let cpus = os.cpus(), utilization = performance.eventLoopUtilization(), sampled = 0, pressure = 0;
  function snapshot() {
    if (Date.now() - sampled >= 1000) {
      const next = os.cpus();
      let idle = 0, total = 0;
      next.forEach((cpu, index) => {
        const previous = cpus[index]?.times || cpu.times;
        idle += cpu.times.idle - previous.idle;
        for (const key of Object.keys(cpu.times)) total += cpu.times[key] - previous[key];
      });
      const loop = performance.eventLoopUtilization(utilization);
      utilization = performance.eventLoopUtilization(); cpus = next; sampled = Date.now();
      pressure = Math.max(total ? 1 - idle / total : 0, loop.utilization);
    }
    return { active: running.size, limit, pressure, encodingRatio: Math.max(0, ...running.values()) };
  }
  return {
    snapshot,
    acquire(key) {
      if (running.size >= limit) throw Object.assign(new Error("The server is busy encoding other streams. Try again or use Auto."), { code: "QUALITY_BUSY" });
      running.set(key, 0);
      return { sample: ratio => running.set(key, ratio), release: () => running.delete(key) };
    }
  };
}

module.exports = { createEncoderBudget };
