#!/usr/bin/env node
// Balance probe: node tools/balance.js <seed> '<json BAL overrides>' '<json opts>'
const S = require('../static/ob_sim.js');
const seed = parseInt(process.argv[2] || '1', 10);
const bal = JSON.parse(process.argv[3] || '{}');
const opts = JSON.parse(process.argv[4] || '{}');
const m = S.run(Object.assign({ seed, bal }, opts));
console.log([process.argv[5] || '', seed, m.winner, 'day', m.day, 'h', m.hAlive, 'z', m.zAlive, 'resc', m.stats.rescued, 'lost', m.stats.humansLost,
  'kill', m.stats.zKilled, 'breach', m.stats.breaches, 'ammo', m.ammo, 'scrap', Math.round(m.scrap), 'turrets', m.turrets].join(' '));
