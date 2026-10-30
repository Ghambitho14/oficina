// Métricas del servidor leyendo el /proc del host (montado en solo lectura en /host/proc).
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const proc = (...p) => path.join(config.hostRoot, 'proc', ...p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cpuTimes() {
  const line = (await fs.readFile(proc('stat'), 'utf8')).split('\n')[0];
  const nums = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = nums[3] + (nums[4] || 0); // idle + iowait
  const total = nums.reduce((a, b) => a + b, 0);
  return { idle, total };
}

async function cpuPercent() {
  const a = await cpuTimes();
  await sleep(1000);
  const b = await cpuTimes();
  const total = b.total - a.total;
  return total > 0 ? Math.round((1 - (b.idle - a.idle) / total) * 1000) / 10 : 0;
}

async function memory() {
  const text = await fs.readFile(proc('meminfo'), 'utf8');
  const kb = Object.fromEntries(
    text.split('\n').filter(Boolean).map((l) => {
      const [k, v] = l.split(':');
      return [k, parseInt(v, 10)];
    }),
  );
  const pct = (used, total) => (total ? Math.round((used / total) * 1000) / 10 : 0);
  return {
    totalMb: Math.round(kb.MemTotal / 1024),
    usedMb: Math.round((kb.MemTotal - kb.MemAvailable) / 1024),
    ramPercent: pct(kb.MemTotal - kb.MemAvailable, kb.MemTotal),
    swapPercent: pct(kb.SwapTotal - kb.SwapFree, kb.SwapTotal),
  };
}

async function disk() {
  // /host/var/log vive en el disco raíz del host, así que statfs nos da el uso del disco principal
  // sin tener que montar todo "/" dentro del contenedor.
  const target = path.join(config.hostRoot, 'var', 'log');
  const s = await fs.statfs(target);
  const total = s.blocks * s.bsize;
  const free = s.bavail * s.bsize;
  return {
    diskTotalGb: Math.round((total / 1024 ** 3) * 10) / 10,
    diskFreeGb: Math.round((free / 1024 ** 3) * 10) / 10,
    diskPercent: total ? Math.round(((total - free) / total) * 1000) / 10 : 0,
  };
}

async function topProcesses(limit = 5) {
  const pids = (await fs.readdir(proc())).filter((d) => /^\d+$/.test(d));
  const procs = [];
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const status = await fs.readFile(proc(pid, 'status'), 'utf8');
        const name = status.match(/^Name:\s+(.+)$/m)?.[1];
        const rss = parseInt(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || '0', 10);
        if (rss) procs.push({ pid: Number(pid), name, memMb: Math.round(rss / 1024) });
      } catch {
        // el proceso terminó mientras leíamos: lo ignoramos
      }
    }),
  );
  return procs.sort((a, b) => b.memMb - a.memMb).slice(0, limit);
}

export async function collectHost() {
  const [cpu, mem, dsk, load, uptime, cpuinfo, top] = await Promise.all([
    cpuPercent(),
    memory(),
    disk(),
    fs.readFile(proc('loadavg'), 'utf8'),
    fs.readFile(proc('uptime'), 'utf8'),
    fs.readFile(proc('cpuinfo'), 'utf8'),
    topProcesses(),
  ]);
  return {
    cpuPercent: cpu,
    cores: (cpuinfo.match(/^processor\s*:/gm) || []).length || 1,
    load: load.split(' ').slice(0, 3).map(Number),
    uptimeHours: Math.round(parseFloat(uptime) / 360) / 10,
    ...mem,
    ...dsk,
    topProcesses: top,
  };
}
