#!/usr/bin/env node
// Diagnostic for a stalled game: node tools/diag.js <seed> '<json BAL>' <day>
const S = require('../static/ob_sim.js');
const seed = parseInt(process.argv[2] || '2', 10), bal = JSON.parse(process.argv[3] || '{}'), day = parseInt(process.argv[4] || '20', 10);
const m = S.create({ seed, bal });
while (!m.over && m.day < day) S.step(m);
const ev0 = m.events.length;
const snap = () => { const o = {}; for (const z of m.zombies) if (z.alive) o[z.id] = [z.x, z.z]; return o; };
let prev = snap(), lastSq = '';
while (!m.over && m.day === day) {
  S.step(m);
  const sq = m.squad;
  const key = sq ? sq.state + ':' + sq.ri : 'none';
  if (key !== lastSq) { console.log(`  [${m.phase} ${m.clock.toFixed(1)}s] squad ${key}` + (sq ? ` at (${sq.ax.toFixed(0)},${sq.az.toFixed(0)}) pace ${sq.pace.toFixed(2)} threat ${m.squadThreat} why '${sq.why}' route ${sq.route.map((b) => b.name + '@' + Math.round(Math.hypot(b.doorX, b.doorZ))).join(',')}` : '')); lastSq = key; }
  if (m.phase === 'night' && (Math.abs(m.clock - 30) < 0.026 || Math.abs(m.clock - 58) < 0.026)) {
    const now = snap(), rows = {};
    for (const z of m.zombies) {
      if (!z.alive) continue;
      const p = prev[z.id] || [z.x, z.z];
      const k = z.type + '/' + z.mode;
      const r = rows[k] = rows[k] || { n: 0, dist: 0, moved: 0, minD: 1e9, stuck: 0 };
      const d = Math.hypot(z.x, z.z), mv = Math.hypot(z.x - p[0], z.z - p[1]);
      r.n++; r.dist += d; r.moved += mv; r.minD = Math.min(r.minD, d); if (mv < 1 && d > 40) r.stuck++;
    }
    console.log(`  night clock ${m.clock.toFixed(0)}: ` + Object.keys(rows).map((k) => `${k} n=${rows[k].n} avgDist=${Math.round(rows[k].dist / rows[k].n)} min=${Math.round(rows[k].minD)} movedSinceLast=${Math.round(rows[k].moved / rows[k].n)} stuckFar=${rows[k].stuck}`).join(' | '));
    prev = now;
  }
}
console.log('events of day ' + day + ':');
console.log(m.events.slice(ev0).map((e) => '  ' + e.phase[0] + ' ' + e.text.slice(0, 150)).join('\n'));
const fit = m.humans.filter((h) => h.alive);
console.log('humans alive', fit.length, 'weapons', JSON.stringify(fit.reduce((o, h) => (o[h.weapon] = (o[h.weapon] || 0) + 1, o), {})), 'armory', m.armory.length, 'posts', JSON.stringify(fit.reduce((o, h) => (o[h.post.type] = (o[h.post.type] || 0) + 1, o), {})));
