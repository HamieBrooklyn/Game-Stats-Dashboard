// Celebrations for milestones (the collector's milestones.js says which): a banner, and confetti on a canvas
// over the page. small: one burst · big: confetti cannons from both corners · epic: cannons, fireworks and a
// confetti rain. With "reduce motion" on, only the banner shows. One at a time: the next waits for "Nice!".

import { h, timeAgo } from './format.js';

const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#8b5cf6', '#facc15', '#22d3ee', '#f43f5e'];
const ICONS = { sales: '🛒', ccu: '🔥', engaged: '⭐', players: '🎮', robux: '💰' };
const GRAVITY = 900; // px/s²
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const random = (min, max) => min + Math.random() * (max - min);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

// --- The particles ---
let canvas = null, paint = null, particles = [], frame = 0, last = 0, timers = [];

function ensureCanvas() {
  if (canvas) return;
  canvas = h('canvas', { class: 'confetti', 'aria-hidden': 'true' });
  document.body.append(canvas);
  paint = canvas.getContext('2d');
  const size = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(innerWidth * ratio);
    canvas.height = Math.round(innerHeight * ratio);
    paint.setTransform(ratio, 0, 0, ratio, 0, 0);
  };
  size();
  window.addEventListener('resize', size);
}

function start() {
  if (frame) return;
  last = performance.now();
  frame = requestAnimationFrame(tick);
}

// A paper bit: flutters (tilt), spins and slows in the air
function confetti(x, y, angle, speed) {
  const shape = Math.random() < 0.15 ? 'circle' : Math.random() < 0.25 ? 'ribbon' : 'rect';
  particles.push({
    kind: 'paper', shape, x, y,
    vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
    w: random(6, 11), hgt: shape === 'ribbon' ? random(12, 18) : random(4, 8),
    rot: random(0, Math.PI * 2), spin: random(-12, 12), tilt: random(0, Math.PI * 2), flutter: random(6, 14),
    color: pick(COLORS), age: 0, life: random(2.6, 4.2), drag: random(1.6, 2.4),
  });
}

// angle in radians (0 = right, -π/2 = up)
function burst(x, y, count, angle = -Math.PI / 2, spread = Math.PI * 2, speed = [250, 650]) {
  for (let i = 0; i < count; i++) confetti(x, y, angle + random(-spread / 2, spread / 2), random(...speed));
  start();
}

function cannons(count = 140) {
  const y = innerHeight + 10;
  burst(-10, y, count, -Math.PI / 2 + 0.55, 0.6, [700, 1250]);
  burst(innerWidth + 10, y, count, -Math.PI / 2 - 0.55, 0.6, [700, 1250]);
}

function rain(seconds = 3) {
  const end = performance.now() + seconds * 1000;
  const drop = () => {
    if (performance.now() > end) return;
    for (let i = 0; i < 6; i++) confetti(random(0, innerWidth), -20, Math.PI / 2 + random(-0.3, 0.3), random(40, 160));
    start();
    timers.push(setTimeout(drop, 60));
  };
  drop();
}

// A firework: a rocket with a trail that bursts into glowing sparks of one or two colours
function rocket() {
  const x = random(innerWidth * 0.15, innerWidth * 0.85);
  const top = random(innerHeight * 0.12, innerHeight * 0.42);
  const vy = -Math.sqrt(2 * GRAVITY * (innerHeight - top)); // reaches `top` as it slows to a stop
  particles.push({ kind: 'rocket', x, y: innerHeight, vx: random(-60, 60), vy, color: pick(COLORS), age: 0, life: 3 });
  start();
}

function explode(x, y, color) {
  const second = pick(COLORS);
  const count = Math.round(random(70, 110));
  const ring = Math.random() < 0.3;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + random(-0.05, 0.05);
    const speed = ring ? random(300, 330) : random(80, 360);
    particles.push({
      kind: 'spark', x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      color: i % 3 ? color : second, age: 0, life: random(1.1, 1.8), drag: 1.8, size: random(1.6, 2.6),
    });
  }
  for (let i = 0; i < 14; i++) confetti(x, y, random(0, Math.PI * 2), random(100, 300));
}

