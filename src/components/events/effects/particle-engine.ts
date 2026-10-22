import { DPR_CAP, MAX_FLASHES_PER_SECOND } from '@/lib/events/theme/motion';

/**
 * The canvas-2D particle engine: background fields (stars, snow, fireflies,
 * dust, bubbles) and overlays (confetti, gold dust, petals, leaves, golf
 * balls, shooting stars, a custom emoji/logo rain). One small module, loaded
 * lazily by the particle island only when a page uses it.
 *
 * Phone budget: particle count scales with canvas area and density and is
 * capped; the canvas renders at most 1.5× DPR; the loop stops when the
 * island says so (offscreen, tab hidden, paused, reduced motion). Scale 0
 * draws a single still frame (the "poster") and never starts a loop.
 */

export type ParticleKind =
  | 'stars'
  | 'snow'
  | 'fireflies'
  | 'dust'
  | 'bubbles'
  | 'confetti'
  | 'gold_dust'
  | 'petals'
  | 'leaves'
  | 'golf_balls'
  | 'shooting_stars'
  | 'custom';

export interface ParticleConfig {
  kind: ParticleKind;
  colors: string[];
  /** 0–1 */
  density: number;
  /** 0–2 */
  speed: number;
  /** The live motion scale (0 = one still frame). */
  scale: number;
  /** 0–1: how much depth layering / parallax. */
  depth?: number;
  shootingStars?: boolean;
  twinkle?: boolean;
  /** One burst from the top, then the loop ends. */
  burst?: boolean;
  sprite?: HTMLImageElement | null;
  sizeScale?: number;
}

export interface ParticleField {
  setScale(scale: number): void;
  setRunning(running: boolean): void;
  setPointer(x: number, y: number): void;
  resize(): void;
  destroy(): void;
}

interface P {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  size: number;
  rot: number;
  vrot: number;
  color: string;
  phase: number;
}

