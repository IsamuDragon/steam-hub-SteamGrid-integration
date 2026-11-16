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
import fetch from "node-fetch";

/**
 * Art sources available for keys.
 */
export type ArtSource = "official" | "steamgriddb";

/**
 * Which piece of a game's store art to put on the key for official steam art.
 */
export type OfficialArtStyle = "capsule" | "header" | "hero" | "logo" | "none";

/**
 * Which piece of art to pull from SteamGridDB.
 */
export type SteamGridDbArtStyle = "grid_square" | "grid_vertical" | "grid_horizontal" | "hero" | "logo" | "icon";

export type ArtStyle = OfficialArtStyle | SteamGridDbArtStyle;

/**
 * How the art is fitted into the square key.
 *
 * - `fill` crops the art to the key, edge to edge.
 * - `fit`  shows all of it over a blurred, dimmed copy of itself.
 */
export type ArtFit = "fill" | "fit";

/** Stream Deck keys top out at 144x144 (72pt @2x), which is what every model scales from. */
const KEY_SIZE = 144;

/**
 * Dimensions of a render target, in pixels.
 *
 * Art is composited at the size it will actually be shown at rather than always at key size,
 * because anything drawn square and then displayed in a wide slot, an encoder's touch strip
 * being the case in point, is stretched by the difference.
 */
export type Size = { readonly w: number; readonly h: number };

/** The square every key scales from. */
const KEY: Size = { w: KEY_SIZE, h: KEY_SIZE };

/** JPEG rather than PNG: the composite is always opaque, and it cuts the payload ~7x. */
const JPEG_QUALITY = 90;

/** Colour behind art that has no usable backdrop, matches Steam's own dark chrome. */
const FALLBACK_BACKDROP = 0x0f1419ff;

/**
 * Dev toggle: when on, every key image this module renders is also written to disk via
 * {@link exportImage}, so the exact bytes sent to a key can be inspected without attaching a
 * debugger to the Stream Deck app.
 */
const EXPORT_IMAGES = false;

/**
 * A single layer of source art. Steam names the same asset differently across client versions, so
 * each kind lists every filename worth trying, best quality first.
 */
const SOURCES = {
  capsule: ["library_600x900_2x.jpg", "library_600x900.jpg", "library_capsule.jpg"],
  header: ["header.jpg", "library_header.jpg", "capsule_616x353.jpg"],
  hero: ["library_hero.jpg"],
  logo: ["logo.png", "logo_2x.png"],
} as const satisfies Record<Exclude<OfficialArtStyle, "none">, readonly string[]>;

/**
 * Names the CDN actually serves. The local cache holds a few that the public CDN does not, and
 * asking for those only buys a round trip and a 404.
 */
const CDN_NAMES = new Set(["library_600x900_2x.jpg", "library_600x900.jpg", "header.jpg", "library_hero.jpg", "logo.png"]);

type ArtKind = keyof typeof SOURCES;

/** Steam's public art CDN. The second host is a fallback for networks that block the first. */
const CDN_HOSTS = ["https://cdn.cloudflare.steamstatic.com/steam/apps", "https://cdn.akamai.steamstatic.com/steam/apps"];

/** Same CDN, different tree: achievement icons live under the community image path, not `steam/apps`. */
const ACHIEVEMENT_CDN_HOSTS = [
  "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps",
  "https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps",
];

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

const STATUS_COLOURS = {
  running: [0x35, 0x9b, 0x43],
  updating: [0xf5, 0xa6, 0x23],
} as const satisfies Record<Exclude<StatusBadge, "idle" | "missing">, readonly [number, number, number]>;

const BORDER_WIDTH = 11;
const TRACK_BRIGHTNESS = 0.3;
const BORDER_INNER_RADIUS = 20;
const BORDER_SAMPLES = 4;

export type StatusBadge = "idle" | "running" | "updating" | "missing";

/**
 * Fetches artwork bytes from SteamGridDB v2 API.
 */
async function fetchSteamGridDbArtwork(appId: string, artType: SteamGridDbArtStyle, apiKey: string): Promise<Buffer | undefined> {
  if (!apiKey || !apiKey.trim()) return undefined;

  const mapping: Record<SteamGridDbArtStyle, { endpoint: string; query?: string }> = {
    grid_square:     { endpoint: "grids", query: "dimensions=512x512,1024x1024" },
    grid_vertical:   { endpoint: "grids", query: "dimensions=600x900" },
    grid_horizontal: { endpoint: "grids", query: "dimensions=460x215,920x430" },
    hero:            { endpoint: "heroes" },
    logo:            { endpoint: "logos" },
    icon:            { endpoint: "icons" }
  };

  const config = mapping[artType] || mapping.grid_square;
  const url = `https://www.steamgriddb.com/api/v2/${config.endpoint}/steam/${appId}${config.query ? "?" + config.query : ""}&nsfw=false&humor=false`;

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey.trim()}` }
    });

    if (!response.ok) return undefined;
    const json = (await response.json()) as any;
    if (!json.success || !json.data || json.data.length === 0) return undefined;

    const imageUrl = json.data[0].url;
    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) return undefined;

    return Buffer.from(await imageRes.arrayBuffer());
  } catch (err) {
    return undefined;
  }
}

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
  artSource: ArtSource = "official",
  style: ArtStyle = "header",
  fit: ArtFit = "fill",
  badge: StatusBadge = "idle",
  progress?: number,
  sgdbApiKey?: string,
): Promise<string | undefined> {
  return renderSized(appId, artSource, style, fit, badge, KEY, progress, sgdbApiKey);
}

export function renderStripImage(
  appId: string,
  artSource: ArtSource = "official",
  style: ArtStyle = "header",
  fit: ArtFit = "fill",
  size: Size = KEY,
  badge: StatusBadge = "idle",
  progress?: number,
  sgdbApiKey?: string,
): Promise<string | undefined> {
  return renderSized(appId, artSource, style, fit, badge, size, progress, sgdbApiKey);
}

export function clearRenderCache(): void {
  rendered.clear();
}

const fileImages = new Map<string, string | undefined>();

export async function renderEmptyKey(customPath?: string): Promise<string> {
  const wanted = customPath?.trim() || pluginPath("imgs", "actions", "slot", "emptyLogo.png");
  const image = await renderImageFile(wanted);

  if (image === undefined && customPath?.trim()) {
    streamDeck.logger.warn(