function tick(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  paint.clearRect(0, 0, innerWidth, innerHeight);
  const list = particles;
  particles = []; // survivors go back in, with what bursts adds meanwhile
  for (const p of list) {
    p.age += dt;
    if (p.kind === 'rocket') {
      p.vy += GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.vy >= -40) { explode(p.x, p.y, p.color); continue; }
      paint.globalAlpha = 1;
      paint.fillStyle = '#fff7d6';
      paint.beginPath();
      paint.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
      paint.fill();
      for (let i = 1; i < 6; i++) { // the trail
        paint.globalAlpha = 0.5 - i * 0.08;
        paint.fillStyle = p.color;
        paint.beginPath();
        paint.arc(p.x - p.vx * dt * i * 1.5, p.y - p.vy * dt * i * 1.5, 2 - i * 0.25, 0, Math.PI * 2);
        paint.fill();
      }
      particles.push(p);
      continue;
    }
    if (p.age >= p.life) continue;
    const slow = Math.exp(-p.drag * dt);
    p.vx *= slow;
    p.vy = p.vy * slow + (p.kind === 'spark' ? GRAVITY * 0.18 : GRAVITY * 0.32) * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.y > innerHeight + 40 || p.x < -60 || p.x > innerWidth + 60) continue;
    const fade = Math.min(1, (p.life - p.age) / 0.6);
    if (p.kind === 'spark') {
      paint.globalAlpha = fade;
      paint.fillStyle = p.color;
      paint.shadowColor = p.color;
      paint.shadowBlur = 8;
      paint.beginPath();
      paint.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      paint.fill();
      paint.shadowBlur = 0;
    } else {
      p.rot += p.spin * dt;
      p.tilt += p.flutter * dt;
      p.x += Math.sin(p.tilt) * 18 * dt; // the sway of falling paper
      paint.globalAlpha = fade;
      paint.fillStyle = p.color;
      paint.save();
      paint.translate(p.x, p.y);
      paint.rotate(p.rot);
      paint.scale(1, Math.cos(p.tilt)); // its side turns towards you and away
      if (p.shape === 'circle') {
        paint.beginPath();
        paint.arc(0, 0, p.w / 2.4, 0, Math.PI * 2);
        paint.fill();
      } else paint.fillRect(-p.w / 2, -p.hgt / 2, p.w, p.hgt);
      paint.restore();
    }
    particles.push(p);
  }
  paint.globalAlpha = 1;
  frame = particles.length ? requestAnimationFrame(tick) : 0;
  if (!frame) paint.clearRect(0, 0, innerWidth, innerHeight);
}

// The confetti for a level, from the banner's middle
export function party(level = 'small', from = null) {
  if (reduced()) return;
  ensureCanvas();
  const x = from ? from.x : innerWidth / 2;
  const y = from ? from.y : innerHeight * 0.18;
  if (level === 'small') return burst(x, y, 120, -Math.PI / 2, Math.PI * 1.6, [200, 600]);
  burst(x, y, 160, -Math.PI / 2, Math.PI * 1.8, [250, 700]);
  cannons(level === 'epic' ? 170 : 120);
  timers.push(setTimeout(() => cannons(level === 'epic' ? 120 : 80), 650));
  if (level !== 'epic') return;
  for (let i = 0; i < 12; i++) timers.push(setTimeout(rocket, 300 + i * 380 + random(0, 200)));
  timers.push(setTimeout(() => rain(3.2), 1400));
  timers.push(setTimeout(() => cannons(140), 4300));
}

function stopParty() {
  for (const timer of timers) clearTimeout(timer);
  timers = [];
}

// --- The banner and the queue ---
const queue = [];
let showing = null;

const CHEERS = { small: 'Milestone', big: 'Big milestone', epic: 'Huge milestone' };

function showNext() {
  if (showing || !queue.length) return;
  const item = queue.shift();
  const old = Date.now() / 1000 - item.At > 600; // reached a while ago (the dashboard wasn't open)
  const onKey = (event) => { if (event.key === 'Escape') dismiss(); };
  const dismiss = () => {
    if (showing?.item !== item) return;
    clearTimeout(showing.timer);
    document.removeEventListener('keydown', onKey);
    banner.classList.add('leaving');
    stopParty();
    setTimeout(() => { banner.remove(); showing = null; showNext(); }, 260);
  };
  const button = h('button', { class: 'button primary', type: 'button', onclick: dismiss }, item.Level === 'epic' ? "Let's go!" : 'Nice!');
  const banner = h('div', { class: `celebration ${item.Level}`, role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'celebration-icon', 'aria-hidden': 'true' }, ICONS[item.Kind] || '🎉'),
    h('div', { class: 'celebration-body' },
      h('div', { class: 'celebration-eyebrow' },
        h('span', { class: 'game-dot', style: `background:var(--game-${item.Slot || 1})` }),
        `${CHEERS[item.Level] || 'Milestone'} · ${item.GameName}`),
      h('div', { class: 'celebration-title' }, item.Title),
      h('div', { class: 'celebration-detail' }, item.Detail, old ? ` Reached ${timeAgo(item.At)}.` : '')),
    button);
  document.body.append(banner);
  showing = { item, timer: item.Level === 'epic' ? null : setTimeout(dismiss, 15000) };
  requestAnimationFrame(() => {
    const box = banner.getBoundingClientRect();
    party(item.Level, { x: box.left + box.width / 2, y: box.top + box.height / 2 });
  });
  button.focus({ preventScroll: true });
  document.addEventListener('keydown', onKey);
}

// item: a milestone from the collector ({ Key, Title, Detail, Level, Kind, GameName, Slot, At })
export function celebrate(item) {
  if (showing?.item.Key === item.Key || queue.some((queued) => queued.Key === item.Key)) return;
  queue.push(item);
  showNext();
}

// --- Which ones this browser has shown ---
const SEEN_KEY = 'celebrated';
const RECENT = 7 * 86400; // older milestones are history, not news
function seenKeys() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); }
}
function remember(keys) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...keys].slice(-400))); } catch {}
}

// Celebrates what's new to this browser: reached in the last week, not quiet, not shown here before
export function celebrateNew(items) {
  const seen = seenKeys();
  const now = Date.now() / 1000;
  const fresh = (items || []).filter((item) => !item.Quiet && now - item.At < RECENT && !seen.has(item.Key)).sort((a, b) => a.At - b.At);
  for (const item of fresh) {
    seen.add(item.Key);
    celebrate(item);
  }
  if (fresh.length) remember(seen);
}
