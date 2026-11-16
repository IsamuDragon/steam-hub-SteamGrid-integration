// src/steam/artwork.ts
import streamDeck from "@elgato/streamdeck";
import jpegCodec from "@jimp/js-jpeg";
import pngCodec from "@jimp/js-png";
import { Jimp } from "jimp";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

import { findSteam } from "./paths";
import { fetchSteamGridDbArtwork, type SteamGridDbArtType } from "./steamgriddb";

/**
 * Art sources available for keys.
 */
export type ArtSource = "official" | "steamgriddb";

/**
 * Which piece of a game's store art to put on the key for official steam art.
 */
export type OfficialArtStyle = "capsule" | "header" | "hero" | "logo" | "none";

export type ArtStyle = OfficialArtStyle | SteamGridDbArtType;

/**
 * How the art is fitted into the square key.
 */
export type ArtFit = "fill" | "fit";

export type AvatarEffect = "none" | "glow" | "pulse" | "dim" | "grey" | "faded";

const KEY_SIZE = 144;

export type Size = { readonly w: number; readonly h: number };

const KEY: Size = { w: KEY_SIZE, h: KEY_SIZE };
const JPEG_QUALITY = 90;
const FALLBACK_BACKDROP = 0x0f1419ff;

const SOURCES = {
  capsule: ["library_600x900_2x.jpg", "library_600x900.jpg", "library_capsule.jpg"],
  header: ["header.jpg", "library_header.jpg", "capsule_616x353.jpg"],
  hero: ["library_hero.jpg"],
  logo: ["logo.png", "logo_2x.png"],
} as const satisfies Record<Exclude<OfficialArtStyle, "none">, readonly string[]>;

const CDN_NAMES = new Set(["library_600x900_2x.jpg", "library_600x900.jpg", "header.jpg", "library_hero.jpg", "logo.png"]);

type ArtKind = keyof typeof SOURCES;

const CDN_HOSTS = ["https://cdn.cloudflare.steamstatic.com/steam/apps", "https://cdn.akamai.steamstatic.com/steam/apps"];

type Image = {
  readonly width: number;
  readonly height: number;
  readonly bitmap: { data: Buffer; width: number; height: number };
  cover(size: { w: number; h: number }): Image;
  scaleToFit(size: { w: number; h: number }): Image;
  blur(radius: number): Image;
  brightness(amount: number): Image;
  composite(source: Image, x: number, y: number): Image;
  getBuffer(mime: "image/jpeg", options: { quality: number }): Promise<Buffer>;
};

const JPEG = jpegCodec();
const PNG = pngCodec();

function decode(data: Buffer): Image {
  return new Jimp(isJpeg(data) ? JPEG.decode(data) : PNG.decode(data)) as unknown as Image;
}

function blank(color: number, size: Size = KEY): Image {
  return new Jimp({ width: size.w, height: size.h, color }) as unknown as Image;
}

const rendered = new Map<string, string>();
const inFlight = new Map<string, Promise<string | undefined>>();
const MAX_CACHED_RENDERS = 160;

const STATUS_COLOURS: Record<Exclude<StatusBadge, "idle" | "missing">, readonly number[]> = {
  running: [0x35, 0x9b, 0x43],
  updating: [0xf5, 0xa6, 0x23],
};

const BORDER_WIDTH = 11;
const TRACK_BRIGHTNESS = 0.3;
const BORDER_INNER_RADIUS = 20;
const BORDER_SAMPLES = 4;

export type StatusBadge = "idle" | "running" | "updating" | "missing";

