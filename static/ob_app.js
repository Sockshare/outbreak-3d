/**
 * Outbreak 3D — app controller: setup screen, main loop, HUD, roster, bio card, event feed, charts, camera controls.
 * The simulation itself (ob_sim.js) is fully autonomous; nothing here changes its decisions.
 */
(function () {
  'use strict';
  const Sim = window.OBSim;
  const $ = (id) => document.getElementById(id);
  const gl = $('gl'), overlay = $('overlay'), g2 = overlay.getContext('2d');
  const world = window.OBWorld.create(window.THREE, Sim, gl);
  const PACE = { blitz: 2, standard: 1, cinematic: 0.5, default_quick: 1 };
  const FORCE_HIGH = /quality=high/.test(location.search);   // add ?quality=high to the address to keep full graphics on a slow machine
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  const app = { m: null, running: false, speed: 1, pace: 'standard', acc: 0, bars: true, lastOpts: null, uiT: 0, rosterT: 0, feedN: -1, chartN: -1, bioKey: '', ended: false };

  // ------------------------------------------------------------------ setup screen
  const sliders = [['humans', ''], ['zombies', ''], ['child', '%'], ['elder', '%'], ['handicap', '%'], ['aggr', '%']];
  for (const [k, unit] of sliders) {
    const el = $('s-' + k);
    el.addEventListener('input', () => { $('v-' + k).textContent = el.value + unit; });
  }
  function applyPreset(p) {
    app.pace = p;
    document.querySelectorAll('.pace').forEach((x) => x.classList.toggle('on', x.dataset.pace === p));
    if (p === 'default_quick') {
      const defs = { humans: 15, zombies: 300, child: 8, elder: 12, handicap: 15, aggr: 100 };
      for (const [k, unit] of sliders) { $('s-' + k).value = defs[k]; $('v-' + k).textContent = defs[k] + unit; }
      $('s-policy').value = 'everyone'; $('s-seed').value = '';
    }
  }
  document.querySelectorAll('.pace').forEach((b) => {
    const fn = (e) => { e.preventDefault(); applyPreset(b.dataset.pace); };
    b.addEventListener('pointerdown', fn);
    b.addEventListener('click', fn);
  });
  function readOpts() {
    const seedTxt = $('s-seed').value.trim();
    return {
      humans: +$('s-humans').value, zombies: +$('s-zombies').value,
      childRate: +$('s-child').value / 100, elderRate: +$('s-elder').value / 100, handicapRate: +$('s-handicap').value / 100,
      aggression: +$('s-aggr').value / 100, policy: $('s-policy').value,
      seed: seedTxt && !isNaN(parseInt(seedTxt, 10)) ? parseInt(seedTxt, 10) : (Math.random() * 2147483646 + 1) | 0,
    };
  }
  function startGame(opts) {
    app.lastOpts = opts;
    app.m = Sim.create(opts);
    world.buildWorld(app.m);
    world.view.selected = 0; world.view.follow = 0; world.view.director = true;
    world.cam.zoomMul = 1;
    $('btn-director').classList.add('on');
    app.running = true; app.ended = false; app.acc = 0; app.feedN = -1; app.chartN = -1; app.bioKey = '';
    $('feed').innerHTML = ''; rowEls.clear(); $('roster').innerHTML = '';
    $('setup').classList.add('hidden'); $('end').classList.add('hidden');
    setSpeed(1);
    last = performance.now();
    scheduleNext();
  }
  const onStart = (e) => { e.preventDefault(); startGame(readOpts()); };
  const onQuick = (e) => { e.preventDefault(); app.pace = 'standard'; startGame({ seed: (Math.random() * 2147483646 + 1) | 0 }); };
  $('btn-start').addEventListener('pointerdown', onStart);
  $('btn-start').addEventListener('click', onStart);
  $('btn-quick').addEventListener('pointerdown', onQuick);
  $('btn-quick').addEventListener('click', onQuick);
  $('btn-new').addEventListener('click', () => {
    app.running = false;
    if ($('btn-apply')) $('btn-apply').classList.add('hidden');
    if ($('btn-cancel')) $('btn-cancel').classList.add('hidden');
    $('btn-start').textContent = 'Start simulation';
    $('end').classList.add('hidden'); $('setup').classList.remove('hidden'); renderOnce();
  });
  if ($('btn-options')) $('btn-options').addEventListener('click', () => {
    if (app.m && app.running) {
      app.prevSpeed = app.speed;
      setSpeed(0);
      $('btn-apply').classList.remove('hidden');
      $('btn-cancel').classList.remove('hidden');
      $('btn-start').textContent = 'Restart simulation';
    } else {
      $('btn-apply').classList.add('hidden');
      $('btn-cancel').classList.add('hidden');
      $('btn-start').textContent = 'Start simulation';
    }
    $('setup').classList.remove('hidden');
  });
  if ($('btn-apply')) $('btn-apply').addEventListener('click', () => {
    if (app.m) {
      const o = readOpts();
      app.m.opts.aggression = o.aggression;
      app.m.opts.policy = o.policy;
      app.m.opts.childRate = o.childRate;
      app.m.opts.elderRate = o.elderRate;
      app.m.opts.handicapRate = o.handicapRate;
    }
    $('setup').classList.add('hidden');
    setSpeed(app.prevSpeed || 1);
    last = performance.now();
    scheduleNext();
  });
  if ($('btn-cancel')) $('btn-cancel').addEventListener('click', () => {
    $('setup').classList.add('hidden');
    setSpeed(app.prevSpeed || 1);
    last = performance.now();
    scheduleNext();
  });
  $('btn-settings').addEventListener('click', () => { app.running = false; $('end').classList.add('hidden'); $('setup').classList.remove('hidden'); renderOnce(); });
  $('btn-again').addEventListener('click', () => startGame(Object.assign({}, app.lastOpts, { seed: (Math.random() * 2147483646 + 1) | 0 })));
  $('btn-view').addEventListener('click', () => $('end').classList.add('hidden'));

  // ------------------------------------------------------------------ top bar controls
  function setSpeed(s) {
    app.speed = s;
    document.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('on', +b.dataset.speed === s));
  }
  document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => setSpeed(+b.dataset.speed)));
  $('btn-director').addEventListener('click', () => { world.view.director = !world.view.director; if (world.view.director) world.view.follow = 0; $('btn-director').classList.toggle('on', world.view.director); app.bioKey = ''; });
  $('btn-bars').addEventListener('click', () => { app.bars = !app.bars; $('btn-bars').classList.toggle('on', app.bars); });
  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); setSpeed(app.speed === 0 ? 1 : 0); }
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));

  // ------------------------------------------------------------------ camera and picking
  let drag = null;
  gl.addEventListener('contextmenu', (e) => e.preventDefault());
  gl.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, moved: 0, pan: e.button === 2 || e.shiftKey }; gl.setPointerCapture(e.pointerId); });
  gl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
    const c = world.cam;
    if (drag.pan) { pan(-dx * 0.0016 * c.dist * c.zoomMul, -dy * 0.0016 * c.dist * c.zoomMul); }
    else { c.az -= dx * 0.006; c.el = Math.min(1.5, Math.max(0.2, c.el + dy * 0.005)); }
    if (!app.running || app.speed === 0) renderOnce();
  });
  gl.addEventListener('pointerup', (e) => {
    if (drag && drag.moved < 5 && app.m) {
      const gt = $('god-tool') ? $('god-tool').value : '';
      if (gt && world.screenToWorld) {
        const pt = world.screenToWorld(e.clientX, e.clientY);
        if (gt === 'crate') Sim.godDropCrate(app.m, pt.x, pt.z);
        else if (gt === 'lightning') Sim.godLightning(app.m, pt.x, pt.z);
        else if (gt === 'horde') Sim.godSpawnHorde(app.m, pt.x, pt.z);
        updateTop(app.m); updateFeed(app.m); renderOnce();
      } else {
        select(world.pick(app.m, e.clientX, e.clientY));
      }
    }
    drag = null;
  });
  gl.addEventListener('wheel', (e) => { e.preventDefault(); world.cam.zoomMul = Math.min(2.6, Math.max(0.16, world.cam.zoomMul * Math.exp(e.deltaY * 0.0012))); }, { passive: false });
  function pan(right, fwd) {
    const c = world.cam;
    c.tx += Math.cos(c.az) * right + Math.sin(c.az) * fwd;
    c.tz += -Math.sin(c.az) * right + Math.cos(c.az) * fwd;
    c.tx = Math.max(-Sim.MAP, Math.min(Sim.MAP, c.tx)); c.tz = Math.max(-Sim.MAP, Math.min(Sim.MAP, c.tz));
    if (world.view.director || world.view.follow) { world.view.director = false; world.view.follow = 0; $('btn-director').classList.remove('on'); app.bioKey = ''; }
  }
  function select(id) {
    world.view.selected = id || 0;
    if (!id) world.view.follow = 0;
    app.bioKey = ''; app.rosterT = 0;
    if (app.m) { updateBio(app.m); updateRoster(app.m); }
    if (!app.running || app.speed === 0) renderOnce();
  }

  // ------------------------------------------------------------------ text helpers
  function roleOf(m, h) {
    if (h.carriedBy) return 'Being carried home';
    if (h.where === 'squad') return h.escort ? 'Rescued — being escorted home' : h.carrying ? 'On expedition, carrying a child' : 'On expedition';
    const p = h.post.type;
    if (h.retreat) return 'Wounded — falling back';
    if (p === 'tower') return 'Sharpshooter on a watchtower';
    if (p === 'wall') return m.phase === 'night' ? 'Holding the wall' : 'Guarding the wall';
    if (p === 'line') return 'On the firing line';
    if (p === 'repair') return 'Repairing the walls';
    if (p === 'bunker') return 'Sheltering in the bunker';
    if (p === 'haul') return 'Hauling corpses to the burn pit';
    if (p === 'brig') return 'Locked in the Brig';
    if (p === 'infirmary') return h.infected > 0 ? 'Being treated for infection' : h.hp < h.maxHp * 0.95 ? 'Recovering in the infirmary' : 'Medic on duty';
    return h.age < 12 ? 'Playing in the yard' : 'In the yard';
  }
  const bar = (label, v) => `<div class="sbar"><span>${label}</span><div class="hpbar"><i style="width:${Math.round(v)}%"></i></div><b>${Math.round(v)}</b></div>`;
  const hpColor = (r) => (r > 0.6 ? '#4cc38a' : r > 0.3 ? '#f2a93b' : '#e5484d');
  const SKIN = ['#f1c9a5', '#e0ac7e', '#c68958', '#9a6540', '#6e452c'], HAIR = ['#1e1712', '#3b2a1a', '#6b4a2a', '#a8842f', '#8a3b1e', '#101010'];
  const SHIRT = ['#b03a3a', '#2f6db0', '#3d8a4f', '#c9a23a', '#7a4aa8', '#d0d4da', '#30343c', '#c9672e', '#3aa3a3', '#8a5a3a'];
  function portrait(cv, e, isZ) {
    const g = cv.getContext('2d');
    g.clearRect(0, 0, 64, 64);
    g.fillStyle = isZ ? '#1c241a' : '#20252d'; g.fillRect(0, 0, 64, 64);
    const skin = isZ ? (e.type === 'feral' ? '#55684f' : '#7f9a78') : SKIN[e.look.skin];
    const child = e.age < 12, r = child ? 15 : 17;
    g.fillStyle = isZ ? '#3a4033' : SHIRT[e.look.shirt]; g.beginPath(); g.ellipse(32, 66, e.type === 'brute' ? 30 : 23, 20, 0, 0, 7); g.fill();
    g.fillStyle = skin; g.beginPath(); g.arc(32, 31, r, 0, 7); g.fill();
    g.fillStyle = !isZ && e.age > 70 ? '#f2f2ee' : !isZ && e.age > 60 ? '#b9bcc0' : HAIR[e.look.hair];
    g.beginPath(); g.arc(32, 28, r + 1, Math.PI, 0); g.lineTo(32 + r + 1, 30); g.quadraticCurveTo(32, 14, 32 - r - 1, 30); g.fill();
    g.fillStyle = isZ ? (e.type === 'feral' ? '#ff5a1f' : '#e8e2c0') : '#1b1b1b';
    g.beginPath(); g.arc(26, 33, 2.1, 0, 7); g.arc(38, 33, 2.1, 0, 7); g.fill();
    g.strokeStyle = isZ ? '#3a1210' : '#5a2f24'; g.lineWidth = 2; g.beginPath();
    if (isZ) { g.moveTo(26, 42); g.lineTo(38, 41); } else g.arc(32, 38, 5, 0.25, Math.PI - 0.25);
    g.stroke();
    if (!isZ && e.handicaps.indexOf('vision') >= 0) { g.fillStyle = '#f4f1e6'; g.fillRect(14, 29, 36, 7); }
    if (!isZ && e.handicaps.indexOf('frail') >= 0) { g.fillStyle = '#9fd0e6'; g.fillRect(24, 38, 16, 8); }
  }

  // ------------------------------------------------------------------ panels
  function updateTop(m) {
    const night = m.phase === 'night', t = m.clock / Sim.PHASE;
    $('phase-name').textContent = (night ? 'NIGHT ' : 'DAY ') + m.day + (night ? ' — horde attacking' : m.squad ? ' — expedition out' : '');
    const hrs = (night ? 18 : 6) + t * 12, hh = Math.floor(hrs) % 24, mm = Math.floor((hrs % 1) * 60);
    $('phase-clock').textContent = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
    $('phase-fill').style.width = (t * 100).toFixed(1) + '%';
    $('phase-fill').style.background = night ? '#6f8cff' : '#f2a93b';
    $('n-h').textContent = m.hAlive; $('n-z').textContent = m.zAlive; $('n-m').textContent = Math.round(m.morale);
    $('s-ammo').textContent = m.ammo; $('s-scrap').textContent = Math.round(m.scrap); $('s-food').textContent = Math.round(m.food || 0); $('s-water').textContent = Math.round(m.water || 0); $('s-med').textContent = Math.floor(m.medkits); $('s-av').textContent = m.antivirals; $('s-tur').textContent = m.turrets;
    const ldr = m.leaderId && m.byId ? m.byId[m.leaderId] : null;
    const WX = { clear: '☀️', rain: '🌧️', fog: '🌫️', heatwave: '🔥', snow: '❄️' };
    if ($('s-wx')) $('s-wx').textContent = `${ldr && ldr.alive ? '👑 ' + ldr.name.split(' ')[0] + ' · ' : ''}${m.season || 'Spring'} · ${WX[m.weather] || ''} ${(m.weather || 'clear').toUpperCase()}${m.truck && m.truck.repaired ? ' · 🚚' : ''}`;
    const res = (id, v, low) => { const el = $(id); if (!el) return; el.textContent = v; el.parentElement.classList.toggle('low', !!low); };
    res('s-fuel', Math.round(m.fuel || 0), (m.fuel || 0) < 6);
    res('s-wood', Math.round(m.firewood || 0), (m.firewood || 0) < 5);
    res('s-food', Math.round(m.food || 0), (m.food || 0) < 10);
    res('s-water', Math.round(m.water || 0), (m.water || 0) < 10);
    res('s-ammo', m.ammo, m.ammo < 20);
    const chip = (id, txt, cls, tip) => { const el = $(id); if (!el) return; el.textContent = txt; el.className = 'chip ' + (cls || ''); if (tip) el.title = tip; };
    const nb = m.bodies ? m.bodies.length : 0;
    chip('c-power', m.power === false ? (night ? '⚡ BLACKOUT' : '⚡ Tank empty') : (m.fuel || 0) < 6 ? '⚡ Fuel low' : '⚡ Power on', m.power === false ? 'bad' : (m.fuel || 0) < 6 ? 'warn' : 'good', 'Generator: runs the floodlights and auto-turrets at night, burning fuel');
    chip('c-climate', m.freezing ? '🥶 Freezing' : m.weather === 'heatwave' ? '🥵 Heatwave' : m.cold ? '🔥 Fires lit' : '🌡 Mild', m.freezing ? 'bad' : m.weather === 'heatwave' || m.cold ? 'warn' : '', `Winter coats in stock: ${m.coats || 0}. Cold weather burns firewood; heatwaves double water use.`);
    chip('c-dog', m.dog ? (m.dog.alive ? '🐕 ' + m.dog.name : '🐕 ' + m.dog.name + ' †') : '🐕 —', m.dog && m.dog.alive ? (m.dogAlertT > 0 ? 'warn' : 'good') : 'bad', 'Camp guard dog: barks early at the horde and sniffs out hidden bites');
    chip('c-radio', m.radio && m.radio.built ? (m.distress ? '📡 Distress call' : '📡 Listening') : '📡 No radio', m.distress ? 'warn' : m.radio && m.radio.built ? 'good' : '', 'Radio dish: intercepts distress calls — rescues, or traps');
    chip('c-bodies', '☠ ' + nb + ' unburied', nb >= 8 ? 'bad' : nb >= 5 ? 'warn' : '', 'Corpses left inside the walls breed sickness and wreck sanity until a crew burns them');
    updateConfessional(m);
    const cnt = {};
    for (const z of m.zombies) if (z.alive) cnt[z.type] = (cnt[z.type] || 0) + 1;
    $('horde').textContent = Object.keys(Sim.ZTYPES).filter((k) => cnt[k]).map((k) => cnt[k] + ' ' + Sim.ZTYPES[k].name.toLowerCase() + (cnt[k] > 1 ? 's' : '')).join(' · ');
  }
  const rowEls = new Map();
  function updateRoster(m) {
    const sort = $('roster-sort').value;
    const list = m.humans.filter((h) => h.alive).map((h) => ({ h, s: Sim.survivability(h) }));
    list.sort((a, b) => sort === 'surv' ? b.s - a.s : sort === 'hp' ? a.h.hp / a.h.maxHp - b.h.hp / b.h.maxHp : sort === 'age' ? a.h.age - b.h.age : sort === 'kills' ? b.h.kills - a.h.kills : a.h.name.localeCompare(b.h.name));
    $('roster-n').textContent = list.length;
    const sel = world.view.selected, container = $('roster');
    const aliveIds = new Set(list.map((x) => x.h.id));
    rowEls.forEach((el, id) => { if (!aliveIds.has(id)) { el.remove(); rowEls.delete(id); } });
    list.forEach(({ h, s }, idx) => {
      let row = rowEls.get(h.id);
      if (!row) {
        row = document.createElement('div');
        row.className = 'row';
        row.dataset.id = h.id;
        row.innerHTML = '<span class="dot"></span><div><div class="nm"></div><div class="sub"></div></div><div><div class="hpbar"><i></i></div><div class="pct"></div></div>';
        rowEls.set(h.id, row);
      }
      row.classList.toggle('sel', h.id === sel);
      const r = h.hp / h.maxHp;
      const dot = h.infected > 0 ? '#9bc53d' : h.escort ? '#fde047' : h.where === 'squad' ? '#22d3ee' : '#3b82f6';
      const marks = (h.infected > 0 ? ' ☣' : '') + (h.handicaps.length ? ' ♿' : '') + (h.age < 5 ? ' 👶' : h.age > 60 ? ' 👴' : '');
      row.children[0].style.background = dot;
      row.children[1].children[0].textContent = `${h.name}, ${Math.floor(h.age)}${marks}`;
      const dom = Sim.dominantEmotion ? Sim.dominantEmotion(h) : { name: '' };
      const relIcon = (m.leaderId === h.id ? ' 👑' : '') + (h.partnerId ? ' ❤️' : h.crushId ? ' 💘' : h.rivalId ? ' ⚡' : '') + (h.sickT > 0 ? ' 🤢' : '') + (h.cold ? ' 🥶' : '') + (h.pregnant > 0 ? ' 🤰' : '');
      const clq = Sim.cliqueOf ? Sim.cliqueOf(m, h) : null;
      row.style.boxShadow = clq ? `inset 3px 0 0 ${clq.color}` : 'none';
      row.title = clq ? `Clique: ${clq.name}` : '';
      row.children[1].children[1].textContent = `${h.personalityName || ''} (${dom.name}) · ${Sim.WEAPONS[h.weapon].name}${relIcon}`;
      const barFill = row.children[2].children[0].children[0];
      barFill.style.width = `${Math.round(r * 100)}%`;
      barFill.style.background = hpColor(r);
      row.children[2].children[1].textContent = `${Math.round(s * 100)}% odds`;
      if (container.children[idx] !== row) container.insertBefore(row, container.children[idx] || null);
    });
  }
  $('roster').addEventListener('pointerdown', (e) => { const row = e.target.closest('.row'); if (row) select(+row.dataset.id); });
  $('roster-sort').addEventListener('change', () => { app.rosterT = 0; if (app.m) updateRoster(app.m); });
  $('bio').addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = world.view.selected;
    if (btn.id === 'bio-follow' && id) {
      world.view.follow = world.view.follow === id ? 0 : id;
      if (world.view.follow) { world.view.director = false; $('btn-director').classList.remove('on'); world.cam.zoomMul = Math.min(world.cam.zoomMul, 0.45); }
      app.bioKey = ''; if (app.m) updateBio(app.m);
    } else if (btn.id === 'bio-close') select(0);
  });

  function updateBio(m) {
    const id = world.view.selected, e = id && m.byId ? m.byId[id] : null;
    const bio = $('bio');
    if (!e) { if (app.bioKey !== 'none') { bio.innerHTML = '<div class="empty">Click any survivor or zombie to inspect them.</div>'; app.bioKey = 'none'; } return; }
    const isZ = e.kind === 'zombie';
    let html, key;
    const followBtn = `<div class="acts"><button id="bio-follow" class="${world.view.follow === id ? 'on' : ''}">${world.view.follow === id ? 'Following' : 'Follow camera'}</button><button id="bio-close">Close</button></div>`;
    if (isZ) {
      const T = Sim.ZTYPES[e.type], night = m.phase === 'night';
      key = ['z', id, Math.round(e.hp), e.alive, night, e.kills, world.view.follow].join('|');
      if (key === app.bioKey) return;
      html = `<div class="head"><canvas id="bio-pic" width="64" height="64"></canvas><div><div class="name">${T.name}</div><div class="role">${e.name ? 'Formerly ' + esc(e.name) + ', ' + Math.floor(e.age) : 'Unknown, about ' + Math.floor(e.age)}</div></div></div>` +
        `<div class="grid">${bar('Health', 100 * Math.max(0, e.hp) / e.maxHp)}${bar('Strength', e.str)}${bar('Speed', Math.min(100, e.spd * (night ? T.night : 1) * 16))}${bar('Decay', (e.decay || 0) * 100)}</div>` +
        `<div class="tags"><span class="tag ${e.alive ? 'sick' : 'bad'}">${e.alive ? (night ? 'Night frenzy: faster and stronger' : 'Daylight: slow and weak') : 'Destroyed'}</span>` +
        `<span class="tag">${e.mode === 'siege' ? 'Attacking the compound' : e.mode === 'hunt' ? 'Hunting a survivor' : 'Wandering'}</span><span class="tag">Kills: ${e.kills}</span>` +
        (e.from ? `<span class="tag bad">Turned on day ${e.bornDay}</span>` : '') + `</div>` + followBtn;
    } else {
      const s = Sim.survivability(e), r = Math.max(0, e.hp) / e.maxHp;
      const dom = Sim.dominantEmotion ? Sim.dominantEmotion(e) : { name: 'Calm', val: 50 };
      key = ['h', id, Math.round(e.hp), e.alive, e.weapon, e.kills, e.handicaps.length, e.infected > 0, Math.round(s * 100), roleOf(m, e), world.view.follow, Math.floor(e.age), e.partnerId, e.bestFriendId, e.rivalId, dom.name, dom.val, e.hoarded, e.crushId, e.cliqueId, e.bunkId, e.insomniaT > 0, e.sickT > 0, e.cold, e.heatT > 0, e.amputated, e.brigT > 0, e.pregnant > 0, e.paternityDrama, m.humans.length].join('|');
      if (key === app.bioKey) return;
      const tags = [];
      const persMeta = Sim.PERSONALITIES && Sim.PERSONALITIES[e.personality];
      if (persMeta) tags.push(`<span class="tag ${persMeta.tag === 'bad' ? 'bad' : persMeta.tag === 'good' ? 'good' : ''}" title="${esc(persMeta.desc)}">Archetype: ${esc(persMeta.name)}</span>`);
      tags.push(`<span class="tag">Mood: ${esc(dom.name)} (${dom.val})</span>`);
      if (!e.alive) tags.push(`<span class="tag bad">Died on day ${e.diedDay}: ${esc(e.cause || '')}</span>`);
      if (e.infected > 0) tags.push(`<span class="tag sick">Infected — turns in ${Math.ceil(e.infected)} s</span>`);
      else if (e.bitten) tags.push('<span class="tag good">Bitten, infection cured</span>');
      for (const k of e.handicaps) tags.push(`<span class="tag bad" title="${Sim.HANDICAPS[k].effect}">${Sim.HANDICAPS[k].name}</span>`);
      if (e.vice && e.vice !== 'None') tags.push(`<span class="tag">Habit: ${esc(e.vice)}</span>`);
      if (e.familyIds && e.familyIds.length) {
        for (const fid of e.familyIds) if (m.byId[fid]) tags.push(`<span class="tag good" style="cursor:pointer" onclick="OBDebug.select(${fid})">👪 Family: ${esc(m.byId[fid].name)}</span>`);
      }
      if (e.partnerId && m.byId[e.partnerId]) tags.push(`<span class="tag good" style="cursor:pointer" onclick="OBDebug.select(${e.partnerId})">❤️ Partner: ${esc(m.byId[e.partnerId].name)}</span>`);
      if (e.exIds && e.exIds.length) {
        for (const xid of e.exIds) if (m.byId[xid]) tags.push(`<span class="tag bad" style="cursor:pointer" onclick="OBDebug.select(${xid})">💔 Ex: ${esc(m.byId[xid].name)}</span>`);
      }
      if (e.bestFriendId && m.byId[e.bestFriendId]) tags.push(`<span class="tag good" style="cursor:pointer" onclick="OBDebug.select(${e.bestFriendId})">🤝 Ride-or-Die: ${esc(m.byId[e.bestFriendId].name)}</span>`);
      if (e.rivalId && m.byId[e.rivalId]) tags.push(`<span class="tag bad" style="cursor:pointer" onclick="OBDebug.select(${e.rivalId})">⚡ Beef/Rival: ${esc(m.byId[e.rivalId].name)}</span>`);
      const link = (id, cls, txt) => `<span class="tag ${cls}" style="cursor:pointer" onclick="OBDebug.select(${id})">${txt}</span>`;
      const clq = Sim.cliqueOf ? Sim.cliqueOf(m, e) : null;
      if (clq) tags.push(`<span class="tag" style="box-shadow:inset 0 0 0 1px ${clq.color};color:${clq.color}">👥 ${esc(clq.name)}</span>`);
      if (e.crushId && m.byId[e.crushId]) tags.push(link(e.crushId, 'love', `💘 Secret crush: ${esc(m.byId[e.crushId].name)}`));
      for (const o of m.humans) if (o.alive && o.crushId === e.id) tags.push(link(o.id, 'love', `💌 Crushed on by ${esc(o.name)}`));
      const mate = Sim.bunkmateOf ? Sim.bunkmateOf(m, e) : null;
      if (mate) { const sour = (e.exIds || []).indexOf(mate.id) >= 0 || Sim.getRel(e, mate) < -40; tags.push(link(mate.id, sour ? 'bad' : '', `🛏 Bunkmate: ${esc(mate.name)}${sour ? ' (it is going badly)' : ''}`)); }
      if (e.parents) { const ps = e.parents.map((id) => m.byId[id]).filter(Boolean); if (ps.length) tags.push(`<span class="tag good">👶 Child of ${ps.map((x) => esc(x.name)).join(' &amp; ')}</span>`); }
      if (e.infected > 0 && e.biteSite) tags.push(`<span class="tag sick">Bite site: ${esc(e.biteSite)}</span>`);
      if (e.amputated) tags.push(`<span class="tag bad">🪚 Amputee (${esc(e.amputated)})</span>`);
      if (e.sickT > 0) tags.push('<span class="tag sick">🤢 Corpse fever</span>');
      if (e.cold) tags.push('<span class="tag bad">🥶 Freezing</span>');
      if (e.heatT > 0) tags.push('<span class="tag bad">🥵 Heat exhaustion</span>');
      if (e.insomniaT > 0) tags.push('<span class="tag bad">😵‍💫 No sleep (bunk fight)</span>');
      if (e.hoarded > 0) tags.push(`<span class="tag bad">🐍 Stashed ammo: ${e.hoarded}</span>`);
      if (e.trauma > 0) tags.push(`<span class="tag bad">😵 Trauma / PTSD (${e.trauma})</span>`);
      if (e.brigT > 0) tags.push(`<span class="tag bad">⛓️ In the Brig (${Math.ceil(e.brigT)}s)</span>`);
      if (e.pregnant > 0) tags.push(e.paternityDrama ? '<span class="tag bad">🤰 Expecting — father disputed</span>' : '<span class="tag good">🤰 Expecting</span>');
      tags.push(`<span class="tag">Weapon: ${Sim.WEAPONS[e.weapon].name}</span>`, `<span class="tag">Kills: ${e.kills}</span>`);
      const em = e.emotions || {};
      const eBar = (label, v, col) => `<div class="sbar"><span>${label}</span><div class="hpbar"><i style="width:${Math.round(v || 0)}%;background:${col}"></i></div><b>${Math.round(v || 0)}</b></div>`;
      const emoGrid = `<div class="emo-title">10 EMOTIONAL FACTORS</div><div class="grid emo-grid">` +
        eBar('Fear', em.fear, '#a78bfa') + eBar('Anger', em.anger, '#ef4444') +
        eBar('Jealousy', em.jealousy, '#ec4899') + eBar('Greed', em.greed, '#eab308') +
        eBar('Paranoia', em.paranoia, '#f97316') + eBar('Pride', em.pride, '#f59e0b') +
        eBar('Empathy', em.empathy, '#34d399') + eBar('Loyalty', em.loyalty, '#38bdf8') +
        eBar('Hope', em.hope, '#4ade80') + eBar('Resentment', em.resentment, '#fb7185') +
        `</div>`;
      html = `<div class="head"><canvas id="bio-pic" width="64" height="64"></canvas><div><div class="name">${m.leaderId === e.id ? '👑 ' : ''}${esc(e.name)}, ${Math.floor(e.age)}</div><div class="role">${esc(e.cultureName || '')} · ${esc(e.bg || 'Survivor')} · ${e.alive ? esc(roleOf(m, e)) : 'Deceased'} · <b>${esc(e.personalityName || '')}</b></div></div></div>` +
        `<div class="surv"><div class="sbar" style="grid-template-columns:62px 1fr 34px"><span>Survival</span><div class="hpbar"><i style="width:${Math.round(s * 100)}%;background:${hpColor(s)}"></i></div><b>${Math.round(s * 100)}%</b></div></div>` +
        `<div class="grid">${bar('Health', r * 100)}${bar('Strength', e.str)}${bar('Speed', Math.min(100, Sim.speedOf(e) / 5.8 * 100))}${bar('Aim', e.aim)}${bar('Medical', e.med)}${bar('Repair', e.rep)}${bar('Bravery', e.brav)}${bar('Stamina', e.stam)}${bar('Sanity', e.sanity ?? 85)}${bar('Fatigue', e.fatigue ?? 15)}</div>` +
        emoGrid +
        `<div class="tags">${tags.join('')}</div>` + followBtn;
    }
    app.bioKey = key;
    bio.innerHTML = html;
    portrait($('bio-pic'), e, isZ);
  }
  function updateFeed(m) {
    if (m.events.length === app.feedN) return;
    app.feedN = m.events.length;
    const feed = $('feed');
    feed.innerHTML = m.events.slice(-70).reverse().map((e) => `<div class="${e.kind}"><span class="t">${e.phase === 'night' ? 'N' : 'D'}${e.day}</span>${esc(e.text)}</div>`).join('');
  }
  function updateChart(m) {
    if (m.hist.length === app.chartN) return;
    app.chartN = m.hist.length;
    const cv = $('chart'), g = cv.getContext('2d'), W = cv.width, H = cv.height, padL = 44, padR = 44, padT = 14, padB = 30;
    g.clearRect(0, 0, W, H);
    const hist = m.hist;
    if (hist.length < 2) return;
    const t0 = hist[0].t, t1 = Math.max(hist[hist.length - 1].t, t0 + 120);
    let top = 10;
    for (const p of hist) top = Math.max(top, p.h, p.z);
    const X = (t) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR), Y = (v) => H - padB - (v / top) * (H - padT - padB);
    g.fillStyle = 'rgba(111,140,255,0.13)';
    for (let d = 0; d * 2 * Sim.PHASE < t1; d++) { const a = d * 2 * Sim.PHASE + Sim.PHASE, b = a + Sim.PHASE; if (b > t0) g.fillRect(X(Math.max(a, t0)), padT, X(Math.min(b, t1)) - X(Math.max(a, t0)), H - padT - padB); }
    g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 1; g.fillStyle = '#9aa3ad'; g.font = '18px Inter, sans-serif'; g.textAlign = 'right';
    for (let i = 0; i <= 2; i++) { const v = (top * i) / 2, y = Y(v); g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR, y); g.stroke(); g.fillText(Math.round(v), padL - 6, y + 6); }
    g.textAlign = 'left'; g.fillStyle = '#f2a93b';
    g.fillText('100%', W - padR + 5, Y(top) + 6); g.fillText('0%', W - padR + 5, Y(0) + 6);
    g.fillStyle = '#9aa3ad'; g.textAlign = 'center';
    const days = Math.ceil(t1 / (2 * Sim.PHASE)), every = Math.max(1, Math.ceil(days / 8));
    for (let d = 0; d < days; d += every) { const x = X(d * 2 * Sim.PHASE); if (x >= padL - 1) g.fillText('Day ' + (d + 1), x + 22, H - 8); }
    const line = (f, color, w) => { g.strokeStyle = color; g.lineWidth = w; g.beginPath(); hist.forEach((p, i) => { const x = X(p.t), y = f(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke(); };
    line((p) => H - padB - p.s * (H - padT - padB), '#f2a93b', 2);
    line((p) => Y(p.z), '#9bc53d', 3);
    line((p) => Y(p.h), '#5aa9ff', 3);
  }
  function showEnd(m) {
    app.ended = true;
    const st = m.stats, win = m.winner;
    $('end-title').innerHTML = win === 'humans' ? '<span style="color:var(--green)">THE SURVIVORS WIN</span>' : win === 'zombies' ? '<span style="color:var(--red)">THE HORDE WINS</span>' : 'STALEMATE';
    $('end-reason').textContent = m.reason;
    const cells = [['Days survived', m.day], ['Survivors left', m.hAlive], ['Zombies left', m.zAlive], ['Peak survivors', st.peakHumans], ['Rescued', st.rescued], ['Survivors lost', st.humansLost], ['Turned into zombies', st.turned],
      ['Zombies destroyed', st.zKilled], ['Nights held', st.nightsHeld], ['Romances formed', st.romances || 0], ['Feuds & fights', st.conflicts || 0], ['Sabotages & breakups', (st.sabotages || 0) + (st.breakups || 0)],
      ['Love triangles', st.triangles || 0], ['Paternity scandals', st.paternity || 0], ['2 AM bunk blowups', st.bunkFights || 0], ['Cliques formed', st.cliques || 0],
      ['Blackouts', st.blackouts || 0], ['Amputations (saved)', `${st.amputations || 0} (${st.ampSaved || 0})`], ['Distress calls answered', (st.radioRescues || 0) + (st.radioTraps || 0)], ['Corpses burned', st.bodiesBurned || 0],
      ['Guard dog', m.dog ? (m.dog.alive ? 'Survived' : 'Lost') : '—']];
    $('end-stats').innerHTML = cells.map(([k, v]) => `<div><b>${v}</b><small>${k}</small></div>`).join('');
    $('end').classList.remove('hidden');
  }

  function renderOnce() {
    if (!app.m) return;
    world.update(app.m, 0.016);
    world.render();
    if (overlay.width !== overlay.clientWidth || overlay.height !== overlay.clientHeight) { overlay.width = overlay.clientWidth; overlay.height = overlay.clientHeight; }
    world.drawOverlay(g2, app.m, app.bars && app.running);
    updateTop(app.m); updateFeed(app.m); updateChart(app.m); updateBio(app.m); updateRoster(app.m);
  }


  // ------------------------------------------------------------------ WebAudio SFX & Relationship Web
  let sfxOn = false, actx = null;
  if ($('btn-sfx')) $('btn-sfx').addEventListener('click', () => {
    sfxOn = !sfxOn; $('btn-sfx').classList.toggle('on', sfxOn);
    if (sfxOn && !actx && (window.AudioContext || window.webkitAudioContext)) actx = new (window.AudioContext || window.webkitAudioContext)();
  });
  function playPing(freq, dur) {
    if (!sfxOn || !actx) return;
    try {
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = freq; g.gain.setValueAtTime(0.05, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + dur);
      o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + dur);
    } catch (e) {}
  }

  if ($('god-tool')) $('god-tool').addEventListener('change', () => {
    const v = $('god-tool').value;
    if (!app.m) return;
    if (v === 'love') { Sim.godMatchmake(app.m); $('god-tool').value = ''; updateFeed(app.m); updateBio(app.m); }
    else if (v === 'beef') { Sim.godBeef(app.m); $('god-tool').value = ''; updateFeed(app.m); updateBio(app.m); }
    else if (v === 'blackout') { Sim.godBlackout(app.m); $('god-tool').value = ''; updateFeed(app.m); updateTop(app.m); }
    else if (v === 'fuel') { Sim.godFuel(app.m); $('god-tool').value = ''; updateFeed(app.m); updateTop(app.m); }
  });

  // Confessional pop-up: shows the latest private confession for a few seconds; click to inspect the survivor
  let confShown = null;
  function updateConfessional(m) {
    const box = $('confessional-box');
    if (!box) return;
    const c = app.running ? m.confessional : null;
    if (!c) { if (confShown) { box.classList.add('hidden'); confShown = null; } return; }
    if (confShown === c) return;
    confShown = c;
    $('conf-who').textContent = `${c.name} · Day ${c.day}`;
    $('conf-text').textContent = `"${c.text}"`;
    box.classList.remove('hidden');
    box.classList.remove('pop'); void box.offsetWidth; box.classList.add('pop');
  }
  if ($('confessional-box')) $('confessional-box').addEventListener('click', () => { if (confShown) select(confShown.id); });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') { $('drama-modal').classList.add('hidden'); }
  });

  let activeDramaTab = 'confessions';
  function renderDramaModal() {
    const m = app.m;
    if (!m) return;
    const confs = (m.confessionals || []).slice().reverse();
    const breakups = (m.dramaLog || []).filter((x) => x.kind === 'breakup').slice().reverse();
    const allDrama = (m.dramaLog || []).slice().reverse();
    // Active Beef pairs
    const beefPairs = [];
    const seen = new Set();
    for (const h of m.humans) {
      if (!h.alive) continue;
      for (const oid of Object.keys(h.rels || {})) {
        const sc = h.rels[oid];
        const o = m.byId[+oid];
        if (!o || !o.alive || sc > -35) continue;
        const key = h.id < o.id ? `${h.id}-${o.id}` : `${o.id}-${h.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        beefPairs.push({ a: h, b: o, score: sc });
      }
    }
    beefPairs.sort((x, y) => x.score - y.score);
    if ($('cnt-conf')) $('cnt-conf').textContent = confs.length;
    if ($('cnt-beef')) $('cnt-beef').textContent = beefPairs.length;
    if ($('cnt-break')) $('cnt-break').textContent = breakups.length;
    if ($('cnt-drama')) $('cnt-drama').textContent = allDrama.length;
    const crushers = m.humans.filter((h) => h.alive && h.crushId && m.byId[h.crushId] && m.byId[h.crushId].alive);
    if ($('cnt-love')) $('cnt-love').textContent = crushers.length;
    if ($('cnt-clique')) $('cnt-clique').textContent = (m.cliques || []).length;
    const who = (h, colr) => `<b style="cursor:pointer;color:${colr || '#fde68a'}" onclick="OBDebug.select(${h.id});document.getElementById('drama-modal').classList.add('hidden')">${esc(h.name)}</b>`;
    const empty = (t) => `<div class="dempty">${t}</div>`;

    const listEl = $('drama-list'), cv = $('drama-canvas');
    if (activeDramaTab === 'web') {
      listEl.classList.add('hidden'); cv.classList.remove('hidden');
      drawDramaWeb();
      return;
    }
    cv.classList.add('hidden'); listEl.classList.remove('hidden');

    if (activeDramaTab === 'confessions') {
      listEl.innerHTML = confs.length ? confs.map((c) =>
        `<div onclick="OBDebug.select(${c.id});document.getElementById('drama-modal').classList.add('hidden')" style="cursor:pointer;padding:10px 12px;border-radius:8px;background:rgba(255,255,255,0.04);border-left:3px solid #ef4444">` +
        `<div style="display:flex;justify-content:space-between;font-size:11px;color:#fde047;margin-bottom:4px"><b>🎥 ${esc(c.name)}</b><span style="color:var(--dim)">Day ${c.day} · ${esc(c.culture)} · ${esc(c.bg)} (${esc(c.pers)})</span></div>` +
        `<div style="font-size:13px;color:#f1f5f9;font-style:italic">"${esc(c.text)}"</div></div>`
      ).join('') : '<div style="color:var(--dim);padding:30px;text-align:center">No private confessions recorded yet — let the simulation run for a few seconds.</div>';
    } else if (activeDramaTab === 'beefs') {
      listEl.innerHTML = beefPairs.length ? beefPairs.map((p) =>
        `<div style="padding:10px 12px;border-radius:8px;background:rgba(229,72,77,0.10);border-left:3px solid #e5484d;display:flex;justify-content:space-between;align-items:center">` +
        `<div><b style="cursor:pointer;color:#fca5a5" onclick="OBDebug.select(${p.a.id});document.getElementById('drama-modal').classList.add('hidden')">${esc(p.a.name)}</b> <span style="color:var(--dim)">(${esc(p.a.personalityName)})</span> ⚡ <b style="cursor:pointer;color:#fca5a5" onclick="OBDebug.select(${p.b.id});document.getElementById('drama-modal').classList.add('hidden')">${esc(p.b.name)}</b> <span style="color:var(--dim)">(${esc(p.b.personalityName)})</span></div>` +
        `<span style="font-weight:700;color:#f87171">Heat: ${p.score}</span></div>`
      ).join('') : '<div style="color:var(--dim);padding:30px;text-align:center">No active beefs yet — give them a few minutes in the yard.</div>';
    } else if (activeDramaTab === 'breakups') {
      const exRows = [];
      const exSeen = new Set();
      for (const h of m.humans) for (const xid of (h.exIds || [])) {
        const o = m.byId[xid]; if (!o) continue;
        const k = h.id < o.id ? `${h.id}-${o.id}` : `${o.id}-${h.id}`;
        if (exSeen.has(k)) continue; exSeen.add(k);
        exRows.push(`<div style="padding:8px 12px;border-radius:8px;background:rgba(236,72,153,0.10);border-left:3px solid #ec4899">💔 <b>${esc(h.name)}</b> &amp; <b>${esc(o.name)}</b> — Bitter Exes</div>`);
      }
      const evRows = breakups.map((b) => `<div style="padding:9px 12px;border-radius:8px;background:rgba(255,255,255,0.04);border-left:3px solid #f43f5e"><b style="color:#fda4af">Day ${b.day}:</b> ${esc(b.text)}</div>`);
      listEl.innerHTML = (evRows.length || exRows.length) ? evRows.concat(exRows).join('') : '<div style="color:var(--dim);padding:30px;text-align:center">No breakups or cheating scandals yet.</div>';
    } else if (activeDramaTab === 'love') {
      const rows = crushers.filter((h) => !(m.byId[h.crushId].crushId === h.id && h.id > h.crushId)).map((h) => {
        const c = m.byId[h.crushId], rival = c.partnerId && m.byId[c.partnerId] && m.byId[c.partnerId].alive ? m.byId[c.partnerId] : null;
        return `<div class="drow" style="border-left-color:#f472b6;background:rgba(244,114,182,0.08)">` +
          (rival ? `<span class="dkind" style="color:#f9a8d4">LOVE TRIANGLE</span> ${who(h, '#f9a8d4')} secretly wants ${who(c, '#f9a8d4')}, who is with ${who(rival, '#fca5a5')}.`
                 : c.crushId === h.id ? `<span class="dkind" style="color:#f9a8d4">MUTUAL CRUSH</span> ${who(h, '#f9a8d4')} and ${who(c, '#f9a8d4')} are secretly into each other. Somebody say something.`
                 : `<span class="dkind" style="color:#f9a8d4">UNREQUITED</span> ${who(h, '#f9a8d4')} has a secret crush on ${who(c, '#f9a8d4')}, who is single. Waiting for the nerve.`) + `</div>`;
      });
      const pats = (m.paternity || []).slice().reverse().map((p) => {
        const mom = m.byId[p.momId]; if (!mom) return '';
        const cands = p.candIds.map((id) => m.byId[id]).filter(Boolean);
        return `<div class="drow" style="border-left-color:#c084fc;background:rgba(192,132,252,0.08)"><span class="dkind" style="color:#d8b4fe">WHO'S THE FATHER?</span> Day ${p.day}: ${who(mom, '#d8b4fe')} — the yard is betting between ${cands.map((x) => who(x)).join(', ')}. <i style="color:var(--dim)">${p.resolved ? 'Settled at the birth.' : 'Unresolved until the baby arrives.'}</i></div>`;
      });
      listEl.innerHTML = (rows.length || pats.length) ? pats.concat(rows).join('') : empty('No secret crushes or paternity questions yet. Give the singles a day or two.');
    } else if (activeDramaTab === 'cliques') {
      const cl = (m.cliques || []).map((c) => {
        const mem = c.memberIds.map((id) => m.byId[id]).filter((x) => x && x.alive);
        return `<div class="drow" style="border-left-color:${c.color};background:rgba(255,255,255,0.04)"><div style="display:flex;justify-content:space-between;align-items:baseline"><b style="color:${c.color};font-size:14px">👥 ${esc(c.name)}</b><span style="color:var(--dim);font-size:11px">since day ${c.formedDay} · ${mem.length} members</span></div>` +
          `<div style="margin-top:4px">${mem.map((x) => who(x, '#e2e8f0')).join(' · ')}</div><div style="margin-top:4px;color:var(--dim);font-size:11px">Votes as a bloc at trials, backs its own in brawls, freezes out outsiders.</div></div>`;
      });
      const loners = m.humans.filter((h) => h.alive && h.age >= 13 && !h.cliqueId);
      const seenB = new Set(), bunks = [];
      for (const h of m.humans) {
        if (!h.alive || !h.bunkId || seenB.has(h.bunkId)) continue;
        seenB.add(h.bunkId);
        const mate = Sim.bunkmateOf(m, h);
        if (!mate) continue;
        const ex = (h.exIds || []).indexOf(mate.id) >= 0, rel = Sim.getRel(h, mate);
        if (ex || rel < -40) bunks.push(`<div class="drow" style="border-left-color:#ef4444;background:rgba(229,72,77,0.10)"><span class="dkind" style="color:#fca5a5">BUNK FROM HELL</span> ${who(h, '#fca5a5')} is stuck bunking with ${ex ? 'their ex' : 'their rival'} ${who(mate, '#fca5a5')}. Expect a 2 AM screaming match.</div>`);
      }
      listEl.innerHTML = (cl.length || bunks.length) ? cl.concat(bunks).join('') + (loners.length ? `<div class="drow" style="border-left-color:#64748b"><span class="dkind">OUTSIDERS</span> ${loners.slice(0, 14).map((x) => who(x, '#cbd5e1')).join(' · ')}${loners.length > 14 ? ' …' : ''}</div>` : '')
        : empty('No cliques have formed yet — friendships need to reach critical mass first.');
    } else {
      listEl.innerHTML = allDrama.length ? allDrama.map((d) =>
        `<div style="padding:8px 12px;border-radius:8px;background:rgba(255,255,255,0.04);border-left:3px solid ${d.kind === 'breakup' ? '#ec4899' : d.kind === 'beef' ? '#ef4444' : '#f59e0b'}">` +
        `<b style="color:var(--amber)">Day ${d.day} · ${d.kind.toUpperCase()}:</b> ${esc(d.text)}</div>`
      ).join('') : '<div style="color:var(--dim);padding:30px;text-align:center">No camp drama logged yet.</div>';
    }
  }

  function drawDramaWeb() {
    const m = app.m;
    if (!m) return;
    const cv = $('drama-canvas'), g = cv.getContext('2d'), W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    const list = m.humans.filter((h) => h.alive).slice(0, 26);
    const pos = new Map();
    const cx = W / 2, cy = H / 2, rx = W * 0.40, ry = H * 0.39;
    list.forEach((h, i) => {
      const a = (i / Math.max(1, list.length)) * Math.PI * 2;
      pos.set(h.id, { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry, h });
    });
    for (let i = 0; i < list.length; i++) {
      const a = list[i], pa = pos.get(a.id);
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j], pb = pos.get(b.id);
        const rel = Sim.getRel ? Sim.getRel(a, b) : 0;
        const isPartner = a.partnerId === b.id;
        const isEx = a.exIds && a.exIds.indexOf(b.id) >= 0;
        if (!isPartner && !isEx && Math.abs(rel) < 40) continue;
        g.save();
        if (isPartner) { g.strokeStyle = '#f472b6'; g.lineWidth = 3; }
        else if (isEx) { g.strokeStyle = '#ef4444'; g.lineWidth = 2; g.setLineDash([5, 4]); }
        else if (rel >= 40) { g.strokeStyle = '#fbbf24'; g.lineWidth = 1.6; }
        else { g.strokeStyle = '#dc2626'; g.lineWidth = 1.8; }
        g.beginPath(); g.moveTo(pa.x, pa.y); g.lineTo(pb.x, pb.y); g.stroke();
        g.restore();
      }
    }
    for (const h of list) {   // one-sided crushes: dotted pink arrow
      const pa = pos.get(h.id), pb = h.crushId ? pos.get(h.crushId) : null;
      if (!pb) continue;
      const dx = pb.x - pa.x, dy = pb.y - pa.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      g.save(); g.strokeStyle = '#f9a8d4'; g.fillStyle = '#f9a8d4'; g.lineWidth = 1.6; g.setLineDash([2, 5]);
      g.beginPath(); g.moveTo(pa.x + ux * 17, pa.y + uy * 17); g.lineTo(pb.x - ux * 22, pb.y - uy * 22); g.stroke(); g.setLineDash([]);
      const ax = pb.x - ux * 19, ay = pb.y - uy * 19;
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax - ux * 8 - uy * 4, ay - uy * 8 + ux * 4); g.lineTo(ax - ux * 8 + uy * 4, ay - uy * 8 - ux * 4); g.closePath(); g.fill();
      g.restore();
    }
    g.font = '600 11px Inter, sans-serif'; g.textAlign = 'left';
    [['#f472b6', 'Couple'], ['#ef4444', 'Exes / beef'], ['#fbbf24', 'Friends'], ['#f9a8d4', 'Secret crush →']].forEach(([c, t], i) => { g.fillStyle = c; g.fillRect(12, 12 + i * 16, 14, 3); g.fillStyle = '#cbd5e1'; g.fillText(t, 32, 17 + i * 16); });
    (m.cliques || []).forEach((c, i) => { g.strokeStyle = c.color; g.lineWidth = 3; g.beginPath(); g.arc(W - 150, 16 + i * 16, 5, 0, 7); g.stroke(); g.fillStyle = '#cbd5e1'; g.fillText(c.name, W - 138, 20 + i * 16); });
    list.forEach((h) => {
      const p = pos.get(h.id);
      g.fillStyle = h.brigT > 0 ? '#991b1b' : h.partnerId ? '#831843' : '#1e293b';
      g.beginPath(); g.arc(p.x, p.y, 15, 0, 7); g.fill();
      const clq = Sim.cliqueOf ? Sim.cliqueOf(m, h) : null;
      g.strokeStyle = h.id === world.view.selected ? '#fde047' : clq ? clq.color : '#64748b'; g.lineWidth = clq ? 3 : 2; g.stroke();
      g.fillStyle = '#e2e8f0'; g.font = '600 10px Inter, sans-serif'; g.textAlign = 'center';
      g.fillText(h.name.split(' ')[0], p.x, p.y + 25);
    });
  }
  document.querySelectorAll('.dtab').forEach((btn) => btn.addEventListener('click', () => {
    activeDramaTab = btn.dataset.dtab;
    document.querySelectorAll('.dtab').forEach((b) => b.classList.toggle('on', b === btn));
    renderDramaModal();
  }));
  if ($('btn-drama')) $('btn-drama').addEventListener('click', () => { $('drama-modal').classList.remove('hidden'); renderDramaModal(); });
  if ($('btn-drama-close')) $('btn-drama-close').addEventListener('click', () => $('drama-modal').classList.add('hidden'));

  // ------------------------------------------------------------------ main loop
  let last = performance.now(), timerId = 0;
  function scheduleNext() {
    if (timerId) return;
    timerId = setTimeout(() => {
      timerId = 0;
      frame(performance.now());
    }, 45);
  }
  function frame(now) {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    const m = app.m;
    if (m && app.running) {
      const mul = app.speed * (PACE[app.pace] || 1);
      if (mul > 0 && !m.over) {
        app.acc += dt * mul;
        let n = 0;
        while (app.acc >= Sim.DT && n < 80 && !m.over) { Sim.step(m); app.acc -= Sim.DT; n++; }
        if (n >= 80) app.acc = 0;
      }
      if (keys.size) {
        const v = dt * 0.9 * world.cam.dist * world.cam.zoomMul;
        const r = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0), f = (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0);
        if (r || f) pan(r * v, f * v);
      }
      world.update(m, dt * Math.max(1, mul));
      world.render();
      if (overlay.width !== overlay.clientWidth || overlay.height !== overlay.clientHeight) { overlay.width = overlay.clientWidth; overlay.height = overlay.clientHeight; }
      world.drawOverlay(g2, m, app.bars && app.running);
      app.uiT -= dt; app.rosterT -= dt;
      if (app.uiT <= 0) { app.uiT = 0.2; updateTop(m); updateFeed(m); updateChart(m); updateBio(m); }
      if (app.rosterT <= 0) { app.rosterT = 0.6; updateRoster(m); }
      if (m.fx && m.fx.length && sfxOn) playPing(220, 0.06);
      if (m.over && !app.ended) showEnd(m);
      scheduleNext();
    }
  }

  // Render a single static preview frame behind the setup screen so setup UI is 100% instant!
  app.m = Sim.create({ seed: 7 });
  app.m.clock = 20;
  world.buildWorld(app.m);
  renderOnce();
  setTimeout(renderOnce, 400);
  // Handle for automated checks: fast-forward without waiting for rendered frames
  window.OBDebug = {
    app, world, Sim,
    start: (opts) => startGame(Object.assign({ seed: 7 }, opts || {})),
    advance(seconds) { const m = app.m; for (let n = Math.round(seconds / Sim.DT); n > 0 && !m.over; n--) { Sim.step(m); if (n % 4 === 0) world.update(m, Sim.DT * 4); } renderOnce(); },
    select,
  };
})();
