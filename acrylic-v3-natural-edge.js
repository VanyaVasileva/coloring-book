(() => {
  'use strict';

  const host = document.getElementById('cityBase');
  if (!host) return;

  let attachedDoc = null;
  let pollTimer = null;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smoothstep = (a, b, x) => {
    x = clamp((x - a) / Math.max(0.0001, b - a), 0, 1);
    return x * x * (3 - 2 * x);
  };

  function tryAttach() {
    let baseDoc, inner, d, w;
    try {
      baseDoc = host.contentDocument;
      inner = baseDoc && baseDoc.getElementById('app');
      d = inner && inner.contentDocument;
      w = inner && inner.contentWindow;
    } catch (_) {
      return false;
    }
    if (!d || !w || !d.documentElement) return false;
    if (d.documentElement.dataset.naturalEdgeV4 === '1') return true;

    const paint = d.getElementById('paint');
    const size = d.getElementById('size');
    const color = d.getElementById('color');
    const paintBtn = d.getElementById('paintBtn');
    const moveBtn = d.getElementById('moveBtn');
    const eraseBtn = d.getElementById('eraseBtn');
    const fillBtn = d.getElementById('fillBtnV3');
    if (!paint || !size || !color || !paintBtn || !moveBtn || !eraseBtn || !fillBtn || !paint.width || !paint.height) return false;

    d.documentElement.dataset.naturalEdgeV4 = '1';
    attachedDoc = d;

    const ctx = paint.getContext('2d', {alpha: true, desynchronized: true});
    let edgeSession = null;
    const edgePointers = new Set();

    function toolKind() {
      if (fillBtn.classList.contains('fillActiveV3')) return 'fill';
      if (moveBtn.classList.contains('active')) return 'move';
      if (eraseBtn.classList.contains('active')) return 'erase';
      return 'paint';
    }

    function pointFromEvent(e) {
      const r = paint.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * paint.width / Math.max(1, r.width),
        y: (e.clientY - r.top) * paint.height / Math.max(1, r.height),
        pressure: e.pressure > 0 ? e.pressure : 0.5,
        time: e.timeStamp || 0
      };
    }

    function hexRgb(hex) {
      return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    }

    function pressureFactor(p) {
      return clamp(0.91 + (p ?? 0.5) * 0.18, 0.92, 1.09);
    }

    function expandSession(s, p) {
      const pad = s.brush * 0.84 + 10;
      s.minX = Math.min(s.minX, p.x - pad);
      s.minY = Math.min(s.minY, p.y - pad);
      s.maxX = Math.max(s.maxX, p.x + pad);
      s.maxY = Math.max(s.maxY, p.y + pad);
    }

    function capturePoint(s, p) {
      expandSession(s, p);
      const last = s.points[s.points.length - 1];
      const minStep = Math.max(0.8, s.brush * 0.018);
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= minStep) {
        s.points.push(p);
      } else {
        s.points[s.points.length - 1] = {...last, x: p.x, y: p.y, pressure: p.pressure, time: p.time};
      }
    }

    function smoothPoints(points) {
      if (points.length < 3) return points.map(p => ({...p}));
      const out = points.map(p => ({...p}));
      for (let i = 1; i < points.length - 1; i++) {
        out[i].x = points[i - 1].x * 0.14 + points[i].x * 0.72 + points[i + 1].x * 0.14;
        out[i].y = points[i - 1].y * 0.14 + points[i].y * 0.72 + points[i + 1].y * 0.14;
        out[i].pressure = points[i - 1].pressure * 0.12 + points[i].pressure * 0.76 + points[i + 1].pressure * 0.12;
      }
      return out;
    }

    function resamplePoints(points, step) {
      if (points.length < 2) return points.map((p, i) => ({...p, dist: i ? 0 : 0}));
      const lengths = [0];
      let total = 0;
      for (let i = 1; i < points.length; i++) {
        total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
        lengths[i] = total;
      }
      const out = [{...points[0], dist: 0}];
      if (total < 0.1) return out;
      for (let target = step; target < total; target += step) {
        let i = 1;
        while (i < lengths.length && lengths[i] < target) i++;
        const a = points[i - 1];
        const b = points[Math.min(i, points.length - 1)];
        const span = Math.max(0.001, lengths[i] - lengths[i - 1]);
        const q = (target - lengths[i - 1]) / span;
        out.push({
          x: a.x + (b.x - a.x) * q,
          y: a.y + (b.y - a.y) * q,
          pressure: a.pressure + (b.pressure - a.pressure) * q,
          dist: target
        });
      }
      out.push({...points[points.length - 1], dist: total});
      return out;
    }

    function envelopeLayer(samples, total, brush, x, y, ww, hh, widthMul) {
      const c = d.createElement('canvas');
      c.width = ww;
      c.height = hh;
      const m = c.getContext('2d');
      m.fillStyle = '#000';
      const shortStroke = total < brush * 0.9;
      const taperLen = Math.min(brush * 0.72, total * 0.34);
      const endMin = shortStroke ? 0.78 : 0.56;
      for (const p of samples) {
        const start = taperLen > 0 ? endMin + (1 - endMin) * smoothstep(0, taperLen, p.dist) : 1;
        const remain = total - p.dist;
        const end = taperLen > 0 ? endMin + (1 - endMin) * smoothstep(0, taperLen, remain) : 1;
        const taper = Math.min(start, end);
        const r = brush * 0.47 * pressureFactor(p.pressure) * taper * widthMul;
        if (r < 0.35) continue;
        m.beginPath();
        m.arc(p.x - x, p.y - y, r, 0, Math.PI * 2);
        m.fill();
      }
      return c;
    }

    function buildEnvelope(s, x, y, ww, hh) {
      const smooth = smoothPoints(s.points || []);
      const samples = resamplePoints(smooth, Math.max(0.85, s.brush * 0.022));
      const total = samples.length ? (samples[samples.length - 1].dist || 0) : 0;
      const final = d.createElement('canvas');
      final.width = ww;
      final.height = hh;
      const f = final.getContext('2d');

      const outer = envelopeLayer(samples, total, s.brush, x, y, ww, hh, 1.02);
      const mid = envelopeLayer(samples, total, s.brush, x, y, ww, hh, 0.98);
      const core = envelopeLayer(samples, total, s.brush, x, y, ww, hh, 0.94);
      const safe = envelopeLayer(samples, total, s.brush, x, y, ww, hh, 0.78);

      f.globalAlpha = 0.18;
      f.drawImage(outer, 0, 0);
      f.globalAlpha = 0.44;
      f.drawImage(mid, 0, 0);
      f.globalAlpha = 1;
      f.drawImage(core, 0, 0);

      return {
        mask: f.getImageData(0, 0, ww, hh).data,
        safe: safe.getContext('2d').getImageData(0, 0, ww, hh).data
      };
    }

    function naturalizeStroke(s) {
      if (!s || s.cancelled || !s.points || !s.points.length) return;
      const W = paint.width;
      const H = paint.height;
      const x = Math.max(0, Math.floor(s.minX));
      const y = Math.max(0, Math.floor(s.minY));
      const x2 = Math.min(W, Math.ceil(s.maxX));
      const y2 = Math.min(H, Math.ceil(s.maxY));
      const ww = x2 - x;
      const hh = y2 - y;
      if (ww < 2 || hh < 2) return;

      let before, after;
      try {
        before = s.base.getContext('2d', {willReadFrequently: true}).getImageData(x, y, ww, hh);
        after = ctx.getImageData(x, y, ww, hh);
      } catch (_) {
        return;
      }

      const env = buildEnvelope(s, x, y, ww, hh);
      const mask = env.mask;
      const safe = env.safe;
      const bd = before.data;
      const ad = after.data;
      const total = ww * hh;
      const sourceAlpha = new Uint8Array(total);
      const hmax = new Uint8Array(total);
      const localMax = new Uint8Array(total);

      for (let i = 0; i < total; i++) {
        const k = i * 4;
        const bA = bd[k + 3] / 255;
        const aA = ad[k + 3] / 255;
        if (bA < 0.985 && aA > bA + 0.0015) {
          sourceAlpha[i] = Math.round(clamp((aA - bA) / Math.max(0.001, 1 - bA), 0, 1) * 255);
        }
      }

      const radius = Math.max(1, Math.min(3, Math.round(s.brush * 0.04)));
      for (let yy = 0; yy < hh; yy++) {
        const row = yy * ww;
        for (let xx = 0; xx < ww; xx++) {
          let mx = 0;
          const a = Math.max(0, xx - radius);
          const b = Math.min(ww - 1, xx + radius);
          for (let q = a; q <= b; q++) mx = Math.max(mx, sourceAlpha[row + q]);
          hmax[row + xx] = mx;
        }
      }
      for (let yy = 0; yy < hh; yy++) {
        for (let xx = 0; xx < ww; xx++) {
          let mx = 0;
          const a = Math.max(0, yy - radius);
          const b = Math.min(hh - 1, yy + radius);
          for (let q = a; q <= b; q++) mx = Math.max(mx, hmax[q * ww + xx]);
          localMax[yy * ww + xx] = mx;
        }
      }

      const [pickR, pickG, pickB] = s.rgb.map(v => v / 255);
      let touched = 0;
      for (let i = 0; i < total; i++) {
        const k = i * 4;
        const m = mask[k + 3] / 255;
        const bA = bd[k + 3] / 255;
        const aA = ad[k + 3] / 255;
        const originalSA = sourceAlpha[i] / 255;
        const near = localMax[i] / 255;
        const insideSafe = safe[k + 3] > 0;
        let filledSA = originalSA;

        if (!insideSafe && near > 0.018) {
          filledSA = Math.max(filledSA, Math.min(0.10, near * 0.35));
        }
        const target = filledSA * m;

        if (bA < 0.985) {
          if (originalSA < 0.003 && target < 0.003) continue;
          if (Math.abs(target - originalSA) < 0.002) continue;

          const br = bd[k] / 255, bg = bd[k + 1] / 255, bb = bd[k + 2] / 255;
          const ar = ad[k] / 255, ag = ad[k + 1] / 255, ab = ad[k + 2] / 255;
          let sr = pickR, sg = pickG, sb = pickB;

          if (originalSA >= 0.003) {
            const spR = ar * aA - br * bA * (1 - originalSA);
            const spG = ag * aA - bg * bA * (1 - originalSA);
            const spB = ab * aA - bb * bA * (1 - originalSA);
            sr = clamp(spR / originalSA, 0, 1);
            sg = clamp(spG / originalSA, 0, 1);
            sb = clamp(spB / originalSA, 0, 1);
          }

          const outA = target + bA * (1 - target);
          const outPR = sr * target + br * bA * (1 - target);
          const outPG = sg * target + bg * bA * (1 - target);
          const outPB = sb * target + bb * bA * (1 - target);
          ad[k] = outA > 0.001 ? Math.round(clamp(outPR / outA, 0, 1) * 255) : 0;
          ad[k + 1] = outA > 0.001 ? Math.round(clamp(outPG / outA, 0, 1) * 255) : 0;
          ad[k + 2] = outA > 0.001 ? Math.round(clamp(outPB / outA, 0, 1) * 255) : 0;
          ad[k + 3] = Math.round(outA * 255);
          touched++;
        } else if (m < 0.995 && aA >= bA - 0.001) {
          const br = bd[k] / 255, bg = bd[k + 1] / 255, bb = bd[k + 2] / 255;
          const ar = ad[k] / 255, ag = ad[k + 1] / 255, ab = ad[k + 2] / 255;
          ad[k] = Math.round((br + (ar - br) * m) * 255);
          ad[k + 1] = Math.round((bg + (ag - bg) * m) * 255);
          ad[k + 2] = Math.round((bb + (ab - bb) * m) * 255);
          ad[k + 3] = bd[k + 3];
          touched++;
        }
      }

      if (touched) ctx.putImageData(after, x, y);
    }

    paint.addEventListener('pointerdown', e => {
      if (toolKind() !== 'paint') return;
      edgePointers.add(e.pointerId);
      if (edgePointers.size === 1) {
        const base = d.createElement('canvas');
        base.width = paint.width;
        base.height = paint.height;
        base.getContext('2d').drawImage(paint, 0, 0);
        const p = pointFromEvent(e);
        const brush = +size.value;
        edgeSession = {
          base,
          rgb: hexRgb(color.value),
          brush,
          points: [],
          minX: p.x,
          maxX: p.x,
          minY: p.y,
          maxY: p.y,
          cancelled: false
        };
        capturePoint(edgeSession, p);
      } else if (edgeSession) {
        edgeSession.cancelled = true;
      }
    }, true);

    paint.addEventListener('pointermove', e => {
      if (!edgeSession || edgeSession.cancelled || !edgePointers.has(e.pointerId)) return;
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
      const list = events && events.length ? events : [e];
      for (const ev of list) capturePoint(edgeSession, pointFromEvent(ev));
    }, true);

    paint.addEventListener('pointerup', e => {
      if (edgeSession && !edgeSession.cancelled && edgePointers.has(e.pointerId)) capturePoint(edgeSession, pointFromEvent(e));
      edgePointers.delete(e.pointerId);
      if (edgeSession && !edgeSession.cancelled && !edgePointers.size) {
        const s = edgeSession;
        edgeSession = null;
        w.setTimeout(() => naturalizeStroke(s), 0);
      } else if (!edgePointers.size) {
        edgeSession = null;
      }
    }, true);

    paint.addEventListener('pointercancel', e => {
      edgePointers.delete(e.pointerId);
      if (edgeSession) edgeSession.cancelled = true;
      if (!edgePointers.size) edgeSession = null;
    }, true);

    return true;
  }

  function startAttachLoop() {
    if (pollTimer) clearInterval(pollTimer);
    let tries = 0;
    pollTimer = setInterval(() => {
      tries++;
      if (tryAttach() || tries > 240) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, 50);
  }

  host.addEventListener('load', () => {
    startAttachLoop();
    try {
      const baseDoc = host.contentDocument;
      const inner = baseDoc && baseDoc.getElementById('app');
      if (inner) inner.addEventListener('load', startAttachLoop, {once: true});
    } catch (_) {}
  });

  startAttachLoop();
})();