async function renderSized(
  appId: string,
  artSource: ArtSource,
  style: ArtStyle,
  fit: ArtFit,
  badge: StatusBadge,
  size: Size,
  progress: number | undefined,
  sgdbApiKey?: string,
): Promise<string | undefined> {
  if (style === "none" || !/^\d{1,10}$/.test(appId)) {
    return undefined;
  }

  const progressKey = progress === undefined ? "-" : Math.round(progress * 100);
  const key = `${appId}:${artSource}:${style}:${fit}:${badge}:${size.w}x${size.h}:${progressKey}`;
  const cached = rendered.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const existing = inFlight.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const task = render(appId, artSource, style, fit, badge, size, progress, sgdbApiKey)
    .catch((err) => {
      streamDeck.logger.error(`Failed to render artwork for app ${appId}`, err);
      return undefined;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, task);

  const image = await task;
  if (image !== undefined) {
    if (rendered.size >= MAX_CACHED_RENDERS) {
      rendered.delete(rendered.keys().next().value!);
    }
    rendered.set(key, image);
  }

  return image;
}

export function renderKeyImage(
  appId: string,
  styleOrSource: ArtStyle | ArtSource = "header",
  fitOrStyle: ArtFit | ArtStyle = "fill",
  badgeOrFit: StatusBadge | ArtFit = "idle",
  progressOrBadge: number | StatusBadge = "idle",
  progress?: number,
  sgdbApiKey?: string,
): Promise<string | undefined> {
  let artSource: ArtSource = "official";
  let style: ArtStyle = "header";
  let fit: ArtFit = "fill";
  let badge: StatusBadge = "idle";
  let prog: number | undefined = undefined;
  let apiKey: string | undefined = undefined;

  if (styleOrSource === "official" || styleOrSource === "steamgriddb") {
    artSource = styleOrSource;
    style = (fitOrStyle as ArtStyle) || "header";
    fit = "fill";
    badge = (progressOrBadge as StatusBadge) || "idle";
    prog = progress;
    apiKey = sgdbApiKey;
  } else {
    artSource = "official";
    style = (styleOrSource as ArtStyle) || "header";
    fit = "fill";
    badge = (badgeOrFit as StatusBadge) || "idle";
    prog = progressOrBadge as number;
  }

  return renderSized(appId, artSource, style, fit, badge, KEY, prog, apiKey);
}

export function renderStripImage(
  appId: string,
  styleOrSource: ArtStyle | ArtSource = "header",
  fitOrStyle: ArtFit | ArtStyle = "fill",
  sizeOrBadge: Size | StatusBadge = KEY,
  badgeOrProgress: StatusBadge | number = "idle",
  progress?: number,
  sgdbApiKey?: string,
): Promise<string | undefined> {
  let artSource: ArtSource = "official";
  let style: ArtStyle = "header";
  let fit: ArtFit = "fill";
  let size: Size = KEY;
  let badge: StatusBadge = "idle";
  let prog: number | undefined = undefined;
  let apiKey: string | undefined = undefined;

  if (styleOrSource === "official" || styleOrSource === "steamgriddb") {
    artSource = styleOrSource;
    style = (fitOrStyle as ArtStyle) || "header";
    fit = "fill";
    size = KEY;
    badge = (badgeOrProgress as StatusBadge) || "idle";
    prog = progress;
    apiKey = sgdbApiKey;
  } else {
    artSource = "official";
    style = (styleOrSource as ArtStyle) || "header";
    fit = "fill";
    size = typeof sizeOrBadge === "object" && sizeOrBadge !== null ? sizeOrBadge : KEY;
    badge = typeof badgeOrProgress === "string" ? badgeOrProgress : "idle";
    prog = typeof badgeOrProgress === "number" ? badgeOrProgress : progress;
  }

  return renderSized(appId, artSource, style, fit, badge, size, prog, apiKey);
}

export async function renderAchievementKey(
  appId: string,
  iconBufferOrUrl?: Buffer | string,
): Promise<string | undefined> {
  if (!iconBufferOrUrl) {
    return renderKeyImage(appId, "header", "fill", "idle");
  }

  let buffer: Buffer | undefined;

  if (typeof iconBufferOrUrl === "string") {
    try {
      if (iconBufferOrUrl.startsWith("http://") || iconBufferOrUrl.startsWith("https://")) {
        const res = await fetch(iconBufferOrUrl);
        if (res.ok) {
          buffer = Buffer.from(await res.arrayBuffer());
        }
      } else {
        buffer = await readFile(iconBufferOrUrl);
      }
    } catch {
      buffer = undefined;
    }
  } else {
    buffer = iconBufferOrUrl;
  }

  if (!buffer) {
    return renderKeyImage(appId, "header", "fill", "idle");
  }

  const decoded = decode(buffer).cover({ w: KEY_SIZE, h: KEY_SIZE });
  return toDataUri(decoded, `achievement-${appId}`);
}

export async function renderAvatarKey(input?: Buffer | string | { avatar?: Buffer | string; frame?: Buffer | string; effect?: AvatarEffect | string }): Promise<string> {
  let bufferOrPath: Buffer | string | undefined;
  if (input && typeof input === "object" && !Buffer.isBuffer(input)) {
    bufferOrPath = input.avatar ?? input.frame;
  } else {
    bufferOrPath = input as Buffer | string | undefined;
  }

  if (!bufferOrPath) {
    return toDataUri(blank(FALLBACK_BACKDROP), "avatar-empty");
  }

  let buffer: Buffer | undefined;
  if (typeof bufferOrPath === "string") {
    try {
      buffer = await readFile(bufferOrPath);
    } catch {
      buffer = undefined;
    }
  } else {
    buffer = bufferOrPath;
  }

  if (!buffer) {
    return toDataUri(blank(FALLBACK_BACKDROP), "avatar-empty");
  }

  const decoded = decode(buffer).cover({ w: KEY_SIZE, h: KEY_SIZE });
  return toDataUri(decoded, "avatar-user");
}

export function clearRenderCache(): void {
  rendered.clear();
}

const fileImages = new Map<string, string | undefined>();

export async function renderEmptyKey(customPath?: string): Promise<string> {
  const wanted = customPath?.trim() || pluginPath("imgs", "actions", "slot", "emptyLogo.png");
  const image = await renderImageFile(wanted);

  if (image === undefined && customPath?.trim()) {
    streamDeck.logger.warn(`Cannot use "${wanted}" as the empty-slot image; expected a readable JPEG or PNG`);
  }

  if (image !== undefined) {
    return image;
  }

  return (emptyKey ??= toDataUri(defaultEmptyKey(), "empty-default"));
}

let emptyKey: Promise<string> | undefined;

export async function renderImageFile(file: string): Promise<string | undefined> {
  let key = file;
  try {
    key = `${file}:${(await stat(file)).mtimeMs}`;
  } catch {
    key = file;
  }

  if (fileImages.has(key)) {
    return fileImages.get(key);
  }

  const bytes = await readIfImage(file);
  const image =
    bytes === undefined
      ? undefined
      : await toDataUri(decode(bytes).cover({ w: KEY_SIZE, h: KEY_SIZE }), path.basename(file));

  if (fileImages.size >= MAX_CACHED_RENDERS) {
    fileImages.clear();
  }
  fileImages.set(key, image);

  return image;
}

export type Caption = {
  main?: string;
  suffix?: string;
  size?: number;
  label?: readonly string[];
  heading?: readonly string[];
  top?: boolean;
  framed?: boolean;
  middle?: boolean;
  muted?: boolean;
};

const CAPTION_MARGIN = { plain: 3, framed: 9 } as const;
const LABEL_SIZE = 15;
export const LABEL_LINE_LENGTH = 14;

export function renderCaption(base: string, caption: Caption): string {
  const font = captionFont("bold");
  const size = caption.size ?? 30;
  const label = caption.label ?? [];

  const capHeight = font === undefined ? 0.72 : (font.tables.os2?.sCapHeight ?? 700) / font.unitsPerEm;
  const margin = caption.framed === true ? CAPTION_MARGIN.framed : CAPTION_MARGIN.plain;
  const bottom = KEY_SIZE - BORDER_WIDTH - margin;
  const top = BORDER_WIDTH + margin + Math.round(size * capHeight);
  const middle = KEY_SIZE / 2 + Math.round((size * capHeight) / 2);
  const heading = caption.heading ?? [];
  const headingTop = BORDER_WIDTH + margin + Math.round(LABEL_SIZE * capHeight);
  const readingBaseline = label.length > 0 || caption.top === true ? top : caption.middle === true ? middle : bottom;

  const layer = (dx: number, bright: string, dim: string): string => {
    const opacity = dx === 0 ? undefined : 0.75;
    let out = "";

    if (caption.main) {
      const runs: TextRun[] = [{ text: caption.main, size, fill: caption.muted === true ? dim : bright, weight: "bold" }];
      if (caption.suffix) {
        runs.push({ text: caption.suffix, size: Math.round(size * 0.67), fill: dim, weight: "regular" });
      }
      out += drawLine(runs, readingBaseline + dx, dx, opacity);
    }

    label.forEach((line, i) => {
      const y = bottom - (label.length - 1 - i) * (LABEL_SIZE + 2);
      out += drawLine([{ text: line, size: LABEL_SIZE, fill: bright, weight: "regular" }], y + dx, dx, opacity);
    });

    heading.forEach((line, i) => {
      const y = headingTop + i * (LABEL_SIZE + 2);
      out += drawLine([{ text: line, size: LABEL_SIZE, fill: bright, weight: "regular" }], y + dx, dx, opacity);
    });

    return out;
  };

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${KEY_SIZE}" height="${KEY_SIZE}" viewBox="0 0 ${KEY_SIZE} ${KEY_SIZE}">` +
    `<image x="0" y="0" width="${KEY_SIZE}" height="${KEY_SIZE}" xlink:href="${base}"/>` +
    layer(1.5, "#001a3a", "#001a3a") +
    layer(0, "#d2e2f6", "#8fb0de") +
    `</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

const CAPTION_FONT_FILES = { bold: "Gila Bold.ttf", regular: "Gila.ttf" } as const;
type FontWeight = keyof typeof CAPTION_FONT_FILES;
const FALLBACK_FONT_FAMILY = "Arial";
const CAPTION_MAX_WIDTH = KEY_SIZE - 2 * (BORDER_WIDTH + CAPTION_MARGIN.plain);
const captionFontCache = new Map<FontWeight, opentype.Font | null>();

function captionFont(weight: FontWeight): opentype.Font | undefined {
  if (!captionFontCache.has(weight)) {
    const file = pluginPath("fonts", CAPTION_FONT_FILES[weight]);
    try {
      const bytes = readFileSync(file);
      captionFontCache.set(
        weight,
        opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
      );
    } catch (err) {
      streamDeck.logger.warn(`Cannot load the caption font "${file}"`, err);
      captionFontCache.set(weight, null);
    }
  }

  return captionFontCache.get(weight) ?? (weight === "bold" ? undefined : captionFont("bold"));
}

type TextRun = { text: string; size: number; fill: string; weight: FontWeight };

function drawLine(runs: readonly TextRun[], baseline: number, dx: number, opacity: number | undefined): string {
  const fillOpacity = opacity === undefined ? "" : ` fill-opacity="${opacity}"`;

  const fonts = runs.map((run) => captionFont(run.weight));
  if (fonts.some((font) => font === undefined)) {
    return (
      `<text x="${KEY_SIZE / 2 + dx}" y="${baseline}" text-anchor="middle" font-family="${FALLBACK_FONT_FAMILY}"${fillOpacity}>` +
      runs
        .map(
          (run) =>
            `<tspan font-size="${run.size}" font-weight="${run.weight === "bold" ? "bold" : "normal"}" fill="${run.fill}">${escapeXml(run.text)}</tspan>`
        )
        .join("") +
      `</text>`
    );
  }

  const widths = runs.map((run, i) => fonts[i]!.getAdvanceWidth(run.text, run.size));
  const total = widths.reduce((sum, width) => sum + width, 0);
  const scale = total > CAPTION_MAX_WIDTH ? CAPTION_MAX_WIDTH / total : 1;

  let x = KEY_SIZE / 2 + dx - (total * scale) / 2;
  return runs
    .map((run, i) => {
      const d = fonts[i]!.getPath(run.text, x, baseline, run.size * scale).toPathData(2);
      x += widths[i]! * scale;
      return `<path d="${d}" fill="${run.fill}"${fillOpacity}/>`;
    })
    .join("");
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function pluginPath(...segments: string[]): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ...segments);
}

function defaultEmptyKey(): Image {
  const plate = blank(0x000000ff);
  const { data, width, height } = plate.bitmap;

  const top = [0x1e, 0x27, 0x33];
  const bottom = [0x0c, 0x10, 0x15];
  const centre = (width - 1) / 2;
  const maxDistance = Math.hypot(centre, centre);

  for (let y = 0; y < height; y++) {
    const down = y / (height - 1);

    for (let x = 0; x < width; x++) {
      const distance = Math.hypot(x - centre, y - centre) / maxDistance;
      const vignette = 1 - 0.3 * distance * distance;

      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        data[offset + channel] = Math.round((top[channel]! + (bottom[channel]! - top[channel]!) * down) * vignette);
      }
      data[offset + 3] = 0xff;
    }
  }

  return plate;
}

async function render(
  appId: string,
  artSource: ArtSource,
  style: ArtStyle,
  fit: ArtFit,
  badge: StatusBadge,
  size: Size = KEY,
  progress?: number,
  sgdbApiKey?: string,
): Promise<string | undefined> {
  let foregroundBuffer: Buffer | undefined;

  if (artSource === "steamgriddb") {
    foregroundBuffer = await fetchSteamGridDbArtwork(appId, style as SteamGridDbArtType, sgdbApiKey ?? "");
  } else {
    let officialStyle = style as OfficialArtStyle;
    if (officialStyle === "logo") {
      const logo = await loadArt(appId, "logo");
      if (logo !== undefined) {
        const backdrop = await loadFirst(appId, ["hero", "header", "capsule"]);
        return compose(logo, backdrop, "fit", 0.84, 0.42, badge, `${appId}-logo-${badge}`, size, progress);
      }
      officialStyle = "header";
    }

    const order: Record<Exclude<OfficialArtStyle, "logo" | "none">, ArtKind[]> = {
      capsule: ["capsule", "header", "hero"],
      header: ["header", "capsule", "hero"],
      hero: ["hero", "header", "capsule"],
    };

    if (officialStyle !== "none") {
      foregroundBuffer = await loadFirst(appId, order[officialStyle as keyof typeof order] || ["header"]);
    }
  }

  if (foregroundBuffer === undefined) {
    return undefined;
  }

  const label = `${appId}-${artSource}-${style}-${fit}-${badge}`;
  return fit === "fill"
    ? compose(foregroundBuffer, undefined, "fill", 1, 1, badge, label, size, progress)
    : compose(foregroundBuffer, foregroundBuffer, "fit", 1, 0.55, badge, label, size, progress);
}

async function compose(
  foreground: Buffer,
  backdrop: Buffer | undefined,
  fit: ArtFit,
  scale: number,
  dim: number,
  badge: StatusBadge,
  label: string,
  size: Size = KEY,
  progress?: number,
): Promise<string> {
  if (fit === "fill") {
    return toDataUri(outline(decode(foreground).cover({ w: size.w, h: size.h }), badge, progress), label);
  }

  const canvas =
    backdrop !== undefined
      ? decode(backdrop).cover({ w: size.w, h: size.h }).blur(5).brightness(dim)
      : blank(FALLBACK_BACKDROP, size);

  const box = Math.round(Math.min(size.w, size.h) * scale);
  const fitted = decode(foreground).scaleToFit({ w: box, h: box });
  const x = Math.round((size.w - fitted.width) / 2);
  const y = Math.round((size.h - fitted.height) / 2);

  canvas.composite(fitted, x, y);
  return toDataUri(outline(canvas, badge, progress), label);
}

function outline(image: Image, badge: StatusBadge, progress?: number): Image {
  if (badge === "missing" || badge === "idle") {
    if (badge === "missing") {
      return markMissing(image);
    }
    return image;
  }

  const color = STATUS_COLOURS[badge] ?? [0, 0, 0];
  const r = color[0] ?? 0;
  const g = color[1] ?? 0;
  const b = color[2] ?? 0;

  const { data, width, height } = image.bitmap;
  const cx = width / 2;
  const cy = height / 2;

  const trackR = Math.round(r * TRACK_BRIGHTNESS);
  const trackG = Math.round(g * TRACK_BRIGHTNESS);
  const trackB = Math.round(b * TRACK_BRIGHTNESS);

  const fillAngle = progress !== undefined ? progress * 360 : 360;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let insideCount = 0;
      for (let sy = 0; sy < BORDER_SAMPLES; sy++) {
        for (let sx = 0; sx < BORDER_SAMPLES; sx++) {
          const px = x + (sx + 0.5) / BORDER_SAMPLES;
          const py = y + (sy + 0.5) / BORDER_SAMPLES;
          const dx = Math.abs(px - cx);
          const dy = Math.abs(py - cy);
          if (dx >= cx - BORDER_WIDTH || dy >= cy - BORDER_WIDTH) {
            insideCount++;
          }
        }
      }

      const coverage = insideCount / (BORDER_SAMPLES * BORDER_SAMPLES);
      if (coverage > 0) {
        let drawR = r;
        let drawG = g;
        let drawB = b;

        if (badge === "updating" && progress !== undefined) {
          const angle = (Math.atan2(y - cy, x - cx) * 180) / Math.PI + 90;
          const normalizedAngle = angle < 0 ? angle + 360 : angle;
          if (normalizedAngle > fillAngle) {
            drawR = trackR;
            drawG = trackG;
            drawB = trackB;
          }
        }

        const offset = (y * width + x) * 4;
        data[offset] = Math.round(data[offset]! * (1 - coverage) + drawR * coverage);
        data[offset + 1] = Math.round(data[offset + 1]! * (1 - coverage) + drawG * coverage);
        data[offset + 2] = Math.round(data[offset + 2]! * (1 - coverage) + drawB * coverage);
      }
    }
  }

  return image;
}

function markMissing(image: Image): Image {
  const { data, width, height } = image.bitmap;
  for (let i = 0; i < data.length; i += 4) {
    const grey = Math.round(data[i]! * 0.3 + data[i + 1]! * 0.59 + data[i + 2]! * 0.11);
    data[i] = grey;
    data[i + 1] = grey;
    data[i + 2] = grey;
  }
  return image;
}

async function toDataUri(image: Image, label: string): Promise<string> {
  const buffer = await image.getBuffer("image/jpeg", { quality: JPEG_QUALITY });
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}

async function loadArt(appId: string, kind: ArtKind): Promise<Buffer | undefined> {
  for (const name of SOURCES[kind]) {
    const local = path.join(await libraryCacheDir(appId), name);
    const bytes = await readIfImage(local);
    if (bytes !== undefined) {
      return bytes;
    }
  }

  for (const host of CDN_HOSTS) {
    for (const name of SOURCES[kind]) {
      if (!CDN_NAMES.has(name)) continue;
      try {
        const res = await fetch(`${host}/${appId}/${name}`);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (isJpeg(buf) || isPng(buf)) {
            await cacheArt(appId, name, buf);
            return buf;
          }
        }
      } catch {}
    }
  }

  return undefined;
}

async function loadFirst(appId: string, kinds: readonly ArtKind[]): Promise<Buffer | undefined> {
  for (const kind of kinds) {
    const art = await loadArt(appId, kind);
    if (art !== undefined) return art;
  }
  return undefined;
}

async function libraryCacheDir(appId: string): Promise<string> {
  const steam = await findSteam();
  const steamRoot = typeof steam === "string" ? steam : steam?.root ?? "";
  const dir = path.join(steamRoot, "appcache", "librarycache", appId);
  await mkdir(dir, { recursive: true }).catch(() => {});
  return dir;
}

async function cacheArt(appId: string, name: string, bytes: Buffer): Promise<void> {
  try {
    const dir = await libraryCacheDir(appId);
    const target = path.join(dir, name);
    const temp = path.join(dir, `${name}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(temp, bytes);
    await rename(temp, target);
  } catch {}
}

async function readIfImage(file: string): Promise<Buffer | undefined> {
  try {
    const bytes = await readFile(file);
    if (isJpeg(bytes) || isPng(bytes)) {
      return bytes;
    }
  } catch {}
  return undefined;
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}

function isPng(bytes: Buffer): boolean {
  return bytes.length > 7 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
}