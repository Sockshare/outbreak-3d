/**
 * Outbreak 3D — simulation core.
 *
 * A seeded, fixed-step, fully autonomous zombie-survival simulation. Runs unchanged in Node (tests, CLI)
 * and in the browser (the renderer only reads this state).
 *
 * Includes:
 *   - 10 Emotional Factors (0-100) per human that shift dynamically with events and alter combat, speed,
 *     cooperation, hoarding, and conflict triggers.
 *   - 12 Personality Archetypes (Stoic Leader, Catty Gossip, Ghetto/HoodScrapper, Ignorant Hothead, Saboteur,
 *     Peacemaker, Ride-or-Die, Entitled Diva, Paranoid Prepper, Instigator, Empath, Opportunist).
 *   - Pairwise Relationships (-100 to +100: Romances, Best Friends, Cliques, Feuds, Rivals, Exes) that bud,
 *     blossom, sour, or explode into breakups, fistfights, sabotage, and expedition delays/mutinies.
 *   - Solid AABB & Circle Physics Collision so neither humans nor zombies phase through buildings, intact
 *     compound walls, the inner bunker, wrecked cars, trees, or each other.
 *   - Season Two systems: secret crushes & love triangles, bunk assignments, paternity drama, named cliques
 *     that vote and brawl as a bloc, a generator with fuel & blackouts, a camp guard dog, seasons that bite
 *     (hypothermia / heat exhaustion), emergency amputations, a radio dish with distress calls, and corpse
 *     disposal with disease. Every romance path is strictly adults-only (see canDate).
 */
