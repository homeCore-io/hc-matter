// Matter's scales to homeCore's, and back. Every function here is tested at
// both ends of its scale (tests/convert.test.ts): a dimmer's lowest step must
// not read as off, and 100 % must reach the device's maximum.

/** A Matter number as a JS number. int64 attributes arrive as bigint; null stays null. */
export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  return null;
}

const round = (v: number, places = 0) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ── Light level: Matter 1–254, homeCore brightness_pct 0–100 (0 is off) ─────

/** `brightness_pct` for a level. 0 when off; a light that is on is never 0. */
export function levelToPct(level: unknown, on: boolean | null): number | null {
  if (on === false) return 0;
  const l = num(level);
  if (l === null) return null;
  if (l <= 0) return on ? 1 : 0;
  return clamp(round((l / 254) * 100), 1, 100);
}

/** The level for a `brightness_pct`; 0 means "turn it off". */
export function pctToLevel(pct: number): number {
  if (!(pct > 0)) return 0;
  return clamp(Math.round((pct / 100) * 254), 1, 254);
}

// ── Colour ──────────────────────────────────────────────────────────────────

export function miredsToKelvin(mireds: unknown): number | null {
  const m = num(mireds);
  return m && m > 0 ? Math.round(1_000_000 / m) : null;
}

/** Mireds for a kelvin, inside what the light says it can do. */
export function kelvinToMireds(kelvin: number, minMireds?: number | null, maxMireds?: number | null): number {
  const m = Math.round(1_000_000 / clamp(kelvin, 1000, 20000));
  return clamp(m, minMireds ?? 1, maxMireds ?? 65279);
}

/** CIE x or y, Matter's 0–65279 (of 65536). */
export function xyFromMatter(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : round(n / 65536, 4);
}

export function xyToMatter(v: number): number {
  return clamp(Math.round(v * 65536), 0, 65279);
}

export interface Rgb { r: number; g: number; b: number }
export interface Xy { x: number; y: number }

const toLinear = (c: number) => {
  const v = clamp(c, 0, 255) / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** sRGB (0–255) to CIE 1931 xy, through D65 XYZ. Black has no colour: null. */
export function rgbToXy({ r, g, b }: Rgb): Xy | null {
  const [R, G, B] = [toLinear(r), toLinear(g), toLinear(b)];
  const X = R * 0.4124 + G * 0.3576 + B * 0.1805;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = R * 0.0193 + G * 0.1192 + B * 0.9505;
  const sum = X + Y + Z;
  if (sum <= 0) return null;
  return { x: round(X / sum, 4), y: round(Y / sum, 4) };
}

/** xy to sRGB at full brightness, for a light that only takes hue and saturation. */
export function xyToRgb({ x, y }: Xy): Rgb {
  if (y <= 0) return { r: 255, g: 255, b: 255 };
  const Y = 1;
  const X = (x / y) * Y;
  const Z = ((1 - x - y) / y) * Y;
  let r = X * 3.2406 - Y * 1.5372 - Z * 0.4986;
  let g = -X * 0.9689 + Y * 1.8758 + Z * 0.0415;
  let b = X * 0.0557 - Y * 0.204 + Z * 1.057;
  const max = Math.max(r, g, b, 1e-9);
  [r, g, b] = [r / max, g / max, b / max].map((c) => clamp(c, 0, 1));
  const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  return { r: Math.round(gamma(r) * 255), g: Math.round(gamma(g) * 255), b: Math.round(gamma(b) * 255) };
}

/** sRGB to Matter hue and saturation, each 0–254. */
export function rgbToHueSat({ r, g, b }: Rgb): { hue: number; saturation: number } {
  const [R, G, B] = [r, g, b].map((c) => clamp(c, 0, 255) / 255);
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
  }
  const deg = (h * 60 + 360) % 360;
  const sat = max === 0 ? 0 : d / max;
  return { hue: clamp(Math.round((deg / 360) * 254), 0, 254), saturation: clamp(Math.round(sat * 254), 0, 254) };
}

// ── Measurements ────────────────────────────────────────────────────────────

/** Hundredths (°C, %RH) to the unit. */
export function hundredths(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : round(n / 100, 2);
}

export function toHundredths(v: number): number {
  return Math.round(v * 100);
}

/** Matter's illuminance, 10000·log10(lux)+1, to lux. 0 means too dark to measure. */
export function illuminanceToLux(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  if (n <= 0) return 0;
  const lux = 10 ** ((n - 1) / 10000);
  return lux < 10 ? round(lux, 2) : round(lux, 1);
}

/** Thousandths (mW, mV, mA) to the unit. */
export function milli(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : round(n / 1000, 3);
}

/** mWh to kWh. */
export function mwhToKwh(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : round(n / 1_000_000, 4);
}

/** A battery's half-percent (0–200) to percent. */
export function halfPercent(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : clamp(round(n / 2, 1), 0, 100);
}

// ── Covers: Matter 0 = open … 10000 = closed; homeCore 100 = open ───────────

export function coverFromMatter(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : clamp(round(100 - n / 100, 1), 0, 100);
}

export function coverToMatter(pct: number): number {
  return clamp(Math.round((100 - clamp(pct, 0, 100)) * 100), 0, 10000);
}