interface Streak {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

const AREA_PER_PARTICLE: Record<ParticleKind, number> = {
  stars: 2400,
  snow: 9000,
  fireflies: 26000,
  dust: 14000,
  bubbles: 30000,
  confetti: 12000,
  gold_dust: 9000,
  petals: 26000,
  leaves: 30000,
  golf_balls: 60000,
  shooting_stars: 1e12,
  custom: 40000,
};

const MAX_PARTICLES: Record<ParticleKind, number> = {
  stars: 420,
  snow: 180,
  fireflies: 48,
  dust: 90,
  bubbles: 40,
  confetti: 120,
  gold_dust: 140,
  petals: 46,
  leaves: 36,
  golf_balls: 18,
  shooting_stars: 0,
  custom: 28,
};

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function pick<T>(list: readonly T[], fallback: T): T {
  return list.length ? (list[Math.floor(Math.random() * list.length)] as T) : fallback;
}

function glowSprite(color: string, radius: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const size = radius * 2;
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(radius, radius, 0, radius, radius, radius);
    grad.addColorStop(0, color);
    grad.addColorStop(0.25, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  return c;
}

export function createParticleField(
  canvas: HTMLCanvasElement,
  config: ParticleConfig,
): ParticleField {
  const ctx = canvas.getContext('2d');
  let scale = config.scale;
  let running = false;
  let raf = 0;
  let last = 0;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let particles: P[] = [];
  const streaks: Streak[] = [];
  let nextStreak = 0;
  let pointerX = 0;
  let pointerY = 0;
  let burstDone = false;
  const sizeScale = config.sizeScale ?? 1;
  const colors = config.colors.length ? config.colors : ['#FFFFFF'];
  const sprites = new Map<string, HTMLCanvasElement>();
  const depth = config.depth ?? 0.5;

  function spawn(initial: boolean): P {
    const z = depth > 0 ? rand(0.25, 1) : 1;
    const k = config.kind;
    const base: P = {
      x: rand(0, width),
      y: initial ? rand(0, height) : -20,
      z,
      vx: 0,
      vy: 0,
      size: 1,
      rot: rand(0, Math.PI * 2),
      vrot: 0,
      color: pick(colors, '#FFFFFF'),
      phase: rand(0, Math.PI * 2),
    };
    switch (k) {
      case 'stars':
        base.size = rand(0.4, 1.6) * z * sizeScale;
        break;
      case 'snow':
        base.size = rand(1, 3.2) * z * sizeScale;
        base.vy = rand(18, 40) * z;
        base.vx = rand(-6, 6);
        break;
      case 'fireflies':
        base.size = rand(6, 12) * sizeScale;
        base.vx = rand(-10, 10);
        base.vy = rand(-8, 8);
        break;
      case 'dust':
      case 'gold_dust':
        base.size = rand(0.8, 2.2) * sizeScale;
        base.vx = rand(-4, 4);
        base.vy = rand(-10, -3);
        if (!initial) base.y = height + 10;
        break;
      case 'bubbles':
        base.size = rand(4, 14) * sizeScale;
        base.vy = rand(-28, -12);
        base.vx = rand(-4, 4);
        if (!initial) base.y = height + 20;
        break;
      case 'confetti':
        base.size = rand(5, 9) * sizeScale;
        base.vy = rand(40, 80);
        base.vx = rand(-15, 15);
        base.vrot = rand(-3, 3);
        break;
      case 'petals':
      case 'leaves':
        base.size = rand(7, 13) * sizeScale;
        base.vy = rand(22, 40);
        base.vx = rand(-12, 12);
        base.vrot = rand(-1.2, 1.2);
        break;
      case 'golf_balls':
        base.size = rand(6, 10) * sizeScale;
        base.vy = rand(26, 44);
        base.vx = rand(-6, 6);
        base.vrot = rand(-1, 1);
        break;
      case 'custom':
        base.size = rand(18, 30) * sizeScale;
        base.vy = rand(30, 55);
        base.vx = rand(-8, 8);
        base.vrot = rand(-1, 1);
        break;
      case 'shooting_stars':
        break;
    }
    if (config.burst && !initial) {
      base.y = rand(-height * 0.6, -10);
      base.vy *= 1.8;
    }
    return base;
  }

  function targetCount(): number {
    const area = width * height;
    const n = Math.round((area / AREA_PER_PARTICLE[config.kind]) * (0.25 + config.density * 1.5));
    return Math.max(0, Math.min(MAX_PARTICLES[config.kind], n));
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    dpr = Math.min(DPR_CAP, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    const want = targetCount();
    if (particles.length > want) particles = particles.slice(0, want);
    while (particles.length < want) particles.push(spawn(!config.burst));
    if (!running) draw(0, last);
  }

  function sprite(color: string, r: number) {
    const key = `${color}:${r}`;
    let s = sprites.get(key);
    if (!s) {
      s = glowSprite(color, r);
      sprites.set(key, s);
    }
    return s;
  }

  function drawStar4(x: number, y: number, r: number) {
    if (!ctx) return;
    ctx.beginPath();
    ctx.moveTo(x, y - r * 2.2);
    ctx.quadraticCurveTo(x, y, x + r * 2.2, y);
    ctx.quadraticCurveTo(x, y, x, y + r * 2.2);
    ctx.quadraticCurveTo(x, y, x - r * 2.2, y);
    ctx.quadraticCurveTo(x, y, x, y - r * 2.2);
    ctx.fill();
  }

  function draw(dt: number, now: number) {
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const s = scale * config.speed;
    const t = now / 1000;
    const scrollShift = typeof window !== 'undefined' ? window.scrollY : 0;
    for (const p of particles) {
      // Move.
      if (dt > 0 && s > 0) {
        switch (config.kind) {
          case 'stars':
            break;
          case 'fireflies':
            p.vx += rand(-6, 6) * dt;
            p.vy += rand(-6, 6) * dt;
            p.vx = Math.max(-14, Math.min(14, p.vx));
            p.vy = Math.max(-14, Math.min(14, p.vy));
            p.x += p.vx * dt * s;
            p.y += p.vy * dt * s;
            break;
          default:
            p.x += (p.vx + Math.sin(t * 0.8 + p.phase) * 8) * dt * s;
            p.y += p.vy * dt * s;
            p.rot += p.vrot * dt * s;
        }
        // Wrap / respawn.
        if (p.y > height + 30 || p.y < -60 || p.x < -40 || p.x > width + 40) {
          if (config.burst) {
            p.y = height + 999;
          } else {
            Object.assign(p, spawn(false));
            if (config.kind === 'fireflies') {
              p.x = rand(0, width);
              p.y = rand(0, height);
            }
          }
        }
      }
      // Draw.
      ctx.fillStyle = p.color;
      ctx.strokeStyle = p.color;
      switch (config.kind) {
        case 'stars': {
          const tw =
            config.twinkle === false
              ? 1
              : 0.55 + 0.45 * Math.sin(t * (0.6 + p.z) * Math.max(0.2, scale) + p.phase);
          const par = depth * p.z;
          const x = (p.x + pointerX * par * 18 + width) % width;
          const y = (p.y - scrollShift * par * 0.08 + pointerY * par * 12 + height * 10) % height;
          ctx.globalAlpha = Math.min(1, (0.35 + 0.65 * p.z) * (scale > 0 ? tw : 0.8));
          ctx.beginPath();
          ctx.arc(x, y, p.size, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'snow':
          ctx.globalAlpha = 0.45 + 0.5 * p.z;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'fireflies': {
          const pulse = 0.35 + 0.65 * Math.abs(Math.sin(t * 0.7 + p.phase));
          ctx.globalAlpha = scale > 0 ? pulse : 0.7;
          const spr = sprite(p.color, Math.round(p.size));
          ctx.drawImage(spr, p.x - p.size, p.y - p.size);
          break;
        }
        case 'dust':
        case 'gold_dust': {
          // A glint at most every ~2 s per particle: far under 3 flashes/s overall per point.
          const glint = Math.max(0, Math.sin(t * (MAX_FLASHES_PER_SECOND / 3) + p.phase));
          ctx.globalAlpha = 0.25 + 0.65 * (scale > 0 ? glint : 0.6);
          if (config.kind === 'gold_dust') drawStar4(p.x, p.y, p.size * (0.6 + glint * 0.6));
          else {
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
          }
          break;
        }
        case 'bubbles':
          ctx.globalAlpha = 0.55;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 0.5;
          ctx.beginPath();
          ctx.arc(p.x - p.size * 0.35, p.y - p.size * 0.35, p.size * 0.22, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'confetti':
          ctx.globalAlpha = 0.92;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.scale(1, Math.cos(p.rot * 2 + p.phase));
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
          ctx.restore();
          break;
        case 'petals':
          ctx.globalAlpha = 0.85;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.scale(1, 0.55 + 0.45 * Math.cos(p.rot + p.phase));
          ctx.beginPath();
          ctx.ellipse(0, 0, p.size, p.size * 0.55, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          break;
        case 'leaves':
          ctx.globalAlpha = 0.85;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.beginPath();
          ctx.moveTo(0, -p.size);
          ctx.quadraticCurveTo(p.size * 0.8, 0, 0, p.size);
          ctx.quadraticCurveTo(-p.size * 0.8, 0, 0, -p.size);
          ctx.fill();
          ctx.restore();
          break;
        case 'golf_balls': {
          ctx.globalAlpha = 0.95;
          const grad = ctx.createRadialGradient(
            p.x - p.size * 0.3,
            p.y - p.size * 0.3,
            p.size * 0.1,
            p.x,
            p.y,
            p.size,
          );
          grad.addColorStop(0, '#FFFFFF');
          grad.addColorStop(1, '#C9CED2');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(0,0,0,0.12)';
          for (let i = 0; i < 5; i += 1) {
            const a = p.rot + (i * Math.PI * 2) / 5;
            ctx.beginPath();
            ctx.arc(
              p.x + Math.cos(a) * p.size * 0.5,
              p.y + Math.sin(a) * p.size * 0.5,
              p.size * 0.12,
              0,
              Math.PI * 2,
            );
            ctx.fill();
          }
          break;
        }
        case 'custom':
          if (config.sprite && config.sprite.complete && config.sprite.naturalWidth) {
            ctx.globalAlpha = 0.95;
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot * 0.4);
            const ratio = config.sprite.naturalHeight / config.sprite.naturalWidth;
            ctx.drawImage(
              config.sprite,
              -p.size / 2,
              (-p.size * ratio) / 2,
              p.size,
              p.size * ratio,
            );
            ctx.restore();
          }
          break;
        case 'shooting_stars':
          break;
      }
    }
    // Shooting stars: an occasional streak, never more than one at a time.
    const wantsStreaks =
      config.kind === 'shooting_stars' || (config.kind === 'stars' && config.shootingStars);
    if (wantsStreaks && scale > 0) {
      if (now > nextStreak && streaks.length === 0) {
        streaks.push({
          x: rand(width * 0.1, width * 0.9),
          y: rand(0, height * 0.4),
          vx: rand(380, 620),
          vy: rand(140, 260),
          life: 1,
        });
        nextStreak = now + rand(3500, 8000) / Math.max(0.3, config.speed);
      }
      for (let i = streaks.length - 1; i >= 0; i -= 1) {
        const st = streaks[i] as Streak;
        st.x += st.vx * dt;
        st.y += st.vy * dt;
        st.life -= dt * 1.4;
        if (st.life <= 0) {
          streaks.splice(i, 1);
          continue;
        }
        const grad = ctx.createLinearGradient(st.x, st.y, st.x - st.vx * 0.18, st.y - st.vy * 0.18);
        grad.addColorStop(0, colors[0] ?? '#FFFFFF');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.globalAlpha = Math.min(1, st.life);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(st.x, st.y);
        ctx.lineTo(st.x - st.vx * 0.18, st.y - st.vy * 0.18);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    if (config.burst && particles.every((p) => p.y > height + 100)) burstDone = true;
  }

  function frame(now: number) {
    if (!running) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    draw(dt, now);
    if (burstDone) {
      running = false;
      ctx?.clearRect(0, 0, width, height);
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function setRunning(next: boolean) {
    const want = next && scale > 0 && !burstDone;
    if (want === running) return;
    running = want;
    if (running) {
      last = 0;
      raf = requestAnimationFrame(frame);
    } else {
      cancelAnimationFrame(raf);
    }
  }

  resize();

  return {
    setScale(next) {
      scale = next;
      if (scale === 0) {
        setRunning(false);
        draw(0, performance.now());
      }
    },
    setRunning,
    setPointer(x, y) {
      pointerX = x;
      pointerY = y;
    },
    resize,
    destroy() {
      running = false;
      cancelAnimationFrame(raf);
      sprites.clear();
    },
  };
}
