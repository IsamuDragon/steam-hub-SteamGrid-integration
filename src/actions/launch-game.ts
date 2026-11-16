// src/actions/launch-game.ts
import streamDeck, {
  action,
  type DialAction,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { type ArtFit, type ArtSource, type ArtStyle, clearRenderCache, renderCaption, renderKeyImage } from "../steam/artwork";
import { launchGame } from "../steam/launch";
import { findGame, getDownloadFraction, getInstalledGames, groupForPicker } from "../steam/library";
import { addClockListener, addStatusListener, removeClockListener, removeStatusListener } from "../steam/monitor";
import { findSteam } from "../steam/paths";
import { getAppStates } from "../steam/status";
import { badgeFor, drawnLines, paintKey } from "./common";

/**
 * Settings for {@link LaunchGame}.
 */
type LaunchGameSettings = {
  appId?: string;
  customAppId?: string;
  gameName?: string;
  artSource?: ArtSource;
  artStyle?: ArtStyle;
  artFit?: ArtFit;
  sgdbApiKey?: string;
  showTitle?: boolean;
  showStatus?: boolean;
  titleIsOurs?: boolean;
};

type InspectorMessage = {
  event?: string;
  isRefresh?: boolean;
};

const DEFAULT_SOURCE: ArtSource = "official";
const DEFAULT_STYLE: ArtStyle = "logo";
const DEFAULT_FIT: ArtFit = "fill";

const APP_ID = /^\d{1,10}$/;

function resolveAppId(settings: LaunchGameSettings): string | undefined {
  for (const candidate of [settings.customAppId, settings.appId]) {
    const id = candidate?.trim();
    if (id !== undefined && APP_ID.test(id)) {
      return id;
    }
  }
  return undefined;
}

@action({ UUID: "com.unai-gonzalez.steam-hub.launch" })
export class LaunchGame extends SingletonAction<LaunchGameSettings> {
  readonly #onPoll = (): Promise<void> => this.#refreshStatuses();
  readonly #onClock = (): Promise<void> => this.#tickDownloads();
  #listening = false;
  readonly #drawn = new Map<string, string>();
  readonly #downloads = new Map<string, KeyAction<LaunchGameSettings>>();

  override async onWillAppear(ev: WillAppearEvent<LaunchGameSettings>): Promise<void> {
    if (!this.#listening) {
      this.#listening = true;
      addStatusListener(this.#onPoll);
      addClockListener(this.#onClock);
    }
    await this.draw(ev.action, ev.payload.settings);
  }

  override onWillDisappear(ev: WillDisappearEvent<LaunchGameSettings>): void {
    this.#drawn.delete(ev.action.id);
    this.#downloads.delete(ev.action.id);

    if (this.#listening && [...this.actions].length <= 1) {
      this.#listening = false;
      removeStatusListener(this.#onPoll);
      removeClockListener(this.#onClock);
    }
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<LaunchGameSettings>): Promise<void> {
    await this.draw(ev.action, ev.payload.settings);
  }

  override async onKeyDown(ev: KeyDownEvent<LaunchGameSettings>): Promise<void> {
    const appId = resolveAppId(ev.payload.settings);

    if (appId === undefined) {
      streamDeck.logger.warn("Key pressed with no game selected");
      await ev.action.showAlert();
      return;
    }

    try {
      await launchGame(appId, () => ev.action.showAlert());
      await ev.action.showOk();
    } catch (err) {
      streamDeck.logger.error(`Could not launch ${ev.payload.settings.gameName ?? appId}`, err);
      await ev.action.showAlert();
    }
  }

  override async onSendToPlugin(ev: SendToPluginEvent<InspectorMessage, LaunchGameSettings>): Promise<void> {
    if (ev.payload?.event === "getGames") {
      await this.sendGames(ev.payload.isRefresh === true);
      return;
    }
    streamDeck.logger.debug(`Ignoring unknown message from the property inspector: ${ev.payload?.event}`);
  }

  async #refreshStatuses(): Promise<void> {
    await Promise.all(
      [...this.actions].map(async (target) => {
        if (target.isKey()) {
          await this.draw(target, await target.getSettings());
        }
      }),
    ).catch((err) => streamDeck.logger.error("Could not repaint the game keys", err));
  }

  async #tickDownloads(): Promise<void> {
    await Promise.all(
      [...this.#downloads.values()].map(async (target) => this.draw(target, await target.getSettings())),
    ).catch((err) => streamDeck.logger.error("Could not repaint a download ring", err));
  }

  private async sendGames(refresh: boolean): Promise<void> {
    if (refresh) {
      clearRenderCache();
    }

    const games = await getInstalledGames(refresh);

    await streamDeck.ui.sendToPropertyInspector({
      event: "getGames",
      items: groupForPicker(games),
    });

    const steam = await findSteam();
    await streamDeck.ui.sendToPropertyInspector({
      event: "status",
      ok: steam !== undefined && games.length > 0,
      text:
        steam === undefined
          ? "Steam was not found on this computer. You can still launch a game by App ID."
          : games.length === 0
            ? `Steam is installed at ${steam.root}, but no games were found.`
            : `${games.length} installed game${games.length === 1 ? "" : "s"} found.`,
    });
  }

  private async draw(
    target: DialAction<LaunchGameSettings> | KeyAction<LaunchGameSettings>,
    settings: LaunchGameSettings,
  ): Promise<void> {
    if (!target.isKey()) {
      return;
    }

    const appId = resolveAppId(settings);
    this.#downloads.delete(target.id);

    if (appId === undefined) {
      this.#drawn.delete(target.id);
      await paintKey(target, undefined, "Choose game", "launch", { clearTitle: settings.titleIsOurs === true });
      if (settings.titleIsOurs === true) {
        await target.setSettings({ ...settings, titleIsOurs: false });
      }
      return;
    }

    const name = (await findGame(appId))?.name ?? settings.gameName;
    const updated: LaunchGameSettings = { ...settings };

    if (name !== undefined) {
      updated.gameName = name;
    }

    const artSource = settings.artSource ?? DEFAULT_SOURCE;
    const style = settings.artStyle ?? DEFAULT_STYLE;
    const fit = settings.artFit ?? DEFAULT_FIT;
    const badge = badgeFor(settings.showStatus !== false, (await getAppStates()).get(appId));
    const sgdbApiKey = settings.sgdbApiKey;

    const fraction = badge === "updating" ? await getDownloadFraction(appId) : undefined;
    const percent = fraction === undefined ? undefined : Math.round(fraction * 100);
    if (badge === "updating") {
      this.#downloads.set(target.id, target);
    }

    const label = settings.showTitle === true ? (name ?? `App ${appId}`) : "";
    const signature = `${appId}:${artSource}:${style}:${fit}:${badge}:${percent ?? "-"}:${label}:${settings.titleIsOurs === true}`;

    if (this.#drawn.get(target.id) !== signature) {
      const image = await renderKeyImage(appId, artSource, style, fit, badge, fraction, sgdbApiKey);

      if (percent !== undefined && image !== undefined) {
        await target.setImage(
          renderCaption(image, {
            main: String(percent),
            suffix: "%",
            top: true,
            framed: true,
            ...(label === "" ? {} : { label: drawnLines(label) }),
          }),
        );
        if (settings.titleIsOurs === true) {
          await target.setTitle("");
        }
      } else {
        await paintKey(target, image, label, "launch", { clearTitle: settings.titleIsOurs === true });
      }

      this.#drawn.set(target.id, signature);
    }
    updated.titleIsOurs = false;

    if (updated.gameName !== settings.gameName || updated.titleIsOurs !== settings.titleIsOurs) {
      await target.setSettings(updated);
    }
  }
}