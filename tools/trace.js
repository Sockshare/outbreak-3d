#!/usr/bin/env node
// Day-by-day trace of one game: node tools/trace.js <seed> '<json BAL>' <maxDays>
const S = require('../static/ob_sim.js');
const seed = parseInt(process.argv[2] || '1', 10);
const bal = JSON.parse(process.argv[3] || '{}');
const maxDays = parseInt(process.argv[4] || '40', 10);
const m = S.create({ seed, bal });
let lastDay = 0, lastPhase = '', evI = 0, killsAt = 0;
while (!m.over && m.day <= maxDays) {
  S.step(m);
  if (m.day !== lastDay || m.phase !== lastPhase) {
    const evs = m.events.slice(evI); evI = m.events.length;
    const cnt = (re) => evs.filter((e) => re.test(e.text)).length;
    const stocked = m.L.buildings.filter((b) => b.stock > 0).length;
    const fit = m.humans.filter((h) => h.alive && h.age >= 15 && h.age <= 60 && h.handicaps.indexOf('leg') < 0).length;
    const guns = m.humans.filter((h) => h.alive && !S.WEAPONS[h.weapon].melee).length;
    const zs = m.zombies.filter((z) => z.alive);
    const modes = { idle: 0, hunt: 0, siege: 0 };
    zs.forEach((z) => modes[z.mode]++);
    const inside = zs.filter((z) => S.inBase(z.x, z.z)).length;
    const broken = m.L.segs.filter((s) => s.hp <= 0).length;
    console.log(`d${lastDay}${lastPhase[0] || '-'} -> d${m.day}${m.phase[0]} | h ${m.hAlive} (fit ${fit}, guns ${guns}) z ${m.zAlive} [idle ${modes.idle} hunt ${modes.hunt} siege ${modes.siege} inside ${inside}] | kills ${m.stats.zKilled - killsAt} | ammo ${m.ammo} scrap ${Math.round(m.scrap)} med ${m.medkits.toFixed(1)} av ${m.antivirals} | stocked ${stocked}/${m.L.buildings.length} broken ${broken} bunker ${Math.round(m.bunkerHp)} | exp: ${cnt(/^Expedition of/)} noexp: ${evs.filter((e) => /expedition today|Too few|Not enough daylight/.test(e.text)).map((e) => e.text.slice(0, 40)).join(';')}`);
    killsAt = m.stats.zKilled; lastDay = m.day; lastPhase = m.phase;
  }
}
console.log('END', m.winner || 'running', 'day', m.day, m.reason);
