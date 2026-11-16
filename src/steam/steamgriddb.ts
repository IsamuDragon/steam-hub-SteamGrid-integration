// src/steam/steamgriddb.ts

export type SteamGridDbArtType = "grid_square" | "grid_vertical" | "grid_horizontal" | "hero" | "logo" | "icon";

interface SgdbResponse {
  success: boolean;
  data: Array<{ url: string; thumb: string; width: number; height: number }>;
}

/**
 * Fetches artwork bytes directly from SteamGridDB v2 API using native global fetch.
 */
export async function fetchSteamGridDbArtwork(appId: string, artType: SteamGridDbArtType, apiKey: string): Promise<Buffer | undefined> {
  if (!apiKey || !apiKey.trim()) return undefined;

  const mapping: Record<SteamGridDbArtType, { endpoint: string; query?: string }> = {
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
    const json = (await response.json()) as SgdbResponse;
    if (!json.success || !json.data || json.data.length === 0) return undefined;

    const imageUrl = json.data[0].url;
    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) return undefined;

    return Buffer.from(await imageRes.arrayBuffer());
  } catch (err) {
    return undefined;
  }
}