import { useEffect, useRef } from 'react';

// 8x8 Bayer matrix, normalised to 0..1 thresholds.
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
].map((value) => (value + 0.5) / 64);

const hexToRgb = (hex) => {
  const value = parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/**
 * A planet drawn with ordered (Bayer) dithering: a lit sphere with drifting
 * latitude bands, two inks (light and accent) on a transparent background.
 * Renders at `resolution` cells across and is scaled up with pixelated
 * sampling, so it stays cheap. Pauses when off screen and draws a single
 * frame for people who prefer reduced motion.
 */
export default function DitherSphere({
  resolution = 132,
  light = '#EDEBE4',
  accent = '#4D8DFF',
  speed = 0.12,
  className = '',
  label,
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    const size = resolution;
    canvas.width = size;
    canvas.height = size;
    const image = ctx.createImageData(size, size);
    const pixels = image.data;
    const ink = hexToRgb(light);
    const blue = hexToRgb(accent);
    const radius = size / 2 - 1;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let frame = 0;
    let visible = true;
    let last = 0;
    let time = 0;

    const draw = () => {
      // Light swings slowly around the planet; bands drift with rotation.
      const lx = -0.55 + Math.sin(time * 0.35) * 0.15;
      const ly = -0.5;
      const lz = 0.67;
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const index = (y * size + x) * 4;
          const nx = (x - size / 2 + 0.5) / radius;
          const ny = (y - size / 2 + 0.5) / radius;
          const r2 = nx * nx + ny * ny;
          if (r2 > 1) {
            pixels[index + 3] = 0;
            continue;
          }
          const nz = Math.sqrt(1 - r2);
          const lambert = Math.max(0, nx * lx + ny * ly + nz * lz);
          const longitude = Math.atan2(nx, nz) + time;
          const bands =
            0.5 +
            0.25 * Math.sin(ny * 9 + Math.sin(longitude * 2) * 0.8) +
            0.25 * Math.sin(longitude * 3 + ny * 4);
          const value = lambert * (0.72 + 0.28 * bands);
          const threshold = BAYER[(y & 7) * 8 + (x & 7)];

          let color = null;
          if (value > threshold) {
            color = ink;
          } else if (value * 2.2 + (1 - nz) * 0.35 > threshold && value > 0.02) {
            color = blue;
          } else if (r2 > 0.86 && threshold < 0.35) {
            // Thin accent rim on the dark side, like an atmosphere.
            color = blue;
          }

          if (color) {
            pixels[index] = color[0];
            pixels[index + 1] = color[1];
            pixels[index + 2] = color[2];
            pixels[index + 3] = 255;
          } else {
            pixels[index + 3] = 0;
          }
        }
      }
      ctx.putImageData(image, 0, 0);
    };

    const loop = (now) => {
      frame = requestAnimationFrame(loop);
      if (!visible || now - last < 42) return;
      time += speed * ((now - last) / 1000 || 0.04);
      last = now;
      draw();
    };

    draw();
    let observer;
    if (!reduceMotion) {
      observer = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
      });
      observer.observe(canvas);
      frame = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [resolution, light, accent, speed]);

  return (
    <canvas
      ref={canvasRef}
      className={`dither-sphere ${className}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
