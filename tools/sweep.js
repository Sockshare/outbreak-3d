#!/usr/bin/env node
// Balance sweep: runs each named config over N seeds in parallel child processes and prints a win-rate table.
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const configs = JSON.parse(process.argv[2]);          // { name: { bal overrides } }
const seeds = parseInt(process.argv[3] || '8', 10);
const opts = process.argv[4] || '{}';
const jobs = [];
for (const name of Object.keys(configs)) for (let s = 1; s <= seeds; s++) jobs.push({ name, s });
const out = {};
let running = 0, idx = 0;
const max = Math.max(2, os.cpus().length - 2);
function next() {
  while (running < max && idx < jobs.length) {
    const j = jobs[idx++];
    running++;
    execFile('node', [path.join(__dirname, 'balance.js'), String(j.s), JSON.stringify(configs[j.name]), opts, j.name], (err, so) => {
      running--;
      (out[j.name] = out[j.name] || []).push(err ? 'ERR ' + String(err).slice(0, 200) : so.trim());
      if (idx >= jobs.length && running === 0) report(); else next();
    });
  }
}
function report() {
  for (const name of Object.keys(configs)) {
    const rows = out[name].map((r) => r.split(' '));
    const errs = out[name].filter((r) => r.startsWith('ERR'));
    const wins = rows.filter((r) => r[2] === 'humans').length, draws = rows.filter((r) => r[2] === 'draw').length;
    const days = rows.map((r) => +r[4]).sort((a, b) => a - b);
    const avg = (i) => Math.round(rows.reduce((s, r) => s + (+r[i] || 0), 0) / rows.length);
    const drawSeeds = rows.filter((r) => r[2] === 'draw').map((r) => r[1]).join(',');
    console.log(`${name}: humans win ${wins}/${rows.length}, draws ${draws}, days ${days[0]}-${days[days.length - 1]} (median ${days[days.length >> 1]}), avg rescued ${avg(10)}, lost ${avg(12)}, breaches ${avg(16)}, end ammo ${avg(18)}, turrets ${avg(22)}${drawSeeds ? ' drawSeeds ' + drawSeeds : ''}${errs.length ? ' ERRORS ' + errs[0] : ''}`);
  }
}
next();
