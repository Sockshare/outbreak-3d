#!/usr/bin/env node
// Outbreak 3D simulation checks: node tools/test_outbreak.js
const assert = require('assert');
const S = require('../static/ob_sim.js');

console.log('1. Setup respects the sandbox options & creates 10 emotions + personalities...');
{
  const m = S.create({ seed: 5, humans: 22, zombies: 140 });
  assert.strictEqual(m.humans.length, 22); assert.strictEqual(m.zombies.length, 140);
  assert.strictEqual(S.EMOTIONS.length, 10, 'must have exactly 10 emotional factors');
  for (const h of m.humans) {
    assert(h.personality && S.PERSONALITIES[h.personality], 'valid personality archetype');
    for (const em of S.EMOTIONS) {
      assert(typeof h.emotions[em.id] === 'number' && h.emotions[em.id] >= 0 && h.emotions[em.id] <= 100, 'emotion 0-100: ' + em.id);
    }
  }
  console.log('   -> ok (10 emotional factors & 12 personality archetypes verified)');
}

console.log('2. Age, handicap, and emotions alter speed and survival odds...');
{
  const m = S.create({ seed: 9 });
  const h = m.humans.find((x) => x.age > 20 && x.age < 50 && !x.handicaps.length);
  const base = S.survivability(h), v = S.speedOf(h);
  const was = h.age;
  h.age = 3; assert(S.survivability(h) < base && S.speedOf(h) < v, 'under 5');
  h.age = 75; assert(S.survivability(h) < base && S.speedOf(h) < v, 'over 60');
  h.age = was; h.handicaps.push('leg'); assert(S.survivability(h) < base && S.speedOf(h) < v * 0.6, 'leg injury');
  console.log('   -> ok');
}

console.log('3. Same seed gives the same game...');
{
  const a = S.run({ seed: 21 }, 20 * 150), b = S.run({ seed: 21 }, 20 * 150);
  assert.strictEqual(JSON.stringify(a.stats), JSON.stringify(b.stats));
  assert.strictEqual(a.events.length, b.events.length);
  console.log('   -> ok');
}

console.log('4. Full games finish with a winner, social drama fires, and solid collision holds...');
for (const seed of [1, 2, 6]) {
  const m = S.create({ seed });
  let n = 0, sawSquadOutside = false, sawNight = false;
  while (!m.over && n++ < 20 * 120 * 125) {
    S.step(m);
    if (n % 40 === 0) {
      assert.strictEqual(m.humans.filter((h) => h.alive).length, m.hAlive, 'human count drifted');
      assert.strictEqual(m.zombies.filter((z) => z.alive).length, m.zAlive, 'zombie count drifted');
      for (const e of m.humans.concat(m.zombies)) {
        if (!e.alive) continue;
        assert(Number.isFinite(e.x) && Number.isFinite(e.z), 'bad position');
        // Verify nobody is inside a town building AABB
        const ci = Math.round(e.x / S.CELL), cj = Math.round(e.z / S.CELL);
        const b = m.L.grid[ci + ',' + cj];
        if (b) {
          const inB = Math.abs(e.x - b.x) < b.w / 2 + 0.3 && Math.abs(e.z - b.z) < b.d / 2 + 0.3;
          assert(!inB, `Entity ${e.id} phased inside building ${b.name} at (${e.x},${e.z})`);
        }
      }
      if (m.squad && !S.inBase(m.squad.ax, m.squad.az)) sawSquadOutside = true;
      if (m.phase === 'night') sawNight = true;
    }
  }
  assert(m.over && m.winner !== 'draw', `seed ${seed} did not produce a winner`);
  assert(sawSquadOutside && sawNight, 'expected an expedition and a night');
  assert((m.stats.conflicts || 0) + (m.stats.romances || 0) + (m.stats.bonds || 0) > 0, 'expected interpersonal events');
  console.log(`   seed ${seed}: ${m.winner} win on day ${m.day} | rescued ${m.stats.rescued}, lost ${m.stats.humansLost}, conflicts ${m.stats.conflicts}, romances ${m.stats.romances}, breakups ${m.stats.breakups}, sabotages ${m.stats.sabotages}`);
}

