// Hero: a procedural night-Earth with a glowing network, drawn on a <canvas>. No images, no libraries.
// Land and city lights come from seeded noise; the globe is shaded per pixel from a small equirectangular
// texture (cheap lookups, no trig per frame); arcs and pulses are vector drawing on top.
(function () {
  'use strict';
  const canvas = document.getElementById('earth');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const hero = canvas.parentElement;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const TAU = Math.PI * 2;

  // ---- seeded randomness and noise
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash(x, y, z) {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1103515245);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let fx = x - xi, fy = y - yi, fz = z - zi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    const a = hash(xi, yi, zi), b = hash(xi + 1, yi, zi), c = hash(xi, yi + 1, zi), d = hash(xi + 1, yi + 1, zi);
    const e = hash(xi, yi, zi + 1), f = hash(xi + 1, yi, zi + 1), g = hash(xi, yi + 1, zi + 1), h = hash(xi + 1, yi + 1, zi + 1);
    const x1 = a + (b - a) * fx, x2 = c + (d - c) * fx, x3 = e + (f - e) * fx, x4 = g + (h - g) * fx;
    const y1 = x1 + (x2 - x1) * fy, y2 = x3 + (x4 - x3) * fy;
    return y1 + (y2 - y1) * fz;
  }
  function fbm(x, y, z, oct) {
    let sum = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += amp * vnoise(x * f + i * 17.31, y * f + i * 5.7, z * f + i * 11.13);
      norm += amp; f *= 2.03; amp *= 0.5;
    }
    return sum / norm;
  }

  // ---- palette
  const WARM = [[255, 232, 186], [244, 162, 97], [239, 131, 84], [232, 184, 125]];
  const TILT = 0.32; // axial tilt, radians
  const sinT = Math.sin(TILT), cosT = Math.cos(TILT);

  // ---- texture (land mask) and cities
  const TW = 1280, TH = 640, SEA = 104; // height values at or above SEA are land
  const tex = new Uint8Array(TW * TH);
  let cities = [], hubs = [], arcs = [], ripples = [];
  let texReady = false, fadeStart = 0;

  function genTexture(done) {
    const OX = 3.7, OY = 1.3, OZ = 8.1;
    let row = 0;
    function slice() {
      const end = Math.min(TH, row + (reduce ? TH : 48));
      for (; row < end; row++) {
        const lat = (0.5 - (row + 0.5) / TH) * Math.PI;
        const y = Math.sin(lat), r = Math.cos(lat);
        for (let i = 0; i < TW; i++) {
          const phi = ((i + 0.5) / TW) * TAU;
          const x = r * Math.sin(phi), z = r * Math.cos(phi);
          let v = fbm(x * 1.9 + OX, y * 1.9 + OY, z * 1.9 + OZ, 7);
          v += (fbm(x * 7 + 2, y * 7 + 9, z * 7 + 4, 3) - 0.5) * 0.3; // ragged coasts and islands
          v -= 0.3 * Math.pow(Math.abs(y), 5); // less land at the poles
          tex[row * TW + i] = Math.max(0, Math.min(255, Math.round(((v - 0.25) / 0.6) * 255)));
        }
      }
      if (row < TH) setTimeout(slice, 0); else done();
    }
    slice();
  }

  function landAt(x, y, z) {
    const lat = Math.asin(y);
    let phi = Math.atan2(x, z); if (phi < 0) phi += TAU;
    const j = Math.min(TH - 1, Math.max(0, Math.floor((0.5 - lat / Math.PI) * TH)));
    return tex[j * TW + Math.min(TW - 1, Math.floor((phi / TAU) * TW))] - SEA; // >= 0 is land
  }

  function buildCities() {
    const rand = rng(20261019);
    const list = [];
    let tries = 0;
    while (list.length < 2400 && tries < 260000) {
      tries++;
      const z = rand() * 2 - 1, a = rand() * TAU, r = Math.sqrt(1 - z * z);
      const x = r * Math.cos(a), y = z, zz = r * Math.sin(a);
      if (landAt(x, y, zz) < 6) continue;
      if (Math.abs(y) > 0.86) continue;
      const p = fbm(x * 3.3 + 7, y * 3.3 + 2, zz * 3.3 + 5, 4);
      const need = 0.42;
      if (p < need) continue;
      const inten = Math.min(1, (p - need) / 0.2);
      if (rand() > 0.3 + inten * 0.7) continue;
      list.push([x, y, zz, inten]);
    }
    // each point seeds a small cluster, so lights bunch up like real settlements
    const out = [];
    for (const c of list) {
      out.push({ x: c[0], y: c[1], z: c[2], i: c[3], c: Math.floor(rand() * WARM.length) });
      const n = Math.floor(3 + c[3] * 9);
      for (let k = 0; k < n; k++) {
        const sp = 0.03 + c[3] * 0.04; const dx = (rand() - 0.5) * sp, dy = (rand() - 0.5) * sp, dz = (rand() - 0.5) * sp;
        let x = c[0] + dx, y = c[1] + dy, z = c[2] + dz;
        const m = Math.hypot(x, y, z); x /= m; y /= m; z /= m;
        if (landAt(x, y, z) < 3) continue;
        out.push({ x, y, z, i: c[3] * rand() * 0.8, c: Math.floor(rand() * WARM.length) });
      }
    }
    cities = out;
    // hubs: the brightest, spread apart
    const sorted = list.slice().sort((a, b) => b[3] - a[3]);
    hubs = [];
    for (const c of sorted) {
      if (hubs.length >= 24) break;
      if (hubs.every((h) => h[0] * c[0] + h[1] * c[1] + h[2] * c[2] < Math.cos(0.3))) hubs.push(c);
    }
    // arcs between hubs: great circles lifted off the surface
    arcs = [];
    const seen = new Set();
    for (let i = 0; i < hubs.length; i++) {
      const links = 2;
      for (let l = 0; l < links; l++) {
        const j = Math.floor(rand() * hubs.length);
        const key = Math.min(i, j) + '-' + Math.max(i, j);
        if (i === j || seen.has(key)) continue;
        const a = hubs[i], b = hubs[j];
        const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
        const om = Math.acos(dot);
        if (om < 0.45 || om > 2.5) continue;
        seen.add(key);
        const N = 56, pts = new Float32Array(N * 3);
        for (let s = 0; s < N; s++) {
          const t = s / (N - 1), so = Math.sin(om);
          const ka = Math.sin((1 - t) * om) / so, kb = Math.sin(t * om) / so;
          const lift = 1 + 0.34 * Math.pow(om / Math.PI, 0.9) * Math.sin(Math.PI * t) + 0.012;
          pts[s * 3] = (ka * a[0] + kb * b[0]) * lift;
          pts[s * 3 + 1] = (ka * a[1] + kb * b[1]) * lift;
          pts[s * 3 + 2] = (ka * a[2] + kb * b[2]) * lift;
        }
        arcs.push({ pts, N, a, b, head: -1, speed: 0.22 + rand() * 0.25, wait: rand() * 6, rev: rand() < 0.5 });
      }
    }
  }

  // ---- layout and per-pixel precompute
  let W = 0, H = 0, DPR = 1, R = 0, CX = 0, CY = 0, scale = 1;
  let bg = null, glow = null;
  let D = 0, base = null, bctx = null, img = null, px32 = null;
  let pk = 0, pPhi, pR0, pR1, pFr, pCode, pIdx;
  const LUT = new Uint32Array(64 * 2048);

  function buildLUT() {
    for (let hq = 0; hq < 64; hq++) {
      let br, bgc, bb;
      if (hq === 0) { br = 9; bgc = 18; bb = 38; }
      else {
        const shore = Math.max(0, 1 - hq / 4);
        const elev = Math.min(1, hq / 22);
        br = 17 + shore * 14 + elev * 16; bgc = 29 + shore * 16 + elev * 18; bb = 49 + shore * 18 + elev * 16;
      }
      for (let code = 0; code < 2048; code++) {
        const shade = 0.5 + 0.62 * ((code & 15) / 15);
        const rim = ((code >> 4) & 31) / 31;
        const warm = ((code >> 9) & 3) / 3;
        let r = br * shade, g = bgc * shade, b = bb * shade;
        // atmosphere at the limb: cool blue, with a sunrise tint on the lit side
        const k = rim * rim;
        r += k * (44 + warm * 150); g += k * (78 + warm * 66); b += k * (150 - warm * 50);
        LUT[hq * 2048 + code] = (255 << 24) | (Math.min(255, b) << 16) | (Math.min(255, g) << 8) | Math.min(255, r);
      }
    }
  }

  function layout() {
    const rect = hero.getBoundingClientRect();
    W = Math.max(320, Math.round(rect.width)); H = Math.max(360, Math.round(rect.height));
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const wide = W >= 880;
    if (wide) { R = Math.min(H * 0.5, W * 0.3); CX = W * 0.73; CY = H * 0.6; }
    else { R = Math.min(W * 0.72, 420); CX = W * 0.5; CY = H + R * 0.3; }
    scale = Math.max(0.75, Math.min(1.5, R / 460));
    drawBackground();
    // sphere pixel grid
    D = Math.min(Math.ceil(2 * R * Math.min(DPR, 1.25)), W < 700 ? 520 : 760);
    base = document.createElement('canvas'); base.width = D; base.height = D;
    bctx = base.getContext('2d'); img = bctx.createImageData(D, D); px32 = new Uint32Array(img.data.buffer);
    const total = D * D;
    pPhi = new Float32Array(total); pR0 = new Int32Array(total); pR1 = new Int32Array(total); pFr = new Float32Array(total); pCode = new Uint16Array(total); pIdx = new Int32Array(total);
    pk = 0;
    const L = [-0.5, 0.5, 0.72]; const lm = Math.hypot(L[0], L[1], L[2]); L[0] /= lm; L[1] /= lm; L[2] /= lm;
    const SUN = [-0.62, 0.55, 0.35]; const sm = Math.hypot(SUN[0], SUN[1], SUN[2]); SUN[0] /= sm; SUN[1] /= sm; SUN[2] /= sm;
    for (let j = 0; j < D; j++) {
      const ny = -(2 * (j + 0.5) / D - 1);
      for (let i = 0; i < D; i++) {
        const nx = 2 * (i + 0.5) / D - 1;
        const r2 = nx * nx + ny * ny;
        if (r2 >= 1) continue;
        const nz = Math.sqrt(1 - r2);
        const y2 = ny * cosT - nz * sinT, z2 = ny * sinT + nz * cosT;
        const lat = Math.asin(Math.max(-1, Math.min(1, y2)));
        let phi = Math.atan2(nx, z2);
        const dl = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
        const shade = Math.round(15 * (0.15 + 0.85 * Math.pow(dl, 0.8)));
        const fres = Math.pow(1 - nz, 2.8);
        const rim = Math.min(31, Math.round(31 * Math.min(1, fres * 1.3)));
        const sun = Math.max(0, nx * SUN[0] + ny * SUN[1] + nz * SUN[2]);
        const warm = Math.min(3, Math.round(3 * Math.pow(sun, 1.6)));
        pPhi[pk] = phi;
        const rv = Math.min(TH - 1.001, Math.max(0, (0.5 - lat / Math.PI) * TH - 0.5));
        const r0 = Math.floor(rv);
        pR0[pk] = r0 * TW; pR1[pk] = (r0 + 1) * TW; pFr[pk] = rv - r0;
        pCode[pk] = shade | (rim << 4) | (warm << 9);
        pIdx[pk] = j * D + i;
        pk++;
      }
    }
    lastBaseYaw = 1e9;
  }

  // static layer: sky, stars, atmosphere halo
  function drawBackground() {
    bg = document.createElement('canvas'); bg.width = Math.round(W * DPR); bg.height = Math.round(H * DPR);
    const b = bg.getContext('2d'); b.scale(DPR, DPR);
    const sky = b.createRadialGradient(CX, CY, R * 0.4, W * 0.5, H * 0.4, Math.max(W, H) * 0.95);
    sky.addColorStop(0, '#0e1a30'); sky.addColorStop(0.5, '#0a1322'); sky.addColorStop(1, '#070b14');
    b.fillStyle = sky; b.fillRect(0, 0, W, H);
    const rand = rng(77);
    const n = Math.round((W * H) / 2600);
    for (let i = 0; i < n; i++) {
      const x = rand() * W, y = rand() * H, m = rand();
      const dx = x - CX, dy = y - CY;
      if (dx * dx + dy * dy < R * R * 1.05) continue;
      b.globalAlpha = 0.15 + m * m * 0.7;
      b.fillStyle = m > 0.93 ? '#ffe9c8' : m > 0.8 ? '#cfe0ff' : '#e8eefc';
      const s = m > 0.97 ? 1.8 : m > 0.85 ? 1.2 : 0.8;
      b.fillRect(x, y, s, s);
    }
    b.globalAlpha = 1;
    // halo
    const halo = b.createRadialGradient(CX, CY, R * 0.97, CX, CY, R * 1.22);
    halo.addColorStop(0, 'rgba(96,140,225,0.34)'); halo.addColorStop(0.2, 'rgba(70,110,200,0.14)'); halo.addColorStop(1, 'rgba(60,100,190,0)');
    b.fillStyle = halo; b.beginPath(); b.arc(CX, CY, R * 1.22, 0, TAU); b.fill();
    // sunrise on the lit limb: a warm ring, faded out away from the upper left
    if (b.createConicGradient) {
      const pad = Math.ceil(R * 1.4), S = pad * 2;
      const t = document.createElement('canvas'); t.width = S; t.height = S;
      const tc = t.getContext('2d');
      const ring = tc.createRadialGradient(pad, pad, R * 0.975, pad, pad, R * 1.2);
      ring.addColorStop(0, 'rgba(255,190,130,0)'); ring.addColorStop(0.06, 'rgba(255,190,130,0.75)'); ring.addColorStop(0.25, 'rgba(239,131,84,0.26)'); ring.addColorStop(1, 'rgba(239,131,84,0)');
      tc.fillStyle = ring; tc.fillRect(0, 0, S, S);
      const ang = Math.atan2(-0.58, -0.8); // upper left
      const con = tc.createConicGradient(ang - Math.PI, pad, pad); // starts opposite, peaks at 0.5
      con.addColorStop(0, 'rgba(0,0,0,0)'); con.addColorStop(0.33, 'rgba(0,0,0,0)'); con.addColorStop(0.5, 'rgba(0,0,0,1)'); con.addColorStop(0.67, 'rgba(0,0,0,0)'); con.addColorStop(1, 'rgba(0,0,0,0)');
      tc.globalCompositeOperation = 'destination-in';
      tc.fillStyle = con; tc.fillRect(0, 0, S, S);
      b.globalCompositeOperation = 'lighter';
      b.drawImage(t, CX - pad, CY - pad);
      b.globalCompositeOperation = 'source-over';
    }
    // dark body under the base render (so the disc exists before the texture is ready)
    const body = b.createRadialGradient(CX - R * 0.3, CY - R * 0.3, R * 0.1, CX, CY, R);
    body.addColorStop(0, '#0d1a2e'); body.addColorStop(1, '#050913');
    b.fillStyle = body; b.beginPath(); b.arc(CX, CY, R, 0, TAU); b.fill();

    // light sprite
    glow = document.createElement('canvas'); glow.width = glow.height = 64;
    const g = glow.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,220,160,0.9)'); gr.addColorStop(0.25, 'rgba(244,162,97,0.4)'); gr.addColorStop(1, 'rgba(239,131,84,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  }

  // ---- per-frame drawing
  let yaw = 0.9, lastBaseYaw = 1e9;
  const INV = 1 / TAU;

  function renderBase() {
    for (let k = 0; k < pk; k++) {
      let u = (pPhi[k] + yaw) * INV;
      u -= Math.floor(u);
      let x = u * TW - 0.5;
      if (x < 0) x += TW;
      const c0 = x | 0, fc = x - c0, c1 = c0 + 1 === TW ? 0 : c0 + 1;
      const r0 = pR0[k], r1 = pR1[k];
      const a = tex[r0 + c0], b = tex[r0 + c1], c = tex[r1 + c0], d = tex[r1 + c1];
      const top = a + (b - a) * fc, bot = c + (d - c) * fc;
      const t = top + (bot - top) * pFr[k] - SEA;
      const hq = t < 0 ? 0 : Math.min(63, 1 + (t >> 2));
      px32[pIdx[k]] = LUT[hq * 2048 + pCode[k]];
    }
    bctx.putImageData(img, 0, 0);
    lastBaseYaw = yaw;
  }

  const cy_ = Math.cos, sy_ = Math.sin;
  let cs = 1, sn = 0; // cos/sin of yaw for this frame
  function proj(x, y, z, out) {
    const x1 = x * cs - z * sn, z1 = z * cs + x * sn;
    out[0] = x1; out[1] = y * cosT + z1 * sinT; out[2] = -y * sinT + z1 * cosT;
  }
  const P = [0, 0, 0];

  function frame(t) {
    cs = cy_(yaw); sn = sy_(yaw);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(bg, 0, 0, W, H);

    const fade = texReady ? Math.min(1, (t - fadeStart) / 1400) : 0;
    if (texReady) {
      if (Math.abs(yaw - lastBaseYaw) > 0.0012) renderBase();
      ctx.globalAlpha = fade;
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(base, CX - R, CY - R, 2 * R, 2 * R);
      ctx.globalAlpha = 1;
    }
    if (!texReady) return;

    ctx.globalCompositeOperation = 'lighter';
    // city lights
    for (let c = 0; c < WARM.length; c++) {
      const col = WARM[c];
      ctx.fillStyle = 'rgb(' + col[0] + ',' + col[1] + ',' + col[2] + ')';
      for (let k = 0; k < cities.length; k++) {
        const ct = cities[k];
        if (ct.c !== c) continue;
        proj(ct.x, ct.y, ct.z, P);
        if (P[2] <= 0.03) continue;
        const a = Math.min(1, P[2] * 1.6) * (0.45 + ct.i * 0.55) * fade;
        const s = (0.9 + ct.i * 1.3) * scale;
        ctx.globalAlpha = a;
        ctx.fillRect(CX + P[0] * R - s / 2, CY - P[1] * R - s / 2, s, s);
      }
    }
    // soft glow on the brightest places
    for (let k = 0; k < hubs.length; k++) {
      const h = hubs[k];
      proj(h[0], h[1], h[2], P);
      if (P[2] <= 0.03) continue;
      const tw = 0.75 + 0.25 * Math.sin(t * 0.0013 + k * 1.7);
      ctx.globalAlpha = Math.min(1, P[2] * 1.5) * 0.85 * tw * fade;
      const s = 26 * scale;
      ctx.drawImage(glow, CX + P[0] * R - s / 2, CY - P[1] * R - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    drawArcs(t, fade);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  function visible(p) { return p[2] > 0 || p[0] * p[0] + p[1] * p[1] > 1; }

  function arcPoint(a, s, out) { proj(a.pts[s * 3], a.pts[s * 3 + 1], a.pts[s * 3 + 2], out); }

  function drawArcs(t, fade) {
    // faint standing lines
    ctx.lineWidth = 0.9 * scale; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(239,131,84,0.3)'; ctx.globalAlpha = fade;
    ctx.beginPath();
    const Q = [0, 0, 0];
    for (const a of arcs) {
      let pen = false;
      for (let s = 0; s < a.N; s++) {
        arcPoint(a, s, Q);
        if (!visible(Q)) { pen = false; continue; }
        const x = CX + Q[0] * R, y = CY - Q[1] * R;
        if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        pen = true;
      }
    }
    ctx.stroke();

    // pulses
    const dt = 1 / 60;
    for (const a of arcs) {
      if (!reduce) {
        if (a.head < 0) { a.wait -= dt; if (a.wait <= 0) { a.head = 0; } }
        else {
          a.head += a.speed * dt;
          if (a.head > 1.25) {
            a.head = -1; a.wait = 1.5 + Math.random() * 7;
            const e = a.rev ? a.a : a.b;
            ripples.push({ x: e[0], y: e[1], z: e[2], t0: t });
            if (ripples.length > 12) ripples.shift();
          }
        }
      }
      if (a.head < 0) continue;
      drawPulse(a, a.head, fade);
    }
    // arrival ripples
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i], age = (t - rp.t0) / 1600;
      if (age > 1) { ripples.splice(i, 1); continue; }
      proj(rp.x, rp.y, rp.z, Q);
      if (Q[2] <= 0.05) continue;
      ctx.globalAlpha = (1 - age) * 0.7 * Math.min(1, Q[2] * 2) * fade;
      ctx.strokeStyle = 'rgb(244,162,97)'; ctx.lineWidth = 1 * scale;
      ctx.beginPath(); ctx.ellipse(CX + Q[0] * R, CY - Q[1] * R, (3 + age * 16) * scale, (3 + age * 16) * scale * Math.max(0.35, Q[2]), 0, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawPulse(a, head, fade) {
    const Q = [0, 0, 0], N = a.N, tail = 0.2;
    const seg = 10;
    let prev = null;
    for (let i = 0; i <= seg; i++) {
      let u = head - tail + (tail * i) / seg;
      if (u < 0 || u > 1) { prev = null; continue; }
      if (a.rev) u = 1 - u;
      const f = u * (N - 1), s0 = Math.floor(f), s1 = Math.min(N - 1, s0 + 1), w = f - s0;
      arcPoint(a, s0, Q); const ax = Q[0], ay = Q[1], az = Q[2];
      arcPoint(a, s1, Q);
      const p = [ax + (Q[0] - ax) * w, ay + (Q[1] - ay) * w, az + (Q[2] - az) * w];
      if (!visible(p)) { prev = null; continue; }
      const x = CX + p[0] * R, y = CY - p[1] * R;
      if (prev) {
        const k = i / seg;
        ctx.globalAlpha = k * k * 0.95 * fade;
        ctx.strokeStyle = k > 0.8 ? 'rgb(255,226,176)' : 'rgb(244,162,97)';
        ctx.lineWidth = (0.8 + 1.6 * k) * scale;
        ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(x, y); ctx.stroke();
      }
      prev = [x, y];
      if (i === seg && head <= 1) {
        const gs = 14 * scale;
        ctx.globalAlpha = 0.9 * fade;
        ctx.drawImage(glow, x - gs / 2, y - gs / 2, gs, gs);
      }
    }
  }

  // ---- loop, visibility, resize
  let running = false, onscreen = true, last = 0, raf = 0;
  function loop(t) {
    raf = 0;
    if (!running) return;
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0.016;
    last = t;
    yaw -= 0.022 * dt;
    frame(t);
    raf = requestAnimationFrame(loop);
  }
  function start() { if (reduce || running || !onscreen || document.hidden) return; running = true; last = 0; raf = requestAnimationFrame(loop); }
  function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }

  if ('IntersectionObserver' in window) {
    new IntersectionObserver((e) => { onscreen = e[0].isIntersecting; onscreen ? start() : stop(); }).observe(hero);
  }
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { layout(); if (texReady) { if (reduce) staticFrame(); } else drawBackground(); }, 150);
  });

  function staticFrame() {
    // reduced motion: one still frame, with a few pulses frozen mid-flight
    yaw = 0.9; lastBaseYaw = 1e9;
    arcs.forEach((a, i) => { a.head = i % 3 === 0 ? 0.35 + (i % 5) * 0.12 : -1; });
    fadeStart = -1e9;
    frame(1e9);
  }

  buildLUT();
  layout();
  // first paint: sky, stars and a dark globe, then the land arrives
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.drawImage(bg, 0, 0, W, H);
  genTexture(() => {
    buildCities();
    texReady = true; fadeStart = performance.now();
    if (reduce) staticFrame(); else start();
  });
})();