(function (root) {
  'use strict';

  const Sim = (function () {
    const DT = 1 / 20;        // simulation step, seconds
    const PHASE = 60;         // simulated seconds per day and per night (pace presets change playback speed)
    const BASE = 22.5;        // half-width of the compound
    const SEG = 9;            // wall segment length (5 per side)
    const CELL = 30;          // town block spacing
    const MAP = 150;          // half-width of the world

    // Balance constants (tuned with tools/test_outbreak.js)
    const BAL = {
      waveBase: 12, waveGrow: 4.5,
      wallHp: 760, gateHp: 600, bunkerHp: 380, wallDmg: 0.16,
      biteP: 0.12, injuryP: 0.18,
      turretCost: 60, scrapPerHp: 1 / 12,
      ammoStart: 11, ammoLoot: 2.2,
      fuelBurn: 0.2, woodBurn: 0.6,
    };

    const WEAPONS = {
      fists:   { name: 'Bare hands',   melee: true, dmg: 7,  str: 0.08, cd: 0.8, reach: 1.7, pow: 0 },
      knife:   { name: 'Knife',        melee: true, dmg: 14, str: 0.12, cd: 0.6, reach: 1.8, pow: 1 },
      bat:     { name: 'Baseball bat', melee: true, dmg: 20, str: 0.22, cd: 0.9, reach: 2.2, pow: 2, twoHand: true },
      pistol:  { name: 'Pistol',       dmg: 30, cd: 0.9, range: 24, pow: 3 },
      shotgun: { name: 'Shotgun',      dmg: 75, cd: 1.5, range: 13, pow: 4, twoHand: true },
      rifle:   { name: 'Sniper rifle', dmg: 60, cd: 1.7, range: 48, pow: 5, twoHand: true },
    };
    const ZTYPES = {
      shambler: { name: 'Shambler',     hp: 60,  spd: 2.0, str: 50, w: 0.52, night: 1.5 },
      sprinter: { name: 'Sprinter',     hp: 42,  spd: 4.0, str: 40, w: 0.14, night: 1.5 },
      brute:    { name: 'Brute',        hp: 170, spd: 1.7, str: 88, w: 0.07, night: 1.5 },
      crawler:  { name: 'Crawler',      hp: 36,  spd: 1.1, str: 38, w: 0.09, night: 1.5 },
      feral:    { name: 'Night-Feral',  hp: 70,  spd: 1.5, str: 55, w: 0.07, night: 2.6 },
      screamer: { name: 'Screamer',     hp: 48,  spd: 2.4, str: 35, w: 0.05, night: 1.6 },
      spitter:  { name: 'Acid Spitter', hp: 52,  spd: 2.1, str: 42, w: 0.04, night: 1.5 },
      riot:     { name: 'Riot Armored', hp: 230, spd: 1.5, str: 72, w: 0.02, night: 1.4 },
      behemoth: { name: 'Behemoth Boss',hp: 440, spd: 1.35,str: 100,w: 0.00, night: 1.4 },
    };
    const WEATHERS = ['clear', 'clear', 'rain', 'fog', 'heatwave', 'snow'];
    const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'];
    const HANDICAPS = {
      leg:    { name: 'Leg injury (limp)',     effect: 'moves at about half speed' },
      arm:    { name: 'Injured / missing arm', effect: 'weaker in melee, cannot use two-handed weapons' },
      vision: { name: 'Poor vision',           effect: 'much less accurate with guns' },
      frail:  { name: 'Asthma / frail',        effect: 'less health and stamina' },
    };

    // 10 Dynamic Emotional Factors (0-100) that alter human behavior
    const EMOTIONS = [
      { id: 'fear',       name: 'Fear / Panic',         desc: 'Shaky aim (-20%), flees combat earlier, may freeze or bolt' },
      { id: 'anger',      name: 'Anger / Volatility',   desc: 'Hits harder in melee (+25%), starts brawls and shouting matches' },
      { id: 'jealousy',   name: 'Jealousy / Petty',     desc: 'Starts catty drama over weapons, partners, and attention' },
      { id: 'greed',      name: 'Greed / Selfishness',  desc: 'Pockets scavenged ammo/scrap and hogs medkits' },
      { id: 'paranoia',   name: 'Paranoia / Distrust',  desc: 'Accuses others of bites or theft, sabotages gates or stashes' },
      { id: 'pride',      name: 'Pride / Ego',          desc: 'Refuses orders, clashes with leaders, demands top weapons' },
      { id: 'empathy',    name: 'Empathy / Devotion',   desc: 'Heals faster (+20%), protects kids/hurt, bonds deeply' },
      { id: 'loyalty',    name: 'Loyalty / Solidarity', desc: 'Stands firm beside friends/partners (+18% combat), never deserts' },
      { id: 'hope',       name: 'Hope / Optimism',       desc: 'Lifts camp morale, repairs faster, keeps fighting' },
      { id: 'resentment', name: 'Resentment / Spite',   desc: 'Slows down work, sabotages rivals, disrupts morning roll-call' },
    ];

    // 12 Personality / Behavioral Archetypes ("human tendencies")
    const PERSONALITIES = {
      leader:     { id: 'leader',     name: 'Stoic Leader',         tag: 'good', bias: { loyalty: 25, hope: 20, pride: 15, fear: -15 }, desc: 'Disciplined organizer who breaks up fights and rallies the squad.' },
      peacemaker: { id: 'peacemaker', name: 'Soft-Hearted Mediator', tag: 'good', bias: { empathy: 30, hope: 20, anger: -20, resentment: -15 }, desc: 'Calms feuds, comforts children, and patches up hurt teammates.' },
      rideordie:  { id: 'rideordie',  name: 'Ride-or-Die Protector', tag: 'good', bias: { loyalty: 35, empathy: 20, anger: 10, fear: -20 }, desc: 'Fiercely protective of their inner circle; will throw hands for a friend.' },
      catty:      { id: 'catty',      name: 'Catty Gossip',         tag: 'bad',  bias: { jealousy: 35, pride: 25, resentment: 20, empathy: -15 }, desc: 'Throws shade, starts cliques, talks behind backs, and stirs relationship drama.' },
      ghetto:     { id: 'ghetto',     name: 'Streetwise Scrapper',  tag: 'warn', bias: { anger: 28, pride: 25, loyalty: 20, fear: -20 }, desc: 'Loud, zero-filter, talks trash at the gate, squares up fast, but scraps hard against zombies.' },
      ignorant:   { id: 'ignorant',   name: 'Ignorant Hothead',     tag: 'bad',  bias: { pride: 35, anger: 25, paranoia: 15, empathy: -20 }, desc: 'Ignores safety rules, fires loud shots that draw zombies, and refuses to listen to medics.' },
      diva:       { id: 'diva',       name: 'Entitled Diva',        tag: 'bad',  bias: { pride: 38, greed: 25, jealousy: 25, loyalty: -15 }, desc: 'Complains about chores, stalls morning expeditions, and demands the best gear.' },
      saboteur:   { id: 'saboteur',   name: 'Two-Faced Saboteur',   tag: 'bad',  bias: { resentment: 35, paranoia: 30, greed: 25, loyalty: -30 }, desc: 'Hoards supplies, loosens barricades out of spite, and backstabs rivals.' },
      instigator: { id: 'instigator', name: 'Messy Instigator',     tag: 'bad',  bias: { jealousy: 30, anger: 25, resentment: 25 }, desc: 'Spreads rumors, pits couples against each other, and loves watching chaos.' },
      paranoid:   { id: 'paranoid',   name: 'Paranoid Prepper',     tag: 'warn', bias: { paranoia: 40, fear: 20, greed: 20, empathy: -15 }, desc: 'Suspects everyone is bitten or stealing; hides extra ammo for themselves.' },
      opportunist:{ id: 'opportunist',name: 'Slick Opportunist',    tag: 'warn', bias: { greed: 35, pride: 15, fear: 15, loyalty: -20 }, desc: 'Looks out for number one, skims supplies off the top, and ducks danger.' },
      grounded:   { id: 'grounded',   name: 'Everyday Survivor',    tag: 'info', bias: { hope: 10, loyalty: 10, empathy: 10 }, desc: 'Regular person trying to stay alive and keep their head down.' },
    };
    const VICES = ['None', 'None', 'None', 'Smoker', 'Caffeine Fiend', 'Insomniac', 'Sweet Tooth'];
    const PERS_WEIGHTS = [
      ['grounded', 0.22], ['leader', 0.08], ['peacemaker', 0.08], ['rideordie', 0.09],
      ['catty', 0.10], ['ghetto', 0.10], ['ignorant', 0.09], ['diva', 0.06],
      ['saboteur', 0.05], ['instigator', 0.05], ['paranoid', 0.04], ['opportunist', 0.04],
    ];

    const BACKGROUNDS = [
      { id: 'nurse',      name: 'ER Nurse',        med: 22, emp: 15 },
      { id: 'mechanic',   name: 'Auto Mechanic',   rep: 24, str: 10 },
      { id: 'soldier',    name: 'Ex-Soldier',      aim: 22, brav: 20, str: 10 },
      { id: 'teacher',    name: 'School Teacher',  emp: 18, hope: 15 },
      { id: 'cook',       name: 'Line Cook',       stam: 15, str: 8 },
      { id: 'thief',      name: 'Petty Thief',     spd: 16, greed: 20 },
      { id: 'pastor',     name: 'Pastor',          hope: 24, emp: 20 },
      { id: 'firefighter',name: 'Firefighter',     str: 18, brav: 20, stam: 14 },
      { id: 'influencer', name: 'Influencer',      pride: 24, jeal: 18 },
      { id: 'boxer',      name: 'Street Boxer',    str: 22, spd: 12, anger: 15 },
      { id: 'pharmacist', name: 'Pharmacist',      med: 26 },
      { id: 'carpenter',  name: 'Carpenter',       rep: 26, str: 12 },
      { id: 'guard',      name: 'Security Guard',  aim: 14, para: 15 },
      { id: 'student',    name: 'College Student', spd: 14, hope: 12 },
    ];
    const BTYPES = [
      { id: 'house',     name: 'House',          scrap: 1.0, ammo: 0.6, med: 0.7, wpn: 0.25 },
      { id: 'shop',      name: 'Corner shop',    scrap: 0.8, ammo: 0.4, med: 0.8, wpn: 0.15 },
      { id: 'clinic',    name: 'Clinic',         scrap: 0.4, ammo: 0.2, med: 2.6, wpn: 0.05 },
      { id: 'police',    name: 'Police station', scrap: 0.6, ammo: 2.6, med: 0.5, wpn: 0.85 },
      { id: 'hardware',  name: 'Hardware store', scrap: 2.6, ammo: 0.3, med: 0.3, wpn: 0.35 },
      { id: 'warehouse', name: 'Warehouse',      scrap: 2.0, ammo: 0.6, med: 0.4, wpn: 0.20 },
      { id: 'garage',    name: 'Garage',         scrap: 1.8, ammo: 0.4, med: 0.3, wpn: 0.30 },
    ];
    const CULTURES = [
      { id: 'black',      name: 'Black / African American', skins: [3, 4], hairs: [0, 5],
        f: ['Deja', 'Keisha', 'Simone', 'Brianna', 'Aaliyah', 'Nia', 'Tasha', 'Destiny'],
        m: ['Malik', 'Marcus', 'Darnell', 'Tyrone', 'Andre', 'Devon', 'Rashad', 'Terrence'],
        l: ['Jackson', 'Washington', 'Brooks', 'Carter', 'Robinson', 'Hayes', 'Coleman', 'Jenkins'] },
      { id: 'white',      name: 'White American', skins: [0, 1], hairs: [1, 2, 3, 4],
        f: ['Ashley', 'Brittany', 'Hannah', 'Madison', 'Chloe', 'Paige', 'Megan', 'Taylor'],
        m: ['Tyler', 'Brandon', 'Kyle', 'Trevor', 'Austin', 'Cody', 'Hunter', 'Dylan'],
        l: ['Miller', 'Davis', 'Anderson', 'Thompson', 'Cooper', 'Reed', 'Bennett', 'Miller'] },
      { id: 'latino',     name: 'Latino / Hispanic-American', skins: [1, 2, 3], hairs: [0, 1, 5],
        f: ['Sofia', 'Camila', 'Valentina', 'Gabriela', 'Adriana', 'Marisol', 'Elena', 'Rosa'],
        m: ['Mateo', 'Carlos', 'Diego', 'Luis', 'Javier', 'Gabriel', 'Hector', 'Marco'],
        l: ['Rodriguez', 'Hernandez', 'Lopez', 'Morales', 'Rivera', 'Delgado', 'Castillo', 'Vega'] },
      { id: 'chinese',    name: 'Chinese-American', skins: [0, 1], hairs: [0, 5],
        f: ['Tiffany', 'Michelle', 'Vivian', 'Chloe', 'Emily', 'Grace', 'Stephanie', 'Mei'],
        m: ['Kevin', 'Jason', 'Ryan', 'Brandon', 'Eric', 'Justin', 'Bryan', 'Derek'],
        l: ['Chen', 'Wang', 'Lin', 'Zhang', 'Wu', 'Liu', 'Yang', 'Huang'] },
      { id: 'japanese',   name: 'Japanese-American', skins: [0, 1], hairs: [0, 5],
        f: ['Kayla', 'Erika', 'Naomi', 'Maya', 'Kimi', 'Hana', 'Rachel', 'Sara'],
        m: ['Kenji', 'Kyle', 'Tyler', 'Derek', 'Sean', 'Ryan', 'nathan', 'Ethan'],
        l: ['Tanaka', 'Sato', 'Takahashi', 'Watanabe', 'Nakamura', 'Kobayashi', 'Yamamoto'] },
      { id: 'korean',     name: 'Korean-American', skins: [0, 1], hairs: [0, 5],
        f: ['Grace', 'Jennifer', 'Christine', 'Hannah', 'Rachel', 'Esther', 'Claire', 'Jenny'],
        m: ['Daniel', 'Justin', 'Brian', 'Andrew', 'Kevin', 'David', 'Josh', 'Eugene'],
        l: ['Kim', 'Park', 'Lee', 'Choi', 'Jung', 'Kang', 'Cho', 'Yoon'] },
      { id: 'filipino',   name: 'Filipino-American', skins: [1, 2], hairs: [0, 1, 5],
        f: ['Jasmine', 'Angelica', 'Alyssa', 'Bea', 'Nicole', 'Bianca', 'Katrina', 'Camille'],
        m: ['Paolo', 'Jordan', 'Christian', 'Mark', 'Joshua', 'Gabriel', 'Marco', 'Jerome'],
        l: ['Santos', 'Reyes', 'Cruz', 'Bautista', 'Mendoza', 'Garcia', 'Aquino', 'Ramos'] },
      { id: 'vietnamese', name: 'Vietnamese-American', skins: [0, 1, 2], hairs: [0, 5],
        f: ['Tiffany', 'Jenny', 'Kathy', 'Linh', 'Michelle', 'Vivian', 'Cindy', 'Thuy'],
        m: ['Tommy', 'Andy', 'Kevin', 'Danny', 'Tony', 'Steven', 'Johnny', 'Minh'],
        l: ['Nguyen', 'Tran', 'Le', 'Pham', 'Hoang', 'Vo', 'Dang', 'Bui'] },
      { id: 'thai',       name: 'Thai-American', skins: [1, 2], hairs: [0, 1, 5],
        f: ['Nadia', 'Nina', 'Maya', 'Tara', 'Natalie', 'Sasha', 'Ploy', 'Kira'],
        m: ['Jay', 'Nick', 'Alex', 'Ben', 'Chris', 'Dylan', 'Luke', 'Sam'],
        l: ['Srisai', 'Chaiyaporn', 'Rattana', 'Thongchai', 'Wattana', 'Sukhum', 'Charoen'] },
    ];
    const FIRST_F = ['Maya', 'Elena', 'Ruth', 'Aisha', 'Nora', 'Grace', 'Ivy', 'Lena', 'Rosa', 'Priya', 'Hana', 'Zoe', 'Ada', 'June', 'Mei', 'Tess', 'Dana', 'Lucy', 'Carmen', 'Faith'];
    const FIRST_M = ['Marcus', 'Eli', 'Omar', 'Jonah', 'Felix', 'Diego', 'Sam', 'Theo', 'Raj', 'Caleb', 'Hugo', 'Ivan', 'Leo', 'Noah', 'Kofi', 'Ben', 'Amir', 'Wes', 'Tomas', 'Abel'];
    const LAST = ['Reyes', 'Okafor', 'Lindqvist', 'Park', 'Hale', 'Moreno', 'Voss', 'Tanaka', 'Brooks', 'Nasser', 'Kowalski', 'Finch', 'Duarte', 'Sato', 'Mercer', 'Ahn', 'Castell', 'Ward', 'Novak', 'Ibarra', 'Quinn', 'Marsh', 'Soto', 'Bello'];

    const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
    const hyp = Math.hypot;
    const inBase = (x, z) => Math.abs(x) < BASE && Math.abs(z) < BASE;

    function rng(m) {
      m.seed = (m.seed + 0x6d2b79f5) | 0;
      let t = Math.imul(m.seed ^ (m.seed >>> 15), 1 | m.seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    const R = (m, a, b) => a + rng(m) * (b - a);
    const pick = (m, arr) => arr[Math.floor(rng(m) * arr.length)];

    function ev(m, text, kind) {
      m.events.push({ t: m.t, day: m.day, phase: m.phase, text, kind: kind || 'info' });
      if (m.events.length > 500) m.events.splice(0, 100);
      if (kind === 'bad' || /breakup|dump|scandal|beef|fight|sabotage|gossip|rumor|brig|mutiny|bully|pocketed|refused|triangle|crush|father|paternity|clique|bunk|frozen out/i.test(text)) {
        const dkind = /breakup|dump|scandal|cheating|paternity/i.test(text) ? 'breakup' : /beef|fight|punch|squared|rival|blowup|clique war/i.test(text) ? 'beef' : 'drama';
        m.dramaLog.push({ day: m.day, kind: dkind, text });
        if (m.dramaLog.length > 150) m.dramaLog.shift();
      }
    }
    function fx(m, o) { if (m.fx.length < 300) m.fx.push(o); }

    // ------------------------------------------------------------------ layout
    function makeLayout(m) {
      const L = {
        base: BASE, seg: SEG, cell: CELL, map: MAP,
        segs: [], towers: [], buildings: [], grid: {}, trees: [], cars: [],
        bunker: { x: 0, z: -8, w: 14, d: 9, doorX: 0, doorZ: -2.4 },
        infirmary: { x: -13, z: 10, w: 9, d: 7 },
        brig: { x: 13.5, z: -8, w: 5.5, d: 5.5 },
        garden: { x: -13.5, z: -8, w: 7.5, d: 6.5 },
        kitchen: { x: 6, z: 12, w: 3, d: 3 },
        generator: { x: 18.6, z: 2 }, radioDish: { x: -18.8, z: 1 }, burnPit: { x: 13, z: BASE + 9 },
        gateIn: { x: 0, z: BASE - 5 }, gateOut: { x: 0, z: BASE + 6 },
      };
      const N = [[0, 1], [1, 0], [0, -1], [-1, 0]];   // outward normals: south, east, north, west
      for (let s = 0; s < 4; s++) {
        for (let k = 0; k < 5; k++) {
          const t = (k - 2) * SEG, nx = N[s][0], nz = N[s][1];
          const gate = s === 0 && k === 2;
          const hp = gate ? BAL.gateHp : BAL.wallHp;
          L.segs.push({ id: s * 5 + k, side: s, k, gate, nx, nz, cx: nx ? nx * BASE : t, cz: nz ? nz * BASE : t, hp, maxHp: hp, att: 0, crowd: 0 });
        }
      }
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) L.towers.push({ x: sx * (BASE - 3), z: sz * (BASE - 3), turret: false, cd: 0 });

      // Town blocks around the compound
      for (let i = -4; i <= 4; i++) {
        for (let j = -4; j <= 4; j++) {
          if (Math.abs(i) <= 1 && Math.abs(j) <= 1) continue;
          if (rng(m) < 0.24) continue;
          const w = R(m, 11, 18), d = R(m, 11, 18);
          const x = i * CELL + R(m, -2.5, 2.5), z = j * CELL + R(m, -2.5, 2.5);
          const type = pick(m, BTYPES);
          let dx = 0, dz = 0;
          if (Math.abs(x) > Math.abs(z)) dx = -Math.sign(x); else dz = -Math.sign(z);
          const b = {
            id: L.buildings.length, x, z, w, d, h: R(m, 5, 13), type: type.id, name: type.name, bt: type,
            doorX: x + dx * (w / 2 + 2.6), doorZ: z + dz * (d / 2 + 2.6), fx: dx, fz: dz,
            stock: 2, visits: 0, tint: rng(m), ruin: rng(m),
          };
          L.buildings.push(b);
          L.grid[i + ',' + j] = b;
        }
      }
      for (let n = 0; n < 520; n++) {
        const x = R(m, -MAP - 40, MAP + 40), z = R(m, -MAP - 40, MAP + 40);
        const far = Math.max(Math.abs(x), Math.abs(z)) > 4.5 * CELL + 4;
        const i = Math.round(x / CELL), j = Math.round(z / CELL);
        const empty = !L.grid[i + ',' + j] && !(Math.abs(i) <= 1 && Math.abs(j) <= 1) && Math.abs(x - i * CELL) < 9 && Math.abs(z - j * CELL) < 9;
        if (far || (empty && rng(m) < 0.6)) L.trees.push({ x, z, s: R(m, 0.7, 1.5), k: rng(m) });
      }
      for (let n = 0; n < 46; n++) {
        const along = R(m, -4.4 * CELL, 4.4 * CELL), lane = (Math.floor(R(m, -4, 5)) + 0.5) * CELL + R(m, -2, 2);
        const horiz = rng(m) < 0.5;
        const x = horiz ? along : lane, z = horiz ? lane : along;
        if (Math.max(Math.abs(x), Math.abs(z)) < BASE + 14) continue;
        L.cars.push({ x, z, yaw: (horiz ? Math.PI / 2 : 0) + R(m, -0.5, 0.5), c: rng(m) });
      }
      return L;
    }

    // ------------------------------------------------------------------ people & emotions
    function combatFactor(age) {
      if (age < 12) return 0;
      if (age < 16) return 0.6;
      if (age <= 55) return 1;
      if (age <= 65) return 0.85;
      if (age <= 75) return 0.65;
      return 0.45;
    }
    function ageBody(age) {
      if (age < 5) return 0.22;
      if (age < 12) return 0.5;
      if (age < 16) return 0.78;
      if (age <= 45) return 1;
      if (age <= 60) return 0.9;
      if (age <= 70) return 0.7;
      return 0.52;
    }
    const has = (h, k) => h.handicaps.indexOf(k) >= 0;
    function maxHpOf(h) {
      return Math.round(100 * (0.45 + 0.55 * ageBody(h.age)) * (has(h, 'frail') ? 0.7 : 1) * (0.8 + 0.4 * h.stam / 100));
    }
    function speedOf(h) {
      if (h.age < 5) return 1.3;
      let v = (3.0 + h.spd * 0.028) * (0.55 + 0.45 * ageBody(h.age));
      if (has(h, 'leg')) v *= 0.55;
      if (has(h, 'frail')) v *= 0.9;
      if (h.emotions) {
        if (h.emotions.resentment > 72 && h.where === 'squad') v *= 0.86;
        if (h.emotions.anger > 70) v *= 1.06;
      }
      if (h.fatigue > 75) v *= 0.85;
      if (h.cold && h.where === 'squad') v *= 0.82;   // no winter coat in the snow
      if (h.heatT > 0) v *= 0.75;
      if (h.sickT > 0) v *= 0.9;
      return v;
    }
    function dominantEmotion(h) {
      if (!h.emotions) return { id: 'hope', name: 'Calm', val: 50 };
      let bestId = 'hope', bestVal = -1;
      for (const em of EMOTIONS) {
        const v = h.emotions[em.id] || 0;
        if (v > bestVal) { bestVal = v; bestId = em.id; }
      }
      const meta = EMOTIONS.find((x) => x.id === bestId) || EMOTIONS[0];
      return { id: bestId, name: meta.name.split(' / ')[0], full: meta.name, val: Math.round(bestVal) };
    }
    function survivability(h) {
      if (!h.alive) return 0;
      const w = WEAPONS[h.weapon];
      let s = 0.12 + 0.24 * combatFactor(h.age) + 0.13 * (h.str / 100) + 0.14 * (speedOf(h) / 5.8)
        + 0.10 * (h.aim / 100) * (has(h, 'vision') ? 0.5 : 1) + 0.07 * (h.brav / 100) + 0.12 * (h.hp / h.maxHp) + 0.02 * w.pow;
      s -= 0.06 * h.handicaps.length;
      if (h.infected > 0) s -= 0.18;
      if (h.age < 5 || h.age > 60) s -= 0.05;
      if (h.emotions) {
        s += (h.emotions.loyalty + h.emotions.hope - h.emotions.fear * 0.8 - h.emotions.paranoia * 0.4) * 0.0006;
        if (h.partnerId) s += 0.03;
      }
      return clamp(s, 0.02, 0.98);
    }

    function pickPersonality(m, age) {
      if (age < 8) return 'grounded';
      const r = rng(m);
      let acc = 0;
      for (const [id, w] of PERS_WEIGHTS) {
        acc += w;
        if (r <= acc) return id;
      }
      return 'grounded';
    }

    function makeHuman(m, forceAdult) {
      const o = m.opts;
      const r = rng(m);
      let age;
      if (!forceAdult && r < o.childRate) age = R(m, 1, 4.99);
      else if (!forceAdult && r < o.childRate + o.elderRate) age = R(m, 61, 84);
      else age = !forceAdult && rng(m) < 0.15 ? R(m, 5, 16) : R(m, 17, 58);
      const u2 = () => (rng(m) + rng(m)) * 50;
      const body = ageBody(age);
      const female = rng(m) < 0.5;
      const persId = pickPersonality(m, age);
      const pers = PERSONALITIES[persId] || PERSONALITIES.grounded;
      const emotions = {};
      for (const em of EMOTIONS) {
        const base = R(m, 18, 58) + (pers.bias[em.id] || 0);
        emotions[em.id] = clamp(Math.round(base), 5, 96);
      }
      const bg = age >= 17 ? pick(m, BACKGROUNDS) : { id: 'kid', name: age < 5 ? 'Toddler' : 'Youth' };
      if (bg.emp) emotions.empathy = clamp(emotions.empathy + bg.emp, 0, 100);
      if (bg.hope) emotions.hope = clamp(emotions.hope + bg.hope, 0, 100);
      if (bg.greed) emotions.greed = clamp(emotions.greed + bg.greed, 0, 100);
      if (bg.pride) emotions.pride = clamp(emotions.pride + bg.pride, 0, 100);
      if (bg.jeal) emotions.jealousy = clamp(emotions.jealousy + bg.jeal, 0, 100);
      if (bg.anger) emotions.anger = clamp(emotions.anger + bg.anger, 0, 100);
      if (bg.para) emotions.paranoia = clamp(emotions.paranoia + bg.para, 0, 100);
      const cult = pick(m, CULTURES);
      const h = {
        id: m.nextId++, kind: 'human', alive: true,
        culture: cult.id, cultureName: cult.name,
        name: pick(m, female ? cult.f : cult.m) + ' ' + pick(m, cult.l), female,
        age,
        bg: bg.name,
        vice: age >= 18 ? pick(m, VICES) : 'None',
        familyIds: [],
        sanity: Math.round(R(m, 68, 98)),
        fatigue: Math.round(R(m, 5, 25)),
        trauma: 0,
        personality: persId,
        personalityName: pers.name,
        emotions,
        rels: {},         // otherHumanId -> score (-100 to +100)
        partnerId: 0,     // romantic partner id
        exIds: [],        // former partners (bitter breakups!)
        bestFriendId: 0,  // ride-or-die / bestie
        rivalId: 0,       // main enemy / beef target
        lastSocialT: -20,
        socialBubble: '', // floating speech/emote icon above head
        socialLine: '',   // short dialogue snippet
        socialBubbleT: 0,
        faction: 'main',
        brigT: 0,
        exiled: false,
        pregnant: 0,
        parents: null,
        concealed: false,
        ragdollT: 0,
        dramaCount: 0,
        hoarded: 0,
        crushId: 0,       // secret one-sided crush (adults only)
        liaisons: [],     // recent partners / flings: { id, day }
        cliqueId: 0, bunkId: 0, noBunkWith: 0, insomniaT: 0, sickT: 0, heatT: 0, cold: false, biteSite: '', amputated: '', ampTried: false,
        str: clamp(u2() * body * (female ? 0.92 : 1.05) + (bg.str || 0), 2, 100),
        spd: clamp(u2() * (0.4 + 0.6 * body) + (bg.spd || 0), 2, 100),
        aim: clamp(u2() * (age < 12 ? 0.2 : age < 16 ? 0.7 : 1) + (age > 60 ? 8 : 0) + (bg.aim || 0), 1, 100),
        med: clamp((rng(m) < 0.18 ? R(m, 60, 100) : R(m, 2, 45)) * (age < 16 ? 0.3 : 1) + (age > 60 ? 15 : 0) + (bg.med || 0), 1, 100),
        rep: clamp((rng(m) < 0.2 ? R(m, 60, 100) : R(m, 2, 45)) * (age < 16 ? 0.3 : 1) + (age > 60 ? 12 : 0) + (bg.rep || 0), 1, 100),
        brav: clamp(u2() - (emotions.fear - 40) * 0.3, 5, 100), stam: clamp(u2(), 5, 100),
        handicaps: [], weapon: 'fists',
        hp: 1, maxHp: 1, infected: 0, bitten: false, kills: 0, injuries: 0,
        where: 'base', escort: false, carriedBy: 0, carrying: 0, assisting: 0,
        post: { type: 'yard', x: 0, z: 8 }, duty: null, retreat: false,
        x: 0, z: 8, yaw: 0, mv: 0, atkT: 0, lastAtk: -9, lastHit: -9, wt: 0, joinedDay: m.day,
        look: { skin: pick(m, cult.skins), shirt: Math.floor(rng(m) * 10), pants: Math.floor(rng(m) * 6), hair: pick(m, cult.hairs) },
      };
      if (!forceAdult && rng(m) < o.handicapRate) {
        h.handicaps.push(pick(m, ['leg', 'arm', 'vision', 'frail']));
        if (rng(m) < 0.08) { const k = pick(m, ['leg', 'arm', 'vision', 'frail']); if (!has(h, k)) h.handicaps.push(k); }
      }
      h.maxHp = maxHpOf(h);
      h.hp = h.maxHp;
      return h;
    }

    // ------------------------------------------------------------------ relationships & interpersonal drama
    function getRel(a, b) {
      if (!a || !b || a.id === b.id) return 0;
      return a.rels[b.id] || 0;
    }
    function addRel(m, a, b, delta) {
      if (!a || !b || a.id === b.id) return;
      const v = clamp((a.rels[b.id] || 0) + delta, -100, 100);
      a.rels[b.id] = v;
      b.rels[a.id] = clamp((b.rels[a.id] || 0) + delta, -100, 100);
      refreshSocialBonds(a);
      refreshSocialBonds(b);
    }
    function refreshSocialBonds(h) {
      let bestF = 0, bestFv = 42, worstR = 0, worstRv = -38;
      for (const k of Object.keys(h.rels)) {
        const id = +k, v = h.rels[id];
        if (id === h.partnerId) continue;
        if (v > bestFv) { bestFv = v; bestF = id; }
        if (v < worstRv) { worstRv = v; worstR = id; }
      }
      h.bestFriendId = bestF;
      h.rivalId = worstR;
    }
    function setBubble(h, icon, dur, line) {
      h.socialBubble = icon;
      h.socialLine = line || '';
      h.socialBubbleT = dur || 4.8;
    }
    function seedInitialRelationships(m) {
      const adults = m.humans.filter((h) => h.age >= 16);
      for (let i = 0; i < adults.length; i++) {
        for (let j = i + 1; j < adults.length; j++) {
          const a = adults[i], b = adults[j];
          const r = rng(m);
          if (r < 0.14 && !a.partnerId && !b.partnerId && canDate(a, b)) {
            a.partnerId = b.id; b.partnerId = a.id;
            a.rels[b.id] = b.rels[a.id] = Math.round(R(m, 68, 92));
            noteLiaison(m, a, b);
            m.stats.romances = (m.stats.romances || 0) + 1;
          } else if (r < 0.30) {
            a.rels[b.id] = b.rels[a.id] = Math.round(R(m, 45, 78));
          } else if (r < 0.46) {
            a.rels[b.id] = b.rels[a.id] = Math.round(R(m, -78, -42));
          }
          refreshSocialBonds(a);
          refreshSocialBonds(b);
        }
      }
      // Seed 2-3 starting family pairs (siblings or parent-child sharing surname)
      for (let i = 0; i < m.humans.length; i++) {
        for (let j = i + 1; j < m.humans.length; j++) {
          const a = m.humans[i], b = m.humans[j];
          if (a.familyIds.length || b.familyIds.length || a.partnerId === b.id) continue;
          if (rng(m) < 0.09) {
            const sur = a.name.split(' ')[1];
            b.name = b.name.split(' ')[0] + ' ' + sur;
            a.familyIds.push(b.id); b.familyIds.push(a.id);
            a.rels[b.id] = b.rels[a.id] = Math.round(R(m, 72, 95));
            refreshSocialBonds(a); refreshSocialBonds(b);
          }
        }
      }
    }

    function triggerSocialEvent(m) {
      const alive = m.humans.filter((h) => h.alive && h.age >= 13);
      if (alive.length < 2) return;
      const a = pick(m, alive);
      const pool = alive.filter((x) => x.id !== a.id && (x.where === a.where || rng(m) < 0.3));
      if (!pool.length) return;
      const b = pick(m, pool);
      const rel = getRel(a, b);
      const pA = a.personality, pB = b.personality;
      const fnA = a.name.split(' ')[0], fnB = b.name.split(' ')[0];


      // Helper: pick an unused key so the same drama/confession never repeats back-to-back
      function pickFresh(keyPrefix, arr) {
        const recent = m.recentDramaKeys || (m.recentDramaKeys = []);
        const avail = arr.map((item, idx) => ({ item, k: `${keyPrefix}_${idx}` })).filter((x) => !recent.includes(x.k));
        const chosen = avail.length ? pick(m, avail) : { item: pick(m, arr), k: `${keyPrefix}_0` };
        recent.push(chosen.k);
        if (recent.length > 18) recent.shift();
        return chosen.item;
      }

      const ldr = m.leaderId && m.byId[m.leaderId] && m.byId[m.leaderId].alive ? m.byId[m.leaderId] : null;
      const partnerA = a.partnerId && m.byId[a.partnerId] && m.byId[a.partnerId].alive ? m.byId[a.partnerId] : null;
      const exA = a.exIds && a.exIds.length ? m.byId[a.exIds[a.exIds.length - 1]] : null;
      const rivalA = a.rivalId && m.byId[a.rivalId] && m.byId[a.rivalId].alive ? m.byId[a.rivalId] : null;
      const third = alive.find((x) => x.id !== a.id && x.id !== b.id) || b;
      const grown = alive.filter((x) => x.age >= ADULT);
      const adultThird = grown.find((x) => x.id !== a.id && x.id !== b.id && !isFamily(a, x)) || null;
      const fnLdr = ldr ? ldr.name.split(' ')[0] : 'the leader';
      const fnThird = third ? third.name.split(' ')[0] : fnB;
      const wxWord = (m.weather || 'clear').toLowerCase();

      // 0A. Dynamic Context-Aware & Steamy Confession Booth (consistent with survivor's real relationships, state & traits)
      if (rng(m) < 0.56) {
        const pool = [];
        // Steamy / romantic / attraction confessions (always adult, non-explicit, consistent with age >= 18)
        if (a.age >= ADULT && b.age >= ADULT && !isFamily(a, b)) {
          pool.push(
            `Me and ${fnB} definitely weren't "checking inventory" in the supply tent last night. Half this camp would lose their damn minds if they knew.`,
            `I don't even care about ${fnB}'s attitude — they're fine as hell after dark and I'm tired of pretending I'm not looking.`,
            `Caught ${fnB} sneaking out of the bunker fixing their shirt at 4 AM. Walk of shame in the middle of an outbreak is crazy.`,
            `If we make it through tonight's siege, I'm pulling ${fnB} behind the infirmary curtain and locking the latch.`,
            `The way ${fnB} looked at me by the rainwater barrels during the ${wxWord} had me forgetting there were zombies outside the wall.`,
            `Somebody needs to tell ${fnB} to stop walking around the yard looking that good in a tank top when tension is already this high.`,
            `We were supposed to be on watchtower duty together, and let's just say neither of us was watching the perimeter for twenty minutes.`
          );
          if (partnerA) {
            pool.push(
              `${partnerA.name.split(' ')[0]} thinks I was cleaning rifles with ${fnB} at 2 AM. Yeah... let's stick with that story.`,
              `I love ${partnerA.name.split(' ')[0]}, I really do, but ${adultThird ? adultThird.name.split(' ')[0] : 'somebody on night watch'} has been flirting with me all week and I'm only human.`,
              `Lowkey I'm only staying with ${partnerA.name.split(' ')[0]} because I'm terrified of sleeping alone when the horde hits the gate.`
            );
          } else {
            pool.push(
              `Being single in this compound is a whole soap opera. Half these couples are miserable and sliding me looks behind each other's backs.`,
              `I'm one bad night away from shooting my shot with ${fnB} right in front of everybody. What are they gonna do, kick me out?`
            );
          }
        }
        // State-consistent confessions (Exes, Rivals, Leader, Low Food/Water, Trauma, Habits)
        if (exA && exA.alive) {
          pool.push(`Seeing my ex ${exA.name.split(' ')[0]} strutting around the yard like nothing happened makes my blood boil. Somebody hold me back.`);
          pool.push(`Every time ${exA.name.split(' ')[0]} tries to act unbothered around me, I remember how quick they folded when things got ugly.`);
        }
        if (rivalA) {
          pool.push(`Half the time I wish ${rivalA.name.split(' ')[0]} would catch a stray sprinter on an expedition so I wouldn't have to hear their damn mouth.`);
          pool.push(`I saw ${rivalA.name.split(' ')[0]} flinch at a shadow yesterday. If the wall breaks, I'm not lifting a finger to save their ass.`);
        }
        if (ldr && ldr.id !== a.id) {
          pool.push(`${fnLdr} walks around acting like they own this compound. One more dumb call and I'm rallying the yard to replace them.`);
        }
        if (m.food < 18 || m.water < 18) {
          pool.push(`Food's down to ${Math.round(m.food)} and water's at ${Math.round(m.water)}, yet certain people are still taking seconds. Somebody's getting checked tonight.`);
        }
        if (a.vice && a.vice !== 'None') {
          pool.push(`Being a ${a.vice.toLowerCase()} in the apocalypse is pure hell. Next person who touches my hidden stash is catching these hands.`);
        }
        if (a.trauma > 0 || a.sanity < 55) {
          pool.push(`I haven't slept three hours straight since we lost people outside the gate. Every time I close my eyes I still hear them screaming.`);
        }
        pool.push(
          `I've been hiding extra ammo and painkillers under my bunk mattress. Nobody in this camp is trustworthy enough to know.`,
          `Everybody thinks I'm loyal to this compound, but the second that pickup truck is gassed up, I'm tempted to leave these clowns behind.`,
          `I didn't survive a whole-ass outbreak as a ${a.bg} just to scrub pots for people who can't even hit a shambler from five feet away.`
        );
        const line = pickFresh('conf', pool);
        const entry = { day: m.day, clock: Math.floor(m.clock), id: a.id, name: a.name, culture: a.cultureName || '', bg: a.bg, pers: a.personalityName, text: line, t: 8.5 };
        m.confessional = entry;
        m.confessionals.push(entry);
        if (m.confessionals.length > 80) m.confessionals.shift();
      }

      // 0B. Dynamic Relationship & Scandal Generator (Cheating, Ex-Confrontations, Love Triangles, Steamy Flings)
      const coupled = alive.filter((h) => h.partnerId && m.byId[h.partnerId] && m.byId[h.partnerId].alive && (h.personality === 'diva' || h.personality === 'ghetto' || h.personality === 'instigator' || h.personality === 'opportunist' || h.emotions.jealousy > 50));
      if (coupled.length && alive.length >= 4 && rng(m) < 0.22) {
        const cheater = pick(m, coupled);
        const sideOpts = alive.filter((x) => x.id !== cheater.partnerId && canDate(cheater, x));
        const sidePiece = sideOpts.length ? pick(m, sideOpts) : null;
        const partner = m.byId[cheater.partnerId];
        const snitch = grown.find((x) => x.id !== cheater.id && x.id !== (sidePiece && sidePiece.id) && (x.personality === 'catty' || x.personality === 'instigator')) || pick(m, grown);
        if (sidePiece && partner && snitch) {
          addRel(m, cheater, partner, -55);
          addRel(m, partner, sidePiece, -65);
          cheater.partnerId = 0; partner.partnerId = 0;
          noteLiaison(m, cheater, sidePiece); markSingle(m, cheater, partner);
          if (cheater.exIds.indexOf(partner.id) < 0) cheater.exIds.push(partner.id);
          if (partner.exIds.indexOf(cheater.id) < 0) partner.exIds.push(cheater.id);
          refreshSocialBonds(cheater); refreshSocialBonds(partner); refreshSocialBonds(sidePiece);
          partner.emotions.anger = 100; partner.emotions.jealousy = 100;
          setBubble(snitch, '📸', 6, 'CAUGHT IN 4K!!');
          setBubble(partner, '🤬', 6.5, 'RUN ME MY FADE!!');
          setBubble(cheater, '😬', 5.5, 'Wait—let me explain!');
          setBubble(sidePiece, '💅', 5.5, 'Your partner was bored, babe.');
          const cObj = { day: m.day, clock: Math.floor(m.clock), id: partner.id, name: partner.name, culture: partner.cultureName || '', bg: partner.bg, pers: partner.personalityName, text: pickFresh('scand_conf', [
            `Caught ${cheater.name.split(' ')[0]} and ${sidePiece.name.split(' ')[0]} sneaking out of the bunker half-dressed?! Oh, I'm flipping EVERY table in this camp.`,
            `I really risked my life on expeditions for ${cheater.name.split(' ')[0]} while they were creeping behind my back with ${sidePiece.name.split(' ')[0]}?! Dead to me.`,
            `${cheater.name.split(' ')[0]} really threw away everything we had for ${sidePiece.name.split(' ')[0]} of all people? Embarrassing as hell.`,
            `Both ${cheater.name.split(' ')[0]} and ${sidePiece.name.split(' ')[0]} better sleep with one eye open tonight. On God.`
          ]), t: 9.0 };
          m.confessional = cObj; m.confessionals.push(cObj);
          m.dramaLog.push({ day: m.day, kind: 'breakup', aId: partner.id, bId: cheater.id, text: `${snitch.name} caught ${cheater.name} & ${sidePiece.name} sneaking behind the bunker — ${partner.name} snapped and dumped ${cheater.name.split(' ')[0]}!` });
          m.stats.breakups = (m.stats.breakups || 0) + 1; m.stats.conflicts = (m.stats.conflicts || 0) + 1;
          cheater.dramaCount += 2;
          ev(m, `SCANDAL: ${snitch.name} caught ${cheater.name} and ${sidePiece.name} sneaking behind the bunker! ${partner.name} snapped, threw hands, and dumped ${cheater.name.split(' ')[0]} on the spot!`, 'bad');
          return;
        }
      }

      // 0B3. Secret crushes: sabotage a couple, or shoot the shot once the crush is single
      if (crushDrama(m, a)) return;

      // 0B2. Steamy Late-Night Hookups, Flirting, Jealous Triangles & Ex Clashes (adults only; the gossip is an adult too)
      if (rng(m) < 0.24 && adultThird && a.age >= ADULT && b.age >= ADULT && !isFamily(a, b)) {
        if (exA && exA.alive && exA.id === b.id) {
          addRel(m, a, b, -15);
          setBubble(a, '🙄', 5, 'Stay away from me.');
          setBubble(b, '😒', 5, 'You wish I cared.');
          const txt = `${a.name} and their ex ${b.name} crossed paths by the bunker and immediately got into a bitter shouting match about their breakup.`;
          m.dramaLog.push({ day: m.day, kind: 'beef', text: txt });
          ev(m, txt, 'bad');
          return;
        }
        const gossip = grown.find((x) => x.id !== a.id && x.id !== b.id && (x.personality === 'catty' || x.personality === 'instigator' || x.personality === 'diva')) || adultThird;
        addRel(m, a, b, 18);
        noteLiaison(m, a, b); m.stats.flings++;
        const steamy = pickFresh('steamy', [
          { ba: '😏 Last night was wild...', bb: '🤫 Keep your voice down!', bg: '👀 WALK OF SHAME!!',
            ev: `${gossip.name} spotted ${a.name} and ${b.name} slipping out of the supply bunker half-dressed at dawn — now the whole camp is talking.` },
          { ba: '🔥 Come to my bunk later?', bb: '😉 After night watch...', bg: '📸 TEA!!',
            ev: `Steamy tension in the yard: ${a.name} and ${b.name} were caught whispering and flirting hard behind the infirmary curtain.` },
          { ba: '💋 You look good in the rain...', bb: '😏 Stop playing with me', bg: '🍿 OOOOH!!',
            ev: `${a.name} and ${b.name} got caught tangled up in the camp lounge after hours; ${gossip.name} couldn't wait to spill the tea.` },
          { ba: '🥃 Share a drink with me?', bb: '😈 Only if you lock the door', bg: '👀 WHOA!!',
            ev: `Late-night sparks: ${a.name} and ${b.name} disappeared into the watchtower stairwell for an hour, leaving ${gossip.name} howling with gossip.` },
        ]);
        setBubble(a, '', 5.2, steamy.ba);
        setBubble(b, '', 5.2, steamy.bb);
        if (gossip) setBubble(gossip, '', 5.2, steamy.bg);
        m.dramaLog.push({ day: m.day, kind: 'drama', text: steamy.ev });
        if (m.dramaLog.length > 150) m.dramaLog.shift();
        ev(m, steamy.ev, 'info');
        return;
      }

      // 0C. Dynamic, Context-Aware Yard Blowups (tied to actual Rations, Weapons, Weather, Leadership, or Habits)
      if (rng(m) < 0.32 && alive.length >= 3) {
        const hype = third;
        const blowups = [];
        if (m.food < 20 || m.water < 20) {
          blowups.push({
            la: 'WHO ATE MY DAMN RATIONS?!', lb: 'DON’T POINT AT ME, BITCH!',
            ev: `Ration Riot: With food at ${Math.round(m.food)}, ${a.name} accused ${b.name} of sneaking extra cans from the kitchen and they threw hands!`
          });
        }
        if (a.weapon === 'fists' && b.weapon !== 'fists') {
          blowups.push({
            la: `WHY YOU HOARDING THAT ${WEAPONS[b.weapon].name.toUpperCase()}?!`, lb: 'EARN YOUR OWN SHIT!',
            ev: `Gear Envy: Unarmed ${a.name} tried to snatch ${b.name}'s ${WEAPONS[b.weapon].name}, sparking a nasty brawl in front of the bunker!`
          });
        }
        if (ldr && (a.id === ldr.id || b.id === ldr.id)) {
          blowups.push({
            la: 'YOU THINK YOU RUN THIS CAMP?!', lb: 'FALL IN LINE OR WALK!',
            ev: `Leadership Clash: ${a.name} challenged Camp Leader ${b.name} in the middle of the yard until bystanders stepped between them!`
          });
        }
        blowups.push(
          { la: 'GET THE FUCK OUT MY FACE!', lb: 'RUN ME MY FADE THEN!',
            ev: `Yard Blowup: ${a.name} (${a.bg}) and ${b.name} (${b.bg}) got into a screaming match over bunker chores while ${fnThird} cheered them on!` },
          { la: 'WHO TOUCHED MY RICE COOKER?!', lb: 'IT WAS DIRTY AS HELL!',
            ev: `Kitchen War: ${a.name} snapped over somebody messing with their cooking setup and squared up on ${b.name} by the campfire!` },
          { la: 'HOLD MY EARRINGS, WATCH THIS!', lb: 'SQUARE THE FUCK UP!',
            ev: `Courtyard Brawl: ${a.name} threw a cup of water in ${b.name}'s face over petty gossip and both started swinging!` },
          { la: 'STOP SNITCHING ON EVERYBODY!', lb: 'KEEP MY NAME OUT YO MOUTH!',
            ev: `Paranoia Clash: ${a.name} called ${b.name} a two-faced snitch in front of the watchtower, escalating into a full-on shoving match!` }
        );
        const chosen = pickFresh('blowup', blowups);
        addRel(m, a, b, -22);
        a.emotions.anger = clamp(a.emotions.anger + 20, 0, 100);
        b.emotions.anger = clamp(b.emotions.anger + 20, 0, 100);
        a.hp = Math.max(12, a.hp - 5); b.hp = Math.max(12, b.hp - 5);
        a.dramaCount++; b.dramaCount++;
        setBubble(a, '🤬', 5.5, chosen.la);
        setBubble(b, '🥊', 5.5, chosen.lb);
        if (hype && hype.id !== a.id && hype.id !== b.id) setBubble(hype, '🍿', 5, 'OOOOH!! GET EM!!');
        m.stats.conflicts = (m.stats.conflicts || 0) + 1;
        ev(m, chosen.ev + cliqueBackup(m, a, b), 'bad');
        return;
      }

      // 1. Catty shade / clique gossip / rumor-spreading
      if ((pA === 'catty' || pA === 'diva' || pA === 'instigator' || a.emotions.jealousy > 68) && rng(m) < 0.38) {
        const third = alive.find((x) => x.id !== a.id && x.id !== b.id);
        addRel(m, a, b, -18);
        a.emotions.jealousy = clamp(a.emotions.jealousy + 8, 0, 100);
        b.emotions.anger = clamp(b.emotions.anger + 16, 0, 100);
        b.emotions.resentment = clamp(b.emotions.resentment + 14, 0, 100);
        a.dramaCount++; m.stats.conflicts = (m.stats.conflicts || 0) + 1;
        setBubble(a, '💅', 5, 'Girl please...'); setBubble(b, '💢', 5, 'Say that again!');
        const lines = [
          `${a.name} rolled their eyes and talked trash about ${b.name}'s outfit and work ethic in front of the whole yard.`,
          `${a.name} started a catty rumor that ${b.name} has been faking injuries to skip wall duty.`,
          `${a.name} made a slick, shady comment about ${b.name}${third ? ' to ' + third.name.split(' ')[0] : ''}; ${fnB} snapped back and now they aren't speaking.`,
          `${a.name} refused to stand next to ${b.name} on watch, calling ${fnB} "dead weight with an attitude."`,
        ];
        ev(m, pick(m, lines), 'bad');
        return;
      }

      // 2. Streetwise / ghetto trash-talk & pressing someone in the yard -> can turn into a fistfight!
      if ((pA === 'ghetto' || pB === 'ghetto' || a.emotions.anger > 74 || rel < -45) && rng(m) < 0.36) {
        const inst = (pA === 'ghetto' || a.emotions.anger >= b.emotions.anger) ? a : b;
        const targ = inst === a ? b : a;
        addRel(m, inst, targ, -24);
        inst.emotions.anger = clamp(inst.emotions.anger + 12, 0, 100);
        targ.emotions.anger = clamp(targ.emotions.anger + 18, 0, 100);
        inst.dramaCount++; m.stats.conflicts = (m.stats.conflicts || 0) + 1;
        if (rng(m) < 0.48 && m.phase === 'day') {
          // Physical scuffle!
          const dA = Math.round(R(m, 4, 11)), dB = Math.round(R(m, 4, 11));
          inst.hp = Math.max(12, inst.hp - dA);
          targ.hp = Math.max(12, targ.hp - dB);
          inst.lastAtk = m.t; targ.lastAtk = m.t;
          setBubble(inst, '🥊', 5.5, 'Square up!'); setBubble(targ, '💢', 5.5, 'Touch me and see!');
          fx(m, { type: 'melee', x: (inst.x + targ.x) * 0.5, z: (inst.z + targ.z) * 0.5 });
          const leader = alive.find((x) => x.personality === 'leader' || x.personality === 'peacemaker');
          ev(m, `${inst.name} got right in ${targ.name}'s face over ration shares — punches flew in the yard (-${dA}/${dB} HP)${leader ? ' before ' + leader.name.split(' ')[0] + ' broke it up' : ''}!` + cliqueBackup(m, inst, targ), 'bad');
        } else {
          setBubble(inst, '🗣️', 5, 'Keep my name out ya mouth!'); setBubble(targ, '😠', 5, 'Back off!');
          ev(m, `${inst.name} checked ${targ.name} loudly in the courtyard: "Keep my name out your mouth or we stepping outside the gate!"`, 'bad');
        }
        return;
      }

      // 3. Ignorant / reckless stunt (wasting ammo, banging on the gate, ignoring quarantine)
      if ((pA === 'ignorant' || a.emotions.pride > 76) && rng(m) < 0.34) {
        a.dramaCount++; m.stats.conflicts = (m.stats.conflicts || 0) + 1;
        setBubble(a, '🤪', 5, 'Watch this!'); setBubble(b, '🤦', 5, 'Are you dumb?!');
        if (m.ammo >= 4 && rng(m) < 0.55) {
          const wasted = Math.min(m.ammo, Math.round(R(m, 2, 5)));
          m.ammo -= wasted;
          // Loud noise draws nearby idle zombies toward the compound or squad!
          for (const z of m.zombies) {
            if (z.alive && z.mode === 'idle' && hyp(z.x - a.x, z.z - a.z) < 48 && rng(m) < 0.35) {
              z.mode = inBase(a.x, a.z) ? 'siege' : 'hunt';
              z.siegeT = 12; z.tgt = a.id;
            }
          }
          ev(m, `${a.name} acted reckless and fired ${wasted} rounds at tin cans to show off — drawing nearby zombies and infuriating ${b.name}!`, 'bad');
        } else {
          addRel(m, a, b, -14);
          ev(m, `${a.name} scoffed at ${b.name}'s safety warning ("Man, zombies ain't even that fast in the sun") and left tools scattered across the yard.`, 'bad');
        }
        return;
      }

      // 4. Sabotage / Hoarding / Paranoia
      if ((pA === 'saboteur' || pA === 'paranoid' || pA === 'opportunist' || a.emotions.greed > 72 || a.emotions.resentment > 74) && rng(m) < 0.34) {
        a.dramaCount++;
        if (a.emotions.resentment > 68 && rng(m) < 0.45) {
          const segs = m.L.segs.filter((s) => s.hp > 140);
          if (segs.length) {
            const s = pick(m, segs);
            const dmg = Math.round(R(m, 45, 95));
            s.hp = Math.max(60, s.hp - dmg);
            m.stats.sabotages = (m.stats.sabotages || 0) + 1;
            setBubble(a, '🗡️', 5);
            ev(m, `Sabotage! Bitter and resentful, ${a.name} secretly loosened bolts on the ${s.gate ? 'front gate' : 'perimeter wall'} (-${dmg} wall HP).`, 'bad');
            return;
          }
        }
        if (m.ammo > 6 || m.scrap > 8) {
          const stAmmo = Math.min(m.ammo, Math.round(R(m, 2, 5)));
          m.ammo -= stAmmo; a.hoarded += stAmmo;
          m.stats.sabotages = (m.stats.sabotages || 0) + 1;
          setBubble(a, '🐍', 5, 'Mine now...'); setBubble(b, '👀', 5, 'Thief!!');
          addRel(m, a, b, -16);
          ev(m, `${b.name} caught ${a.name} stashing ${stAmmo} rounds of ammo into a private bag; ${fnA} swore it was "for emergencies only."`, 'bad');
          return;
        }
      }

      // 5. Relationship drama: Jealousy / Cheating / Breakups / New Romance / Ride-or-Die bonding
      if (a.partnerId && m.byId[a.partnerId] && m.byId[a.partnerId].alive && rng(m) < 0.36) {
        const partner = m.byId[a.partnerId];
        if (a.emotions.jealousy > 62 || partner.emotions.jealousy > 62 || pA === 'catty' || pA === 'instigator' || getRel(a, partner) < 35) {
          // Breakup or jealous blowup!
          if (rng(m) < 0.45) {
            a.partnerId = 0; partner.partnerId = 0;
            a.exIds.push(partner.id); partner.exIds.push(a.id);
            a.rels[partner.id] = partner.rels[a.id] = -65;
            a.emotions.resentment = clamp(a.emotions.resentment + 25, 0, 100);
            partner.emotions.anger = clamp(partner.emotions.anger + 25, 0, 100);
            refreshSocialBonds(a); refreshSocialBonds(partner);
            m.stats.breakups = (m.stats.breakups || 0) + 1;
            setBubble(a, '💔', 6, 'We are DONE!'); setBubble(partner, '💔', 6, 'Fine, walk away!');
            markSingle(m, a, partner);
            ev(m, b.age >= ADULT && b.id !== partner.id
              ? `Messy breakup! ${a.name} and ${partner.name} had a screaming match after ${fnA} accused ${partner.name.split(' ')[0]} of flirting with ${fnB} — they called it quits!`
              : `Messy breakup! ${a.name} and ${partner.name} had one screaming match too many over chores, rations, and who never listens — they called it quits!`, 'bad');
          } else {
            addRel(m, a, partner, -15);
            setBubble(a, '😒', 5); setBubble(partner, '🙄', 5);
            if (b.age >= ADULT && b.id !== partner.id) {
              addRel(m, a, b, -22);
              ev(m, `Jealousy flared when ${a.name} saw ${partner.name} laughing with ${b.name}; ${fnA} made a scene in front of the bunker.`, 'bad');
            } else ev(m, `${a.name} and ${partner.name} bickered loudly in front of the bunker until ${fnA} stormed off.`, 'bad');
          }
          return;
        }
        // Sweet moment between partners
        addRel(m, a, partner, 10);
        a.emotions.hope = clamp(a.emotions.hope + 10, 0, 100);
        partner.emotions.hope = clamp(partner.emotions.hope + 10, 0, 100);
        a.emotions.fear = clamp(a.emotions.fear - 8, 0, 100);
        setBubble(a, '❤️', 5, 'Stay safe out there'); setBubble(partner, '❤️', 5, 'Always.');
        ev(m, `${a.name} and ${partner.name} shared a quiet moment by the watchtower, promising to bring each other home alive.`, 'good');
        return;
      }

      // 6. Budding romance or new Ride-or-Die friendship!
      if (!a.partnerId && !b.partnerId && canDate(a, b) && rel >= 25 && a.exIds.indexOf(b.id) < 0 && rng(m) < 0.42) {
        a.partnerId = b.id; b.partnerId = a.id;
        a.rels[b.id] = b.rels[a.id] = Math.max(rel + 28, 72);
        noteLiaison(m, a, b);
        if (a.crushId === b.id) a.crushId = 0;
        if (b.crushId === a.id) b.crushId = 0;
        a.emotions.hope = clamp(a.emotions.hope + 16, 0, 100);
        b.emotions.hope = clamp(b.emotions.hope + 16, 0, 100);
        a.emotions.loyalty = clamp(a.emotions.loyalty + 14, 0, 100);
        b.emotions.loyalty = clamp(b.emotions.loyalty + 14, 0, 100);
        m.stats.romances = (m.stats.romances || 0) + 1;
        setBubble(a, '❤️', 6, 'Got your back forever'); setBubble(b, '❤️', 6, '❤️');
        ev(m, `Romance blossomed in the deadzone: ${a.name} and ${b.name} have officially coupled up after watching each other's backs.`, 'good');
        return;
      }

      // Default: solidarity / pep talk / reconciliation
      addRel(m, a, b, 16);
      a.emotions.loyalty = clamp(a.emotions.loyalty + 8, 0, 100);
      b.emotions.hope = clamp(b.emotions.hope + 10, 0, 100);
      b.emotions.fear = clamp(b.emotions.fear - 8, 0, 100);
      m.stats.bonds = (m.stats.bonds || 0) + 1;
      setBubble(a, '🤝', 4.5, 'We got this'); setBubble(b, '🤝', 4.5, 'Respect');
      if (rel < -15) {
        ev(m, `${a.name} and ${b.name} squashed their beef over a shared can of rations and shook hands.`, 'good');
      } else {
        ev(m, `${a.name} hyping up ${b.name}: "${fnB}, we got this — nobody gets left behind on our watch."`, 'good');
      }
    }

    function makeZombie(m, x, z, from) {
      let type;
      const z0 = { id: m.nextId++, kind: 'zombie', alive: true, x, z, hx: x, hz: z, yaw: rng(m) * 6.28, mv: 0,
        mode: 'idle', wave: false, tgt: 0, seg: null, segT: 0, thru: false, siegeT: 0, atkT: rng(m), lastAtk: -9, lastHit: -9, wt: 0, tx: x, tz: z,
        name: '', from: 0, age: 30, look: null, kills: 0, bornDay: m.day };
      if (from) {
        type = has(from, 'leg') ? 'crawler' : from.str >= 72 ? 'brute' : from.spd >= 70 ? 'sprinter' : 'shambler';
        const T = ZTYPES[type];
        z0.str = clamp(T.str * 0.6 + from.str * 0.45, 15, 100);
        z0.spd = T.spd * clamp(0.75 + from.spd / 200, 0.75, 1.2) * (from.age < 12 ? 0.7 : 1);
        z0.maxHp = Math.round(T.hp * (0.6 + 0.4 * from.maxHp / 100));
        z0.decay = 0;
        z0.name = from.name; z0.from = from.id; z0.age = from.age; z0.look = from.look; z0.female = from.female;
      } else {
        const r = rng(m);
        let acc = 0;
        for (const k of Object.keys(ZTYPES)) { acc += ZTYPES[k].w; type = k; if (r < acc) break; }
        const T = ZTYPES[type];
        z0.decay = rng(m);
        z0.str = clamp(T.str + R(m, -14, 14), 15, 100);
        z0.spd = T.spd * R(m, 0.85, 1.15);
        z0.maxHp = Math.round(T.hp * (1 - 0.35 * z0.decay) * R(m, 0.9, 1.15));
        z0.age = R(m, 16, 75);
        z0.female = rng(m) < 0.5;
        z0.look = { skin: 0, shirt: Math.floor(rng(m) * 10), pants: Math.floor(rng(m) * 6), hair: Math.floor(rng(m) * 6) };
      }
      z0.type = type;
      z0.hp = z0.maxHp;
      return z0;
    }

    // ------------------------------------------------------------------ solid geometry & collision helpers
    function segAt(L, x, z) {
      const ax = Math.abs(x), az = Math.abs(z);
      let side, t;
      if (az >= ax) { side = z > 0 ? 0 : 2; t = x; } else { side = x > 0 ? 1 : 3; t = z; }
      return L.segs[side * 5 + clamp(Math.floor((t + BASE) / SEG), 0, 4)];
    }
    function hitsRect(x0, z0, x1, z1, b, mg) {
      const minX = b.x - b.w / 2 - mg, maxX = b.x + b.w / 2 + mg, minZ = b.z - b.d / 2 - mg, maxZ = b.z + b.d / 2 + mg;
      let t0 = 0, t1 = 1;
      const dx = x1 - x0, dz = z1 - z0;
      for (const [p, q] of [[-dx, x0 - minX], [dx, maxX - x0], [-dz, z0 - minZ], [dz, maxZ - z0]]) {
        if (p === 0) { if (q < 0) return false; continue; }
        const r = q / p;
        if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
      }
      return t0 <= t1;
    }
    const COMPOUND = { id: -2, x: 0, z: 0, w: 2 * BASE, d: 2 * BASE };
    function detour(L, e, tx, tz, d, aroundCompound) {
      const x = e.x, z = e.z;
      const a = Math.min(d, 24), px = x + ((tx - x) / d) * a, pz = z + ((tz - z) / d) * a;
      let blk = null;
      if (aroundCompound && hitsRect(x, z, px, pz, COMPOUND, 1.2)) blk = COMPOUND;
      if (!blk) {
        const ci = Math.round(x / CELL), cj = Math.round(z / CELL);
        for (let i = ci - 1; i <= ci + 1 && !blk; i++) {
          for (let j = cj - 1; j <= cj + 1; j++) {
            const b = L.grid[i + ',' + j];
            if (b && hitsRect(x, z, px, pz, b, 1.2)) { blk = b; break; }
          }
        }
      }
      if (!blk) { e.navB = -1; return null; }
      if (e.navB !== blk.id) { e.navB = blk.id; e.navSeen = 0; e.navC = -1; }
      const corner = (k) => [blk.x + (k & 1 ? 1 : -1) * (blk.w / 2 + 2.3), blk.z + (k & 2 ? 1 : -1) * (blk.d / 2 + 2.3)];
      if (e.navC >= 0) {
        const c = corner(e.navC);
        if (hyp(c[0] - x, c[1] - z) > 0.9) return c;
        e.navSeen |= 1 << e.navC; e.navC = -1;
      }
      let best = -1, bc = 1e9;
      for (let k = 0; k < 4; k++) {
        if (e.navSeen & (1 << k)) continue;
        const c = corner(k);
        const cost = hyp(c[0] - x, c[1] - z) + hyp(tx - c[0], tz - c[1]) + (hitsRect(x, z, c[0], c[1], blk, 0.7) ? 80 : 0);
        if (cost < bc) { bc = cost; best = k; }
      }
      if (best < 0) { e.navSeen = 0; return null; }
      e.navC = best;
      return corner(best);
    }

    function pushOutBox(e, bx, bz, hw, hd) {
      const dx = e.x - bx, dz = e.z - bz;
      if (Math.abs(dx) >= hw || Math.abs(dz) >= hd) return;
      if (hw - Math.abs(dx) < hd - Math.abs(dz)) e.x = bx + (dx >= 0 ? hw : -hw);
      else e.z = bz + (dz >= 0 ? hd : -hd);
    }

    /**
     * Enforces solid walls, buildings, bunker, supply crates, and street obstacles so characters never phase
     * into geometry visually or physically.
     */
    function enforceSolidEnvironment(m, e, wasInside, isZ) {
      const L = m.L, pad = 0.72;
      // 1. Check nearby 3x3 town building cells
      const ci = Math.round(e.x / CELL), cj = Math.round(e.z / CELL);
      for (let i = ci - 1; i <= ci + 1; i++) {
        for (let j = cj - 1; j <= cj + 1; j++) {
          const b = L.grid[i + ',' + j];
          if (b) pushOutBox(e, b.x, b.z, b.w / 2 + pad, b.d / 2 + pad);
        }
      }
      // 2. Check compound perimeter wall thickness & intact segments
      const wallPad = 0.65;
      const nowIn = inBase(e.x, e.z);
      const s = segAt(L, e.x, e.z);
      const canPass = isZ ? (s.hp <= 0) : (s.gate && Math.abs(e.x) < SEG * 0.42);
      if (!canPass) {
        if (wasInside) {
          e.x = clamp(e.x, -BASE + wallPad, BASE - wallPad);
          e.z = clamp(e.z, -BASE + wallPad, BASE - wallPad);
        } else {
          // Keep outside the wall's outer face if within the compound span
          const ax = Math.abs(e.x), az = Math.abs(e.z);
          if (ax < BASE + wallPad && az < BASE + wallPad) {
            if (ax > az) e.x = (e.x >= 0 ? 1 : -1) * (BASE + wallPad);
            else e.z = (e.z >= 0 ? 1 : -1) * (BASE + wallPad);
          }
        }
      } else if (s.gate && !isZ) {
        // Keep humans inside the open gateway jambs while crossing z = BASE
        if (Math.abs(e.z - BASE) < 0.9 && Math.abs(e.x) > SEG * 0.40) {
          e.x = Math.sign(e.x) * SEG * 0.40;
        }
      }
      // 3. Inside compound: solid bunker walls (unless sheltering inside through the door) & supply crates
      if (nowIn || wasInside) {
        const B = L.bunker;
        const wantsBunker = !isZ && e.where === 'base' && e.post && e.post.type === 'bunker' && m.bunkerHp > 0;
        if (!wantsBunker && (m.bunkerHp > 0 || !isZ)) {
          pushOutBox(e, B.x, B.z, B.w / 2 + 0.55, B.d / 2 + 0.55);
        }
        // Supply crate stack at (15.4, 14.1)
        pushOutBox(e, 15.4, 14.1, 2.2, 1.3);
      }
      e.x = clamp(e.x, -MAP, MAP);
      e.z = clamp(e.z, -MAP, MAP);
    }

    /** Moves an entity toward a point, steering around buildings and respecting the compound walls. */
    function move(m, e, tx, tz, speed, isZ) {
      const L = m.L;
      const wasInside = inBase(e.x, e.z);
      let dx = tx - e.x, dz = tz - e.z;
      const d = hyp(dx, dz);
      if (d < 0.08) { e.mv = 0; enforceSolidEnvironment(m, e, wasInside, isZ); return d; }
      let lim = d;
      if (!wasInside || !inBase(tx, tz)) {
        const wp = detour(L, e, tx, tz, d, !wasInside && !inBase(tx, tz));
        if (wp) { dx = wp[0] - e.x; dz = wp[1] - e.z; lim = hyp(dx, dz); }
      }
      const st = Math.min(speed * DT, lim), n = lim || 1;
      const nx = e.x + (dx / n) * st, nz = e.z + (dz / n) * st;
      const i1 = inBase(nx, nz);
      if (wasInside !== i1) {
        const s = i1 ? segAt(L, e.x, e.z) : segAt(L, nx, nz);
        if (isZ ? s.hp > 0 : !s.gate) { e.mv = 0; enforceSolidEnvironment(m, e, wasInside, isZ); return d; }
      }
      e.x = nx; e.z = nz;
      enforceSolidEnvironment(m, e, wasInside, isZ);
      e.yaw = Math.atan2(dx, dz);
      e.mv = 1;
      return d;
    }
    /** Humans can only cross the wall line through the gate: route them via the gate when needed. */
    function humanMove(m, h, tx, tz, speed) {
      const i0 = inBase(h.x, h.z), i1 = inBase(tx, tz);
      if (i0 !== i1) {
        const zIn = BASE - 2.5, zOut = BASE + 2.5;
        if (i0) { if (Math.abs(h.x) > 2.5 || h.z < zIn - 1.5) { tx = 0; tz = zIn; } else { tx = clamp(tx, -3, 3); tz = Math.max(tz, zOut); } }
        else if (Math.abs(h.x) > 2.5 || h.z > zOut + 1.5 || h.z < BASE) { tx = 0; tz = zOut; } else { tx = clamp(tx, -3, 3); tz = Math.min(tz, zIn); }
      }
      return move(m, h, tx, tz, speed, false);
    }

    /** Soft character-to-character separation so figures don't stack on identical coordinates. */
    function resolveCrowding(m) {
      const hs = m.humans;
      for (let i = 0; i < hs.length; i++) {
        const a = hs[i];
        if (!a.alive || a.carriedBy) continue;
        const onT = a.where === 'base' && a.post && a.post.type === 'tower';
        for (let j = i + 1; j < hs.length; j++) {
          const b = hs[j];
          if (!b.alive || b.carriedBy) continue;
          if (onT !== (b.where === 'base' && b.post && b.post.type === 'tower')) continue;
          const dx = b.x - a.x, dz = b.z - a.z, d2 = dx * dx + dz * dz;
          if (d2 < 0.42 && d2 > 1e-6) {
            const d = Math.sqrt(d2), push = (0.65 - d) * 0.35;
            const px = (dx / d) * push, pz = (dz / d) * push;
            const wa = inBase(a.x, a.z), wb = inBase(b.x, b.z);
            a.x -= px; a.z -= pz; b.x += px; b.z += pz;
            enforceSolidEnvironment(m, a, wa, false);
            enforceSolidEnvironment(m, b, wb, false);
          }
        }
      }
    }

    // ------------------------------------------------------------------ setup
    function create(opts) {
      const o = Object.assign({ humans: 15, zombies: 300, childRate: 0.08, elderRate: 0.12, handicapRate: 0.15, aggression: 1, policy: 'everyone', seed: 1 }, opts || {});
      o.humans = clamp(Math.round(o.humans), 5, 50);
      o.zombies = clamp(Math.round(o.zombies), 50, 1000);
      const m = {
        opts: o, seed: (o.seed | 0) || 1, nextId: 1,
        t: 0, day: 1, phase: 'day', clock: 0, over: false, winner: '', reason: '',
        humans: [], zombies: [], corpses: [], events: [], fx: [], hist: [], histT: 0,
        squad: null, expT: 3, expDone: false, todaysFinds: 0, socialT: 9,
        scrap: 30, ammo: 0, medkits: 3, antivirals: 1, food: 40, water: 40, armory: [],
        weather: 'clear', season: 'Spring',
        truck: { repaired: false, progress: 0, x: -16, z: 36, yaw: 0.4, active: false, hp: 100 },
        traps: [], crates: [], raiders: [], trader: null,
        gymBuilt: false, loungeBuilt: false, splinterCamp: null, leaderId: 0, confessional: null, confessionals: [], dramaLog: [], recentDramaKeys: [],
        morale: 55, grief: 0, bunkerHp: BAL.bunkerHp, turrets: 0, wave: null, tick: 0,
        fuel: 28, firewood: 8, coats: 0, power: true, cold: false, freezing: false, radio: { built: false }, distress: null,
        dog: null, dogAlertT: 0, bodies: [], burnT: 0, cliques: [], nextClique: 0, nextBunk: 0, paternity: [], bunkDramaDone: false,
        hAlive: 0, zAlive: 0, zInside: 0, zSiege: 0, squadThreat: 0,
        stats: { rescued: 0, leftBehind: 0, humansLost: 0, zKilled: 0, turned: 0, cured: 0, bitten: 0, nightsHeld: 0, breaches: 0, injuries: 0, conflicts: 0, romances: 0, breakups: 0, sabotages: 0, bonds: 0, births: 0, trials: 0, coups: 0,
          crushes: 0, triangles: 0, rejections: 0, flings: 0, paternity: 0, bunkFights: 0, cliques: 0, cliqueBackups: 0, blocVotes: 0, freezeOuts: 0,
          blackouts: 0, dogWarnings: 0, dogSaves: 0, dogLost: 0, coldSnaps: 0, heatCases: 0, amputations: 0, ampSaved: 0,
          distressCalls: 0, distressIgnored: 0, radioTraps: 0, radioRescues: 0, bodiesBurned: 0, sickened: 0,
          startHumans: o.humans, startZombies: o.zombies, peakHumans: o.humans },
      };
      if (o.bal) Object.assign(BAL, o.bal);
      m.ammo = Math.round(BAL.ammoStart * o.humans);
      m.L = makeLayout(m);
      const forced = Math.ceil(o.humans * 0.35);
      for (let i = 0; i < o.humans; i++) {
        const h = makeHuman(m, i < forced);
        h.x = R(m, -12, 12); h.z = R(m, 2, 16);
        enforceSolidEnvironment(m, h, true, false);
        m.humans.push(h);
      }
      seedInitialRelationships(m);
      m.coats = Math.round(o.humans * 0.4);
      formCliques(m);
      assignBunks(m);
      const initLdr = m.humans.filter((h) => h.age >= 18).sort((a, b) => (b.personality === 'leader' ? 40 : 0) + b.brav - ((a.personality === 'leader' ? 40 : 0) + a.brav))[0];
      if (initLdr) m.leaderId = initLdr.id;
      const n = o.humans;
      const add = (k, c) => { for (let i = 0; i < c; i++) m.armory.push(k); };
      add('rifle', n >= 10 ? 1 : 0); add('shotgun', 1); add('pistol', Math.round(n * 0.15) + 1); add('bat', Math.round(n * 0.2)); add('knife', Math.round(n * 0.3));
      for (let i = 0; i < o.zombies; i++) {
        let x, z, tries = 0;
        do { x = R(m, -MAP + 8, MAP - 8); z = R(m, -MAP + 8, MAP - 8); tries++; }
        while ((Math.max(Math.abs(x), Math.abs(z)) < BASE + 26 || insideBuilding(m.L, x, z)) && tries < 40);
        const zed = makeZombie(m, x, z, null);
        enforceSolidEnvironment(m, zed, false, true);
        m.zombies.push(zed);
      }
      m.dog = makeDog(m);
      count(m);
      distributeWeapons(m);
      assignPosts(m);
      m.todaysFinds = Math.floor(11 * Math.pow(rng(m), 1.6));
      ev(m, `Day 1. ${m.hAlive} survivors hold the compound; ${m.zAlive} zombies roam the town.`, 'phase');
      return m;
    }
    function insideBuilding(L, x, z) {
      const b = L.grid[Math.round(x / CELL) + ',' + Math.round(z / CELL)];
      return !!b && Math.abs(x - b.x) < b.w / 2 + 1 && Math.abs(z - b.z) < b.d / 2 + 1;
    }
    function count(m) {
      let h = 0, z = 0;
      for (const a of m.humans) if (a.alive) h++;
      for (const a of m.zombies) if (a.alive) z++;
      m.hAlive = h; m.zAlive = z;
      if (h > m.stats.peakHumans) m.stats.peakHumans = h;
    }

    // ------------------------------------------------------------------ base management (all automatic)
    function distributeWeapons(m) {
      const people = m.humans.filter((h) => h.alive && h.where === 'base' && combatFactor(h.age) > 0);
      const stock = m.armory.slice();
      for (const h of people) {
        if (h.weapon !== 'fists') {
          // Prideful / Diva / Streetwise survivors sometimes refuse to hand over their prized weapon!
          if ((h.personality === 'diva' || h.personality === 'ghetto' || h.emotions.pride > 82) && WEAPONS[h.weapon].pow >= 3 && m.ammo > 0) continue;
          stock.push(h.weapon);
          h.weapon = 'fists';
        }
      }
      const worth = (w) => WEAPONS[w].pow - (m.ammo <= 0 && !WEAPONS[w].melee ? 10 : 0);
      stock.sort((a, b) => worth(b) - worth(a));
      const free = new Set(people.filter((h) => h.weapon === 'fists'));
      const left = [];
      for (const w of stock) {
        const W = WEAPONS[w];
        let best = null, bs = -1;
        for (const h of free) {
          if (W.twoHand && has(h, 'arm')) continue;
          const s = (W.melee ? h.str : h.aim * (has(h, 'vision') ? 0.5 : 1)) * combatFactor(h.age);
          if (s > bs) { bs = s; best = h; }
        }
        if (best) { best.weapon = w; free.delete(best); } else left.push(w);
      }
      m.armory = left;
    }
    function bestSkill(m, key) {
      let b = 0;
      for (const h of m.humans) if (h.alive && h.where === 'base' && h.age >= 14 && h[key] > b) b = h[key];
      return b;
    }
    function elderBonus(m) {
      let n = 0;
      for (const h of m.humans) if (h.alive && h.where === 'base' && h.age > 60) n++;
      return 1 + Math.min(0.15, n * 0.03);
    }
    function treatInfections(m) {
      const med = bestSkill(m, 'med');
      for (const h of m.humans) {
        if (!h.alive || h.where !== 'base' || !(h.infected > 0)) continue;
        const key = m.day + m.phase;
        if (h.treated === key) continue;
        h.treated = key;
        if (m.antivirals <= 0 && tryAmputation(m, h, med)) continue;
        let p;
        if (m.antivirals > 0) { m.antivirals--; p = 0.6 + 0.0035 * med; } else p = 0.08 + 0.002 * med;
        if (rng(m) < p) {
          h.infected = 0; h.emotions.hope = clamp(h.emotions.hope + 22, 0, 100); h.emotions.fear = clamp(h.emotions.fear - 20, 0, 100);
          m.stats.cured++; ev(m, `${h.name}'s infection was cured in the infirmary.`, 'good');
        } else {
          h.emotions.fear = clamp(h.emotions.fear + 18, 0, 100);
          ev(m, `Treatment failed for ${h.name}; the infection is spreading.`, 'bad');
        }
      }
    }
    function updateMorale(m) {
      let kids = 0, elders = 0, hopeSum = 0, fearSum = 0, n = 0;
      for (const h of m.humans) {
        if (!h.alive) continue;
        n++;
        hopeSum += h.emotions ? h.emotions.hope : 50;
        fearSum += h.emotions ? h.emotions.fear : 30;
        if (h.where === 'base') { if (h.age < 12) kids++; else if (h.age > 60) elders++; }
      }
      const emoMod = n ? ((hopeSum - fearSum * 0.7) / n) * 0.25 : 0;
      m.morale = clamp(50 + Math.min(15, kids * 3) + Math.min(10, elders * 2) + Math.min(20, m.stats.nightsHeld * 4) - m.grief * 6 + emoMod, 0, 100);
    }
    function assignPosts(m) {
      const L = m.L, night = m.phase === 'night' || m.zSiege > 0 || m.zInside > 0;
      const people = m.humans.filter((h) => h.alive && h.where === 'base');
      const fighters = [];
      let bn = 0, inf = 0;
      const bunk = (h) => { const i = bn++; h.post = { type: 'bunker', x: L.bunker.x - 5 + (i % 6) * 2, z: L.bunker.z - 2.5 + Math.floor(i / 6) % 4 * 1.6 }; };
      const infirm = (h) => { const i = inf++; h.post = { type: 'infirmary', x: L.infirmary.x - 3 + (i % 4) * 2, z: L.infirmary.z - 2 + Math.floor(i / 4) % 3 * 1.8 }; };
      for (const h of people) {
        h.retreat = false;
        if (h.brigT > 0) { h.post = { type: 'brig', x: L.brig.x + R(m, -1.2, 1.2), z: L.brig.z + R(m, -1.2, 1.2) }; continue; }
        const cf = combatFactor(h.age);
        if (h.infected > 0 && h.bitten && !h.concealed) infirm(h);
        else if (cf === 0) { if (night) bunk(h); else h.post = { type: 'yard', x: R(m, -8, 8), z: R(m, 0, 6) }; }
        else if (h.hp < h.maxHp * (night ? 0.3 : 0.7)) infirm(h);
        else if (night && (h.age > 72 || (has(h, 'frail') && h.age > 60))) bunk(h);
        else fighters.push(h);
      }
      const medics = fighters.filter((h) => h.med >= 50).sort((a, b) => b.med - a.med).slice(0, fighters.length >= 8 ? 2 : fighters.length >= 4 ? 1 : 0);
      for (const h of medics) infirm(h);
      let rest = fighters.filter((h) => medics.indexOf(h) < 0);
      const builders = rest.filter((h) => h.rep >= 50).sort((a, b) => b.rep - a.rep).slice(0, rest.length >= 6 ? 2 : 1);
      if (m.scrap > 0 || !night) for (const h of builders) h.post = { type: 'repair', x: 0, z: BASE - 4 };
      rest = rest.filter((h) => !(builders.indexOf(h) >= 0 && h.post.type === 'repair'));
      if (!night && m.bodies.length) {   // cleanup crew drags the dead out to the burn pit
        const crew = rest.filter((h) => h.age >= 16 && !has(h, 'leg') && !(h.sickT > 0)).sort((a, b) => WEAPONS[a.weapon].pow - WEAPONS[b.weapon].pow).slice(0, Math.min(4, Math.ceil(m.bodies.length / 3)));
        for (const h of crew) h.post = { type: 'haul', x: h.x, z: h.z };
        rest = rest.filter((h) => crew.indexOf(h) < 0);
      }
      const shooters = rest.filter((h) => !WEAPONS[h.weapon].melee).sort((a, b) => b.aim - a.aim);
      const melee = rest.filter((h) => WEAPONS[h.weapon].melee);
      shooters.forEach((h, i) => {
        if (i < 8 && (night || i < 2)) { const tw = L.towers[i % 4]; h.post = { type: 'tower', tower: i % 4, x: tw.x + (i < 4 ? -0.7 : 0.7), z: tw.z }; }
        else if (night) { const a = (i / Math.max(1, shooters.length)) * 6.283; h.post = { type: 'line', x: Math.sin(a) * 11, z: 5 + Math.cos(a) * 9 }; }
        else h.post = { type: 'yard', x: R(m, -14, 14), z: R(m, 0, 17) };
      });
      melee.forEach((h, i) => {
        if (night) h.post = { type: 'wall', x: (i % 5 - 2) * 3, z: BASE - 4 - Math.floor(i / 5) * 2, segId: -1 };
        else h.post = { type: 'yard', x: R(m, -14, 14), z: R(m, 0, 17) };
      });
      for (const h of people) h.duty = h.post;
    }
    function upkeep(m) {
      while (m.turrets < 4 && m.scrap >= BAL.turretCost + 20) {
        m.scrap -= BAL.turretCost;
        m.L.towers[m.turrets].turret = true;
        m.turrets++;
        ev(m, `Builders mounted an auto-turret on watchtower ${m.turrets}.`, 'good');
      }
      treatInfections(m);
      distributeWeapons(m);
      updateMorale(m);
      assignPosts(m);
    }

    // ------------------------------------------------------------------ phases
    function startNight(m) {
      m.phase = 'night'; m.clock = 0;
      m.stats.dayOf = m.day;
      const alive = m.zombies.filter((z) => z.alive && !z.wave);
      const n = Math.min(alive.length, Math.round((BAL.waveBase + BAL.waveGrow * m.day) * m.opts.aggression));
      alive.sort((a, b) => (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z));
      for (let i = 0; i < n; i++) { alive[i].wave = true; alive[i].mode = 'siege'; alive[i].seg = null; alive[i].segT = 0; }
      m.wave = { size: n, done: false };
      upkeep(m);
      ev(m, `Night ${m.day} falls. A horde of ${n} frenzied zombies converges on the compound.`, 'phase');
      if (m.squad) ev(m, 'The expedition is still outside the walls after dark!', 'bad');
      m.bunkDramaDone = false;
      assignBunks(m);
      if (m.distress) { ev(m, `Nobody reached the ${m.distress.name} in time — the distress signal went silent at dusk.`, 'bad'); m.distress = null; }
      if (m.fuel <= 0) {
        m.power = false; m.stats.blackouts++;
        panicInTheDark(m, 8);
        ev(m, 'The generator tank is empty: tonight the compound fights in the dark — no floodlights, no auto-turrets.', 'bad');
      }
    }
    function startDay(m) {
      let fled = 0;
      for (const z of m.zombies) {
        if (!z.alive) continue;
        if (z.wave) {
          z.wave = false;
          if (!inBase(z.x, z.z)) {
            z.mode = 'idle'; z.tgt = 0; fled++;
            const mx = Math.max(Math.abs(z.x), Math.abs(z.z), 1), k = mx < BASE + 28 ? (BASE + 30) / mx : 1;
            z.hx = clamp(z.x * k, -MAP, MAP); z.hz = clamp(z.z * k, -MAP, MAP);
          }
        }
      }
      const held = m.hAlive > 0;
      if (held) m.stats.nightsHeld++;
      ev(m, m.wave && m.wave.done ? `Dawn. The night horde was wiped out.` : `Dawn. Sunlight drives ${fled} surviving zombies back into the town.`, 'phase');
      m.day++; m.phase = 'day'; m.clock = 0; m.wave = null;
      m.grief *= 0.6;
      for (const h of m.humans) {
        if (!h.alive) continue;
        const was = h.age;
        h.age += 0.25;
        if (was < 5 && h.age >= 5) ev(m, `${h.name} turned 5 and can keep up on foot now.`, 'good');
        if (was <= 60 && h.age > 60) ev(m, `${h.name} turned 61 and moves to lighter duties.`, 'info');
        const mh = maxHpOf(h);
        h.hp = Math.min(mh, h.hp * (mh / h.maxHp));
        h.maxHp = mh;
        if (h.emotions) {
          h.emotions.hope = clamp(h.emotions.hope + 4, 0, 100);
          h.emotions.fear = clamp(h.emotions.fear - 6, 0, 100);
        }
      }
      m.expT = 3; m.expDone = false;
      m.todaysFinds = Math.floor(11 * Math.pow(rng(m), 1.6));
      upkeep(m);
      ev(m, `Day ${m.day} begins. ${m.hAlive} survivors, ${m.zAlive} zombies remain.`, 'phase');
      formCliques(m);
      assignBunks(m);   // birthdays at dawn can change who may share a bunk
      radioIntercept(m);
      if (m.season !== 'Winter' && m.weather !== 'snow') m.firewood = Math.min(60, m.firewood + 1);   // a little chopping every mild morning
    }

    // ------------------------------------------------------------------ expedition (with interpersonal disruptions)
    function accepts(m, h) {
      const p = m.opts.policy;
      if (p === 'everyone') return true;
      const fit = h.age >= 12 && h.age <= 60 && !has(h, 'leg') && !has(h, 'frail');
      if (p === 'able') return fit;
      return fit || h.age < 16;
    }
    function planExpedition(m) {
      const all = m.humans.filter((h) => h.alive && h.where === 'base');
      const fit = all.filter((h) => h.age >= 15 && h.age <= 60 && !has(h, 'leg') && h.hp >= h.maxHp * 0.6 && !(h.infected > 0 && h.bitten));
      if (fit.length < 3) { m.expDone = true; ev(m, 'Too few able-bodied survivors to risk an expedition today; everyone stays behind the walls.', 'info'); return; }

      // Morning drama check: once per day at muster, a Diva, Catty, Ghetto, or Resentful survivor may stall roll-call!
      if (!m.expStalledToday && m.clock < 12) {
        const diva = fit.find((h) => h.personality === 'diva' || h.personality === 'catty' || h.emotions.resentment > 78 || h.emotions.pride > 82);
        if (diva && rng(m) < 0.35) {
          m.expStalledToday = true;
          m.expT = m.clock + 5.5;
          diva.dramaCount++; m.stats.conflicts = (m.stats.conflicts || 0) + 1;
          setBubble(diva, '🙄', 5.5);
          const excuses = [
            `Morning expedition delayed! ${diva.name} (${diva.personalityName}) threw a fit at the gate, refusing to leave until somebody traded them better gear.`,
            `Roll-call drama: ${diva.name} started a loud argument over who gets to lead today's search, holding up the gate for several minutes.`,
            `${diva.name} complained that the same people always get stuck doing the dangerous runs and stalled the morning muster.`,
          ];
          ev(m, pick(m, excuses), 'bad');
          return;
        }
      }
      m.expStalledToday = false;
      m.expDone = true;

      const keep = new Set();
      const by = (k) => fit.slice().sort((a, b) => b[k] - a[k])[0];
      if (fit.length >= 5) { keep.add(by('med')); keep.add(by('rep')); }
      const pool = fit.filter((h) => !keep.has(h)).sort((a, b) => (b.spd + b.str + b.aim) - (a.spd + a.str + a.aim));
      const size = clamp(Math.round(fit.length * 0.5), 2, 8);
      let team = pool.slice(0, Math.min(size, Math.max(2, pool.length - 1)));

      // Interpersonal refusal: if two bitter rivals or recent exes are on the squad, one may storm off at the gate!
      if (team.length >= 3) {
        for (let i = 0; i < team.length; i++) {
          for (let j = i + 1; j < team.length; j++) {
            const a = team[i], b = team[j];
            if (getRel(a, b) < -48 || a.exIds.indexOf(b.id) >= 0) {
              if (rng(m) < 0.55) {
                const quitter = a.emotions.pride >= b.emotions.pride ? a : b;
                const other = quitter === a ? b : a;
                team = team.filter((x) => x.id !== quitter.id);
                setBubble(quitter, '💢', 5); setBubble(other, '😒', 5);
                m.stats.conflicts = (m.stats.conflicts || 0) + 1;
                ev(m, `${quitter.name} flat-out refused to go on the expedition with their ${quitter.exIds.indexOf(other.id) >= 0 ? 'ex' : 'rival'} ${other.name} ("I'm not watching ${other.name.split(' ')[0]}'s back!") and stayed in the yard.`, 'bad');
                break;
              }
            }
          }
          if (team.length < size) break;
        }
      }

      if (team.length < 2) return;
      const left = PHASE - m.clock, pace = Math.min.apply(null, team.map(speedOf));
      const cand = m.L.buildings.filter((b) => b.stock > 0);
      const route = [];
      let px = 0, pz = BASE + 6, used = 4;
      if (m.distress) {   // a radio distress call jumps the queue
        const b = m.L.buildings[m.distress.bid];
        const go = hyp(b.doorX - px, b.doorZ - pz) / pace + 3.5, back = hyp(b.doorX, b.doorZ - BASE - 6) / (pace * 0.8);
        if (used + go + back <= left * 0.8) { used += go; route.push(b); px = b.doorX; pz = b.doorZ; const i = cand.indexOf(b); if (i >= 0) cand.splice(i, 1); }
      }
      while (cand.length && route.length < 4) {
        cand.sort((a, b) => hyp(a.doorX - px, a.doorZ - pz) + a.visits * 25 - (hyp(b.doorX - px, b.doorZ - pz) + b.visits * 25));
        const b = cand.shift();
        const go = hyp(b.doorX - px, b.doorZ - pz) / pace + 3.5, back = hyp(b.doorX, b.doorZ - BASE - 6) / (pace * 0.8);
        if (used + go + back > left * 0.74) { if (route.length) break; else continue; }
        used += go; route.push(b); px = b.doorX; pz = b.doorZ;
      }
      if (!route.length) { ev(m, 'Not enough daylight left for an expedition.', 'info'); return; }
      const finds = {};
      for (let i = 0; i < m.todaysFinds; i++) { const b = pick(m, route); finds[b.id] = (finds[b.id] || 0) + 1; }
      for (const h of team) { h.where = 'squad'; h.escort = false; h.retreat = false; }
      m.squad = { state: 'muster', route, ri: 0, ax: 0, az: BASE - 8, yaw: 0, searchT: 0, timer: 0, dramaDone: false, finds, start: team.length, loot: { scrap: 0, ammo: 0, medkits: 0, antivirals: 0, fuel: 0, wood: 0, coats: 0, weapons: [] }, found: 0, pace, why: '' };
      assignPosts(m);
      ev(m, `Expedition of ${team.length} leaves through the gate: ${team.slice(0, 4).map((h) => h.name.split(' ')[0]).join(', ')}${team.length > 4 ? '…' : ''}. Plan: ${route.map((b) => b.name).join(' → ')}.`, 'info');
    }

    function searchBuilding(m, sq, b) {
      b.visits++;
      const T = b.bt, lo = sq.loot;
      const team = m.humans.filter((h) => h.alive && h.where === 'squad');
      if (b.stock > 0) {
        b.stock--;
        let sc = Math.round(R(m, 6, 16) * T.scrap), am = Math.round(R(m, 4, 22) * T.ammo * BAL.ammoLoot);
        const mk = rng(m) < 0.4 * T.med ? 1 + (rng(m) < 0.3 * T.med ? 1 : 0) : 0, av = rng(m) < 0.16 * T.med ? 1 : 0;

        // Greed / Opportunist skimming during building search!
        const greedy = team.find((h) => !h.escort && (h.personality === 'opportunist' || h.personality === 'saboteur' || h.emotions.greed > 76));
        if (greedy && am > 5 && rng(m) < 0.35) {
          const skim = Math.max(1, Math.round(am * 0.2));
          am -= skim; greedy.hoarded += skim;
          setBubble(greedy, '🤑', 4.5);
          m.stats.sabotages = (m.stats.sabotages || 0) + 1;
          ev(m, `While searching the ${b.name}, ${greedy.name} quietly pocketed ${skim} rounds before the rest of the squad saw.`, 'bad');
        }

        lo.scrap += sc; lo.ammo += am; lo.medkits += mk; lo.antivirals += av;
        let txt = `Searched the ${b.name}: ${sc} scrap, ${am} ammo` + (mk ? `, ${mk} medkit${mk > 1 ? 's' : ''}` : '') + (av ? ', 1 antiviral' : '');
        const fr = { garage: [4, 9], warehouse: [2, 6], hardware: [2, 5], police: [1, 4], house: [0, 3], shop: [0, 3] }[T.id] || [0, 0];
        const fu = Math.round(R(m, fr[0], fr[1]));
        const wd = T.id === 'house' || T.id === 'hardware' || T.id === 'warehouse' ? Math.round(R(m, 1, 4)) : 0;
        const ct = (T.id === 'house' || T.id === 'shop') && rng(m) < 0.6 ? 1 + (rng(m) < 0.4 ? 1 : 0) : 0;
        lo.fuel += fu; lo.wood += wd; lo.coats += ct;
        if (fu) txt += `, ${fu} fuel`;
        if (wd) txt += `, ${wd} firewood`;
        if (ct) txt += `, ${ct} winter coat${ct > 1 ? 's' : ''}`;
        if (rng(m) < T.wpn) {
          const w = pick(m, T.id === 'police' ? ['pistol', 'pistol', 'shotgun', 'rifle'] : ['knife', 'bat', 'bat', 'pistol', 'shotgun']);
          const eligible = team.filter((h) => combatFactor(h.age) > 0 && !(WEAPONS[w].twoHand && has(h, 'arm')));
          eligible.sort((a, b2) => WEAPONS[a.weapon].pow - WEAPONS[b2.weapon].pow);
          if (eligible.length && WEAPONS[eligible[0].weapon].pow < WEAPONS[w].pow) {
            if (eligible[0].weapon !== 'fists') lo.weapons.push(eligible[0].weapon);
            eligible[0].weapon = w;
          } else lo.weapons.push(w);
          txt += `, and a ${WEAPONS[w].name.toLowerCase()}`;
        }
        ev(m, txt + '.', 'info');
      } else ev(m, `The ${b.name} has already been picked clean.`, 'info');

      if (m.distress && m.distress.bid === b.id) resolveDistress(m, sq, b, team);
      const n = sq.finds[b.id] || 0;
      let took = 0, leftB = 0;
      for (let i = 0; i < n; i++) {
        const h = makeHuman(m, false);
        h.hp = Math.round(h.maxHp * R(m, 0.55, 1));
        if (!accepts(m, h)) { leftB++; m.stats.leftBehind++; m.nextId--; continue; }
        h.where = 'squad'; h.escort = true; h.x = b.doorX + R(m, -1.5, 1.5); h.z = b.doorZ + R(m, -1.5, 1.5);
        enforceSolidEnvironment(m, h, false, false);
        m.humans.push(h); took++; m.stats.rescued++; sq.found++;
      }
      if (took) {
        // Sometimes a paranoid or catty squad member complains about taking in more mouths to feed!
        const grumbler = team.find((h) => !h.escort && (h.personality === 'paranoid' || h.personality === 'catty' || h.personality === 'diva'));
        const empath = team.find((h) => !h.escort && (h.personality === 'peacemaker' || h.personality === 'leader' || h.emotions.empathy > 68));
        if (grumbler && empath && grumbler.id !== empath.id && rng(m) < 0.45) {
          addRel(m, grumbler, empath, -12);
          setBubble(grumbler, '😒', 5); setBubble(empath, '❤️', 5);
          ev(m, `Found ${took} survivor${took > 1 ? 's' : ''} in the ${b.name} — ${grumbler.name} complained about "more mouths eating our rations," but ${empath.name} insisted on bringing them home.`, 'good');
        } else {
          ev(m, `Found ${took} survivor${took > 1 ? 's' : ''} hiding in the ${b.name}.`, 'good');
        }
      }
      if (leftB) ev(m, `${leftB} survivor${leftB > 1 ? 's were' : ' was'} turned away at the ${b.name} (rescue policy).`, 'bad');
      count(m);
    }

    function updateSquad(m) {
      const sq = m.squad;
      if (!sq) return;
      const L = m.L;
      const mem = m.humans.filter((h) => h.alive && h.where === 'squad');
      if (!mem.length) { m.squad = null; ev(m, 'The expedition was lost. No one came back.', 'bad'); return; }
      const adults = mem.filter((h) => h.age >= 15 && !has(h, 'leg') && h.hp > 0);
      for (const h of mem) { if (h.carrying && !(m.byId[h.carrying] && m.byId[h.carrying].alive)) h.carrying = 0; h.assisting = 0; }
      for (const c of mem) {
        if (c.age >= 5) continue;
        const car = m.byId[c.carriedBy];
        if (car && car.alive && car.where === 'squad') continue;
        c.carriedBy = 0;
        const freeA = adults.filter((a) => !a.carrying).sort((a, b) => b.str - a.str)[0];
        if (freeA) { freeA.carrying = c.id; c.carriedBy = freeA.id; }
      }
      let pace = 99;
      const walkers = mem.filter((h) => !h.carriedBy);
      const helpers = adults.filter((a) => !a.carrying && a.str >= 40).sort((a, b) => b.str - a.str);
      const slow = walkers.slice().sort((a, b) => speedOf(a) - speedOf(b));
      const eff = new Map();
      for (const h of walkers) eff.set(h, speedOf(h) * (h.carrying ? 0.85 : 1));
      for (const s of slow) {
        if (speedOf(s) > 3.2 || !helpers.length) break;
        const hp = helpers.find((x) => x !== s && getRel(x, s) > -35); // rivals won't lend a shoulder!
        if (!hp) break;
        helpers.splice(helpers.indexOf(hp), 1);
        hp.assisting = s.id;
        eff.set(s, Math.max(eff.get(s), speedOf(hp) * 0.7));
        eff.set(hp, Math.min(eff.get(hp), speedOf(hp) * 0.8));
      }
      for (const v of eff.values()) if (v < pace) pace = v;
      sq.pace = pace;
      const homeward = sq.state === 'return' || sq.state === 'enter';
      const moveA = (tx, tz) => {
        const a = sq.nav || (sq.nav = {});
        a.x = sq.ax; a.z = sq.az; a.yaw = sq.yaw; a.mv = 0;
        const d = humanMove(m, a, tx, tz, pace * (m.squadThreat > 0 ? (homeward ? 0.75 : 0.3) : 1));
        sq.ax = a.x; sq.az = a.z; sq.yaw = a.yaw;
        return d;
      };
      sq.timer += DT;
      const fighters = mem.filter((h) => !h.escort);

      // Mid-expedition field drama: an Ignorant, Catty, or Paranoid member can disrupt the search!
      if (!sq.dramaDone && sq.state === 'out' && sq.timer > 11 && fighters.length >= 3) {
        const trouble = fighters.find((h) => h.personality === 'ignorant' || h.personality === 'catty' || h.personality === 'ghetto' || h.personality === 'paranoid');
        if (trouble && rng(m) < 0.28) {
          sq.dramaDone = true;
          const other = fighters.find((h) => h.id !== trouble.id) || fighters[0];
          setBubble(trouble, '🗣️', 5); setBubble(other, '💢', 5);
          addRel(m, trouble, other, -15);
          m.stats.conflicts = (m.stats.conflicts || 0) + 1;
          if (trouble.personality === 'ignorant') {
            for (const z of m.zombies) if (z.alive && z.mode === 'idle' && hyp(z.x - sq.ax, z.z - sq.az) < 35 && rng(m) < 0.45) { z.mode = 'hunt'; z.tgt = trouble.id; }
            ev(m, `On the street, ${trouble.name} kicked a car alarm and yelled at ${other.name}, alerting zombies on the block!`, 'bad');
          } else if (trouble.personality === 'paranoid' && sq.ri > 0) {
            sq.why = `${trouble.name} panicked and demanded the team turn back`;
            sq.state = 'return';
            ev(m, `${trouble.name} had a paranoid meltdown mid-run ("It's a trap, we're surrounded!") and forced the expedition to cut the route short.`, 'bad');
          } else {
            ev(m, `${trouble.name} and ${other.name} got into a heated argument in the middle of the street over which building to hit next.`, 'bad');
          }
        } else sq.dramaDone = true;
      }

      if (sq.state === 'out' || sq.state === 'search') {
        const eta = hyp(sq.ax - L.gateOut.x, sq.az - L.gateOut.z) / (pace * 0.85) + 5;
        const hpAvg = fighters.reduce((s, h) => s + h.hp / h.maxHp, 0) / Math.max(1, fighters.length);
        if (m.phase === 'day' && PHASE - m.clock < eta) sq.why = 'Sunset is close';
        else if (fighters.length <= sq.start * 0.5) sq.why = 'Too many losses';
        else if (hpAvg < 0.45) sq.why = 'The team is badly hurt';
        else if (m.phase === 'night') sq.why = 'Night has fallen';
        if (sq.why && sq.state !== 'return') { sq.state = 'return'; ev(m, `${sq.why}: the expedition turns for home with ${mem.length} people.`, 'info'); }
      }
      if (sq.state === 'muster') { if (moveA(L.gateIn.x, L.gateIn.z) < 1 || sq.timer > 7) { sq.state = 'exit'; sq.timer = 0; } }
      else if (sq.state === 'exit') { if (moveA(L.gateOut.x, L.gateOut.z) < 1) { sq.state = 'out'; } }
      else if (sq.state === 'out') {
        const b = sq.route[sq.ri];
        if (moveA(b.doorX, b.doorZ) < 1.2) { sq.state = 'search'; sq.searchT = 3.5; }
      } else if (sq.state === 'search') {
        sq.searchT -= DT;
        if (sq.searchT <= 0) {
          searchBuilding(m, sq, sq.route[sq.ri]);
          sq.ri++;
          if (sq.ri >= sq.route.length) { sq.state = 'return'; ev(m, 'Search complete; the expedition heads home.', 'info'); } else sq.state = 'out';
        }
      } else if (sq.state === 'return') { if (moveA(L.gateOut.x, L.gateOut.z) < 1.2) sq.state = 'enter'; }
      else if (sq.state === 'enter') {
        moveA(L.gateIn.x, L.gateIn.z - 2);
        let outside = 0, arrived = 0;
        for (const h of mem) {
          const self = h.carriedBy ? m.byId[h.carriedBy] : h;
          if (inBase(self.x, self.z) && self.z < BASE - 1.5) { h.where = 'base'; h.escort = false; arrived++; if (h.carriedBy) { m.byId[h.carriedBy].carrying = 0; h.carriedBy = 0; } }
          else outside++;
        }
        if (arrived && !sq.banked) {
          sq.banked = true;
          const lo = sq.loot;
          m.scrap += lo.scrap; m.ammo += lo.ammo; m.medkits += lo.medkits; m.antivirals += lo.antivirals;
          m.fuel += lo.fuel; m.firewood += lo.wood; m.coats += lo.coats;
          for (const w of lo.weapons) m.armory.push(w);
          // Surviving an expedition together builds camaraderie among squadmates!
          for (let i = 0; i < fighters.length; i++) {
            for (let j = i + 1; j < fighters.length; j++) addRel(m, fighters[i], fighters[j], 6);
          }
          ev(m, `The expedition is home: +${lo.scrap} scrap, +${lo.ammo} ammo, +${lo.medkits} medkits, +${lo.antivirals} antivirals, +${lo.fuel} fuel, +${lo.wood} firewood` + (sq.found ? `, and ${sq.found} rescued survivor${sq.found > 1 ? 's' : ''}` : '') + '.', 'good');
        }
        if (arrived) { for (const h of mem) if (h.where === 'base') h.carrying = 0; upkeep(m); }
        if (!outside) m.squad = null;
      }
      const sy = Math.sin(sq.yaw), cy = Math.cos(sq.yaw);
      let i = 0;
      for (const h of mem) {
        if (h.where !== 'squad') continue;
        if (h.carriedBy) { const c = m.byId[h.carriedBy]; h.x = c.x; h.z = c.z; h.yaw = c.yaw; h.mv = c.mv; continue; }
        const row = Math.floor(i / 3) + (h.escort ? 1 : 0), col = (i % 3) - 1; i++;
        let tx = sq.ax + cy * col * 1.5 - sy * row * 1.5, tz = sq.az - sy * col * 1.5 - cy * row * 1.5;
        const v = speedOf(h) * (h.carrying ? 0.85 : 1);
        const W = WEAPONS[h.weapon];
        let engaged = false;
        if (!h.escort && combatFactor(h.age) > 0 && (W.melee || m.ammo <= 0) && !h.carrying) {
          const zn = nearestZ(m, h.x, h.z, 6.5, null);
          if (zn && hyp(zn.x - sq.ax, zn.z - sq.az) < 10) { engaged = true; if (hyp(zn.x - h.x, zn.z - h.z) > W.reach * 0.8) humanMove(m, h, zn.x, zn.z, v); else { h.mv = 0; h.yaw = Math.atan2(zn.x - h.x, zn.z - h.z); } }
        }
        if (!engaged) {
          const d = hyp(tx - h.x, tz - h.z);
          if (d > 0.5) humanMove(m, h, tx, tz, Math.min(v * 1.15, Math.max(pace, d * 2))); else { h.mv = 0; if (sq.state === 'search') h.yaw = sq.yaw + i; }
        }
        humanAttack(m, h);
      }
    }

    function sheltered(m, h) {
      const b = m.L.bunker;
      return m.bunkerHp > 0 && Math.abs(h.x - b.x) < b.w / 2 + 0.5 && Math.abs(h.z - b.z) < b.d / 2 + 0.5;
    }

    // ------------------------------------------------------------------ combat
    function nearestZ(m, x, z, range, filter) {
      let best = null, bd = range;
      for (const zz of m.zombies) {
        if (!zz.alive) continue;
        const dx = zz.x - x; if (dx > bd || dx < -bd) continue;
        const dz = zz.z - z; if (dz > bd || dz < -bd) continue;
        const d = hyp(dx, dz);
        if (d < bd && (!filter || filter(zz, d))) { bd = d; best = zz; }
      }
      return best;
    }
    function hurtZombie(m, z, dmg, h) {
      if (!z.alive) return;
      z.hp -= dmg; z.lastHit = m.t;
      if (z.hp > 0) return;
      z.alive = false; z.diedT = m.t; z.wave = false;
      m.stats.zKilled++; m.zAlive--;
      if (h) {
        h.kills++;
        if (h.emotions) {
          h.emotions.pride = clamp(h.emotions.pride + 2, 0, 100);
          h.emotions.fear = clamp(h.emotions.fear - 3, 0, 100);
        }
      }
      fx(m, { type: 'zdeath', x: z.x, z: z.z });
      noteBody(m, z);
    }
    function killHuman(m, h, how) {
      if (!h.alive) return;
      h.alive = false; h.hp = 0; h.diedT = m.t; h.diedDay = m.day; h.cause = how;
      m.stats.humansLost++; m.grief += 1; m.hAlive--;
      if (h.carrying) { const c = m.byId[h.carrying]; if (c) c.carriedBy = 0; h.carrying = 0; }
      if (h.where === 'base' && h.weapon !== 'fists') m.armory.push(h.weapon);
      if (h.hoarded > 0) m.ammo += h.hoarded;
      // Emotional ripple across survivors when someone dies!
      for (const o of m.humans) {
        if (!o.alive || !o.emotions) continue;
        const rel = getRel(o, h);
        if (o.partnerId === h.id) {
          o.partnerId = 0; o.trauma++; o.sanity = clamp((o.sanity || 80) - 28, 5, 100);
          o.emotions.anger = clamp(o.emotions.anger + 35, 0, 100);
          o.emotions.fear = clamp(o.emotions.fear + 20, 0, 100);
          o.emotions.hope = clamp(o.emotions.hope - 30, 0, 100);
          setBubble(o, '😭', 6);
          ev(m, `${o.name} is devastated and enraged after losing their partner ${h.name}!`, 'death');
        } else if (rel > 45) {
          o.trauma++; o.sanity = clamp((o.sanity || 80) - 14, 5, 100);
          o.emotions.anger = clamp(o.emotions.anger + 20, 0, 100);
          o.emotions.hope = clamp(o.emotions.hope - 15, 0, 100);
          setBubble(o, '😢', 5);
        } else if (rel < -45) {
          o.emotions.fear = clamp(o.emotions.fear + 10, 0, 100);
        }
      }
      m.corpses.push({ id: h.id, x: h.x, z: h.z, t: 5 });
      ev(m, `${h.name} (${Math.floor(h.age)}) ${how}.`, 'death');
      fx(m, { type: 'hdeath', x: h.x, z: h.z });
      updateMorale(m);
    }
    function hurtHuman(m, h, dmg, z) {
      if (!h.alive) return;
      h.hp -= dmg; h.lastHit = m.t;
      if (h.emotions) {
        h.emotions.fear = clamp(h.emotions.fear + 10, 0, 100);
        h.emotions.anger = clamp(h.emotions.anger + 8, 0, 100);
      }
      fx(m, { type: 'bite', x: h.x, z: h.z });
      if (h.hp <= 0) { if (z) z.kills++; killHuman(m, h, `was killed by a ${ZTYPES[z.type].name.toLowerCase()}`); return; }
      if (!(h.infected > 0) && rng(m) < BAL.biteP) {
        h.infected = R(m, 70, 140); h.bitten = true; m.stats.bitten++;
        h.biteSite = pick(m, ['arm', 'arm', 'leg', 'leg', 'torso']); h.ampTried = false;
        if (h.emotions) h.emotions.fear = clamp(h.emotions.fear + 25, 0, 100);
        if ((h.emotions && (h.emotions.fear > 65 || h.emotions.paranoia > 65 || h.emotions.pride > 72)) || h.personality === 'saboteur' || h.personality === 'opportunist') {
          h.concealed = rng(m) < 0.55;
        }
        if (h.concealed) ev(m, `${h.name} was scratched in the chaos—and quietly hid the bite mark from the medics!`, 'bad');
        else ev(m, `${h.name} was bitten and may be infected.`, 'bad');
      }
      if ((dmg > h.maxHp * 0.22 || h.hp < h.maxHp * 0.25) && rng(m) < BAL.injuryP) {
        const opts = ['leg', 'arm', 'vision', 'frail'].filter((k) => !has(h, k));
        if (opts.length) {
          const k = pick(m, opts);
          h.handicaps.push(k); h.injuries++; m.stats.injuries++;
          const mh = maxHpOf(h); h.hp = Math.min(h.hp, mh); h.maxHp = mh;
          if (WEAPONS[h.weapon].twoHand && k === 'arm') { if (h.where === 'base') m.armory.push(h.weapon); h.weapon = 'fists'; }
          ev(m, `${h.name} survived a mauling but is left with a permanent injury: ${HANDICAPS[k].name.toLowerCase()}.`, 'bad');
        }
      }
    }
    function humanAttack(m, h) {
      if (h.atkT > 0) { h.atkT -= DT; return; }
      const cf = combatFactor(h.age);
      if (cf === 0 || h.carriedBy) return;
      let W = WEAPONS[h.weapon];
      const inside = inBase(h.x, h.z);
      const mor = 0.9 + 0.2 * m.morale / 100;
      const em = h.emotions || {};
      // Solidarity boost when fighting near a partner or best friend!
      let bondBoost = 1.0;
      if (h.partnerId && m.byId[h.partnerId] && m.byId[h.partnerId].alive && hyp(m.byId[h.partnerId].x - h.x, m.byId[h.partnerId].z - h.z) < 8) bondBoost = 1.18;
      else if (h.bestFriendId && m.byId[h.bestFriendId] && m.byId[h.bestFriendId].alive && hyp(m.byId[h.bestFriendId].x - h.x, m.byId[h.bestFriendId].z - h.z) < 8) bondBoost = 1.12;

      if (!W.melee && (m.ammo > 0 || h.hoarded > 0)) {
        const tower = h.where === 'base' && h.post.type === 'tower';
        const range = W.range * (tower ? 1.3 : 1);
        const tgt = nearestZ(m, h.x, h.z, range, (z, d) => {
          if (inside) return z.mode !== 'idle' || inBase(z.x, z.z) || Math.max(Math.abs(z.x), Math.abs(z.z)) < BASE + 12;
          return z.mode === 'hunt' || d < 11;
        });
        if (!tgt) { h.atkT = 0.2; return; }
        const d = hyp(tgt.x - h.x, tgt.z - h.z);
        const lit = m.power && Math.max(Math.abs(tgt.x), Math.abs(tgt.z)) < BASE + 16;   // floodlights need the generator
        const fearPen = em.fear > 65 ? 0.82 : 1.0;
        let p = clamp(0.25 + h.aim * 0.006, 0.25, 0.85) * (has(h, 'vision') ? 0.6 : 1) * (m.phase === 'night' && !lit ? 0.7 : 1) * (tower ? 1.15 : 1) * (1 - 0.4 * d / range) * mor * (0.6 + 0.4 * cf) * (h.carrying ? 0.6 : 1) * fearPen * bondBoost * (m.dogAlertT > 0 ? 1.1 : 1);
        if (W.twoHand && has(h, 'arm')) p *= 0.5;
        if (m.ammo > 0) m.ammo--; else h.hoarded--;
        h.atkT = W.cd; h.lastAtk = m.t; h.yaw = Math.atan2(tgt.x - h.x, tgt.z - h.z);
        const hit = rng(m) < p;
        fx(m, { type: 'shot', x: h.x, z: h.z, tx: tgt.x, tz: tgt.z, hit, y: tower ? 5.2 : 1.3 });
        if (hit) hurtZombie(m, tgt, W.dmg * R(m, 0.8, 1.2), h);
        if (!inside) {
          for (const z of m.zombies) if (z.alive && z.mode === 'idle' && Math.abs(z.x - h.x) < 34 && Math.abs(z.z - h.z) < 34 && rng(m) < 0.25) { z.mode = 'hunt'; z.tgt = h.id; }
        }
        return;
      }
      if (!W.melee) W = WEAPONS.fists;
      const tgt = nearestZ(m, h.x, h.z, 3.3, (z, d) => (inBase(z.x, z.z) === inside ? d <= W.reach : inside && d <= 3.2));
      if (!tgt) { h.atkT = 0.15; return; }
      h.atkT = W.cd; h.lastAtk = m.t; h.yaw = Math.atan2(tgt.x - h.x, tgt.z - h.z);
      const angerBoost = em.anger > 60 ? 1 + (em.anger - 60) * 0.006 : 1;
      let dmg = (W.dmg + h.str * W.str) * cf * mor * R(m, 0.8, 1.2) * (has(h, 'arm') ? 0.6 : 1) * (h.carrying ? 0.6 : 1) * angerBoost * bondBoost;
      fx(m, { type: 'melee', x: tgt.x, z: tgt.z });
      hurtZombie(m, tgt, dmg, h);
    }

    // ------------------------------------------------------------------ humans inside the compound
    function updateBaseHumans(m) {
      const L = m.L;
      const threat = m.zSiege > 0 || m.zInside > 0;
      if (m.tick % 20 === 0) {
        const hot = L.segs.filter((s) => s.att > 0).sort((a, b) => b.att - a.att);
        let i = 0;
        for (const h of m.humans) {
          if (!h.alive || h.where !== 'base' || h.post.type !== 'wall') continue;
          if (hot.length) { const s = hot[i % hot.length]; const lat = ((i % 4) - 1.5) * 1.6; h.post.x = s.cx - s.nx * 1.7 + (s.nx ? 0 : lat); h.post.z = s.cz - s.nz * 1.7 + (s.nz ? 0 : lat); }
          i++;
        }
        let worst = null, wr = 0.999;
        for (const s of L.segs) { const r = s.hp / s.maxHp; if (r < wr && (s.hp > 0 || s.att === 0)) { wr = r; worst = s; } }
        for (const h of m.humans) {
          if (!h.alive || h.where !== 'base' || h.post.type !== 'repair') continue;
          h.post.seg = worst;
          if (worst) { h.post.x = worst.cx - worst.nx * 1.6; h.post.z = worst.cz - worst.nz * 1.6; } else { h.post.x = 6; h.post.z = 12; }
        }
      }
      const medic = bestSkill(m, 'med'), eb = elderBonus(m);
      for (const h of m.humans) {
        if (!h.alive) continue;
        if (h.socialBubbleT > 0) { h.socialBubbleT -= DT; if (h.socialBubbleT <= 0) h.socialBubble = ''; }
        if (h.where !== 'base') continue;
        if (h.infected > 0) { h.infected -= DT; if (h.infected <= 0) { killHuman(m, h, 'succumbed to the infection and turned'); continue; } }
        const v = speedOf(h), cf = combatFactor(h.age), W = WEAPONS[h.weapon];
        // Fearful survivors retreat earlier; high-loyalty / angry survivors hold the line longer
        const retThresh = h.emotions && h.emotions.fear > 72 ? 0.42 : h.emotions && h.emotions.loyalty > 72 ? 0.22 : 0.30;
        if (!h.retreat && cf > 0 && h.hp < h.maxHp * retThresh && h.post.type !== 'infirmary' && h.post.type !== 'bunker') {
          h.retreat = true;
          h.post = m.zInside > 0 && m.bunkerHp > 0 ? { type: 'bunker', x: L.bunker.x + R(m, -5, 5), z: L.bunker.z + R(m, -3, 3) } : { type: 'infirmary', x: L.infirmary.x + R(m, -3, 3), z: L.infirmary.z + R(m, -2, 2) };
        } else if (h.retreat && h.hp > h.maxHp * 0.7 && h.duty) { h.retreat = false; h.post = h.duty; }
        if (h.post.type === 'haul') haulStep(m, h);
        let tx = h.post.x, tz = h.post.z, engaged = false;
        const meleeNow = cf > 0 && (W.melee || m.ammo <= 0) && !h.retreat && h.post.type !== 'bunker' && h.post.type !== 'infirmary';
        if (meleeNow && m.zInside > 0) {
          const zn = nearestZ(m, h.x, h.z, 20, (z) => inBase(z.x, z.z));
          if (zn) { engaged = true; if (hyp(zn.x - h.x, zn.z - h.z) > W.reach * 0.8) humanMove(m, h, zn.x, zn.z, v); else { h.mv = 0; h.yaw = Math.atan2(zn.x - h.x, zn.z - h.z); } }
        }
        if (!engaged) {
          if (!threat && h.post.type === 'yard') {
            h.wt -= DT;
            if (h.wt <= 0) {
              h.wt = R(m, 3, 9);
              // Couples and best friends gravitate toward each other in the yard; rivals avoid each other!
              const friend = m.byId[h.partnerId] || m.byId[h.bestFriendId];
              if (friend && friend.alive && friend.where === 'base' && rng(m) < 0.55) {
                h.post.x = clamp(friend.x + R(m, -2.2, 2.2), -17, 17);
                h.post.z = clamp(friend.z + R(m, -2.2, 2.2), -1, 18);
              } else {
                h.post.x = clamp(h.post.x + R(m, -5, 5), -17, 17);
                h.post.z = clamp(h.post.z + R(m, -5, 5), -1, 18);
              }
            }
          }
          const d = hyp(tx - h.x, tz - h.z);
          if (d > 0.4) humanMove(m, h, tx, tz, threat ? v : v * 0.55); else h.mv = 0;
        }
        if (h.post.type === 'repair' && h.post.seg && m.scrap > 0 && hyp(tx - h.x, tz - h.z) < 1.5) {
          const resMul = h.emotions && h.emotions.resentment > 70 ? 0.65 : 1.0;
          const s = h.post.seg, add = Math.min(s.maxHp - s.hp, (4 + h.rep * 0.12) * eb * resMul * DT);
          if (add > 0) { const was = s.hp; s.hp += add; m.scrap = Math.max(0, m.scrap - add * BAL.scrapPerHp); h.lastAtk = m.t; if (was <= 0) ev(m, `${h.name} sealed the breach in the ${s.gate ? 'gate' : 'wall'}.`, 'good'); }
        }
        if (h.post.type === 'infirmary' && h.hp < h.maxHp && medic >= 40 && hyp(tx - h.x, tz - h.z) < 3) {
          let rate = (1.2 + medic * 0.04) * eb * (h.emotions && h.emotions.empathy > 65 ? 1.15 : 1);
          if (m.medkits > 0 && h.hp < h.maxHp * 0.6) { rate *= 2.2; m.medkits = Math.max(0, m.medkits - rate * DT / 45); }
          h.hp = Math.min(h.maxHp, h.hp + rate * DT);
        }
        if (!sheltered(m, h)) humanAttack(m, h);
      }
      for (const tw of L.towers) {
        if (!tw.turret || (m.phase === 'night' && !m.power)) continue;   // turrets need the generator after dark
        tw.cd -= DT;
        if (tw.cd > 0) continue;
        const tgt = nearestZ(m, tw.x, tw.z, 26, (z) => z.mode === 'siege' || inBase(z.x, z.z));
        if (!tgt) { tw.cd = 0.3; continue; }
        tw.cd = 0.5; tw.aim = Math.atan2(tgt.x - tw.x, tgt.z - tw.z);
        const hit = rng(m) < 0.55;
        fx(m, { type: 'shot', x: tw.x, z: tw.z, tx: tgt.x, tz: tgt.z, hit, y: 6.2, turret: true });
        if (hit) hurtZombie(m, tgt, 22, null);
      }
    }

    // ------------------------------------------------------------------ zombies
    function zStats(m, z) {
      const T = ZTYPES[z.type], night = m.phase === 'night';
      const f = night ? T.night : 1;
      return { spd: z.spd * f, dmg: (6 + z.str * 0.14) * (night ? (z.type === 'feral' ? 2 : 1.5) : 1) };
    }
    function zAttackHuman(m, z, h, dmg) {
      if (z.atkT > 0) return;
      z.atkT = 1.1; z.lastAtk = m.t;
      hurtHuman(m, h, dmg * R(m, 0.8, 1.2), z);
    }
    function updateZombies(m) {
      const L = m.L;
      const outside = [], inbase = [];
      let bunkered = 0;
      for (const h of m.humans) {
        if (!h.alive || h.carriedBy) continue;
        if (!inBase(h.x, h.z)) outside.push(h);
        else if (sheltered(m, h)) bunkered++;
        else inbase.push(h);
      }
      for (const s of L.segs) s.att = 0;
      const night = m.phase === 'night', aggro = night ? 38 : 15;
      let zInside = 0, zSiege = 0, threat = 0;
      const sq = m.squad;
      const near = (list, z, r) => {
        let best = null, bd = r;
        for (const h of list) { const d = hyp(h.x - z.x, h.z - z.z); if (d < bd) { bd = d; best = h; } }
        return best;
      };
      for (const z of m.zombies) {
        if (!z.alive) continue;
        if (z.atkT > 0) z.atkT -= DT;
        const S = zStats(m, z);
        const inside = inBase(z.x, z.z);
        if (inside) zInside++;
        if (sq && Math.abs(z.x - sq.ax) < 9 && Math.abs(z.z - sq.az) < 9 && z.mode !== 'idle') threat++;

        if (z.mode === 'idle') {
          if (inside) {
            if (inbase.length || bunkered) { z.mode = 'siege'; continue; }
            const s = L.segs.filter((q) => q.hp <= 0).sort((a, b) => hyp(a.cx - z.x, a.cz - z.z) - hyp(b.cx - z.x, b.cz - z.z))[0];
            if (s) move(m, z, s.cx + s.nx * 5, s.cz + s.nz * 5, S.spd, true); else z.mv = 0;
            continue;
          }
          const h = outside.length ? near(outside, z, aggro) : null;
          if (h) { z.mode = 'hunt'; z.tgt = h.id; continue; }
          const dh = hyp(z.hx - z.x, z.hz - z.z);
          if (dh > 16) { move(m, z, z.hx, z.hz, S.spd * 0.8, true); continue; }
          z.wt -= DT;
          if (z.wt <= 0) { z.wt = R(m, 2, 8); z.tx = z.hx + R(m, -11, 11); z.tz = z.hz + R(m, -11, 11); if (Math.max(Math.abs(z.tx), Math.abs(z.tz)) < BASE + 8) { z.tx = z.hx; z.tz = z.hz; } }
          if (hyp(z.tx - z.x, z.tz - z.z) > 0.6) move(m, z, z.tx, z.tz, S.spd * 0.35, true); else z.mv = 0;
          continue;
        }
        if (z.mode === 'hunt') {
          let h = m.byId[z.tgt];
          if (m.tick % 10 === z.id % 10 || !h || !h.alive) { h = near(outside, z, aggro * 1.8); z.tgt = h ? h.id : 0; }
          if (!h || !h.alive) { z.mode = 'idle'; continue; }
          if (inBase(h.x, h.z)) {
            z.mode = 'siege'; z.siegeT = 14; z.seg = null; z.segT = 0; continue;
          }
          const d = hyp(h.x - z.x, h.z - z.z);
          if (d > 1.5) move(m, z, h.x, h.z, S.spd, true); else { z.mv = 0; z.yaw = Math.atan2(h.x - z.x, h.z - z.z); }
          if (d < 1.7) zAttackHuman(m, z, h, S.dmg);
          continue;
        }
        // ---- siege
        zSiege++;
        if (inside) {
          const h = near(inbase, z, 80);
          if (h) {
            const d = hyp(h.x - z.x, h.z - z.z);
            if (d > 1.4) move(m, z, h.x, h.z, S.spd, true); else { z.mv = 0; z.yaw = Math.atan2(h.x - z.x, h.z - z.z); }
            if (d < 1.7) zAttackHuman(m, z, h, S.dmg);
          } else if (bunkered && m.bunkerHp > 0) {
            const b = L.bunker, px = b.doorX + ((z.id % 5) - 2) * 0.9, pz = b.doorZ + 0.4 + (z.id % 3) * 0.5;
            if (hyp(px - z.x, pz - z.z) > 0.9) move(m, z, px, pz, S.spd, true);
            else {
              z.mv = 0; z.yaw = Math.PI;
              if (z.atkT <= 0) {
                z.atkT = 1.1; z.lastAtk = m.t; m.bunkerHp -= S.dmg * 0.35;
                if (m.bunkerHp <= 0) { m.bunkerHp = 0; ev(m, 'The bunker door has been smashed in!', 'bad'); }
              }
            }
          } else { z.mode = 'idle'; z.wave = false; }
          continue;
        }
        if (!z.wave) { z.siegeT -= DT; if (z.siegeT <= 0) { z.mode = 'idle'; continue; } }
        const prey = outside.length ? near(outside, z, 20) : null;
        if (prey) {
          const d = hyp(prey.x - z.x, prey.z - z.z);
          if (d > 1.5) move(m, z, prey.x, prey.z, S.spd, true); else z.mv = 0;
          if (d < 1.7) zAttackHuman(m, z, prey, S.dmg);
          continue;
        }
        z.segT -= DT;
        if (!z.seg || z.segT <= 0) {
          z.segT = 2 + (z.id % 7) * 0.2;
          let best = null, bc = 1e9;
          for (const s of L.segs) {
            const c = hyp(s.cx + s.nx * 2 - z.x, s.cz + s.nz * 2 - z.z) + (s.hp <= 0 ? -22 : 0) + s.crowd * 5 + (s === z.seg ? -4 : 0);
            if (c < bc) { bc = c; best = s; }
          }
          if (best !== z.seg) z.thru = false;
          z.seg = best;
        }
        const s = z.seg;
        if (s.hp <= 0) {
          const ox = s.cx + s.nx * 2.5, oz = s.cz + s.nz * 2.5;
          if (!z.thru && hyp(ox - z.x, oz - z.z) > 1.6) move(m, z, ox, oz, S.spd, true);
          else { z.thru = true; move(m, z, s.cx - s.nx * 4, s.cz - s.nz * 4, S.spd, true); }
          s.att++;
        } else {
          const lat = ((z.id % 7) - 3) * 1.15;
          const px = s.cx + s.nx * 1.3 + (s.nx ? 0 : lat), pz = s.cz + s.nz * 1.3 + (s.nz ? 0 : lat);
          const d = hyp(px - z.x, pz - z.z);
          if (d > 0.7) move(m, z, px, pz, S.spd, true);
          else {
            z.mv = 0; z.yaw = Math.atan2(-s.nx, -s.nz);
            if (z.atkT <= 0) {
              z.atkT = 1.1; z.lastAtk = m.t; s.hp -= S.dmg * BAL.wallDmg;
              if (s.hp <= 0) { s.hp = 0; m.stats.breaches++; ev(m, `Zombies broke through the ${s.gate ? 'front gate' : ['south', 'east', 'north', 'west'][s.side] + ' wall'}!`, 'bad'); fx(m, { type: 'breach', x: s.cx, z: s.cz }); }
            }
          }
          if (d < 6) s.att++;
        }
      }
      for (const s of L.segs) s.crowd = s.att;
      m.zInside = zInside; m.zSiege = zSiege; m.squadThreat = threat;
    }

    function updateCorpses(m) {
      for (let i = m.corpses.length - 1; i >= 0; i--) {
        const c = m.corpses[i];
        c.t -= DT;
        if (c.t > 0) continue;
        m.corpses.splice(i, 1);
        const h = m.byId[c.id];
        const z = makeZombie(m, c.x, c.z, h);
        if (inBase(z.x, z.z)) z.mode = 'siege';
        if (m.phase === 'night' && m.wave && !m.wave.done) z.wave = true, z.mode = 'siege';
        m.zombies.push(z); m.byId[z.id] = z;
        h.turnedInto = z.id;
        m.stats.turned++; m.zAlive++;
        ev(m, `${h.name} has risen as a ${ZTYPES[z.type].name.toLowerCase()}.`, 'death');
        fx(m, { type: 'rise', x: c.x, z: c.z });
      }
    }


    // ------------------------------------------------------------------ Ant Farm Deep Systems
    function updateAntFarmSystems(m) {
      const L = m.L;
      // 1. Food & Water consumption & farming
      if (m.tick % 40 === 0) {
        const farmers = m.humans.filter((h) => h.alive && h.where === 'base' && !h.brigT && h.age >= 12).length;
        if (m.phase === 'day') {
          m.food = clamp(m.food + farmers * 0.14 + (m.weather === 'rain' ? 0.3 : 0), 0, 160);
          m.water = clamp(m.water + (m.weather === 'rain' ? 2.5 : 0.25), 0, 160);
        }
        m.food = Math.max(0, m.food - m.hAlive * 0.08);
        m.water = Math.max(0, m.water - m.hAlive * 0.09 * (m.weather === 'heatwave' ? 2 : 1));   // heatwaves double water drain
        if ((m.food < 5 || m.water < 5) && m.tick % 200 === 0) {
          ev(m, `Ration shortage! Food (${Math.round(m.food)}) / Water (${Math.round(m.water)}) critically low — tempers flare in the yard.`, 'bad');
          for (const h of m.humans) if (h.alive && h.emotions) {
            h.emotions.anger = clamp(h.emotions.anger + 6, 0, 100);
            h.emotions.greed = clamp(h.emotions.greed + 8, 0, 100);
            h.emotions.resentment = clamp(h.emotions.resentment + 5, 0, 100);
          }
        }
      }

      // 2. Compound Construction: Traps, Gym, Lounge, Truck Repair
      if (m.tick % 100 === 0 && m.scrap >= 25) {
        if (!m.radio.built && m.day >= 2 && m.scrap >= 28) {
          m.scrap -= 25; m.radio.built = true; m.radio.builtDay = m.day;
          ev(m, `Builders raised a Radio Dish on the west wall — the camp can now intercept distress calls from the town.`, 'good');
        } else if (m.traps.length < 10 && rng(m) < 0.45) {
          m.scrap -= 18;
          const side = m.traps.length % 4;
          const ang = (side * 1.57) + R(m, -0.5, 0.5);
          const dist = BASE + 3.5;
          m.traps.push({ id: m.nextId++, kind: m.traps.length % 2 ? 'mine' : 'wire', x: Math.sin(ang) * dist, z: Math.cos(ang) * dist, armed: true });
          ev(m, `Builders deployed ${m.traps[m.traps.length - 1].kind === 'mine' ? 'a propane tripwire mine' : 'barbed wire coils'} outside the walls.`, 'good');
        } else if (!m.gymBuilt && m.scrap >= 35) {
          m.scrap -= 35; m.gymBuilt = true;
          ev(m, `Survivors built a courtyard Gym — fighters gain Strength over time.`, 'good');
        } else if (!m.loungeBuilt && m.scrap >= 35) {
          m.scrap -= 35; m.loungeBuilt = true;
          ev(m, `Survivors set up a Camp Lounge — lowers Fear and Resentment each day.`, 'good');
        } else if (!m.truck.repaired && m.scrap >= 22) {
          m.scrap -= 20; m.truck.progress += 35;
          if (m.truck.progress >= 100) {
            m.truck.repaired = true;
            ev(m, `Mechanics hotwired and armored a Pickup Truck! Expeditions can now haul supplies faster (watch out for engine noise!).`, 'good');
          }
        }
      }

      // 3. Trap detonation / wire damage
      for (const tr of m.traps) {
        if (!tr.armed) continue;
        for (const z of m.zombies) {
          if (!z.alive) continue;
          if (hyp(z.x - tr.x, z.z - tr.z) < 1.8) {
            if (tr.kind === 'mine') {
              tr.armed = false;
              fx(m, { type: 'breach', x: tr.x, z: tr.z });
              ev(m, `BOOM! A propane tripwire mine detonated at the perimeter!`, 'good');
              for (const z2 of m.zombies) {
                if (z2.alive && hyp(z2.x - tr.x, z2.z - tr.z) < 6.5) {
                  z2.ragdollT = 1.4;
                  hurtZombie(m, z2, 130, null);
                }
              }
              break;
            } else if (m.tick % 10 === 0) {
              hurtZombie(m, z, 6, null);
            }
          }
        }
      }

      // 4. Brig countdown, Pregnancy & Births, Gym/Lounge perks
      for (const h of m.humans) {
        if (!h.alive) continue;
        if (h.ragdollT > 0) h.ragdollT = Math.max(0, h.ragdollT - DT);
        if (h.brigT > 0) {
          h.brigT = Math.max(0, h.brigT - DT);
          if (h.brigT <= 0) { ev(m, `${h.name} finished their sentence in the Brig and returned to the yard.`, 'info'); assignPosts(m); }
        }
        if (h.pregnant > 0) {
          h.pregnant -= DT;
          if (h.pregnant <= 0) {
            const baby = makeHuman(m, false);
            baby.age = 0.2; baby.maxHp = maxHpOf(baby); baby.hp = baby.maxHp;
            baby.name = baby.name.split(' ')[0] + ' ' + h.name.split(' ')[1];
            baby.parents = [h.id, h.babyFatherId || h.partnerId];
            baby.x = h.x; baby.z = h.z;
            m.humans.push(baby); count(m);
            m.stats.births++;
            setBubble(h, '👶', 6, 'Welcome to the world!');
            ev(m, `New life in the deadzone! ${h.name} gave birth to ${baby.name}.`, 'good');
            birthReveal(m, h, baby);
          }
        }
      }

      // 5. Periodic Compound Justice Trials & Coups/Splinters
      if (m.tick % 240 === 0) {
        const troublemakers = m.humans.filter((h) => h.alive && h.where === 'base' && h.brigT <= 0 && h.dramaCount >= 3 && h.age >= 16);
        if (troublemakers.length && rng(m) < 0.45) {
          const acc = troublemakers[0];
          m.stats.trials++;
          const bloc = cliqueVote(m, acc);
          if (bloc === 'acquit') {
            // the accused's clique sprang them
          } else if (acc.dramaCount >= 5 && m.hAlive >= 8) {
            acc.brigT = 45; acc.dramaCount = 0;
            setBubble(acc, '⛓️', 6, 'This is BS!!');
            ev(m, `Courtyard Trial: Fed up with ${acc.name}'s chaos, the compound voted to lock ${acc.name.split(' ')[0]} in the Brig!` + bloc, 'bad');
            assignPosts(m);
          } else {
            acc.brigT = 25; acc.dramaCount = 0;
            setBubble(acc, '⛓️', 5, 'Watch when I get out...');
            ev(m, `Compound Justice: ${acc.name} was sentenced to time in the Brig for hoarding/fighting.` + bloc, 'info');
            assignPosts(m);
          }
        }
        // Coup / Mutiny check if morale is very low
        if (m.morale < 28 && m.hAlive >= 7 && rng(m) < 0.25) {
          const rebel = m.humans.find((h) => h.alive && h.where === 'base' && (h.personality === 'ghetto' || h.personality === 'saboteur' || h.emotions.resentment > 75));
          if (rebel) {
            m.stats.coups++;
            rebel.emotions.anger = 95; rebel.emotions.pride = 95;
            setBubble(rebel, '🔥', 6, 'New management NOW!');
            ev(m, `MUTINY! ${rebel.name} tried to seize leadership of the compound amid collapsing morale — chaos erupted in the courtyard!`, 'bad');
            m.morale = clamp(m.morale + 10, 0, 100);
          }
        }
      }

      // 6. Pregnancy chance for couples at daybreak & Gym/Lounge bonuses
      if (m.tick % 300 === 0) {
        if (m.gymBuilt) for (const h of m.humans) if (h.alive && h.age >= 15) h.str = Math.min(100, h.str + 0.5);
        if (m.loungeBuilt) for (const h of m.humans) if (h.alive && h.emotions) { h.emotions.fear = Math.max(0, h.emotions.fear - 2); h.emotions.resentment = Math.max(0, h.emotions.resentment - 2); }
        const mothers = m.humans.filter((h) => h.alive && h.female && h.partnerId && !h.pregnant && h.age >= 20 && h.age <= 40 && m.hAlive < 46);
        if (mothers.length && rng(m) < 0.08) {
          const mom = pick(m, mothers);
          conceive(m, mom);
        }
      }

      // 7. Collectibles / God-dropped Supply Crates
      for (let i = m.crates.length - 1; i >= 0; i--) {
        const cr = m.crates[i];
        const nearH = m.humans.find((h) => h.alive && hyp(h.x - cr.x, h.z - cr.z) < 2.2);
        if (nearH) {
          m.scrap += 25; m.ammo += 20; m.medkits += 2; m.food += 15; m.fuel += 6;
          setBubble(nearH, '📦', 4.5, 'Supply drop secured!');
          ev(m, `${nearH.name} opened a supply crate: +25 scrap, +20 ammo, +2 medkits, +15 food, +6 fuel!`, 'good');
          m.crates.splice(i, 1);
        }
      }

      // 8. Trader Caravan & Rival Raiders (daytime events)
      if (m.phase === 'day' && m.clock > 15 && m.clock < 16 && !m.trader && rng(m) < 0.28) {
        m.trader = { x: 0, z: BASE + 7, t: 18 };
        if (m.scrap >= 30) {
          m.scrap -= 25; m.ammo += 22; m.antivirals += 1; m.food += 12; m.fuel += 8;
          ev(m, `Wandering Trader arrived at the front gate! Bartered 25 scrap for 22 ammo, 1 antiviral, 12 food, and 8 fuel.`, 'good');
        } else {
          ev(m, `A Wandering Trader stopped by the gate, but the compound lacked scrap to barter.`, 'info');
        }
      }
      if (m.trader) { m.trader.t -= DT; if (m.trader.t <= 0) m.trader = null; }


      // 10. Deep Human Psychology, Camp Politics, Vigil/Coping, Concealed-Bite Witch Hunts, Fatigue & PTSD
      if (m.tick % 40 === 0) {
        for (const h of m.humans) {
          if (!h.alive) continue;
          const working = h.where === 'squad' || (h.where === 'base' && h.post && (h.post.type === 'repair' || h.post.type === 'wall'));
          h.fatigue = clamp(h.fatigue + (working ? 1.4 : m.phase === 'night' ? -0.8 : -0.4) + (m.weather === 'heatwave' ? 0.6 : 0), 0, 100);
          if (h.fatigue > 80 && h.emotions) h.emotions.anger = clamp(h.emotions.anger + 2, 0, 100);
          if (h.sanity < 35 && h.emotions) h.emotions.paranoia = clamp(h.emotions.paranoia + 2, 0, 100);
        }
      }

      // Camp Leader check & Power Struggles
      if (!m.leaderId || !m.byId[m.leaderId] || !m.byId[m.leaderId].alive) {
        const candidates = m.humans.filter((h) => h.alive && h.age >= 18 && !h.brigT).sort((a, b) => ((b.personality === 'leader' ? 30 : 0) + b.brav + b.emotions.pride * 0.4) - ((a.personality === 'leader' ? 30 : 0) + a.brav + a.emotions.pride * 0.4));
        if (candidates.length) {
          m.leaderId = candidates[0].id;
          setBubble(candidates[0], '👑', 5, 'I am taking charge.');
          ev(m, `Leadership Transition: ${candidates[0].name} (${candidates[0].bg}) stepped up as the new Camp Leader.`, 'phase');
        }
      }

      if (m.tick % 180 === 0) {
        const alive = m.humans.filter((h) => h.alive && h.age >= 15);
        if (alive.length >= 4) {
          const r = rng(m);
          // A. Concealed Bite Exposure / Paranoid Witch Hunt
          const hidden = alive.find((h) => h.concealed && h.infected > 0);
          if (hidden && r < 0.55) {
            const acc = alive.find((x) => x.id !== hidden.id && (x.personality === 'paranoid' || x.med > 50 || x.emotions.paranoia > 60)) || alive[0];
            hidden.concealed = false;
            setBubble(acc, '🚨', 6, 'THEY ARE BITTEN!!');
            setBubble(hidden, '😰', 6, 'Please, no...');
            hidden.brigT = 30;
            assignPosts(m);
            ev(m, `Panic at the compound! ${acc.name} spotted blood on ${hidden.name}'s sleeve and exposed their hidden zombie bite — ${hidden.name} was rushed into quarantine!`, 'bad');
          }
          // B. PTSD Flashback / Nightmare / Panic Attack
          else if (r < 0.25) {
            const broken = alive.find((h) => h.sanity < 55 || h.trauma > 0 || h.emotions.fear > 72);
            if (broken) {
              broken.sanity = clamp(broken.sanity - 12, 5, 100);
              broken.emotions.fear = clamp(broken.emotions.fear + 18, 0, 100);
              const helper = alive.find((x) => x.id !== broken.id && (x.bg === 'Pastor' || x.personality === 'peacemaker' || x.emotions.empathy > 65));
              setBubble(broken, '😵', 5.5, 'I still hear them...');
              if (helper) {
                broken.sanity = clamp(broken.sanity + 16, 0, 100);
                addRel(m, broken, helper, 14);
                setBubble(helper, '🫂', 5, 'Breathe. You are safe.');
                ev(m, `${broken.name} suffered a severe PTSD panic attack, but ${helper.name} (${helper.bg}) talked them down from the edge.`, 'info');
              } else {
                m.morale = clamp(m.morale - 4, 0, 100);
                ev(m, `${broken.name} had a screaming nightmare about the dead, rattling nerves across the whole camp.`, 'bad');
              }
            }
          }
          // C. Campfire Stories, Vigil, Music & Dark Humor (humanity & coping)
          else if (r < 0.55) {
            const host = alive.find((h) => h.bg === 'Pastor' || h.bg === 'School Teacher' || h.personality === 'peacemaker' || h.emotions.hope > 60) || alive[0];
            setBubble(host, '🎸', 5.5, 'Remember before all this?');
            for (const h of alive) {
              h.sanity = clamp(h.sanity + 6, 0, 100);
              if (h.emotions) h.emotions.hope = clamp(h.emotions.hope + 6, 0, 100);
            }
            ev(m, `Around the courtyard fire, ${host.name} (${host.bg}) shared pre-outbreak stories and dark humor, lifting everyone's sanity and hope.`, 'good');
          }
          // D. Protection Racket / Bullying or Scapegoating Newcomers
          else if (r < 0.78) {
            const bully = alive.find((h) => h.personality === 'ghetto' || h.personality === 'saboteur' || h.bg === 'Street Boxer' || h.emotions.greed > 72);
            const victim = alive.find((h) => h.id !== (bully ? bully.id : 0) && (h.age > 60 || h.handicaps.length > 0 || h.joinedDay > 1));
            if (bully && victim) {
              addRel(m, bully, victim, -20);
              victim.emotions.fear = clamp(victim.emotions.fear + 14, 0, 100);
              bully.dramaCount++;
              setBubble(bully, '😤', 5, 'Pay the tax.');
              setBubble(victim, '😨', 5, 'Leave me alone!');
              ev(m, `Scapegoating & Bullying: ${bully.name} cornered newcomer ${victim.name} in the yard, blaming them for low rations and demanding their best gear.`, 'bad');
            }
          }
          // E. Deserter Attempt (when morale or sanity is critically low)
          else if (m.morale < 35 && alive.length >= 6) {
            const deserter = alive.find((h) => h.sanity < 45 || h.emotions.fear > 78 || h.emotions.resentment > 80);
            if (deserter && deserter.id !== m.leaderId) {
              setBubble(deserter, '🏃', 5, 'I am done with this place!');
              deserter.sanity = clamp(deserter.sanity + 10, 0, 100);
              ev(m, `${deserter.name} tried to pack a bag and bolt through the gate in a panic, before guards talked them back inside.`, 'bad');
            }
          }
        }
      }


      // 11. Armed Raider Stand-offs at the Gate, Vice Withdrawal & Heroic Last Stands
      if (m.phase === 'day' && m.day >= 2 && m.clock > 24 && m.clock < 25 && !m.raiderEventDay && rng(m) < 0.35) {
        m.raiderEventDay = m.day;
        const ldr = m.byId[m.leaderId];
        const hothead = m.humans.find((h) => h.alive && h.where === 'base' && (h.personality === 'ghetto' || h.personality === 'ignorant' || h.bg === 'Ex-Soldier'));
        if (m.scrap >= 25 && m.ammo >= 15 && (!hothead || rng(m) < 0.5)) {
          m.scrap -= 18; m.ammo -= 10;
          ev(m, `Raider Shakedown: Armed scavengers rolled up to the gate demanding tribute. ${ldr ? ldr.name : 'The camp'} paid 18 scrap and 10 ammo to avoid a bloodbath.`, 'bad');
        } else {
          const hero = hothead || ldr || m.humans.find((h) => h.alive);
          if (hero) {
            setBubble(hero, '🔫', 6, 'Try us and find out!');
            hero.hp = Math.max(15, hero.hp - Math.round(R(m, 8, 22)));
            m.ammo = Math.max(0, m.ammo - 6);
            m.scrap += 22;
            ev(m, `Gate Gunfight! Raiders tried to rush the compound — ${hero.name} led a fierce shootout at the gate, driving them off (+22 scrap, -6 ammo).`, 'good');
          }
        }
      }
      if (m.tick % 220 === 0) {
        const needy = m.humans.find((h) => h.alive && h.vice !== 'None' && h.vice !== 'Insomniac');
        if (needy && rng(m) < 0.35) {
          if (m.food > 20) {
            needy.sanity = clamp(needy.sanity + 8, 0, 100);
            setBubble(needy, '☕', 4.5, `${needy.vice} fix!`);
          } else {
            needy.emotions.anger = clamp(needy.emotions.anger + 12, 0, 100);
            setBubble(needy, '😫', 4.5, `Need my ${needy.vice.toLowerCase()} fix...`);
          }
        }
        // Rearguard Last Stand when squad is overwhelmed outside
        if (m.squad && m.squadThreat >= 3) {
          const protector = m.humans.find((h) => h.alive && h.where === 'squad' && !h.escort && (h.personality === 'rideordie' || h.bg === 'Firefighter' || h.bg === 'Ex-Soldier'));
          if (protector) {
            setBubble(protector, '🛡️', 5, "Go! I'll hold them!");
            protector.emotions.loyalty = 100;
          }
        }
      }

      // 9. Weather & Seasons
      if (m.day !== m._lastWDay) {
        m._lastWDay = m.day;
        m.season = SEASONS[Math.floor((m.day - 1) / 2) % 4];   // two days per season, so a typical run sees winter
        m.weather = pick(m, SEASON_WEATHER[m.season]);
        ev(m, `${m.season} weather today: ${m.weather.toUpperCase()}.`, 'info');
        // Day 4+ Behemoth Boss Siege!
        if (m.day >= 4 && m.day % 2 === 0) {
          const boss = makeZombie(m, 0, -MAP + 20, null);
          boss.type = 'behemoth'; boss.maxHp = 440; boss.hp = 440; boss.str = 100; boss.spd = 1.35;
          boss.wave = true; boss.mode = 'siege';
          m.zombies.push(boss); count(m);
          ev(m, `WARNING: A towering Behemoth Boss zombie has been spotted marching toward the compound!`, 'bad');
        }
      }
    }

    // ------------------------------------------------------------------ Season Two systems
    // Crushes & love triangles, bunk assignments, paternity drama, named cliques, the generator & blackouts,
    // the camp guard dog, seasons that bite, emergency amputations, the radio dish, and corpse disposal.
    const ADULT = 18;         // every romance path (partners, crushes, flings, scandals, pregnancies) is adults-only
    const first = (h) => h.name.split(' ')[0];
    const bump = (h, k, d) => { if (h.emotions) h.emotions[k] = clamp(h.emotions[k] + d, 0, 100); };
    const CLIQUE_NAMES = ['The Gatekeepers', 'The Kitchen Crew', 'The Night Owls', 'The Tea Committee', 'The Day Ones', 'The Back Bunk Mafia',
      'The Wall Rats', 'The Scrap Kings', 'The Prayer Circle', 'The Smoke Break Club', 'The Watchtower Set', 'The Leftovers'];
    const CLIQUE_COLORS = ['#f59e0b', '#38bdf8', '#a78bfa', '#34d399', '#f472b6', '#fb7185'];
    const DOG_NAMES = ['Biscuit', 'Tank', 'Roxy', 'Diesel', 'Luna', 'Chowder', 'Bandit', 'Mango'];
    const SEASON_WEATHER = {
      Spring: ['clear', 'clear', 'rain', 'fog'],
      Summer: ['clear', 'heatwave', 'heatwave', 'rain'],
      Autumn: ['clear', 'rain', 'fog', 'fog', 'snow'],
      Winter: ['snow', 'snow', 'snow', 'clear', 'fog'],
    };

    function isFamily(a, b) {
      if (a.familyIds.indexOf(b.id) >= 0 || b.familyIds.indexOf(a.id) >= 0) return true;
      if (a.parents && a.parents.indexOf(b.id) >= 0) return true;
      if (b.parents && b.parents.indexOf(a.id) >= 0) return true;
      return false;
    }
    /** The single gate for anything romantic: two living, unrelated adults of broadly similar age. */
    function canDate(a, b) {
      return !!a && !!b && a.id !== b.id && a.alive && b.alive && a.age >= ADULT && b.age >= ADULT && Math.abs(a.age - b.age) < 22 && !isFamily(a, b);
    }
    function noteLiaison(m, a, b) {
      for (const [x, y] of [[a, b], [b, a]]) {
        x.liaisons.push({ id: y.id, day: m.day });
        if (x.liaisons.length > 8) x.liaisons.shift();
      }
    }
    function markSingle(m, a, b) { a.singleSince = m.t; b.singleSince = m.t; }
    function coupleUp(m, a, b, score) {
      a.partnerId = b.id; b.partnerId = a.id;
      a.rels[b.id] = b.rels[a.id] = score;
      if (a.crushId === b.id) a.crushId = 0;
      if (b.crushId === a.id) b.crushId = 0;
      refreshSocialBonds(a); refreshSocialBonds(b);
      noteLiaison(m, a, b);
      m.stats.romances = (m.stats.romances || 0) + 1;
    }
    function confess(m, h, text, t) {
      const entry = { day: m.day, clock: Math.floor(m.clock), id: h.id, name: h.name, culture: h.cultureName || '', bg: h.bg, pers: h.personalityName, text, t: t || 8.5 };
      m.confessional = entry;
      m.confessionals.push(entry);
      if (m.confessionals.length > 80) m.confessionals.shift();
    }
    const baseAdults = (m) => m.humans.filter((h) => h.alive && h.where === 'base' && h.age >= ADULT);

    // ---- 5. Secret crushes & love triangles
    function updateCrushes(m) {
      const adults = m.humans.filter((h) => h.alive && h.age >= ADULT);
      for (const h of adults) {
        const c = h.crushId ? m.byId[h.crushId] : null;
        if (h.crushId && (!c || !canDate(h, c) || h.partnerId)) h.crushId = 0;
        if (h.crushId || h.partnerId || rng(m) > 0.16) continue;
        let best = null, bs = 16;
        for (const o of adults) {
          if (!canDate(h, o) || h.exIds.indexOf(o.id) >= 0) continue;
          const s = getRel(h, o) + rng(m) * 16;
          if (s > bs) { bs = s; best = o; }
        }
        if (best) { h.crushId = best.id; m.stats.crushes++; }
      }
    }
    /** Called from the social tick: a single survivor acts on their crush. Returns true if it produced an event. */
    function crushDrama(m, a) {
      if (!a.crushId || a.partnerId || a.where !== 'base') return false;
      const c = m.byId[a.crushId];
      if (!canDate(a, c)) return false;
      const rival = c.partnerId ? m.byId[c.partnerId] : null;
      if (rival && rival.alive) {
        if (rng(m) > 0.5) return false;
        bump(a, 'jealousy', 14);
        a.dramaCount++; m.stats.triangles++; m.stats.conflicts = (m.stats.conflicts || 0) + 1;
        const v = Math.floor(rng(m) * 3);
        let txt;
        if (v === 0) {
          addRel(m, c, rival, -14); addRel(m, a, rival, -18); bump(rival, 'jealousy', 16);
          setBubble(a, '🤫', 5, 'I heard something...'); setBubble(rival, '🤨', 5, 'Say that again?');
          txt = `Love triangle: ${a.name}, secretly crushing on ${c.name}, fed ${first(rival)} a rumor that ${first(c)} has been sneaking around — sabotage, plain and simple.`;
        } else if (v === 1) {
          addRel(m, a, c, 8); addRel(m, c, rival, -8); bump(rival, 'jealousy', 18);
          setBubble(a, '😍', 5, 'Need a hand with that?'); setBubble(rival, '😒', 5, 'I see you.');
          txt = `Love triangle: ${a.name} keeps finding excuses to work right next to ${c.name}, and ${first(c)}'s partner ${rival.name} has noticed the crush.`;
        } else {
          addRel(m, a, rival, -24); bump(a, 'resentment', 10); bump(rival, 'anger', 16);
          setBubble(rival, '😤', 5.5, 'Back OFF.'); setBubble(a, '🙄', 5.5, 'Make me.');
          txt = `Love triangle: ${rival.name} told ${a.name} to back off ${first(c)} in front of the whole yard — ${first(a)} did not back off.`;
        }
        confess(m, a, pick(m, [
          `I know ${first(c)} is with ${first(rival)}. I also know I'd treat ${first(c)} better. I'm just waiting for ${first(rival)} to mess up.`,
          `Everybody thinks I hate ${first(rival)} for no reason. There's a reason. The reason is ${first(c)}.`,
          `If ${first(c)} and ${first(rival)} break up, I am not going to pretend I'm sad about it.`,
        ]));
        ev(m, txt, 'bad');
        return true;
      }
      if (c.partnerId || rng(m) > 0.6) return false;
      const rel = getRel(a, c), fresh = c.singleSince != null && m.t - c.singleSince < 90;
      const p = clamp(0.25 + rel * 0.006 + (c.crushId === a.id ? 0.4 : 0), 0.1, 0.9);
      if (rng(m) < p) {
        coupleUp(m, a, c, Math.max(rel + 28, 72));
        bump(a, 'hope', 16); bump(c, 'hope', 12);
        setBubble(a, '❤️', 6, 'Finally!'); setBubble(c, '❤️', 6, 'Took you long enough');
        ev(m, fresh ? `${a.name} shot their shot with ${c.name} barely a day after ${first(c)}'s breakup — and it landed. The yard has opinions.`
          : `${a.name} finally confessed a long-running crush on ${c.name} — and ${first(c)} said yes. They've coupled up.`, 'good');
      } else {
        a.crushId = 0; m.stats.rejections++;
        addRel(m, a, c, -10); bump(a, 'resentment', 12); bump(a, 'hope', -8);
        setBubble(a, '💔', 5.5, 'Forget I said anything.'); setBubble(c, '😬', 5.5, "Let's just be friends.");
        ev(m, `${a.name} shot their shot with ${c.name} in front of everybody and got turned down — an unrequited crush crashed and burned.`, 'bad');
      }
      return true;
    }

    // ---- 7. Paternity drama
    function conceive(m, mom) {
      const partner = m.byId[mom.partnerId];
      const cands = [];
      const add = (id) => { const o = m.byId[id]; if (o && o.kind === 'human' && !o.female && o.age >= ADULT && cands.indexOf(o) < 0) cands.push(o); };
      if (partner) add(partner.id);
      for (const l of mom.liaisons) if (m.day - l.day <= 4) add(l.id);
      mom.pregnant = 95;
      mom.babyFatherId = cands.length ? pick(m, cands).id : (partner ? partner.id : 0);
      const others = cands.filter((o) => !partner || o.id !== partner.id);
      setBubble(mom, '🤰', 6, others.length ? 'So... about that.' : 'We are having a baby!');
      if (!others.length) {
        ev(m, `${mom.name} and ${partner ? partner.name : 'their partner'} shared joyful news — a baby is on the way!`, 'good');
        return;
      }
      mom.paternityDrama = true;
      m.stats.paternity++;
      m.paternity.push({ momId: mom.id, candIds: cands.map((o) => o.id), day: m.day, resolved: false });
      if (partner) {
        bump(partner, 'jealousy', 25); bump(partner, 'paranoia', 15);
        for (const o of others) addRel(m, partner, o, -28);
        setBubble(partner, '🤨', 6, 'Do the math for me.');
      }
      const names = cands.map(first);
      ev(m, `WHO'S THE FATHER?! ${mom.name} is pregnant — and after the recent mess with ${others.map(first).join(' and ')}, the whole yard is openly taking bets between ${names.join(', ')}.`, 'bad');
      confess(m, partner && rng(m) < 0.5 ? partner : mom, pick(m, [
        `Everybody is counting days on their fingers when they think I'm not looking. I can count too.`,
        `I'm not saying anything until that baby gets here. Let them whisper.`,
        `One of us in this camp knows the truth, and it might not even be me.`,
      ]), 9);
    }
    function birthReveal(m, mom, baby) {
      if (!mom.paternityDrama) return;
      mom.paternityDrama = false;
      for (const p of m.paternity) if (p.momId === mom.id) p.resolved = true;
      const father = m.byId[mom.babyFatherId], partner = m.byId[mom.partnerId];
      if (!father) return;
      if (partner && partner.alive && father.id === partner.id) {
        addRel(m, mom, partner, 15); bump(partner, 'jealousy', -20);
        ev(m, `Paternity settled: baby ${first(baby)} is the spitting image of ${partner.name}. The rumor mill owes ${first(mom)} an apology.`, 'good');
        return;
      }
      if (partner && partner.alive) {
        addRel(m, partner, mom, -45); addRel(m, partner, father, -50);
        bump(partner, 'anger', 30); bump(partner, 'resentment', 25);
        setBubble(partner, '🤬', 6.5, 'THAT IS NOT MY KID!');
        if (rng(m) < 0.6) {
          mom.partnerId = 0; partner.partnerId = 0;
          if (mom.exIds.indexOf(partner.id) < 0) mom.exIds.push(partner.id);
          if (partner.exIds.indexOf(mom.id) < 0) partner.exIds.push(mom.id);
          refreshSocialBonds(mom); refreshSocialBonds(partner); markSingle(m, mom, partner);
          m.stats.breakups = (m.stats.breakups || 0) + 1;
          ev(m, `PATERNITY SCANDAL: baby ${first(baby)} has ${father.name}'s eyes, not ${first(partner)}'s — ${partner.name} walked out on ${first(mom)} on the spot. Breakup!`, 'bad');
        } else {
          ev(m, `PATERNITY SCANDAL: everyone can see baby ${first(baby)} looks like ${father.name}. ${partner.name} is staying with ${first(mom)}, but nobody is making eye contact at dinner.`, 'bad');
        }
      } else {
        ev(m, `Paternity settled: baby ${first(baby)} clearly takes after ${father.name}${father.alive ? '' : ', who did not live to see it'}.`, 'info');
      }
    }

    // ---- 6. Bunk assignments
    function assignBunks(m) {
      const map = {};
      for (const h of m.humans) map[h.id] = h;
      const sleepers = m.humans.filter((h) => h.alive && h.age >= 5);
      const groups = {};
      for (const h of sleepers) if (h.bunkId) (groups[h.bunkId] = groups[h.bunkId] || []).push(h);
      for (const h of m.humans) {
        const g = groups[h.bunkId];
        if (!h.alive || h.age < 5 || !g || g.length !== 2) h.bunkId = 0;
        else if ((g[0].age >= ADULT) !== (g[1].age >= ADULT) && !isFamily(g[0], g[1])) h.bunkId = 0;   // someone came of age: re-bunk
      }
      const newBunk = (a, b) => { const id = ++m.nextBunk; a.bunkId = id; if (b) b.bunkId = id; };
      for (const h of sleepers) {           // couples move in together, evicting whoever was there
        const p = map[h.partnerId];
        if (!p || !p.alive || h.id > p.id || (h.bunkId && h.bunkId === p.bunkId)) continue;
        for (const o of sleepers) if (o !== h && o !== p && o.bunkId && (o.bunkId === h.bunkId || o.bunkId === p.bunkId)) o.bunkId = 0;
        newBunk(h, p);
      }
      for (const grown of [true, false]) {   // adults bunk with adults; minors with family or other minors
        const free = sleepers.filter((h) => !h.bunkId && (h.age >= ADULT) === grown);
        while (free.length) {
          const a = free.shift();
          let i = free.findIndex((o) => isFamily(a, o));
          if (i < 0) i = free.findIndex((o) => a.noBunkWith !== o.id && o.noBunkWith !== a.id);
          if (i < 0 && free.length) i = 0;   // no spare bunks: stuck with them anyway
          newBunk(a, i >= 0 ? free.splice(i, 1)[0] : null);
        }
      }
    }
    function bunkmateOf(m, h) {
      if (!h.bunkId) return null;
      for (const o of m.humans) if (o.alive && o !== h && o.bunkId === h.bunkId) return o;
      return null;
    }
    function bunkDrama(m) {
      const seen = {};
      let fights = 0;
      for (const h of m.humans) {
        if (!h.alive || !h.bunkId || seen[h.bunkId] || h.age < 16 || h.where !== 'base') continue;
        seen[h.bunkId] = 1;
        const mate = bunkmateOf(m, h);
        if (!mate || mate.age < 16 || mate.where !== 'base') continue;
        const ex = h.exIds.indexOf(mate.id) >= 0, rel = getRel(h, mate);
        if (!ex && rel > -40) { if (rel > 30 && h.partnerId !== mate.id) addRel(m, h, mate, 2); continue; }
        if (fights >= 2 || rng(m) > 0.65) continue;
        fights++;
        m.stats.bunkFights++; m.stats.conflicts = (m.stats.conflicts || 0) + 1;
        for (const x of [h, mate]) {
          x.fatigue = clamp(x.fatigue + 16, 0, 100); x.sanity = clamp(x.sanity - 6, 5, 100); x.insomniaT = 90;
          bump(x, 'anger', 14); x.dramaCount++;
        }
        addRel(m, h, mate, -10);
        let woke = 0;
        for (const o of m.humans) if (o.alive && o.where === 'base' && o !== h && o !== mate && woke < 3 && rng(m) < 0.3) { o.fatigue = clamp(o.fatigue + 5, 0, 100); woke++; }
        setBubble(h, '🤬', 5.5, 'STAY ON YOUR SIDE!'); setBubble(mate, '😤', 5.5, 'YOU SNORE AND YOU LIE!');
        const what = ex ? 'Exes' : 'Bitter rivals';
        let txt = `2 AM bunk blowup: ${what} ${h.name} and ${mate.name}, forced to share a bunk, screamed at each other until half the bunker was awake. Nobody slept.`;
        if (rng(m) < 0.5) {
          h.noBunkWith = mate.id; mate.noBunkWith = h.id; h.bunkId = 0; mate.bunkId = 0;
          txt += ` ${first(h)} dragged a mattress out and is demanding a new bunk assignment.`;
        }
        ev(m, txt, 'bad');
      }
    }

    // ---- 3. Named cliques & alliances
    function cliqueOf(m, h) {
      if (!h || !h.cliqueId) return null;
      for (const c of m.cliques) if (c.id === h.cliqueId) return c;
      return null;
    }
    function formCliques(m) {
      const pool = m.humans.filter((h) => h.alive && h.age >= 13);
      const friend = (a, b) => getRel(a, b) >= 38 || a.partnerId === b.id || isFamily(a, b);
      const deg = new Map();
      for (const h of pool) deg.set(h, pool.reduce((n, o) => n + (o !== h && friend(h, o) ? 1 : 0), 0));
      const sorted = pool.slice().sort((a, b) => deg.get(b) - deg.get(a) || a.id - b.id);
      const taken = new Set(), groups = [];
      for (const seed of sorted) {
        if (taken.has(seed.id) || deg.get(seed) < 2 || groups.length >= 4) continue;
        const mem = [seed];
        for (const o of sorted) {
          if (o === seed || taken.has(o.id) || !friend(seed, o) || mem.some((x) => getRel(x, o) <= -30)) continue;
          mem.push(o);
          if (mem.length >= 6) break;
        }
        if (mem.length >= 3) { for (const x of mem) taken.add(x.id); groups.push(mem); }
      }
      const old = m.cliques, next = [], usedOld = new Set();
      for (const mem of groups) {
        const ids = mem.map((x) => x.id);
        const match = old.find((c) => !usedOld.has(c.id) && c.memberIds.filter((id) => ids.indexOf(id) >= 0).length >= 2);
        if (match) { usedOld.add(match.id); next.push({ id: match.id, name: match.name, color: match.color, memberIds: ids, formedDay: match.formedDay }); continue; }
        const taken2 = old.concat(next).map((c) => c.name);
        const names = CLIQUE_NAMES.filter((n) => taken2.indexOf(n) < 0);
        const id = ++m.nextClique;
        const c = { id, name: names.length ? pick(m, names) : 'Crew #' + id, color: CLIQUE_COLORS[(id - 1) % CLIQUE_COLORS.length], memberIds: ids, formedDay: m.day };
        next.push(c);
        m.stats.cliques++;
        if (m.t > 0) ev(m, `A new clique has formed: "${c.name}" — ${mem.map(first).join(', ')} now eat together, vote together, and fight together.`, 'info');
      }
      for (const c of old) if (!usedOld.has(c.id) && m.t > 0) ev(m, `"${c.name}" has fallen apart — too many losses and too much bad blood to hold the clique together.`, 'info');
      m.cliques = next;
      for (const h of m.humans) h.cliqueId = 0;
      const map = {};
      for (const h of m.humans) map[h.id] = h;
      for (const c of next) for (const id of c.memberIds) map[id].cliqueId = c.id;
    }
    /** Clique-mates back each other in a brawl. Returns a sentence to append to the fight's event text. */
    function cliqueBackup(m, a, b) {
      const c = cliqueOf(m, a);
      if (!c || b.cliqueId === c.id || rng(m) > 0.6) return '';
      const mate = m.humans.find((x) => x.alive && x.cliqueId === c.id && x !== a && x !== b && x.where === a.where && x.age >= 16);
      if (!mate) return '';
      addRel(m, mate, b, -12);
      b.hp = Math.max(12, b.hp - 3);
      setBubble(mate, '👊', 5, 'Not my people!');
      m.stats.cliqueBackups++;
      return ` ${first(mate)} of "${c.name}" jumped in to back ${first(a)}.`;
    }
    /** A clique votes as a bloc at a trial: it can spring one of its own, or make a sentence stick on an outsider. */
    function cliqueVote(m, acc) {
      const voters = m.humans.filter((h) => h.alive && h.where === 'base' && h.age >= 16).length || 1;
      const own = cliqueOf(m, acc);
      if (own) {
        const n = own.memberIds.filter((id) => m.byId[id] && m.byId[id].alive).length;
        if (n >= 3 && rng(m) < Math.min(0.75, (n / voters) * 1.8)) {
          acc.dramaCount = 2; m.stats.blocVotes++;
          for (const h of m.humans) if (h.alive && h.cliqueId !== own.id) bump(h, 'resentment', 4);
          setBubble(acc, '😏', 5.5, 'My people got me.');
          ev(m, `Courtyard Trial: the camp tried to send ${acc.name} to the Brig, but "${own.name}" voted as a bloc and got the whole thing thrown out. Outsiders are fuming.`, 'bad');
          return 'acquit';
        }
        return '';
      }
      let worst = null, ws = -12;
      for (const c of m.cliques) {
        const mem = c.memberIds.map((id) => m.byId[id]).filter((x) => x && x.alive);
        if (mem.length < 3) continue;
        const avg = mem.reduce((s, x) => s + getRel(x, acc), 0) / mem.length;
        if (avg < ws) { ws = avg; worst = c; }
      }
      if (worst) { m.stats.blocVotes++; return ` "${worst.name}" voted as a bloc to make it stick.`; }
      return '';
    }
    function cliquePolitics(m) {
      if (!m.cliques.length || rng(m) > 0.4) return;
      const live = (c) => c.memberIds.map((id) => m.byId[id]).filter((x) => x && x.alive && x.where === 'base');
      if (m.cliques.length >= 2 && rng(m) < 0.35) {
        const a = pick(m, m.cliques), b = pick(m, m.cliques.filter((c) => c !== a));
        const A = live(a), B = live(b);
        if (A.length >= 2 && B.length >= 2) {
          for (let i = 0; i < 2; i++) addRel(m, A[i], B[i], -9);
          setBubble(A[0], '😒', 5, 'Stay on your side.'); setBubble(B[0], '🙄', 5, 'Gladly.');
          m.stats.conflicts = (m.stats.conflicts || 0) + 1;
          ev(m, `Clique war: "${a.name}" and "${b.name}" are no longer speaking — meals are now eaten on opposite sides of the yard.`, 'bad');
          return;
        }
      }
      const c = pick(m, m.cliques), mem = live(c);
      if (mem.length < 2) return;
      let out = null, os = 1e9;
      for (const h of m.humans) {
        if (!h.alive || h.where !== 'base' || h.age < 13 || h.cliqueId === c.id) continue;
        const s = mem.reduce((t, x) => t + getRel(x, h), 0) / mem.length - (h.joinedDay > 1 ? 15 : 0) - (h.cliqueId ? 0 : 10);
        if (s < os) { os = s; out = h; }
      }
      if (!out) return;
      for (const x of mem.slice(0, 3)) addRel(m, x, out, -6);
      out.sanity = clamp(out.sanity - 6, 5, 100); bump(out, 'resentment', 10); bump(out, 'hope', -5);
      setBubble(mem[0], '🧊', 5, 'Seat is taken.'); setBubble(out, '😔', 5, '...okay then.');
      m.stats.freezeOuts++;
      ev(m, `Frozen out: "${c.name}" closed ranks on ${out.name} — no seat at the fire, and somehow all the worst chores got "reassigned" to ${first(out)}.`, 'bad');
    }

    // ---- 9. Generator, fuel & blackouts
    function panicInTheDark(m, amt) {
      for (const h of m.humans) if (h.alive && h.where === 'base') { bump(h, 'fear', amt); bump(h, 'hope', -5); }
      updateMorale(m);
    }
    function blackout(m, why) {
      m.power = false; m.stats.blackouts++;
      panicInTheDark(m, 14);
      fx(m, { type: 'blackout', x: m.L.generator.x, z: m.L.generator.z });
      ev(m, `BLACKOUT! ${why} — the floodlights and auto-turrets are dead, the yard is pitch black, and panic is spreading.`, 'bad');
    }
    function updatePower(m) {
      if (m.phase !== 'night') { m.power = m.fuel > 0; return; }
      if (m.fuel > 0) {
        if (!m.power) { m.power = true; ev(m, 'The generator roars back to life — floodlights and turrets are online again.', 'good'); }
        m.fuel = Math.max(0, m.fuel - BAL.fuelBurn * DT);
        if (m.fuel <= 0) blackout(m, 'The generator coughed, sputtered, and ran dry');
      } else m.power = false;
    }

    // ---- 10. Camp guard dog
    function makeDog(m) {
      return { name: pick(m, DOG_NAMES), alive: true, x: 3, z: 13, yaw: 0, mv: 0, hp: 60, maxHp: 60, wt: 0, tx: 3, tz: 13, buddyId: 0, bubble: '', bubbleT: 0, barkNight: 0, barkT: 0, sniffT: 6 };
    }
    function dogSay(d, text, t) { d.bubble = text; d.bubbleT = t || 4; }
    function dogDies(m, how) {
      const d = m.dog;
      d.alive = false; d.hp = 0; d.diedDay = m.day;
      m.grief += 1.5; m.stats.dogLost = 1;
      for (const h of m.humans) if (h.alive) { h.sanity = clamp(h.sanity - 8, 5, 100); bump(h, 'hope', -10); bump(h, 'anger', 8); }
      const buddy = m.byId[d.buddyId];
      if (buddy && buddy.alive) { buddy.trauma++; buddy.sanity = clamp(buddy.sanity - 12, 5, 100); setBubble(buddy, '😭', 6.5, `${d.name}!! NO!!`); }
      fx(m, { type: 'hdeath', x: d.x, z: d.z });
      ev(m, `${d.name}, the camp's guard dog, ${how}. The whole compound is gutted${buddy && buddy.alive ? ` — ${buddy.name} won't leave the spot` : ''}.`, 'death');
      updateMorale(m);
    }
    function updateDog(m) {
      const d = m.dog;
      if (!d || !d.alive) return;
      const L = m.L, night = m.phase === 'night';
      if (d.bubbleT > 0) { d.bubbleT -= DT; if (d.bubbleT <= 0) d.bubble = ''; }
      if (d.barkT > 0) d.barkT -= DT;
      let buddy = m.byId[d.buddyId];
      if (m.tick % 100 === 0 && (!buddy || !buddy.alive || buddy.where !== 'base')) {
        buddy = null;
        for (const h of m.humans) if (h.alive && h.where === 'base' && h.age >= 5 && (!buddy || h.emotions.empathy > buddy.emotions.empathy)) buddy = h;
        d.buddyId = buddy ? buddy.id : 0;
      }
      const zn = m.zInside > 0 ? nearestZ(m, d.x, d.z, 10, (z) => inBase(z.x, z.z)) : null;
      let speed = 2.2;
      if (zn) {
        const dz = hyp(zn.x - d.x, zn.z - d.z);
        let biters = 0;
        for (const z of m.zombies) if (z.alive && Math.abs(z.x - d.x) < 1.8 && Math.abs(z.z - d.z) < 1.8) biters++;
        if (biters) { d.hp -= 18 * biters * DT; if (m.tick % 10 === 0) fx(m, { type: 'bite', x: d.x, z: d.z }); if (d.hp <= 0) { dogDies(m, `was killed by a ${ZTYPES[zn.type].name.toLowerCase()} while defending the yard`); return; } }
        if (d.hp > d.maxHp * 0.3 && !d.fleeing) {   // goes for the intruder's ankles until it gets hurt
          d.tx = zn.x; d.tz = zn.z; speed = 5.0;
          if (dz < 1.7) hurtZombie(m, zn, 9 * DT, null);
        } else {
          d.fleeing = d.hp < d.maxHp * 0.8;
          d.tx = clamp(d.x + (d.x - zn.x) / (dz || 1) * 6, -BASE + 2, BASE - 2); d.tz = clamp(d.z + (d.z - zn.z) / (dz || 1) * 6, -BASE + 2, BASE - 2);
          speed = 5.6;
        }
        if (d.barkT <= 0) { d.barkT = 4; dogSay(d, '🐕 GRRRR!! WOOF!', 3); }
      } else {
        d.wt -= DT;
        if (d.wt <= 0) {
          d.wt = R(m, 2, 5);
          if (night) { d.tx = R(m, -9, 9); d.tz = R(m, BASE - 9, BASE - 3); }
          else if (buddy && buddy.alive && buddy.where === 'base') { d.tx = clamp(buddy.x + R(m, -2, 2), -BASE + 2, BASE - 2); d.tz = clamp(buddy.z + R(m, -2, 2), -BASE + 2, BASE - 2); }
          else { d.tx = R(m, -12, 12); d.tz = R(m, 2, 17); }
        }
        if (d.hp < d.maxHp) d.hp = Math.min(d.maxHp, d.hp + 0.4 * DT);
      }
      const dx = d.tx - d.x, dzz = d.tz - d.z, dist = hyp(dx, dzz);
      if (dist > 0.5) {
        const st = Math.min(dist, speed * DT);
        d.x += dx / dist * st; d.z += dzz / dist * st; d.yaw = Math.atan2(dx, dzz); d.mv = 1;
        pushOutBox(d, L.bunker.x, L.bunker.z, L.bunker.w / 2 + 0.5, L.bunker.d / 2 + 0.5);
        d.x = clamp(d.x, -BASE + 1.2, BASE - 1.2); d.z = clamp(d.z, -BASE + 1.2, BASE - 1.2);
      } else d.mv = 0;

      // Early warning: the dog hears the horde before the watch can see it
      if (night && d.barkNight !== m.day && m.clock > 1.5 && m.tick % 10 === 0) {
        let nearN = 0, sx = 0, sz = 0;
        for (const z of m.zombies) if (z.alive && z.wave && Math.max(Math.abs(z.x), Math.abs(z.z)) < BASE + 34) { nearN++; sx += z.x; sz += z.z; }
        if (nearN >= 3) {
          d.barkNight = m.day; m.dogAlertT = 30; m.stats.dogWarnings++;
          const side = Math.abs(sx) > Math.abs(sz) ? (sx > 0 ? 'east' : 'west') : (sz > 0 ? 'south' : 'north');
          dogSay(d, '🐕 WOOF! WOOF! WOOF!', 5);
          for (const h of m.humans) if (h.alive && h.where === 'base') bump(h, 'fear', -4);
          ev(m, `${d.name} is barking at the ${side} fence line — the horde is close. The defenders are braced and aiming early.`, 'info');
        }
      }
      // Sniffing out a concealed bite
      d.sniffT -= DT;
      if (d.sniffT <= 0) {
        d.sniffT = 5;
        const hidden = m.humans.find((h) => h.alive && h.where === 'base' && h.concealed && h.infected > 0 && hyp(h.x - d.x, h.z - d.z) < 14);
        if (hidden && rng(m) < 0.35) {
          hidden.concealed = false; hidden.brigT = 30; m.stats.dogSaves++;
          dogSay(d, '🐕 GRRRRRR...', 5);
          setBubble(hidden, '😰', 6, 'Get the dog off me!');
          assignPosts(m);
          ev(m, `${d.name} would not stop growling at ${hidden.name}'s sleeve — the medics pulled it back and found a hidden bite. ${first(hidden)} was rushed into quarantine.`, 'bad');
        }
      }
    }

    // ---- 11. Seasons that bite: hypothermia, coats, heat exhaustion
    function updateClimate(m) {
      const snow = m.weather === 'snow', cold = snow || m.season === 'Winter', heat = m.weather === 'heatwave';
      m.cold = cold;
      const key = m.day + m.phase;
      if (cold) {
        if (m.firewood > 0) { m.firewood = Math.max(0, m.firewood - BAL.woodBurn); m.freezing = false; }
        else {
          m.freezing = true;
          if (m.freezeKey !== key) { m.freezeKey = key; m.stats.coldSnaps++; ev(m, `HYPOTHERMIA: the firewood is gone and the ${snow ? 'snow keeps falling' : 'winter cold is biting'} — survivors are shivering through the ${m.phase}, losing health by the hour.`, 'bad'); }
        }
      } else m.freezing = false;
      const squad = m.humans.filter((h) => h.alive && h.where === 'squad' && !h.escort);
      let coats = m.coats;
      for (const h of m.humans) {
        if (!h.alive) continue;
        if (h.where === 'squad') h.cold = snow && !(h.escort ? false : coats-- > 0);
        else h.cold = m.freezing;
        if (h.cold) {
          const frail = h.age < 12 || h.age > 60 || has(h, 'frail');
          h.hp = Math.max(8, h.hp - (h.where === 'squad' ? 0.35 : frail ? 0.9 : 0.5));
          h.fatigue = clamp(h.fatigue + 1.2, 0, 100);
        }
        if (h.sickT > 0) { h.hp = Math.max(10, h.hp - 0.4); h.fatigue = clamp(h.fatigue + 0.8, 0, 100); }
      }
      if (snow && squad.length > m.coats && m.squad && !m.squad.coldNoted) {
        m.squad.coldNoted = true;
        ev(m, `${squad.length - m.coats} scavenger${squad.length - m.coats > 1 ? 's' : ''} left without a winter coat — the expedition is trudging through the snow at a crawl.`, 'bad');
      }
      if (heat && m.phase === 'day') {
        if (m.water < 5) {
          for (const h of m.humans) if (h.alive) h.hp = Math.max(8, h.hp - 0.6);
          if (m.thirstKey !== key) { m.thirstKey = key; ev(m, 'DEHYDRATION: the water barrels are empty in the middle of a heatwave — everyone is fading fast.', 'bad'); }
        }
        for (const h of m.humans) {
          if (!h.alive || h.heatT > 0 || h.age < 12) continue;
          const working = h.where === 'squad' ? !h.escort : (h.post && (h.post.type === 'repair' || h.post.type === 'wall' || h.post.type === 'haul'));
          if (!working || h.fatigue < 55 || rng(m) > 0.02) continue;
          h.heatT = 28; h.hp = Math.max(10, h.hp - 8); h.fatigue = clamp(h.fatigue + 10, 0, 100);
          m.stats.heatCases++;
          setBubble(h, '🥵', 5.5, 'I need... water...');
          ev(m, `Heat exhaustion: ${h.name} collapsed in the heatwave ${h.where === 'squad' ? 'out on the expedition' : 'while working the yard'}.`, 'bad');
        }
      }
    }

    // ---- 12. Emergency amputation
    function tryAmputation(m, h, med) {
      if (h.concealed || h.ampTried || (h.biteSite !== 'arm' && h.biteSite !== 'leg')) return false;
      let doc = null;
      for (const o of m.humans) if (o.alive && o.where === 'base' && o !== h && o.age >= 16 && o.med >= 30 && (!doc || o.med > doc.med)) doc = o;
      if (!doc) return false;
      h.ampTried = true; m.stats.amputations++;
      const site = h.biteSite, p = clamp(0.38 + 0.005 * doc.med, 0.4, 0.86);
      setBubble(doc, '🪚', 6, 'Hold them down. NOW.');
      const maim = () => {
        if (!has(h, site)) { h.handicaps.push(site); h.injuries++; m.stats.injuries++; }
        h.amputated = site;
        const mh = maxHpOf(h); h.maxHp = mh; h.hp = Math.max(10, Math.min(mh, h.hp * 0.55));
        if (site === 'arm' && WEAPONS[h.weapon].twoHand) { m.armory.push(h.weapon); h.weapon = 'fists'; }
      };
      if (rng(m) < p) {
        maim();
        h.infected = 0; m.stats.cured++; m.stats.ampSaved++;
        bump(h, 'fear', -10); bump(h, 'hope', 10); h.trauma++;
        addRel(m, h, doc, 20);
        setBubble(h, '😖', 6, 'It worked... it worked.');
        ev(m, `EMERGENCY AMPUTATION: with no antivirals left, ${doc.name} took ${h.name}'s bitten ${site} off with a hacksaw — and it worked. ${first(h)} is alive, infection-free, and missing ${site === 'arm' ? 'an arm' : 'a leg'}.`, 'good');
      } else if (rng(m) < 0.6) {
        bump(doc, 'hope', -15); doc.trauma++; doc.sanity = clamp(doc.sanity - 10, 5, 100);
        ev(m, `EMERGENCY AMPUTATION: ${doc.name} gambled on taking ${h.name}'s bitten ${site} — and lost. ${first(h)} bled out on the infirmary table.`, 'bad');
        killHuman(m, h, 'died on the table during an emergency amputation');
      } else {
        maim();
        bump(h, 'fear', 20); bump(h, 'resentment', 15);
        ev(m, `EMERGENCY AMPUTATION: ${doc.name} took ${h.name}'s bitten ${site}, but too late — the infection had already spread. ${first(h)} lost the ${site} for nothing.`, 'bad');
      }
      return true;
    }

    // ---- 13. Radio dish & distress calls
    function radioIntercept(m) {
      if (!m.radio.built || m.distress || rng(m) > 0.55) return;
      const opts = m.L.buildings.filter((b) => { const d = hyp(b.doorX, b.doorZ - BASE); return d > 28 && d < 62; });
      if (!opts.length) return;
      const b = pick(m, opts), trap = rng(m) < 0.3;
      const dir = Math.abs(b.x) > Math.abs(b.z) ? (b.x > 0 ? 'east' : 'west') : (b.z > 0 ? 'south' : 'north');
      const ldr = m.byId[m.leaderId];
      m.stats.distressCalls++;
      const call = pick(m, ['"…anyone… we have kids here… please…"', '"…three of us, out of food, second floor…"', '"…if you can hear this, we have medicine to trade…"', '"…they are at the door… hurry…"']);
      if (ldr && ldr.alive && (ldr.personality === 'paranoid' || ldr.emotions.paranoia > 75) && rng(m) < 0.5) {
        m.stats.distressIgnored++;
        ev(m, `Radio intercept: a broken distress call from a ${b.name} to the ${dir} — ${call} Camp Leader ${ldr.name} called it bait and ordered the radio switched off.`, 'bad');
        return;
      }
      m.distress = { bid: b.id, trap, day: m.day, dir, name: b.name };
      ev(m, `Radio intercept: a broken distress call from a ${b.name} to the ${dir} — ${call} Today's expedition will check it out.`, 'phase');
    }
    function resolveDistress(m, sq, b, team) {
      const ds = m.distress;
      m.distress = null;
      if (ds.trap) {
        m.stats.radioTraps++;
        const n = 6 + Math.floor(rng(m) * 4), fighters = team.filter((h) => !h.escort);
        for (let i = 0; i < n; i++) {
          const a = rng(m) * 6.283, r = R(m, 9, 14);
          const z = makeZombie(m, clamp(b.doorX + Math.sin(a) * r, -MAP + 4, MAP - 4), clamp(b.doorZ + Math.cos(a) * r, -MAP + 4, MAP - 4), null);
          enforceSolidEnvironment(m, z, false, true);
          z.mode = 'hunt'; z.tgt = fighters.length ? pick(m, fighters).id : 0;
          m.zombies.push(z);
        }
        count(m);
        for (const h of team) bump(h, 'fear', 15);
        if (fighters[0]) setBubble(fighters[0], '😱', 5.5, 'IT IS A TRAP!!');
        ev(m, `IT WAS A TRAP! The "distress call" at the ${b.name} was a looped recording wired to a siren — ${n} zombies came pouring out of the alleys onto the expedition.`, 'bad');
        return;
      }
      m.stats.radioRescues++;
      let took = 0;
      const n = 2 + Math.floor(rng(m) * 2);
      for (let i = 0; i < n; i++) {
        const h = makeHuman(m, false);
        h.hp = Math.round(h.maxHp * R(m, 0.5, 0.9));
        if (!accepts(m, h)) { m.stats.leftBehind++; m.nextId--; continue; }
        h.where = 'squad'; h.escort = true; h.x = b.doorX + R(m, -1.5, 1.5); h.z = b.doorZ + R(m, -1.5, 1.5);
        enforceSolidEnvironment(m, h, false, false);
        m.humans.push(h); took++; m.stats.rescued++; sq.found++;
      }
      const lo = sq.loot, av = rng(m) < 0.5 ? 1 : 0;
      lo.ammo += 18; lo.medkits += 1; lo.antivirals += av; lo.fuel += 5;
      count(m);
      ev(m, `Distress call answered: the expedition pulled ${took} survivor${took === 1 ? '' : 's'} out of the ${b.name}, and the grateful holdouts handed over 18 ammo, a medkit, 5 fuel${av ? ' and an antiviral' : ''}.`, 'good');
    }

    // ---- 14. Corpse disposal & disease
    function noteBody(m, z) {
      if (m.bodies.length >= 45) return;
      if (inBase(z.x, z.z)) m.bodies.push({ x: z.x, z: z.z, by: 0 });
      else if (Math.max(Math.abs(z.x), Math.abs(z.z)) < BASE + 2.6 && rng(m) < 0.35) {
        m.bodies.push({ x: clamp(z.x, -BASE + 1.4, BASE - 1.4), z: clamp(z.z, -BASE + 1.4, BASE - 1.4), by: 0 });   // slumped through / over the wall
      }
    }
    function haulStep(m, h) {
      if (!m.bodies.length || m.phase === 'night' || m.zInside > 0) {
        h.post = { type: 'yard', x: clamp(h.x, -14, 14), z: clamp(h.z, 0, 17) }; h.duty = h.post; h.haulT = 0;
        return;
      }
      let b = null, bd = 1e9;
      for (const c of m.bodies) {
        if (c.by && c.by !== h.id && m.byId[c.by] && m.byId[c.by].alive && m.byId[c.by].post.type === 'haul') continue;
        const d = hyp(c.x - h.x, c.z - h.z);
        if (d < bd) { bd = d; b = c; }
      }
      if (!b) { b = m.bodies[0]; bd = hyp(b.x - h.x, b.z - h.z); }
      b.by = h.id; h.post.x = b.x; h.post.z = b.z;
      if (bd < 1.6) {
        h.haulT = (h.haulT || 0) + DT; h.lastAtk = m.t;
        if (h.haulT >= 1.6) {
          h.haulT = 0;
          m.bodies.splice(m.bodies.indexOf(b), 1);
          m.stats.bodiesBurned++; m.burnT = 8;
          h.fatigue = clamp(h.fatigue + 2, 0, 100);
          fx(m, { type: 'burn', x: m.L.burnPit.x, z: m.L.burnPit.z });
          if (!m.bodies.length) ev(m, `The cleanup crew hauled the last corpse out to the burn pit. The yard is clear and the air is breathable again.`, 'good');
        }
      }
    }
    function updateDisease(m) {
      const n = m.bodies.length;
      if (n < 5) return;
      const inside = m.humans.filter((h) => h.alive && h.where === 'base');
      for (const h of inside) h.sanity = clamp(h.sanity - Math.min(3, n * 0.12), 5, 100);
      const key = m.day + m.phase;
      if (n >= 8 && m.stenchKey !== key) {
        m.stenchKey = key;
        ev(m, `The stench is unbearable: ${n} rotting corpses are piled inside the walls. Nerves are fraying and flies are everywhere.`, 'bad');
      }
      const well = inside.filter((h) => !(h.sickT > 0));
      if (well.length && rng(m) < Math.min(0.6, (n - 4) * 0.05)) {
        const h = pick(m, well);
        h.sickT = 45; m.stats.sickened++;
        setBubble(h, '🤢', 5.5, 'I do not feel right...');
        if (m.sickKey !== key) { m.sickKey = key; ev(m, `Sickness is spreading from the unburied dead: ${h.name} is feverish and vomiting. The corpses have to go.`, 'bad'); }
      }
    }

    /** Per-step driver for the Season Two systems. */
    function updateSeasonTwo(m) {
      updatePower(m);
      updateDog(m);
      if (m.dogAlertT > 0) m.dogAlertT -= DT;
      if (m.burnT > 0) m.burnT -= DT;
      for (const h of m.humans) {
        if (!h.alive) continue;
        if (h.heatT > 0) h.heatT -= DT;
        if (h.sickT > 0) h.sickT -= DT;
        if (h.insomniaT > 0) h.insomniaT -= DT;
      }
      if (m.tick % 40 === 0) updateClimate(m);
      if (m.tick % 160 === 0) updateCrushes(m);
      if (m.tick % 200 === 0) updateDisease(m);
      if (m.tick % 260 === 0) cliquePolitics(m);
      if (m.tick % 100 === 0 && m.phase === 'day' && m.bodies.length && !m.zInside && !m.zSiege && !m.humans.some((h) => h.alive && h.where === 'base' && h.post.type === 'haul')) assignPosts(m);
      if (m.phase === 'night' && !m.bunkDramaDone && m.clock >= 40) { m.bunkDramaDone = true; bunkDrama(m); }
    }
    function godBlackout(m) {
      m.fuel = 0;
      ev(m, '[God Mode] Somebody "forgot" to refuel the generator. The tank is bone dry.', 'bad');
      if (m.phase === 'night' && m.power) blackout(m, 'The generator ran dry');
    }
    function godFuel(m) {
      m.fuel += 20; m.firewood += 10;
      ev(m, '[God Mode] A fuel drum and a cord of firewood appeared by the generator (+20 fuel, +10 firewood).', 'good');
    }

    // God-Mode / Ant-Farm Poke Helpers
    function godDropCrate(m, x, z) {
      m.crates.push({ id: m.nextId++, x: clamp(x, -MAP + 5, MAP - 5), z: clamp(z, -MAP + 5, MAP - 5) });
      ev(m, `[God Mode] Dropped an emergency supply crate onto the map.`, 'good');
    }
    function godLightning(m, x, z) {
      fx(m, { type: 'breach', x, z });
      let hit = 0;
      for (const zed of m.zombies) {
        if (zed.alive && hyp(zed.x - x, zed.z - z) < 10) { zed.ragdollT = 1.8; hurtZombie(m, zed, 220, null); hit++; }
      }
      ev(m, `[God Mode] Lightning strike! Zapped ${hit} zombie${hit === 1 ? '' : 's'} near (${Math.round(x)}, ${Math.round(z)}).`, 'good');
    }
    function godSpawnHorde(m, x, z) {
      for (let i = 0; i < 8; i++) {
        const zed = makeZombie(m, clamp(x + R(m, -4, 4), -MAP + 4, MAP - 4), clamp(z + R(m, -4, 4), -MAP + 4, MAP - 4), null);
        zed.mode = 'siege'; zed.wave = true;
        m.zombies.push(zed);
      }
      count(m);
      ev(m, `[God Mode] Spawned an 8-zombie ambush pack!`, 'bad');
    }
    function godMatchmake(m) {
      const singles = m.humans.filter((h) => h.alive && !h.partnerId && h.age >= ADULT);
      let a = null, b = null;
      for (let i = 0; i < singles.length && !a; i++) for (let j = i + 1; j < singles.length; j++) if (canDate(singles[i], singles[j])) { a = singles[i]; b = singles[j]; break; }
      if (!a) return;
      coupleUp(m, a, b, 85);
      setBubble(a, '❤️', 6, 'Soulmates!'); setBubble(b, '❤️', 6, '❤️');
      ev(m, `[God Mode] Cupid struck ${a.name} and ${b.name} — instant romance!`, 'good');
    }
    function godBeef(m) {
      const adults = m.humans.filter((h) => h.alive && h.age >= 15);
      if (adults.length < 2) return;
      const a = adults[0], b = adults[adults.length - 1];
      a.rels[b.id] = b.rels[a.id] = -85;
      a.emotions.anger = 92; b.emotions.anger = 92;
      refreshSocialBonds(a); refreshSocialBonds(b);
      setBubble(a, '💢', 6, 'On sight!!'); setBubble(b, '🥊', 6, 'Pull up!!');
      m.stats.conflicts++;
      ev(m, `[God Mode] Sparked instant beef between ${a.name} and ${b.name}!`, 'bad');
    }

    // ------------------------------------------------------------------ main step
    function step(m) {
      if (m.over) return m;
      m.t += DT; m.clock += DT; m.tick++;
      if (m.confessional) { m.confessional.t -= DT; if (m.confessional.t <= 0) m.confessional = null; }
      if (!m.byId || m.byIdN !== m.humans.length + m.zombies.length) {
        m.byId = {};
        for (const h of m.humans) m.byId[h.id] = h;
        for (const z of m.zombies) m.byId[z.id] = z;
        m.byIdN = m.humans.length + m.zombies.length;
      }
      if (m.phase === 'day') {
        if (m.clock >= PHASE) startNight(m);
        else if (!m.expDone && !m.squad && m.clock >= m.expT) {
          if (m.zInside > 0 || m.zSiege > 2) { m.expT = m.clock + 2; if (m.clock > PHASE * 0.45) { m.expDone = true; ev(m, 'Zombies are still at the walls; no expedition today.', 'info'); } }
          else planExpedition(m);
        }
      } else {
        if (m.wave && !m.wave.done && m.clock > 2 && m.tick % 10 === 0) {
          let left = 0;
          for (const z of m.zombies) if (z.alive && z.wave) left++;
          if (!left) { m.wave.done = true; ev(m, 'The last zombie of the night horde falls. The compound holds!', 'good'); if (m.clock < PHASE - 4) m.clock = PHASE - 4; }
        }
        if (m.clock >= PHASE) startDay(m);
        if (m.tick % 60 === 0) assignPosts(m);
      }
      // Interpersonal & emotional events fire periodically
      m.socialT -= DT;
      if (m.socialT <= 0) {
        m.socialT = R(m, 3.5, 7.0);
        triggerSocialEvent(m);
      }
      updateSquad(m);
      updateBaseHumans(m);
      for (const h of m.humans) if (h.alive && h.where === 'squad' && h.infected > 0) { h.infected -= DT; if (h.infected <= 0) killHuman(m, h, 'succumbed to the infection and turned'); }
      updateZombies(m);
      updateAntFarmSystems(m);
      updateSeasonTwo(m);
      if (m.tick % 2 === 0) resolveCrowding(m);
      updateCorpses(m);
      m.histT -= DT;
      if (m.histT <= 0) {
        m.histT = 2;
        let s = 0, n = 0;
        for (const h of m.humans) if (h.alive) { s += survivability(h); n++; }
        m.hist.push({ t: m.t, day: m.day, night: m.phase === 'night', h: m.hAlive, z: m.zAlive, s: n ? s / n : 0 });
      }
      if (m.hAlive <= 0) { m.over = true; m.winner = 'zombies'; m.reason = `The last survivor fell on ${m.phase} ${m.day}. ${m.zAlive} zombies remain.`; ev(m, m.reason, 'phase'); }
      else if (m.zAlive <= 0 && !m.corpses.length) { m.over = true; m.winner = 'humans'; m.reason = `The last zombie was destroyed on ${m.phase} ${m.day}. ${m.hAlive} survivors live.`; ev(m, m.reason, 'phase'); }
      else if (m.day > 120) { m.over = true; m.winner = 'draw'; m.reason = 'Neither side could finish the other after 120 days.'; }
      return m;
    }

    /** Runs a whole game without rendering and returns a summary. */
    function run(opts, maxSteps) {
      const m = create(opts);
      let n = 0;
      const cap = maxSteps || 20 * 60 * 2 * 125;
      while (!m.over && n++ < cap) step(m);
      return m;
    }

    return { create, step, run, survivability, speedOf, maxHpOf, combatFactor, dominantEmotion, getRel, inBase, godDropCrate, godLightning, godSpawnHorde, godMatchmake, godBeef, godBlackout, godFuel, canDate, isFamily, cliqueOf, bunkmateOf, ADULT, WEAPONS, ZTYPES, HANDICAPS, EMOTIONS, PERSONALITIES, BAL, DT, PHASE, BASE, SEG, CELL, MAP };
  })();

  if (typeof module === 'object' && module.exports) module.exports = Sim;
  root.OBSim = Sim;
})(typeof self !== 'undefined' ? self : this);