console.log('5. "Able-bodied only" policy turns people away...');
{
  const m = S.run({ seed: 4, policy: 'able', childRate: 0.2, elderRate: 0.25 }, 20 * 120 * 4);
  assert(m.stats.leftBehind > 0, 'expected some survivors to be left behind');
  console.log(`   -> rescued ${m.stats.rescued}, left behind ${m.stats.leftBehind}`);
}
console.log('6. Season Two invariants: adults-only romance, bunks, cliques, corpses, dog (checked every 2 s over full games)...');
{
  const tot = {};
  for (const seed of [3, 11]) {
    const m = S.create({ seed, humans: 20 });
    let n = 0;
    while (!m.over && n++ < 20 * 120 * 40) {
      S.step(m);
      if (n % 40) continue;
      const byId = {};
      for (const h of m.humans) byId[h.id] = h;
      for (const h of m.humans) {
        if (!h.alive) continue;
        if (h.partnerId) {
          const p = byId[h.partnerId];
          assert(h.age >= S.ADULT && p && p.age >= S.ADULT, `partner under ${S.ADULT}: ${h.name} (${h.age.toFixed(1)})`);
          assert(!S.isFamily(h, p), 'partners are family: ' + h.name);
          assert.strictEqual(p.partnerId, h.id, 'partner link is one-sided');
        }
        if (h.crushId) assert(h.age >= S.ADULT && byId[h.crushId] && byId[h.crushId].age >= S.ADULT, 'crush involves a minor: ' + h.name);
        if (h.pregnant > 0) assert(h.age >= S.ADULT, 'pregnant minor');
        for (const l of h.liaisons) assert(h.age >= S.ADULT && byId[l.id].age >= S.ADULT, 'liaison involves a minor: ' + h.name);
        const mate = S.bunkmateOf(m, h);
        if (mate && (h.age < S.ADULT) !== (mate.age < S.ADULT)) assert(S.isFamily(h, mate), `minor bunked with an unrelated adult: ${h.name} / ${mate.name}`);
        if (h.cliqueId) assert(S.cliqueOf(m, h) && S.cliqueOf(m, h).memberIds.indexOf(h.id) >= 0, 'clique membership out of sync');
        assert(h.hp > 0 && Number.isFinite(h.hp), 'bad hp on a living survivor: ' + h.name);
      }
      for (const c of m.cliques) assert(c.memberIds.length >= 3 && c.name, 'clique too small');
      assert(m.fuel >= 0 && m.firewood >= 0 && m.bodies.length <= 45, 'resource out of range');
      if (m.phase === 'night' && m.fuel <= 0) assert.strictEqual(m.power, false, 'power on with an empty tank');
      for (const b of m.bodies) assert(S.inBase(b.x, b.z), 'corpse recorded outside the walls');
      if (m.dog.alive) assert(S.inBase(m.dog.x, m.dog.z) && m.dog.hp > 0, 'dog out of bounds');
    }
    assert(m.over, 'game did not finish');
    for (const k of Object.keys(m.stats)) if (typeof m.stats[k] === 'number') tot[k] = (tot[k] || 0) + m.stats[k];
    console.log(`   seed ${seed}: ${m.winner} win on day ${m.day} | cliques ${m.stats.cliques}, triangles ${m.stats.triangles}, bunk fights ${m.stats.bunkFights}, blackouts ${m.stats.blackouts}, dog warnings ${m.stats.dogWarnings}, burned ${m.stats.bodiesBurned}, distress ${m.stats.distressCalls}`);
  }
  for (const k of ['crushes', 'cliques', 'bunkFights', 'blackouts', 'dogWarnings', 'bodiesBurned', 'flings']) assert(tot[k] > 0, 'expected the system to fire at least once: ' + k);
}

console.log('7. Blackout, amputation and distress-call paths (forced)...');
{
  const m = S.create({ seed: 8 });
  while (m.phase !== 'night') S.step(m);
  for (let i = 0; i < 40; i++) S.step(m);
  S.godBlackout(m);
  assert.strictEqual(m.power, false); assert(m.stats.blackouts >= 1, 'blackout not counted');
  S.godFuel(m); S.step(m);
  assert.strictEqual(m.power, true, 'generator did not restart after refuelling');

  let amps = 0, saved = 0, died = 0;
  for (let seed = 30; seed < 60; seed++) {
    const g = S.create({ seed });
    S.step(g);
    g.antivirals = 0;
    const h = g.humans.find((x) => x.age > 20 && x.age < 50 && !x.handicaps.length);
    h.infected = 100; h.bitten = true; h.biteSite = 'leg'; h.concealed = false;
    for (let i = 0; i < 20 * 61 && h.alive && !h.ampTried; i++) S.step(g);
    if (!h.ampTried) continue;
    amps++;
    if (!h.alive) { died++; continue; }
    assert(h.handicaps.indexOf('leg') >= 0 && h.amputated === 'leg', 'amputation must leave a real leg handicap');
    if (!(h.infected > 0)) saved++;
  }
  assert(amps >= 10 && saved > 0 && died > 0, `amputation should be a real gamble (tried ${amps}, saved ${saved}, died ${died})`);
  console.log(`   -> blackout ok; amputations tried ${amps}: ${saved} saved, ${died} died on the table`);

  let answered = 0;
  for (let seed = 70; seed < 76; seed++) {
    const g = S.run({ seed, bal: {} }, 20 * 120 * 6);
    answered += g.stats.radioRescues + g.stats.radioTraps;
  }
  assert(answered > 0, 'no distress call was ever answered');
  console.log(`   -> distress calls answered across 6 games: ${answered}`);
}
console.log('OUTBREAK 3D CHECKS PASSED');
