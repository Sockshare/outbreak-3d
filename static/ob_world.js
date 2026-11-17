/**
 * Outbreak 3D — world, characters and effects.
 *
 * Draws the simulation state from ob_sim.js: one continuous 3D map with the walled compound in the middle of a
 * ruined town, a day/night lighting cycle, and an articulated, animated figure for every human and zombie.
 * Figures are built from instanced body parts, so several hundred of them animate in a handful of draw calls.
 * Each figure shows its stats: size by age, build by strength, grey hair and cane for elders, crutch / bandages /
 * short arm for handicaps, the weapon in hand, and a distinct body for each zombie type.
 *
 * Textures in static/assets are CC0 photos from Poly Haven (see CREDITS.txt). Everything else is generated here.
 */
(function (root) {
  'use strict';

  function create(THREE, Sim, canvas) {
    const BASE = Sim.BASE, SEG = Sim.SEG, CELL = Sim.CELL, MAP = Sim.MAP, PHASE = Sim.PHASE;
    const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
    const lerp = (a, b, t) => a + (b - a) * t;
    const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    const col = (c) => new THREE.Color(c);

    const HI_Q = !/quality=low/.test(location.search);
    const FORCE_SW = /sw=1/.test(location.search);
    let renderer = null;
    if (!FORCE_SW) {
      try {
        const probe = document.createElement('canvas');
        const glCtx = probe.getContext('webgl2') || probe.getContext('webgl') || probe.getContext('experimental-webgl');
        if (glCtx) {
          const dbg = glCtx.getExtension('WEBGL_debug_renderer_info');
          const rName = (dbg ? glCtx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : glCtx.getParameter(glCtx.RENDERER)) || '';
          const isSwift = /SwiftShader|llvmpipe|Software/i.test(rName) && !/quality=high/.test(location.search);
          renderer = new THREE.WebGLRenderer({ canvas, antialias: !isSwift, powerPreference: 'high-performance' });
          renderer.setPixelRatio(isSwift ? 0.85 : Math.min(window.devicePixelRatio || 1, 1.5));
          renderer.shadowMap.enabled = !isSwift;
          renderer.shadowMap.type = THREE.PCFSoftShadowMap;
          renderer.outputEncoding = THREE.sRGBEncoding;
          renderer.toneMapping = THREE.ACESFilmicToneMapping;
          renderer.toneMappingExposure = 1.08;
          renderer.isSwift = isSwift;
        }
      } catch (e) { renderer = null; }
    }

    const scene = new THREE.Scene();
    scene.background = col('#9cc4e8');
    scene.fog = new THREE.Fog('#9cc4e8', 160, 520);
    const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.5, 900);
    const cam = { az: 0.55, el: 0.88, dist: 95, tx: 0, tz: 6, zoomMul: 1 };

    // ---------------------------------------------------------------- lights
    const hemi = new THREE.HemisphereLight('#dfeeff', '#6a6f5a', 0.85);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight('#ffffff', 1.5);
    sun.castShadow = !(renderer && renderer.isSwift);
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -85; sc.right = 85; sc.top = 85; sc.bottom = -85; sc.near = 10; sc.far = 320;
    sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.05;
    scene.add(sun, sun.target);
    const floods = [];
    const fire = new THREE.PointLight('#ff9a3c', 0, 30, 1.6);
    fire.position.set(6, 1.6, 12);
    scene.add(fire);

    // ---------------------------------------------------------------- textures and materials
    const loader = new THREE.TextureLoader();
    function tex(name, rx, ry) {
      const t = loader.load('/static/assets/' + name + '.jpg');
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(rx || 1, ry || 1);
      t.encoding = THREE.sRGBEncoding;
      t.anisotropy = 4;
      return t;
    }
    const T = { brick: tex('brick'), concrete: tex('concrete'), planks: tex('planks'), metal: tex('metal'), plaster: tex('plaster'), roof: tex('roof') };
    const std = (o) => {
      if (renderer && renderer.isSwift) {
        const p = Object.assign({}, o);
        delete p.roughness; delete p.metalness;
        return new THREE.MeshLambertMaterial(p);
      }
      return new THREE.MeshStandardMaterial(Object.assign({ roughness: 0.85, metalness: 0.05 }, o));
    };
    function texBox(w, h, d, ts) {       // box whose texture repeats every `ts` metres
      const g = new THREE.BoxGeometry(w, h, d), uv = g.attributes.uv;
      for (let i = 0; i < 24; i++) {
        const f = i >> 2, su = (f < 2 ? d : w) / ts, sv = (f === 2 || f === 3 ? d : h) / ts;
        uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
      }
      return g;
    }
    function mesh(geo, mat, x, y, z, parent, noCast) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = !noCast; m.receiveShadow = true;
      (parent || scene).add(m);
      return m;
    }
    function signTex(text, bg, fg) {
      const cv = document.createElement('canvas');
      cv.width = 256; cv.height = 64;
      const g = cv.getContext('2d');
      g.fillStyle = bg; g.fillRect(0, 0, 256, 64);
      g.fillStyle = fg; g.font = '800 34px Inter, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, 128, 34);
      const t = new THREE.CanvasTexture(cv);
      t.encoding = THREE.sRGBEncoding;
      return t;
    }

    // ---------------------------------------------------------------- instancing helpers
    const WHITE = col('#ffffff');
    function inst(geo, mat, cap, cast) {
      const im = new THREE.InstancedMesh(geo, mat, cap);
      im.setColorAt(0, WHITE);        // must run while count is still the full capacity: the colour buffer is sized from it
      im.cap = cap; im.n = 0; im.count = 0;
      im.frustumCulled = false;
      im.castShadow = !!cast; im.receiveShadow = false;
      scene.add(im);
      return im;
    }
    function put(im, mtx, c) {
      if (im.n >= im.cap) return;
      im.setMatrixAt(im.n, mtx);
      im.setColorAt(im.n, c);
      im.n++;
    }
    function flush(im) {
      im.count = im.n; im.n = 0;
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor.needsUpdate = true;
    }
    const _m = new THREE.Matrix4(), _l = new THREE.Matrix4(), _l2 = new THREE.Matrix4(), _b = new THREE.Matrix4(), _j = new THREE.Matrix4();
    const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _v = new THREE.Vector3();
    const ONE = new THREE.Vector3(1, 1, 1), YAX = new THREE.Vector3(0, 1, 0), XAX = new THREE.Vector3(1, 0, 0);
    function staticInst(im, x, y, z, ry, sx, sy, sz, c) {
      _q.setFromAxisAngle(YAX, ry || 0);
      _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
      put(im, _m, c);
    }

    // ---------------------------------------------------------------- world (built once per game)
    let worldGrp = null, segMeshes = [], rubble = [], gateL = null, gateR = null, turrets = [], bunkerMat = null, bunkerDoor = null, lampMats = [], bldgRoofs = [], truckMesh = null, traderMesh = null, groundMatRef = null, rainGroup = null;
    let dynCrateIm = null, dynTrapIm = null, truckGeoRef = null, crateGeoRef = null;
    let genGrp = null, genLamp = null, radioGrp = null, radioDish = null, radioBlink = null, dogGrp = null, dogTail = null, bodyIm = null;
    const statics = [];
    function buildWorld(m) {
      if (worldGrp) { scene.remove(worldGrp); worldGrp.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
      for (const s of statics) { scene.remove(s); s.geometry.dispose(); }
      statics.length = 0; segMeshes = []; rubble = []; turrets = []; lampMats = []; bldgRoofs = []; truckMesh = null; traderMesh = null;
      for (const f of floods) scene.remove(f, f.target);
      floods.length = 0;
      const L = m.L;
      const G = worldGrp = new THREE.Group();
      scene.add(G);

      // ground, streets, compound yard — solid, non-overlapping elevation tiers + polygonOffset so planes never blend!
      const groundMat = groundMatRef = std({ map: tex('grass', 80, 80), color: '#6b8e58', polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 });
      const ground = mesh(new THREE.PlaneGeometry(600, 600, 32, 32), groundMat, 0, -0.08, 0, G, true);
      ground.userData.swBias = -0.003;
      ground.rotation.x = -Math.PI / 2;
      const asphalt = std({ map: tex('asphalt', 1, 1), color: '#5c6066', roughness: 0.92, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
      const curbMat = std({ map: T.concrete, color: '#9a9e9f', roughness: 0.85 });
      for (let k = -5; k <= 4; k++) {
        const c = (k + 0.5) * CELL, len = 2 * MAP + 30;
        const pieces = Math.abs(c) < 20 ? [[-len / 2, -45], [45, len / 2]] : [[-len / 2, len / 2]];
        for (const [a, b] of pieces) {
          for (const horiz of [0, 1]) {
            const g = new THREE.BoxGeometry(horiz ? b - a : 7.2, 0.10, horiz ? 7.2 : b - a, horiz ? 12 : 1, 1, horiz ? 1 : 12);
            const r = mesh(g, asphalt, horiz ? (a + b) / 2 : c, -0.03, horiz ? c : (a + b) / 2, G, true);
            r.userData.swBias = -0.001;
          }
        }
      }
      // Solid compound foundation slab with raised concrete border curb
      const yardMat = std({ map: tex('concrete', 8, 8), color: '#a89f8f', roughness: 0.88, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      const yard = mesh(new THREE.BoxGeometry(BASE * 2 + 0.6, 0.14, BASE * 2 + 0.6, 18, 1, 18), yardMat, 0, -0.07, 0, G, true);
      yard.userData.swBias = 0.0005;
      const drive = mesh(new THREE.BoxGeometry(7.2, 0.12, 23, 2, 1, 6), asphalt, 0, -0.04, BASE + 11.5, G, true);
      drive.userData.swBias = 0.0002;

      // perimeter wall: 20 segments (one is the gate), posts, and rubble that appears where a segment is destroyed
      const wallGeo = texBox(SEG - 0.15, 3.2, 0.5, 3);
      const postGeo = new THREE.BoxGeometry(0.7, 3.7, 0.7), postMat = std({ map: T.concrete, color: '#8d8d8d' });
      const rubGeo = new THREE.BoxGeometry(1, 1, 1);
      for (const s of L.segs) {
        let sm;
        if (s.gate) {
          sm = new THREE.Group(); G.add(sm);
          const leafGeo = texBox(SEG / 2 - 0.2, 3.0, 0.3, 2.5), leafMat = std({ map: T.metal, color: '#9aa7b0', metalness: 0.4, roughness: 0.6 });
          const pl = new THREE.Group(), pr = new THREE.Group();
          pl.position.set(-SEG / 2, 0, BASE); pr.position.set(SEG / 2, 0, BASE);
          mesh(leafGeo, leafMat, SEG / 4, 1.5, 0, pl); mesh(leafGeo, leafMat, -SEG / 4, 1.5, 0, pr);
          sm.add(pl, pr); gateL = pl; gateR = pr;
          const beam = mesh(new THREE.BoxGeometry(SEG + 0.8, 0.5, 0.7), postMat, 0, 4.0, BASE, G);
          beam.userData.k = 1;
        } else {
          sm = mesh(wallGeo, std({ map: s.id % 2 ? T.planks : T.metal, color: s.id % 2 ? '#b09a7a' : '#8f9aa2' }), s.cx, 1.6, s.cz, G);
          if (s.nx) sm.rotation.y = Math.PI / 2;
        }
        segMeshes.push(sm);
        const rg = new THREE.Group();
        rg.position.set(s.cx, 0, s.cz); rg.visible = false;
        for (let i = 0; i < 7; i++) {
          const r = mesh(rubGeo, std({ map: T.planks, color: '#6b5c48' }), (s.nx ? 0 : (i - 3) * 1.2) + Math.sin(i * 7.1) * 0.5, 0.2, (s.nx ? (i - 3) * 1.2 : 0) + Math.cos(i * 5.3) * 0.9, rg);
          r.scale.set(1.4 + (i % 3) * 0.5, 0.25 + (i % 2) * 0.25, 0.5); r.rotation.set(Math.sin(i) * 0.3, i * 1.3, Math.cos(i) * 0.3);
        }
        G.add(rg); rubble.push(rg);
      }
      for (let side = 0; side < 4; side++) for (let k = 0; k <= 5; k++) {
        const t = -BASE + k * SEG;
        if (k === 5 && side !== 3) continue;
        const x = side === 0 ? t : side === 1 ? BASE : side === 2 ? -t : -BASE, z = side === 0 ? BASE : side === 1 ? -t : side === 2 ? -BASE : t;
        mesh(postGeo, postMat, x, 1.85, z, G);
      }

      // watchtowers with floodlights (and a turret that appears once it is built)
      const wood = std({ map: T.planks, color: '#8a6f4f' }), dark = std({ color: '#22262c', metalness: 0.6, roughness: 0.5 });
      L.towers.forEach((tw) => {
        const g = new THREE.Group();
        g.position.set(tw.x, 0, tw.z); G.add(g);
        for (const [x, z] of [[-1.7, -1.7], [1.7, -1.7], [-1.7, 1.7], [1.7, 1.7]]) mesh(new THREE.BoxGeometry(0.3, 7.2, 0.3), wood, x, 3.6, z, g);
        mesh(texBox(4.2, 0.3, 4.2, 2), wood, 0, 4.15, 0, g);
        for (const [x, z, w, d] of [[0, -2, 4.2, 0.15], [0, 2, 4.2, 0.15], [-2, 0, 0.15, 4.2], [2, 0, 0.15, 4.2]]) mesh(new THREE.BoxGeometry(w, 0.9, d), wood, x, 4.75, z, g);
        const roof = mesh(new THREE.ConeGeometry(3.4, 1.5, 4), std({ map: T.metal, color: '#6f7a80' }), 0, 7.9, 0, g);
        roof.rotation.y = Math.PI / 4;
        for (let i = 0; i < 7; i++) mesh(new THREE.BoxGeometry(0.7, 0.08, 0.12), wood, 0, 0.6 + i * 0.55, 2.0, g, true);   // ladder
        const lm = new THREE.MeshStandardMaterial({ color: '#ddd', emissive: '#fff6cf', emissiveIntensity: 0 });
        lampMats.push(lm);
        const sx = Math.sign(tw.x), sz = Math.sign(tw.z);
        mesh(new THREE.BoxGeometry(0.9, 0.5, 0.5), lm, sx * 1.6, 7.0, sz * 1.6, g, true);
        const sp = new THREE.SpotLight('#fff3cf', 0, 80, 0.85, 0.55, 1.2);
        sp.position.set(tw.x + sx * 1.6, 7.2, tw.z + sz * 1.6);
        sp.target.position.set(tw.x + sx * 22, 0, tw.z + sz * 22);
        sp.visible = HI_Q && !lowQ;
        scene.add(sp, sp.target); floods.push(sp);
        const tg = new THREE.Group();
        tg.position.set(0, 4.35, 0); tg.visible = false;
        mesh(new THREE.CylinderGeometry(0.45, 0.55, 0.7, 10), dark, 0, 0.35, 0, tg);
        mesh(new THREE.BoxGeometry(0.5, 0.4, 0.8), dark, 0, 0.85, 0, tg);
        mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.5, 8), dark, 0, 0.9, 1.0, tg).rotation.x = Math.PI / 2;
        g.add(tg); turrets.push(tg);
      });

      // bunker, infirmary canopy, campfire, supply crates
      const B = L.bunker;
      bunkerMat = std({ map: T.concrete, color: '#9a9a96', transparent: true, opacity: 1 });
      mesh(texBox(B.w, 3.6, B.d, 4), bunkerMat, B.x, 1.8, B.z, G);
      bunkerDoor = mesh(new THREE.BoxGeometry(2.2, 2.6, 0.25), std({ color: '#3d4750', metalness: 0.7, roughness: 0.45 }), B.x, 1.3, B.z + B.d / 2 + 0.1, G);
      const bs = mesh(new THREE.PlaneGeometry(5, 1.1), new THREE.MeshBasicMaterial({ map: signTex('BUNKER', '#2a2f36', '#f2c94c') }), B.x, 3.0, B.z + B.d / 2 + 0.06, G, true);
      bs.userData.k = 1;
      const I = L.infirmary, canvasMat = std({ color: '#e9e6dc', side: THREE.DoubleSide });
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) mesh(new THREE.CylinderGeometry(0.1, 0.1, 3, 6), wood, I.x + x * I.w / 2, 1.5, I.z + z * I.d / 2, G);
      const tent = mesh(new THREE.CylinderGeometry(0.01, I.d * 0.62, 1.6, 4, 1, true), canvasMat, I.x, 3.75, I.z, G);
      tent.rotation.y = Math.PI / 4; tent.scale.x = I.w / I.d;
      mesh(new THREE.PlaneGeometry(2.4, 1.2), new THREE.MeshBasicMaterial({ map: signTex('+ MEDIC', '#ffffff', '#c62828') }), I.x, 2.6, I.z + I.d / 2 + 0.05, G, true);
      for (let i = 0; i < 4; i++) mesh(new THREE.BoxGeometry(0.9, 0.35, 2), std({ color: i % 2 ? '#c9d6dd' : '#d8cfc0' }), I.x - 3 + i * 2, 0.2, I.z - 1.2, G);
      for (let i = 0; i < 5; i++) mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.3, 6), std({ color: '#3a2a1c' }), 6 + Math.cos(i * 1.26) * 0.3, 0.2, 12 + Math.sin(i * 1.26) * 0.3, G).rotation.set(Math.PI / 2, 0, i * 1.26);
      for (let i = 0; i < 6; i++) mesh(new THREE.BoxGeometry(1.2, 1, 1.2), wood, 14 + (i % 3) * 1.4, 0.5 + (i > 2 ? 1 : 0), 14 + (i > 2 ? 0.2 : 0), G);


      // Brig cage (L.brig), Vegetable Garden (L.garden), Compound Pickup Truck, Trader, Crates & Traps
      if (L.brig) {
        const BR = L.brig;
        const barMat = std({ color: '#4b5563', metalness: 0.7, roughness: 0.4 });
        mesh(new THREE.BoxGeometry(BR.w, 0.12, BR.d), std({ color: '#52525b' }), BR.x, 0.08, BR.z, G, true);
        for (let k = -2; k <= 2; k++) {
          mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.5, 6), barMat, BR.x + k * 1.1, 1.3, BR.z + BR.d / 2, G);
          mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.5, 6), barMat, BR.x + k * 1.1, 1.3, BR.z - BR.d / 2, G);
        }
        mesh(new THREE.PlaneGeometry(3.2, 0.8), new THREE.MeshBasicMaterial({ map: signTex('BRIG', '#1f2937', '#f87171') }), BR.x, 2.8, BR.z + BR.d / 2 + 0.06, G, true);
      }
      if (L.garden) {
        const GD = L.garden;
        const soilMat = std({ color: '#4a3525', roughness: 0.95 }), cropMat = std({ color: '#4d9e3d', roughness: 0.8 });
        for (let r = -1; r <= 1; r++) {
          mesh(new THREE.BoxGeometry(GD.w - 0.6, 0.22, 1.3), soilMat, GD.x, 0.14, GD.z + r * 2.0, G, true);
          for (let c = -2; c <= 2; c++) mesh(new THREE.ConeGeometry(0.32, 0.55, 5), cropMat, GD.x + c * 1.2, 0.45, GD.z + r * 2.0, G, true);
        }
      }
      truckMesh = mesh(truckGeoRef || new THREE.BoxGeometry(1.9, 1.4, 4.4), std({ color: '#c25e34', roughness: 0.55, metalness: 0.35 }), m.truck.x, 0.45, m.truck.z, G);
      traderMesh = mesh(new THREE.BoxGeometry(2.2, 1.8, 3.6), std({ color: '#d97706', roughness: 0.6 }), 0, 0.9, BASE + 7, G);
      traderMesh.visible = false;
      dynCrateIm = inst(crateGeoRef || new THREE.BoxGeometry(1.1, 1.1, 1.1), std({ color: '#eab308', roughness: 0.5, metalness: 0.2 }), 40, true);
      dynTrapIm = inst(new THREE.CylinderGeometry(0.45, 0.55, 0.35, 8), std({ color: '#dc2626', roughness: 0.4, metalness: 0.5 }), 40, false);
      statics.push(dynCrateIm, dynTrapIm);

      // Season Two props: generator + fuel drum, radio dish, burn pit, corpse piles, and the camp dog
      const GN = L.generator || { x: 18.6, z: 2 };
      genGrp = new THREE.Group(); genGrp.position.set(GN.x, 0, GN.z); G.add(genGrp);
      mesh(new THREE.BoxGeometry(1.8, 0.2, 2.6), dark, 0, 0.1, 0, genGrp);
      mesh(new THREE.BoxGeometry(1.5, 1.1, 2.3), std({ color: '#c2410c', roughness: 0.6, metalness: 0.4 }), 0, 0.75, 0, genGrp);
      mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.4, 6), dark, 0.45, 1.9, -0.8, genGrp);
      mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.95, 10), std({ color: '#b91c1c', metalness: 0.5, roughness: 0.4 }), -0.2, 0.48, 1.9, genGrp);
      genLamp = new THREE.MeshStandardMaterial({ color: '#222222', emissive: '#22c55e', emissiveIntensity: 1.5 });
      mesh(new THREE.BoxGeometry(0.1, 0.28, 0.28), genLamp, -0.8, 1.0, 0.5, genGrp, true);
      const gs = mesh(new THREE.PlaneGeometry(2.0, 0.6), new THREE.MeshBasicMaterial({ map: signTex('GENERATOR', '#1f2937', '#fbbf24') }), -0.78, 1.75, 0, genGrp, true);
      gs.rotation.y = -Math.PI / 2;
      const RD = L.radioDish || { x: -18.8, z: 1 };
      radioGrp = new THREE.Group(); radioGrp.position.set(RD.x, 0, RD.z); radioGrp.visible = false; G.add(radioGrp);
      mesh(new THREE.BoxGeometry(1.2, 0.3, 1.2), dark, 0, 0.15, 0, radioGrp);
      mesh(new THREE.CylinderGeometry(0.1, 0.14, 7.5, 6), std({ color: '#9ca3af', metalness: 0.7, roughness: 0.4 }), 0, 3.9, 0, radioGrp);
      for (let i = 0; i < 3; i++) mesh(new THREE.BoxGeometry(1.1 - i * 0.25, 0.06, 0.06), dark, 0, 5.2 + i * 0.8, 0, radioGrp, true);
      radioDish = new THREE.Group(); radioDish.position.set(0, 4.4, 0); radioGrp.add(radioDish);
      const dishM = mesh(new THREE.ConeGeometry(1.15, 0.55, 14, 1, true), std({ color: '#e5e7eb', metalness: 0.5, roughness: 0.4, side: THREE.DoubleSide }), 0.75, 0, 0, radioDish);
      dishM.rotation.z = Math.PI / 2 + 0.5;
      radioBlink = new THREE.MeshStandardMaterial({ color: '#330000', emissive: '#ef4444', emissiveIntensity: 0 });
      mesh(new THREE.SphereGeometry(0.16, 8, 6), radioBlink, 0, 7.75, 0, radioGrp, true);
      const BP = L.burnPit || { x: 13, z: BASE + 9 };
      mesh(new THREE.CylinderGeometry(1.7, 1.9, 0.22, 12), std({ color: '#1f1a17', roughness: 1 }), BP.x, 0.08, BP.z, G, true);
      for (let i = 0; i < 6; i++) mesh(new THREE.BoxGeometry(0.5, 0.35, 0.4), std({ color: '#57534e' }), BP.x + Math.cos(i * 1.05) * 1.9, 0.17, BP.z + Math.sin(i * 1.05) * 1.9, G, true);
      bodyIm = inst(new THREE.BoxGeometry(0.6, 0.3, 1.65), std({ color: '#ffffff', roughness: 0.95 }), 48, false);
      statics.push(bodyIm);
      dogGrp = new THREE.Group(); G.add(dogGrp);
      const fur = std({ color: '#a16207', roughness: 0.9 }), furDark = std({ color: '#422006', roughness: 0.9 });
      mesh(new THREE.BoxGeometry(0.34, 0.36, 0.9), fur, 0, 0.5, 0, dogGrp);
      mesh(new THREE.BoxGeometry(0.3, 0.3, 0.34), fur, 0, 0.72, 0.55, dogGrp);
      mesh(new THREE.BoxGeometry(0.16, 0.14, 0.2), furDark, 0, 0.66, 0.8, dogGrp);
      for (const ex of [-0.11, 0.11]) mesh(new THREE.BoxGeometry(0.08, 0.14, 0.06), furDark, ex, 0.92, 0.5, dogGrp, true);
      for (const [lx, lz] of [[-0.11, 0.32], [0.11, 0.32], [-0.11, -0.32], [0.11, -0.32]]) mesh(new THREE.BoxGeometry(0.09, 0.36, 0.09), fur, lx, 0.18, lz, dogGrp);
      dogTail = new THREE.Group(); dogTail.position.set(0, 0.62, -0.45); dogGrp.add(dogTail);
      mesh(new THREE.BoxGeometry(0.07, 0.07, 0.4), furDark, 0, 0.08, -0.18, dogTail, true);
      mesh(new THREE.BoxGeometry(0.36, 0.06, 0.1), std({ color: '#dc2626' }), 0, 0.62, 0.38, dogGrp, true);   // collar

      // town buildings
      const wallMats = { brick: T.brick, plaster: T.plaster, concrete: T.concrete, metal: T.metal };
      const KIND = {
        house: ['plaster', '#d9cbb0'], shop: ['plaster', '#c9d3c0'], clinic: ['concrete', '#e3e7ea'], police: ['concrete', '#93a4b8'],
        hardware: ['brick', '#c9a58c'], warehouse: ['metal', '#9aa3a8'], garage: ['metal', '#b7a98c'],
      };
      const SIGN = { shop: ['SHOP', '#2e7d32', '#fff'], clinic: ['CLINIC +', '#ffffff', '#c62828'], police: ['POLICE', '#1e3a8a', '#fff'], hardware: ['HARDWARE', '#e65100', '#fff'], warehouse: ['WAREHOUSE', '#455a64', '#fff'], garage: ['GARAGE', '#f9a825', '#222'] };
      const signMats = {};
      for (const k of Object.keys(SIGN)) signMats[k] = new THREE.MeshBasicMaterial({ map: signTex(SIGN[k][0], SIGN[k][1], SIGN[k][2]) });
      const doorMat = std({ color: '#1b1612' }), roofFlat = std({ map: T.concrete, color: '#55585c' }), roofTile = std({ map: T.roof, color: '#b8836a' });
      let nWin = 0;
      for (const b of L.buildings) nWin += 2 * (Math.floor(b.w / 3.2) + Math.floor(b.d / 3.2)) * Math.max(1, Math.floor(b.h / 3));
      const winIm = inst(new THREE.BoxGeometry(1, 1, 1), std({ color: '#ffffff', roughness: 0.25, metalness: 0.5 }), Math.max(1, nWin), false);
      statics.push(winIm);
      const WC = [col('#1c2733'), col('#26333f'), col('#0f151c'), col('#3a4650')];
      for (const b of L.buildings) {
        const [mk, tint] = KIND[b.type];
        const c = col(tint).multiplyScalar(0.72 + 0.28 * (1 - b.ruin * 0.6)).offsetHSL((b.tint - 0.5) * 0.06, 0, 0);
        mesh(texBox(b.w, b.h, b.d, 3.5), std({ map: wallMats[mk], color: c }), b.x, b.h / 2, b.z, G);
        let roofGrp = new THREE.Group(); G.add(roofGrp);
        if (b.type === 'house') {
          const r = mesh(new THREE.ConeGeometry(0.74, 1, 4), roofTile, b.x, b.h + 1.4, b.z, roofGrp);
          r.rotation.y = Math.PI / 4; r.scale.set(b.w, 2.8, b.d);
        } else {
          mesh(new THREE.BoxGeometry(b.w + 0.5, 0.4, b.d + 0.5), roofFlat, b.x, b.h + 0.2, b.z, roofGrp);
          mesh(new THREE.BoxGeometry(2.2, 1.1, 2.2), roofFlat, b.x + b.w * 0.2, b.h + 0.9, b.z - b.d * 0.15, roofGrp);
        }
        bldgRoofs[b.id] = roofGrp;
        const fx = b.fx, fz = b.fz, dx = b.x + fx * (b.w / 2 + 0.08), dz = b.z + fz * (b.d / 2 + 0.08);
        const door = mesh(new THREE.BoxGeometry(fx ? 0.12 : 1.8, 2.5, fx ? 1.8 : 0.12), doorMat, dx, 1.25, dz, G, true);
        door.userData.k = 1;
        if (signMats[b.type]) {
          const s = mesh(new THREE.PlaneGeometry(5.2, 1.3), signMats[b.type], b.x + fx * (b.w / 2 + 0.14), Math.min(b.h - 0.9, 3.6), b.z + fz * (b.d / 2 + 0.14), G, true);
          s.rotation.y = Math.atan2(fx, fz);
        }
        const rows = Math.max(1, Math.floor(b.h / 3));
        for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const len = nx ? b.d : b.w, n = Math.floor(len / 3.2);
          for (let i = 0; i < n; i++) for (let r = 0; r < rows; r++) {
            const t = (i - (n - 1) / 2) * 3.2, y = Math.min(b.h - 1, 2.1 + r * 3);
            if (nx === fx && nz === fz && r === 0 && Math.abs(t) < 2) continue;   // leave room for the door
            staticInst(winIm, b.x + nx * (b.w / 2 + 0.10) + (nx ? 0 : t), y, b.z + nz * (b.d / 2 + 0.10) + (nz ? 0 : t), nx ? Math.PI / 2 : 0, 1.3, 1.4, 0.08, WC[(i * 7 + r * 3 + b.id) % 4]);
          }
        }
      }
      flush(winIm);

      // trees and wrecked cars
      const trunk = inst(new THREE.BoxGeometry(0.45, 1, 0.45), std({ color: '#5a4230' }), Math.max(1, L.trees.length), false);
      const leaf = leafImRef = inst(new THREE.ConeGeometry(1.15, 2.2, 7), std({ color: '#ffffff', flatShading: true }), Math.max(1, L.trees.length), true);
      const lc = new THREE.Color();
      for (const t of L.trees) {
        const h = 3.2 * t.s;
        staticInst(trunk, t.x, h / 2, t.z, 0, t.s, h, t.s, WHITE);
        lc.setRGB(0.16 + t.k * 0.1, 0.33 + t.k * 0.16, 0.13 + t.k * 0.05);
        staticInst(leaf, t.x, h + 1.8 * t.s, t.z, t.k * 6, 2.1 * t.s, 2.2 * t.s, 2.1 * t.s, lc);
      }
      flush(trunk); flush(leaf);
      const carB = inst(new THREE.BoxGeometry(1.9, 0.75, 4.4), std({ color: '#ffffff', roughness: 0.55, metalness: 0.4 }), Math.max(1, L.cars.length), true);
      const carC = inst(new THREE.BoxGeometry(1.7, 0.6, 2.2), std({ color: '#ffffff', roughness: 0.3, metalness: 0.5 }), Math.max(1, L.cars.length), true);
      const carW = inst(new THREE.BoxGeometry(2.0, 0.55, 3.2), std({ color: '#15171a' }), Math.max(1, L.cars.length), false);
      const CARS = ['#7a2f2a', '#39506b', '#6f7378', '#c9c5b8', '#3d5a43', '#8a6a2f', '#2b2d31'];
      for (const c of L.cars) {
        lc.set(CARS[Math.floor(c.c * CARS.length)]).multiplyScalar(0.8);
        staticInst(carW, c.x, 0.3, c.z, c.yaw, 1, 1, 1, WHITE);
        staticInst(carB, c.x, 0.72, c.z, c.yaw, 1, 1, 1, lc);
        staticInst(carC, c.x - Math.sin(c.yaw) * 0.3, 1.35, c.z - Math.cos(c.yaw) * 0.3, c.yaw, 1, 1, 1, lc.set('#20262d'));
      }
      flush(carB); flush(carC); flush(carW);
      statics.push(trunk, leaf, carB, carC, carW);
      for (const s of statics) s.receiveShadow = true;
      pools.n = 0; poolI = 0;
      for (let i = 0; i < particles.max; i++) particles.life[i] = 0;
    }

    // ---------------------------------------------------------------- characters (instanced body parts)
    const CAP = 1300;
    const bodyMat = std({ color: '#ffffff', roughness: 0.85 });
    const imTorso = inst(new THREE.BoxGeometry(1, 1, 1), bodyMat, CAP, true);
    const imLimb = inst(new THREE.BoxGeometry(1, 1, 1), bodyMat, CAP * 4, true);
    const imHead = inst(new THREE.SphereGeometry(1, 10, 8), bodyMat, CAP, true);
    const imHair = inst(new THREE.SphereGeometry(1.06, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.58), bodyMat, CAP, false);
    // Load Blender-sculpted .glb geometries for characters, props, and trees (seamlessly upgrades instanced meshes)
    let leafImRef = null;
    function parseGlbGeometries(arrayBuffer) {
      const dv = new DataView(arrayBuffer);
      if (dv.getUint32(0, true) !== 0x46546C67) return {};
      const jsonLen = dv.getUint32(12, true);
      const gltf = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(arrayBuffer, 20, jsonLen)));
      let binOffset = 20 + jsonLen;
      while (binOffset % 4 !== 0) binOffset++;
      const binStart = binOffset + 8;
      const getAcc = (idx) => {
        const acc = gltf.accessors[idx], bv = gltf.bufferViews[acc.bufferView];
        const bo = binStart + (bv.byteOffset || 0) + (acc.byteOffset || 0);
        const n = acc.type === 'SCALAR' ? 1 : acc.type === 'VEC2' ? 2 : acc.type === 'VEC3' ? 3 : 4;
        if (acc.componentType === 5126) return new Float32Array(arrayBuffer, bo, acc.count * n);
        if (acc.componentType === 5123) return new Uint16Array(arrayBuffer, bo, acc.count * n);
        return new Uint32Array(arrayBuffer, bo, acc.count * n);
      };
      const out = {};
      for (const nd of (gltf.nodes || [])) {
        if (nd.mesh === undefined || !gltf.meshes[nd.mesh]) continue;
        const prim = gltf.meshes[nd.mesh].primitives[0];
        const g = new THREE.BufferGeometry();
        if (prim.attributes.POSITION !== undefined) g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(getAcc(prim.attributes.POSITION)), 3));
        if (prim.attributes.NORMAL !== undefined) g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(getAcc(prim.attributes.NORMAL)), 3));
        if (prim.indices !== undefined) {
          const ia = getAcc(prim.indices);
          g.setIndex(new THREE.BufferAttribute(ia instanceof Uint32Array ? new Uint32Array(ia) : new Uint16Array(ia), 1));
        }
        if (!prim.attributes.NORMAL) g.computeVertexNormals();
        out[nd.name] = g;
      }
      return out;
    }
    fetch('/static/assets/models/character_parts.glb').then((r) => r.ok ? r.arrayBuffer() : null).then((buf) => {
      if (!buf) return;
      const geos = parseGlbGeometries(buf);
      if (geos.Torso) { imTorso.geometry.dispose(); imTorso.geometry = geos.Torso; }
      if (geos.Head)  { imHead.geometry.dispose();  imHead.geometry = geos.Head; }
      if (geos.Hair)  { imHair.geometry.dispose();  imHair.geometry = geos.Hair; }
      if (geos.Limb)  { imLimb.geometry.dispose();  imLimb.geometry = geos.Limb; }
      if (geos.Prop)  { imProp.geometry.dispose();  imProp.geometry = geos.Prop; }
      if (geos.PineCanopy && leafImRef) { leafImRef.geometry.dispose(); leafImRef.geometry = geos.PineCanopy; }
      if (geos.PickupTruck) { truckGeoRef = geos.PickupTruck; if (truckMesh) { truckMesh.geometry.dispose(); truckMesh.geometry = geos.PickupTruck; } }
      if (geos.SupplyCrate) { crateGeoRef = geos.SupplyCrate; if (dynCrateIm) { dynCrateIm.geometry.dispose(); dynCrateIm.geometry = geos.SupplyCrate; } }
      window.OBGlbLoaded = true;
    }).catch(() => {});

    const imProp = inst(new THREE.BoxGeometry(1, 1, 1), std({ color: '#ffffff', roughness: 0.6, metalness: 0.2 }), CAP * 2, true);
    const imGlow = inst(new THREE.SphereGeometry(1, 6, 5), new THREE.MeshBasicMaterial({ color: '#ffffff', fog: false }), 400, false);
    const discGeo = new THREE.CircleGeometry(1, 12);
    discGeo.rotateX(-Math.PI / 2);
    const imDisc = inst(discGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, depthWrite: false }), 200, false);
    const pools = inst(discGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.75, depthWrite: false }), 400, false);
    pools.n = 0;
    let poolI = 0;
    const selRing = new THREE.Mesh(new THREE.RingGeometry(0.75, 0.95, 28), new THREE.MeshBasicMaterial({ color: '#ffe066', transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }));
    selRing.rotation.x = -Math.PI / 2; selRing.visible = false;
    scene.add(selRing);

    const PAL = {
      skin: ['#f1c9a5', '#e0ac7e', '#c68958', '#9a6540', '#6e452c'].map(col),
      shirt: ['#b03a3a', '#2f6db0', '#3d8a4f', '#c9a23a', '#7a4aa8', '#d0d4da', '#30343c', '#c9672e', '#3aa3a3', '#8a5a3a'].map(col),
      pants: ['#2b3a55', '#3a3a3a', '#5a4a35', '#4a5a3a', '#22262e', '#6a6f78'].map(col),
      hair: ['#1e1712', '#3b2a1a', '#6b4a2a', '#a8842f', '#8a3b1e', '#101010'].map(col),
    };
    const C = {
      grey: col('#b9bcc0'), white: col('#f2f2ee'), zskin: col('#7f9a78'), zrot: col('#56604a'), blood: col('#5e0d0d'), wood: col('#8a6238'), steel: col('#c9ced3'), gun: col('#1d2024'),
      bandage: col('#f4f1e6'), mask: col('#9fd0e6'), red: col('#ff3b30'), sick: col('#9fbf6a'), eyeDay: col('#7a2b12'), eyeNight: col('#ff5a1f'), flash: col('#ffffff'),
      discBase: col('#3b82f6'), discSquad: col('#22d3ee'), discRescue: col('#fde047'), discSick: col('#84cc16'), poolZ: col('#2c3a1c'), poolH: col('#6b0f0f'),
    };
    const cSkin = new THREE.Color(), cShirt = new THREE.Color(), cPants = new THREE.Color(), cHair = new THREE.Color(), cTmp = new THREE.Color();
    const rstate = new Map();
    let frameNo = 0;

    function part(im, base, jx, jy, jz, rx, rz, cx, cy, cz, sx, sy, sz, c) {
      _e.set(rx, 0, rz); _q2.setFromEuler(_e);
      _l.compose(_p.set(jx, jy, jz), _q2, ONE);
      _j.multiplyMatrices(base, _l);
      _l2.makeScale(sx, sy, sz).setPosition(cx, cy, cz);
      _m.multiplyMatrices(_j, _l2);
      put(im, _m, c);
    }
    function attach(im, cx, cy, cz, sx, sy, sz, c) {       // adds a piece in the frame of the last joint (e.g. a weapon in the hand)
      _l2.makeScale(sx, sy, sz).setPosition(cx, cy, cz);
      _m.multiplyMatrices(_j, _l2);
      put(im, _m, c);
    }

    function drawFigure(m, e, isZ, dt, night, state) {
      let rs = rstate.get(e.id);
      if (!rs) { rs = { x: e.x, z: e.z, yaw: e.yaw, ph: (e.id * 1.7) % 6.28, y: 0 }; rstate.set(e.id, rs); }
      rs.f = frameNo;
      const ox = rs.x, oz = rs.z;
      rs.x = e.x; rs.z = e.z;   // follow solid physics coordinates directly so nobody visually phases through walls/corners
      let dy = e.yaw - rs.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      rs.yaw += dy * Math.min(1, dt * 9);
      const moved = Math.hypot(rs.x - ox, rs.z - oz);
      const dead = state === 'dead';
      const T2 = isZ ? e.type : '';
      // size and build
      let s = 1, wd = 1;
      const age = e.age;
      if (age < 5) s = 0.42; else if (age < 12) s = 0.5 + (age - 5) * 0.04; else if (age < 16) s = 0.86; else if (age > 60 && !isZ) s = 0.96;
      wd = clamp(1 + ((e.str || 50) - 50) / 230, 0.8, 1.25);
      if (T2 === 'brute') { s *= 1.32; wd = 1.5; }
      else if (T2 === 'behemoth') { s *= 1.85; wd = 1.85; }
      else if (T2 === 'riot') { s *= 1.12; wd = 1.25; }
      rs.ph += moved * (3.4 / s) * (T2 === 'crawler' ? 2.2 : 1);
      const walking = moved > 0.002 && !dead;
      const sw = walking ? Math.sin(rs.ph) : 0;
      // colours
      const lk = e.look;
      if (isZ) {
        cSkin.copy(C.zskin).lerp(C.zrot, e.decay || 0);
        if (T2 === 'feral') cSkin.multiplyScalar(0.7);
        cShirt.copy(PAL.shirt[lk.shirt]).multiplyScalar(0.5).lerp(C.zrot, 0.3 + 0.3 * (e.decay || 0));
        cPants.copy(PAL.pants[lk.pants]).multiplyScalar(0.6);
        cHair.copy(PAL.hair[lk.hair]).multiplyScalar(0.6);
      } else {
        cSkin.copy(PAL.skin[lk.skin]);
        if (e.infected > 0) cSkin.lerp(C.sick, 0.35 + 0.25 * Math.sin(m.t * 4));
        cShirt.copy(PAL.shirt[lk.shirt]); cPants.copy(PAL.pants[lk.pants]);
        if (age > 60) cHair.copy(age > 70 ? C.white : C.grey); else cHair.copy(PAL.hair[lk.hair]);
      }
      if (!dead && m.t - e.lastHit < 0.18) { cSkin.lerp(C.red, 0.6); cShirt.lerp(C.red, 0.45); }
      // posture
      const limp = !isZ && e.handicaps.indexOf('leg') >= 0;
      let lean = 0, y = 0, roll = 0;
      if (isZ) lean = T2 === 'sprinter' ? 0.42 : T2 === 'brute' ? 0.3 : 0.22; else if (age > 65) lean = 0.2; else if (walking) lean = 0.06;
      if (limp) roll = sw * 0.13;
      const onTower = !isZ && e.where === 'base' && e.post.type === 'tower' && Math.hypot(e.x - e.post.x, e.z - e.post.z) < 1.3;
      rs.y += ((onTower ? 4.32 : 0.03) - rs.y) * Math.min(1, dt * 8);
      y = rs.y;
      let px = rs.x, pz = rs.z;
      const carried = !isZ && e.carriedBy;
      if (carried) { const cr = rstate.get(e.carriedBy); if (cr) { px = cr.x - Math.sin(cr.yaw) * 0.28; pz = cr.z - Math.cos(cr.yaw) * 0.28; y = cr.y + 0.78; rs.yaw = cr.yaw; lean = 0.25; } }
      _q.setFromAxisAngle(YAX, rs.yaw);
      if (dead || (e.ragdollT && e.ragdollT > 0)) {
        const t = dead ? (m.t - (e.diedT || 0)) : 1;
        _q.multiply(_q2.setFromAxisAngle(XAX, -Math.PI / 2 * Math.min(1, t * 4)));
        y = 0.22 * s;
      } else if (T2 === 'crawler') { _q.multiply(_q2.setFromAxisAngle(XAX, 1.32)); y = 0.3; }
      else if (lean || roll) { _e.set(lean, 0, roll); _q.multiply(_q2.setFromEuler(_e)); }
      _b.compose(_p.set(px, y, pz), _q, _s.set(s, s, s));
      const base = _b.clone ? baseTmp.copy(_b) : _b;

      // torso, head, hair
      part(imTorso, base, 0, 0.85, 0, 0, 0, 0, 0.31, 0, 0.42 * wd, 0.62, 0.24 * (T2 === 'brute' ? 1.3 : 1), cShirt);
      part(imHead, base, 0, 1.63, 0.01, 0, 0, 0, 0, 0, 0.15, 0.165, 0.155, cSkin);
      if (!isZ || e.id % 5 > 1) attach(imHair, 0, 0.02, -0.01, 0.155, 0.168, 0.16, cHair);
      if (!isZ && e.handicaps.indexOf('vision') >= 0) attach(imProp, 0, 0.03, 0.02, 0.32, 0.06, 0.33, C.bandage);
      if (!isZ && e.handicaps.indexOf('frail') >= 0) attach(imProp, 0, -0.06, 0.13, 0.19, 0.09, 0.06, C.mask);
      if (T2 === 'feral') {
        cTmp.copy(night ? C.eyeNight : C.eyeDay);
        attach(imGlow, -0.06, 0.02, 0.135, 0.04, 0.04, 0.04, cTmp); attach(imGlow, 0.06, 0.02, 0.135, 0.04, 0.04, 0.04, cTmp);
      }
      // legs
      const la = T2 === 'crawler' ? 0.12 : 0.65;
      part(imLimb, base, -0.11 * wd, 0.85, 0, sw * la * (limp ? 0.25 : 1), 0, 0, -0.425, 0, 0.15, 0.85, 0.17, cPants);
      part(imLimb, base, 0.11 * wd, 0.85, 0, -sw * la, 0, 0, -0.425, 0, 0.15, 0.85, 0.17, cPants);
      // arms
      const atk = dead ? 1 : (m.t - e.lastAtk) / 0.3;
      const sx0 = 0.21 * wd + 0.07, aw = T2 === 'brute' ? 0.17 : 0.11;
      let rxL = -sw * 0.6, rxR = sw * 0.6;
      const W = isZ ? null : Sim.WEAPONS[e.weapon];
      const gun = W && !W.melee;
      if (isZ) {
        if (T2 === 'crawler') { rxL = -2.7 + sw * 0.5; rxR = -2.7 - sw * 0.5; }
        else { rxL = -1.3 + Math.sin(rs.ph * 0.5) * 0.14; rxR = -1.3 - Math.sin(rs.ph * 0.5) * 0.14; }
        if (atk < 1) rxR = -2.3 + atk * 1.6;
      } else if (!dead) {
        if (e.carrying) { rxL = -0.9; rxR = -0.9; }
        if (gun && (atk < 3 || e.where !== 'base' || onTower)) { rxR = atk < 1 ? -1.62 + atk * 0.12 : -1.35; if (W.twoHand) rxL = -1.2; }
        else if (atk < 1 && W) rxR = -2.5 + atk * 2.2;
        if (!W && atk < 1) rxR = -1.4;
      }
      const armHurt = !isZ && e.handicaps.indexOf('arm') >= 0;
      part(imLimb, base, -sx0, 1.43, 0, dead ? 0 : rxL, dead ? 0.5 : 0.06, 0, armHurt ? -0.13 : -0.31, 0, aw, armHurt ? 0.26 : 0.62, 0.12, armHurt ? C.bandage : (isZ ? cSkin : cShirt));
      if (!isZ && !dead && age > 66 && !limp && !(W && W.twoHand)) attach(imProp, 0, -0.72, 0.1, 0.035, 0.85, 0.035, C.wood);          // walking cane
      part(imLimb, base, sx0, 1.43, 0, dead ? 0 : rxR, dead ? -0.5 : -0.06, 0, -0.31, 0, aw, 0.62, 0.12, isZ ? cSkin : cShirt);
      if (W && !dead && e.weapon !== 'fists') {
        if (e.weapon === 'knife') attach(imProp, 0, -0.64, 0.14, 0.03, 0.05, 0.3, C.steel);
        else if (e.weapon === 'bat') attach(imProp, 0, -0.62, 0.36, 0.07, 0.07, 0.85, C.wood);
        else if (e.weapon === 'pistol') attach(imProp, 0, -0.66, 0.1, 0.05, 0.13, 0.22, C.gun);
        else attach(imProp, 0, -0.62, 0.42, 0.06, 0.09, e.weapon === 'rifle' ? 1.2 : 0.95, C.gun);
      }
      if (limp && !dead) part(imProp, base, 0.36, 0, 0.12, 0, 0, 0, 0.62, 0, 0.045, 1.24, 0.045, C.steel);                               // crutch
      if (!isZ && !dead && e.bitten && e.infected > 0) part(imProp, base, sx0, 1.2, 0, rxR, 0, 0, 0, 0, 0.13, 0.12, 0.14, C.blood);     // bite wound
      return rs;
    }
    const baseTmp = new THREE.Matrix4();

    // ---------------------------------------------------------------- effects
    const tracerGeo = new THREE.BoxGeometry(1, 1, 1);
    const tracers = [];
    for (let i = 0; i < 70; i++) {
      const t = new THREE.Mesh(tracerGeo, new THREE.MeshBasicMaterial({ color: '#ffe9a8', transparent: true, fog: false }));
      t.visible = false; t.life = 0; scene.add(t); tracers.push(t);
    }
    let tracerI = 0;
    const particles = (function () {
      const max = 1800, pos = new Float32Array(max * 3), colr = new Float32Array(max * 4), size = new Float32Array(max);
      const vel = new Float32Array(max * 3), life = new Float32Array(max), mlife = new Float32Array(max), s0 = new Float32Array(max), a0 = new Float32Array(max), grav = new Float32Array(max);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aColor', new THREE.BufferAttribute(colr, 4));
      geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      const mat = new THREE.ShaderMaterial({
        uniforms: { uScale: { value: 900 } },
        vertexShader: 'attribute vec4 aColor; attribute float aSize; varying vec4 vColor; uniform float uScale; void main(){ vColor=aColor; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mv; gl_PointSize=clamp(aSize*uScale/max(1.0,-mv.z),0.0,256.0); }',
        fragmentShader: 'varying vec4 vColor; void main(){ float d=length(gl_PointCoord-0.5)*2.0; float a=smoothstep(1.0,0.35,d)*vColor.a; if(a<0.01) discard; gl_FragColor=vec4(vColor.rgb,a); }',
        transparent: true, depthWrite: false,
      });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false; pts.renderOrder = 5;
      scene.add(pts);
      let head = 0;
      function emit(x, y, z, vx, vy, vz, lf, sz, r, g, b, a, gr) {
        const i = head; head = (head + 1) % max;
        pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
        vel[i * 3] = vx; vel[i * 3 + 1] = vy; vel[i * 3 + 2] = vz;
        life[i] = mlife[i] = lf; s0[i] = sz; a0[i] = a; grav[i] = gr;
        colr[i * 4] = r; colr[i * 4 + 1] = g; colr[i * 4 + 2] = b; colr[i * 4 + 3] = a; size[i] = sz;
      }
      function update(dt) {
        for (let i = 0; i < max; i++) {
          if (life[i] <= 0) continue;
          life[i] -= dt;
          if (life[i] <= 0) { size[i] = 0; colr[i * 4 + 3] = 0; continue; }
          vel[i * 3 + 1] += grav[i] * dt;
          pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] = Math.max(0.05, pos[i * 3 + 1] + vel[i * 3 + 1] * dt); pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
          const t = 1 - life[i] / mlife[i];
          size[i] = s0[i] * (1 + t * 1.5);
          colr[i * 4 + 3] = a0[i] * (1 - t);
        }
        geo.attributes.position.needsUpdate = true; geo.attributes.aColor.needsUpdate = true; geo.attributes.aSize.needsUpdate = true;
      }
      return { emit, update, mat, max, life };
    })();
    const rnd = (a, b) => a + Math.random() * (b - a);
    function burst(x, y, z, n, sp, lf, sz, r, g, b, a, gr, up) {
      for (let i = 0; i < n; i++) particles.emit(x, y, z, rnd(-sp, sp), rnd(-sp, sp) * 0.6 + (up || 0), rnd(-sp, sp), rnd(lf * 0.6, lf), rnd(sz * 0.6, sz), r, g, b, a, gr);
    }
    function addPool(x, z, r, c) {
      _q.identity();
      _m.compose(_p.set(x, 0.06 + (poolI % 7) * 0.002, z), _q, _s.set(r, 1, r * rnd(0.7, 1.1)));
      const i = poolI % pools.cap; poolI++;
      pools.setMatrixAt(i, _m); pools.setColorAt(i, c);
      pools.count = Math.min(pools.cap, poolI);
      pools.instanceMatrix.needsUpdate = true; pools.instanceColor.needsUpdate = true;
    }
    function handleFx(f) {
      if (f.type === 'shot') {
        const t = tracers[tracerI++ % tracers.length];
        const y0 = f.y, y1 = f.hit ? 1.1 : 0.2;
        const dx = f.tx - f.x, dyy = y1 - y0, dz = f.tz - f.z, len = Math.hypot(dx, dyy, dz) || 1;
        t.position.set(f.x + dx / 2, y0 + dyy / 2, f.z + dz / 2);
        t.lookAt(f.tx, y1, f.tz);
        t.scale.set(0.05, 0.05, len);
        t.visible = true; t.life = 0.09; t.material.opacity = 0.9;
        const k = 0.9 / len;
        burst(f.x + dx * k, y0 + dyy * k, f.z + dz * k, 2, 0.6, 0.09, 1.3, 1, 0.85, 0.4, 0.95, 0);
        if (f.hit) burst(f.tx, 1.1, f.tz, 4, 1.4, 0.45, 0.42, 0.45, 0.04, 0.04, 0.9, -7);
        else burst(f.tx, 0.15, f.tz, 2, 0.8, 0.5, 0.5, 0.55, 0.5, 0.42, 0.6, 0, 0.6);
      } else if (f.type === 'melee') burst(f.x, 1.2, f.z, 4, 1.5, 0.4, 0.4, 0.35, 0.05, 0.04, 0.9, -7);
      else if (f.type === 'bite') burst(f.x, 1.2, f.z, 5, 1.4, 0.45, 0.42, 0.75, 0.05, 0.05, 0.95, -7);
      else if (f.type === 'zdeath') { addPool(f.x, f.z, rnd(0.6, 1.0), C.poolZ); burst(f.x, 0.9, f.z, 6, 1.6, 0.6, 0.55, 0.25, 0.3, 0.12, 0.85, -6); }
      else if (f.type === 'hdeath') { addPool(f.x, f.z, rnd(0.9, 1.3), C.poolH); burst(f.x, 1.0, f.z, 10, 1.8, 0.7, 0.55, 0.7, 0.04, 0.04, 0.95, -6); }
      else if (f.type === 'rise') burst(f.x, 0.6, f.z, 14, 1.2, 1.3, 0.9, 0.45, 0.75, 0.25, 0.7, 0, 1.4);
      else if (f.type === 'breach') burst(f.x, 1.2, f.z, 40, 4, 1.8, 2.2, 0.6, 0.55, 0.47, 0.75, 0, 1.2);
      else if (f.type === 'burn') burst(f.x, 0.6, f.z, 16, 0.9, 1.5, 1.3, 1.0, 0.5, 0.12, 0.85, 0, 2.4);
      else if (f.type === 'blackout') burst(f.x, 1.4, f.z, 28, 2.4, 1.1, 0.8, 1, 0.9, 0.45, 0.95, -4, 1.8);
    }

    // ---------------------------------------------------------------- per-frame update
    const SKY = { day: col('#9cc4e8'), dusk: col('#e59a5b'), night: col('#141f3a') };
    const SUNC = { day: col('#fff6e4'), dusk: col('#ff9a55'), moon: col('#8fa6ff') };
    const HEMI = { day: col('#dfeeff'), night: col('#4a5d9c') };
    const sunDir = new THREE.Vector3();

    function createSoftwareRenderer(canvasEl) {
      const ctx = canvasEl.getContext('2d');
      let cw = 960, ch = 540;
      const off = document.createElement('canvas');
      off.width = cw; off.height = ch;
      const octx = off.getContext('2d');
      let img = octx.createImageData(cw, ch);
      let pix = new Uint32Array(img.data.buffer);
      let zbuf = new Float32Array(cw * ch);
      const vp = new THREE.Matrix4(), mvp = new THREE.Matrix4(), mw = new THREE.Matrix4(), imat = new THREE.Matrix4();
      const ic = new THREE.Color();

      function rasterMesh(geo, mat, worldMat, instCol, maxDistSq, camPos, zBias) {
        if (mat && mat.visible === false) return;
        if (mat && mat.transparent && mat.opacity < 0.22) return;
        const mwE = worldMat.elements;
        if (maxDistSq) {
          const dx = mwE[12] - camPos.x, dz = mwE[14] - camPos.z;
          if (dx * dx + dz * dz > maxDistSq) return;
        }
        const pos = geo.attributes.position;
        if (!pos) return;
        if (!geo.attributes.normal) geo.computeVertexNormals();
        const nArr = geo.attributes.normal.array;
        const pArr = pos.array;
        const baseCol = (mat && mat.color) || WHITE;
        const rBase = instCol ? baseCol.r * instCol.r : baseCol.r;
        const gBase = instCol ? baseCol.g * instCol.g : baseCol.g;
        const bBase = instCol ? baseCol.b * instCol.b : baseCol.b;
        mvp.multiplyMatrices(vp, worldMat);
        const e = mvp.elements;
        const idx = geo.index ? geo.index.array : null;
        const count = idx ? idx.length : pos.count;
        const unlit = !!(mat && mat.isMeshBasicMaterial);

        for (let i = 0; i < count; i += 3) {
          const i0 = (idx ? idx[i] : i) * 3;
          const i1 = (idx ? idx[i + 1] : i + 1) * 3;
          const i2 = (idx ? idx[i + 2] : i + 2) * 3;
          const x0 = pArr[i0], y0 = pArr[i0 + 1], z0 = pArr[i0 + 2];
          const x1 = pArr[i1], y1 = pArr[i1 + 1], z1 = pArr[i1 + 2];
          const x2 = pArr[i2], y2 = pArr[i2 + 1], z2 = pArr[i2 + 2];
          const w0 = e[3] * x0 + e[7] * y0 + e[11] * z0 + e[15];
          const w1 = e[3] * x1 + e[7] * y1 + e[11] * z1 + e[15];
          const w2 = e[3] * x2 + e[7] * y2 + e[11] * z2 + e[15];
          if (w0 <= 0.2 || w1 <= 0.2 || w2 <= 0.2) continue;
          const iw0 = 1 / w0, iw1 = 1 / w1, iw2 = 1 / w2;
          const sx0 = ((e[0] * x0 + e[4] * y0 + e[8] * z0 + e[12]) * iw0 * 0.5 + 0.5) * cw;
          const sy0 = (-(e[1] * x0 + e[5] * y0 + e[9] * z0 + e[13]) * iw0 * 0.5 + 0.5) * ch;
          const sx1 = ((e[0] * x1 + e[4] * y1 + e[8] * z1 + e[12]) * iw1 * 0.5 + 0.5) * cw;
          const sy1 = (-(e[1] * x1 + e[5] * y1 + e[9] * z1 + e[13]) * iw1 * 0.5 + 0.5) * ch;
          const sx2 = ((e[0] * x2 + e[4] * y2 + e[8] * z2 + e[12]) * iw2 * 0.5 + 0.5) * cw;
          const sy2 = (-(e[1] * x2 + e[5] * y2 + e[9] * z2 + e[13]) * iw2 * 0.5 + 0.5) * ch;
          const area = (sx1 - sx0) * (sy2 - sy0) - (sy1 - sy0) * (sx2 - sx0);
          if (Math.abs(area) < 0.15) continue;
          const minX = Math.max(0, Math.floor(Math.min(sx0, sx1, sx2)));
          const maxX = Math.min(cw - 1, Math.ceil(Math.max(sx0, sx1, sx2)));
          const minY = Math.max(0, Math.floor(Math.min(sy0, sy1, sy2)));
          const maxY = Math.min(ch - 1, Math.ceil(Math.max(sy0, sy1, sy2)));
          if (minX > maxX || minY > maxY) continue;
          let lit = 1.0;
          if (!unlit) {
            const nx = mwE[0] * nArr[i0] + mwE[4] * nArr[i0 + 1] + mwE[8] * nArr[i0 + 2];
            const ny = mwE[1] * nArr[i0] + mwE[5] * nArr[i0 + 1] + mwE[9] * nArr[i0 + 2];
            const nz = mwE[2] * nArr[i0] + mwE[6] * nArr[i0 + 1] + mwE[10] * nArr[i0 + 2];
            const nl = Math.hypot(nx, ny, nz) || 1;
            const dot = (nx * sunDir.x + ny * sunDir.y + nz * sunDir.z) / nl;
            lit = Math.max(0.32, Math.min(1.38, hemi.intensity * 0.62 + Math.max(0, dot) * sun.intensity * 0.58));
          }
          const r = Math.min(255, (rBase * 255 * lit) | 0);
          const g = Math.min(255, (gBase * 255 * lit) | 0);
          const b = Math.min(255, (bBase * 255 * lit) | 0);
          const abgr = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
          const zAvg = (iw0 + iw1 + iw2) * 0.3333 + (zBias || 0);
          for (let y = minY; y <= maxY; y++) {
            const row = y * cw;
            for (let x = minX; x <= maxX; x++) {
              const w0e = (sx1 - sx0) * (y - sy0) - (sy1 - sy0) * (x - sx0);
              const w1e = (sx2 - sx1) * (y - sy1) - (sy2 - sy1) * (x - sx1);
              const w2e = (sx0 - sx2) * (y - sy2) - (sy0 - sy2) * (x - sx2);
              if ((w0e >= 0 && w1e >= 0 && w2e >= 0) || (w0e <= 0 && w1e <= 0 && w2e <= 0)) {
                const pIdx = row + x;
                if (zAvg > zbuf[pIdx]) { zbuf[pIdx] = zAvg; pix[pIdx] = abgr; }
              }
            }
          }
        }
      }

      return {
        isSoftware: true,
        shadowMap: { enabled: false },
        info: { render: { calls: 0, triangles: 0 } },
        setPixelRatio() {},
        setSize(w, h) { canvasEl.width = w; canvasEl.height = h; },
        render(scn, camObj) {
          scn.updateMatrixWorld(true);
          camObj.updateMatrixWorld(true);
          camObj.matrixWorldInverse.copy(camObj.matrixWorld).invert();
          vp.multiplyMatrices(camObj.projectionMatrix, camObj.matrixWorldInverse);
          const bg = scn.background || SKY.day;
          const bgAbgr = (0xff000000 | ((Math.min(255, (bg.b * 255) | 0)) << 16) | ((Math.min(255, (bg.g * 255) | 0)) << 8) | (Math.min(255, (bg.r * 255) | 0))) >>> 0;
          pix.fill(bgAbgr);
          zbuf.fill(0);
          const camPos = camObj.position;
          scn.traverse((node) => {
            if (!node.visible) return;
            let cur = node.parent;
            while (cur) { if (!cur.visible) return; cur = cur.parent; }
            if (node.isInstancedMesh) {
              const n = node.count;
              if (n <= 0) return;
              const mat = Array.isArray(node.material) ? node.material[0] : node.material;
              const hasCol = !!node.instanceColor;
              for (let i = 0; i < n; i++) {
                node.getMatrixAt(i, imat);
                mw.multiplyMatrices(node.matrixWorld, imat);
                if (hasCol) node.getColorAt(i, ic);
                rasterMesh(node.geometry, mat, mw, hasCol ? ic : null, 210 * 210, camPos, 0.0012);
              }
            } else if (node.isMesh && node.geometry) {
              const mat = Array.isArray(node.material) ? node.material[0] : node.material;
              rasterMesh(node.geometry, mat, node.matrixWorld, null, 0, camPos, node.userData.swBias || 0);
            }
          });
          octx.putImageData(img, 0, 0);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(off, 0, 0, canvasEl.width, canvasEl.height);
        }
      };
    }

    if (!renderer) renderer = createSoftwareRenderer(canvas);
    const view = { selected: 0, follow: 0, director: true, gate: 0, w: 1, h: 1 };
    let overlayList = [];

    function update(m, dt) {
      frameNo++;
      const t = m.clock / PHASE, night = m.phase === 'night';
      // lighting: d = how much daylight (0 night … 1 day), w = warm dusk/dawn tint
      let d, w;
      if (!night) { d = Math.min(smooth(0, 0.1, t), 1 - 0.8 * smooth(0.85, 1, t)); w = Math.max(1 - smooth(0, 0.12, t), smooth(0.78, 1, t)); }
      else { d = 0.2 * (1 - smooth(0, 0.12, t)); w = 1 - smooth(0, 0.14, t); }
      const a = lerp(0.14, 0.86, t) * Math.PI;
      if (night) sunDir.set(-0.35, 0.8, 0.3); else sunDir.set(Math.cos(a) * 0.9, Math.sin(a) * 0.85 + 0.18, 0.38);
      sunDir.normalize();
      sun.color.copy(SUNC.moon).lerp(cTmp.copy(SUNC.day).lerp(SUNC.dusk, w), smooth(0, 0.35, d));
      sun.intensity = lerp(0.62, 1.55, d);
      hemi.color.copy(HEMI.night).lerp(HEMI.day, d);
      hemi.intensity = lerp(0.62, 0.85, d);
      scene.background.copy(SKY.night).lerp(cTmp.copy(SKY.day).lerp(SKY.dusk, w * 0.8), smooth(0, 0.5, d));
      scene.fog.color.copy(scene.background);
      const dark = 1 - smooth(0.15, 0.7, d);
      const pw = m.power === false ? 0 : 1;   // a blackout kills the floodlights
      for (const f of floods) f.intensity = dark * 2.4 * pw;
      for (const lm of lampMats) lm.emissiveIntensity = dark * 2 * pw;
      fire.visible = HI_Q && !lowQ;
      fire.intensity = (HI_Q && !lowQ) ? dark * (1.6 + Math.sin(m.t * 13) * 0.25) : 0;


      // Dynamic Ant-Farm props, Cutaway roofs, Weather, Crates, Traps, Truck
      if (groundMatRef) {
        if (m.weather === 'snow') groundMatRef.color.set('#cbd5e1');
        else if (m.weather === 'heatwave') groundMatRef.color.set('#8f8b52');
        else groundMatRef.color.set('#6b8e58');
      }
      if (m.weather === 'fog') scene.fog.near = 40, scene.fog.far = 210;
      else scene.fog.near = 160, scene.fog.far = 520;
      if (truckMesh && m.truck) {
        truckMesh.visible = true;
        truckMesh.position.set(m.truck.x, 0.35, m.truck.z);
        truckMesh.rotation.y = m.truck.yaw;
        truckMesh.material.color.set(m.truck.repaired ? '#3b82f6' : '#78350f');
      }
      if (traderMesh) traderMesh.visible = !!m.trader;
      if (genLamp && m.L.generator) {
        const on = m.power !== false && (m.fuel || 0) > 0, low = (m.fuel || 0) < 6;
        genLamp.emissive.set(on ? (low ? '#f59e0b' : '#22c55e') : '#ef4444');
        genLamp.emissiveIntensity = on ? 1.6 + Math.sin(m.t * 9) * 0.3 : (Math.sin(m.t * 6) > 0 ? 1.4 : 0.1);
        if (on && night && frameNo % 5 === 0) burst(m.L.generator.x + 0.45, 2.7, m.L.generator.z - 0.8, 1, 0.2, 1.5, 0.55, 0.3, 0.3, 0.3, 0.45, 0, 1.1);
      }
      if (radioGrp) {
        radioGrp.visible = !!(m.radio && m.radio.built);
        if (radioGrp.visible) { radioDish.rotation.y = m.t * 0.35; radioBlink.emissiveIntensity = m.distress ? (Math.sin(m.t * 10) > 0 ? 3 : 0.2) : (Math.sin(m.t * 2) > 0.9 ? 1.5 : 0.1); }
      }
      if (bodyIm) {
        for (const b of (m.bodies || [])) staticInst(bodyIm, b.x, 0.17, b.z, (b.x * 7.3 + b.z * 3.1) % 6.28, 1, 1, 1, C.zrot);
        flush(bodyIm);
      }
      if (m.burnT > 0 && m.L.burnPit && frameNo % 2 === 0) {
        burst(m.L.burnPit.x, 0.5, m.L.burnPit.z, 2, 0.5, 0.7, 0.9, 1, 0.55, 0.12, 0.85, 0, 2.2);
        burst(m.L.burnPit.x, 1.6, m.L.burnPit.z, 1, 0.4, 2.6, 1.6, 0.16, 0.15, 0.14, 0.55, 0, 1.6);
      }
      if (dogGrp) {
        const d = m.dog;
        dogGrp.visible = !!(d && d.alive);
        if (dogGrp.visible) {
          dogGrp.position.set(d.x, d.mv ? Math.abs(Math.sin(m.t * 15)) * 0.07 : 0, d.z);
          dogGrp.rotation.y = d.yaw;
          dogTail.rotation.y = Math.sin(m.t * (d.bubble ? 24 : 9)) * 0.6;
        }
      }
      if (dynCrateIm) {
        for (const cr of (m.crates || [])) staticInst(dynCrateIm, cr.x, 0.65, cr.z, 0.4, 1.2, 1.2, 1.2, WHITE);
        flush(dynCrateIm);
      }
      if (dynTrapIm) {
        for (const tr of (m.traps || [])) if (tr.armed) staticInst(dynTrapIm, tr.x, 0.22, tr.z, 0, tr.kind === 'mine' ? 0.9 : 1.8, 0.9, tr.kind === 'mine' ? 0.9 : 1.8, tr.kind === 'mine' ? C.red : C.steel);
        flush(dynTrapIm);
      }
      const activeSearchBid = (m.squad && m.squad.state === 'search' && m.squad.route[m.squad.ri]) ? m.squad.route[m.squad.ri].id : -1;
      for (let bid = 0; bid < bldgRoofs.length; bid++) {
        if (bldgRoofs[bid]) bldgRoofs[bid].visible = (bid !== activeSearchBid);
      }

      // walls, gate, turrets, bunker
      const L = m.L;
      let nearGate = false;
      for (const h of m.humans) if (h.alive && Math.abs(h.x) < 4 && Math.abs(h.z - BASE) < 6.5) { nearGate = true; break; }
      const gateSeg = L.segs[2];
      view.gate += ((nearGate && gateSeg.hp > 0 ? 1 : 0) - view.gate) * Math.min(1, dt * 4);
      for (let i = 0; i < L.segs.length; i++) {
        const s = L.segs[i], sm = segMeshes[i], r = s.hp / s.maxHp;
        sm.visible = s.hp > 0; rubble[i].visible = s.hp <= 0;
        if (s.gate) { gateL.rotation.y = -view.gate * 1.45 - (1 - r) * 0.12; gateR.rotation.y = view.gate * 1.45 + (1 - r) * 0.12; }
        else {
          sm.scale.y = 0.6 + 0.4 * r; sm.position.y = 1.6 * sm.scale.y;
          const tilt = (1 - r) * 0.22 * (s.id % 2 ? 1 : -1);
          if (s.nx) sm.rotation.set(0, Math.PI / 2, tilt); else sm.rotation.set(tilt, 0, 0);
          sm.material.color.setScalar(1).multiply(cTmp.set(s.id % 2 ? '#b09a7a' : '#8f9aa2')).multiplyScalar(0.55 + 0.45 * r);
        }
      }
      L.towers.forEach((tw, i) => { turrets[i].visible = tw.turret; if (tw.aim != null) turrets[i].rotation.y = tw.aim; });
      bunkerDoor.visible = m.bunkerHp > 0;
      bunkerMat.opacity = m.bunkerHp > 0 ? 1 : 0.35;

      // figures
      const corpse = new Set();
      for (const c of m.corpses) corpse.add(c.id);
      overlayList = [];
      for (const h of m.humans) {
        if (!h.alive && !corpse.has(h.id)) continue;
        const hidden = h.alive && h.where === 'base' && h.post.type === 'bunker' && m.bunkerHp > 0 && Math.abs(h.x - L.bunker.x) < L.bunker.w / 2 && Math.abs(h.z - L.bunker.z) < L.bunker.d / 2;
        const rs = drawFigure(m, h, false, dt, night, h.alive ? '' : 'dead');
        if (!h.alive) continue;
        if (!hidden && !h.carriedBy) {
          _q.identity();
          _m.compose(_p.set(rs.x, rs.y + 0.02, rs.z), _q, _s.set(0.58, 1, 0.58));
          put(imDisc, _m, h.infected > 0 ? C.discSick : h.escort ? C.discRescue : h.where === 'squad' ? C.discSquad : C.discBase);
        }
        overlayList.push({ e: h, x: rs.x, y: rs.y + (h.carriedBy ? 1.5 : 1.95) * (h.age < 5 ? 0.5 : h.age < 12 ? 0.75 : 1), z: rs.z, hidden });
      }
      for (const z of m.zombies) {
        if (!z.alive) { if (!(m.t - z.diedT < 6)) continue; drawFigure(m, z, true, dt, night, 'dead'); continue; }
        const rs = drawFigure(m, z, true, dt, night, '');
        if (z.id === view.selected || m.t - z.lastHit < 1.5) overlayList.push({ e: z, x: rs.x, y: z.type === 'crawler' ? 0.9 : z.type === 'brute' ? 2.6 : 1.95, z: rs.z, zed: true });
      }
      flush(imTorso); flush(imLimb); flush(imHead); flush(imHair); flush(imProp); flush(imGlow); flush(imDisc);
      if (frameNo % 600 === 0) rstate.forEach((v, k) => { if (v.f < frameNo - 5) rstate.delete(k); });

      // effects
      let n = 0;
      for (const f of m.fx) { if (n++ < 60) handleFx(f); }
      m.fx.length = 0;
      for (const tr of tracers) if (tr.visible) { tr.life -= dt; tr.material.opacity = Math.max(0, tr.life / 0.09); if (tr.life <= 0) tr.visible = false; }
      particles.update(dt);

      // camera
      const sel = view.selected ? rstate.get(view.selected) : null;
      const selE = view.selected ? m.byId && m.byId[view.selected] : null;
      if (sel && selE && (selE.alive || corpse.has(selE.id))) { selRing.visible = true; selRing.position.set(sel.x, sel.y + 0.09, sel.z); selRing.scale.setScalar(selE.type === 'brute' ? 1.5 : 1); }
      else selRing.visible = false;
      let wantDist = cam.dist;
      if (view.follow && sel) { cam.tx += (sel.x - cam.tx) * Math.min(1, dt * 4); cam.tz += (sel.z - cam.tz) * Math.min(1, dt * 4); }
      else if (view.director) {
        let gx = 0, gz = 4, gd = night ? 100 : 92;
        if (m.squad && !night) { gx = m.squad.ax; gz = m.squad.az; gd = 58; }
        cam.tx += (gx - cam.tx) * Math.min(1, dt * 1.2); cam.tz += (gz - cam.tz) * Math.min(1, dt * 1.2);
        cam.dist += (gd - cam.dist) * Math.min(1, dt * 0.9);
        wantDist = cam.dist;
      }
      const dist = wantDist * cam.zoomMul;
      camera.position.set(cam.tx + Math.sin(cam.az) * Math.cos(cam.el) * dist, Math.sin(cam.el) * dist, cam.tz + Math.cos(cam.az) * Math.cos(cam.el) * dist);
      camera.lookAt(cam.tx, 1, cam.tz);
      sun.position.set(cam.tx + sunDir.x * 150, sunDir.y * 150, cam.tz + sunDir.z * 150);
      sun.target.position.set(cam.tx, 0, cam.tz);
      const ext = clamp(dist * 0.75, 45, 120);
      if (Math.abs(sc.right - ext) > 4) { sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.updateProjectionMatrix(); }
    }

    let lowQ = false;
    /** Drops shadows, floodlights and high-DPI rendering so slow machines keep a moving picture. */
    function lowQuality() {
      lowQ = true;
      renderer.shadowMap.enabled = false; sun.castShadow = false;
      for (const f of floods) f.visible = false;
      fire.visible = false;
      renderer.setPixelRatio(1);
      view.w = 0;
    }
    function resize() {
      const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
      if (w === view.w && h === view.h) return;
      view.w = w; view.h = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
      particles.mat.uniforms.uScale.value = h / (2 * Math.tan((camera.fov * Math.PI) / 360));
    }
    function render() { resize(); camera.updateMatrixWorld(); renderer.render(scene, camera); }

    function screen(x, y, z) {
      _v.set(x, y, z).project(camera);
      return { x: (_v.x * 0.5 + 0.5) * view.w, y: (-_v.y * 0.5 + 0.5) * view.h, ok: _v.z < 1 };
    }
    /** Health bars, the selected name tag and the expedition status, drawn on a 2D canvas over the 3D view. */
    function drawOverlay(g, m, showBars) {
      g.clearRect(0, 0, view.w, view.h);
      g.textAlign = 'center';
      for (const o of overlayList) {
        if (o.hidden) continue;
        const p = screen(o.x, o.y, o.z);
        if (!p.ok || p.x < -20 || p.x > view.w + 20 || p.y < 0 || p.y > view.h) continue;
        const e = o.e, sel = e.id === view.selected;
        if (showBars || sel || o.zed) {
          const w = 26, r = clamp(e.hp / e.maxHp, 0, 1);
          g.fillStyle = 'rgba(10,14,22,0.75)'; g.fillRect(p.x - w / 2 - 1, p.y - 4, w + 2, 5);
          g.fillStyle = o.zed ? '#84cc16' : r > 0.6 ? '#22c55e' : r > 0.3 ? '#f59e0b' : '#ef4444';
          g.fillRect(p.x - w / 2, p.y - 3, w * r, 3);
          if (!o.zed && e.infected > 0) { g.fillStyle = '#a3e635'; g.font = '700 11px Inter, sans-serif'; g.fillText('☣', p.x + w / 2 + 7, p.y + 2); }
        }
        if (!o.zed && e.socialBubble) {
          const msg = e.socialLine ? `${e.socialBubble} ${e.socialLine}` : e.socialBubble;
          g.font = '700 11px Inter, sans-serif';
          const tw = Math.min(180, g.measureText(msg).width + 12);
          const by = p.y - (sel ? 34 : 22);
          g.fillStyle = 'rgba(15, 20, 28, 0.88)';
          g.fillRect(p.x - tw / 2, by - 11, tw, 16);
          g.strokeStyle = 'rgba(242, 169, 59, 0.7)'; g.lineWidth = 1;
          g.strokeRect(p.x - tw / 2, by - 11, tw, 16);
          g.fillStyle = '#fef3c7';
          g.fillText(msg, p.x, by + 1);
        }
        if (sel) {
          g.font = '700 12px Inter, sans-serif';
          const label = o.zed ? Sim.ZTYPES[e.type].name + (e.name ? ' (' + e.name + ')' : '') : e.name + ', ' + Math.floor(e.age) + (e.personalityName ? ' · ' + e.personalityName : '');
          g.lineWidth = 3; g.strokeStyle = 'rgba(10,14,22,0.9)'; g.strokeText(label, p.x, p.y - 9);
          g.fillStyle = '#ffe066'; g.fillText(label, p.x, p.y - 9);
        }
      }
      const sq = m.squad;
      if (sq) {
        const p = screen(sq.ax, 4.2, sq.az);
        if (p.ok) {
          const txt = sq.state === 'search' ? 'Searching ' + sq.route[sq.ri].name + '…' : sq.state === 'return' || sq.state === 'enter' ? 'Expedition returning' : sq.state === 'out' ? 'Expedition → ' + sq.route[sq.ri].name : 'Expedition leaving';
          g.font = '700 12px Inter, sans-serif';
          g.lineWidth = 3; g.strokeStyle = 'rgba(10,14,22,0.9)'; g.strokeText(txt, p.x, p.y);
          g.fillStyle = '#67e8f9'; g.fillText(txt, p.x, p.y);
        }
      }
      const tagAt = (x, y, z, txt, colr) => {
        const p = screen(x, y, z);
        if (!p.ok || p.x < -40 || p.x > view.w + 40 || p.y < 0 || p.y > view.h) return;
        g.font = '700 12px Inter, sans-serif';
        g.lineWidth = 3; g.strokeStyle = 'rgba(10,14,22,0.9)'; g.strokeText(txt, p.x, p.y);
        g.fillStyle = colr; g.fillText(txt, p.x, p.y);
      };
      const dog = m.dog;
      if (dog && dog.alive) tagAt(dog.x, 1.25, dog.z, dog.bubble || ('🐕 ' + dog.name), dog.bubble ? '#fde047' : '#fcd34d');
      if (m.distress && m.L.buildings[m.distress.bid]) { const b = m.L.buildings[m.distress.bid]; tagAt(b.x, b.h + 4.5, b.z, '📡 DISTRESS CALL', Math.sin(m.t * 8) > 0 ? '#f87171' : '#fecaca'); }
      if (m.phase === 'night' && m.power === false && m.L.generator) tagAt(m.L.generator.x, 3.4, m.L.generator.z, '⚠ NO POWER', '#f87171');
      if (m.bodies && m.bodies.length >= 5) { const b = m.bodies[0]; tagAt(b.x, 1.2, b.z, '☠ ' + m.bodies.length + ' unburied', '#bef264'); }
    }
    /** Returns the id of the figure nearest to a screen point (0 if none is close). */
    function pick(m, sx, sy) {
      let best = 0, bd = 26;
      const test = (e, y) => {
        const rs = rstate.get(e.id);
        if (!rs) return;
        const p = screen(rs.x, rs.y + y, rs.z);
        if (!p.ok) return;
        const d = Math.hypot(p.x - sx, p.y - sy);
        if (d < bd) { bd = d; best = e.id; }
      };
      for (const h of m.humans) if (h.alive) test(h, 1.0);
      for (const z of m.zombies) if (z.alive) test(z, z.type === 'crawler' ? 0.3 : 1.0);
      return best;
    }


    function screenToWorld(sx, sy) {
      const ndc = new THREE.Vector3((sx / view.w) * 2 - 1, -(sy / view.h) * 2 + 1, 0.5);
      ndc.unproject(camera);
      const dir = ndc.sub(camera.position).normalize();
      const t = -camera.position.y / (dir.y || -0.001);
      return { x: camera.position.x + dir.x * t, z: camera.position.z + dir.z * t };
    }

    return { buildWorld, update, render, drawOverlay, pick, screenToWorld, lowQuality, cam, view, renderer, camera, scene };
  }

  root.OBWorld = { create };
})(typeof self !== 'undefined' ? self : this);
