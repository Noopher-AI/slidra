/**
 * [E2.T17] The thin binding to YouTube's official IFrame Player API.
 *
 * Why the official API and not a bare `postMessage`: the player ignores
 * commands from a window that has not completed its private handshake
 * (measured — a raw `{"event":"command","func":"playVideo"}` to a
 * `?enablejsapi=1` frame produces no reply and no playback). That
 * handshake's shape is undocumented and YouTube's to change; `YT.Player`
 * is the supported way to speak it, so this is the one place that touches
 * a third-party script, and it stays behind two functions.
 *
 * The script is loaded lazily — only once a slide actually carries a
 * YouTube embed — so a deck without one pays nothing and makes no
 * third-party request.
 */

const API_SRC = "https://www.youtube.com/iframe_api";

interface YouTubePlayer {
  playVideo(): void;
  pauseVideo(): void;
  destroy(): void;
}

interface YouTubeApi {
  Player: new (element: HTMLIFrameElement, options: { events?: { onReady?: () => void } }) => YouTubePlayer;
}

interface YouTubeWindow extends Window {
  YT?: YouTubeApi & { loading?: number };
  onYouTubeIframeAPIReady?: () => void;
}

let apiPromise: Promise<YouTubeApi> | null = null;

/**
 * Resolves once `window.YT.Player` exists, loading the script on first
 * call. Rejects if the script cannot load (offline, blocked) rather than
 * hanging forever — the caller then simply has no player to drive, which
 * is the same state as "the embed is still loading", not a broken slide.
 */
export function loadYouTubeApi(): Promise<YouTubeApi> {
  if (apiPromise) return apiPromise;

  const win = window as YouTubeWindow;
  if (win.YT?.Player) {
    apiPromise = Promise.resolve(win.YT);
    return apiPromise;
  }

  apiPromise = new Promise<YouTubeApi>((resolve, reject) => {
    // The API calls this global exactly once, whoever inserted the script
    // — chain any existing one rather than clobbering it.
    const previous = win.onYouTubeIframeAPIReady;
    win.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (win.YT?.Player) resolve(win.YT);
      else reject(new Error("YouTube IFrame API 載入後仍找不到 YT.Player"));
    };

    if (document.querySelector(`script[src="${API_SRC}"]`)) return;
    const script = document.createElement("script");
    script.src = API_SRC;
    script.async = true;
    script.addEventListener("error", () => reject(new Error("YouTube IFrame API 載入失敗")));
    document.head.appendChild(script);
  });
  return apiPromise;
}

/**
 * Binds an already-rendered `<iframe>` (which must carry
 * `?enablejsapi=1`) to a player object. Constructing `YT.Player` over an
 * existing element adopts it rather than creating a second frame, which is
 * what lets `EmbedLayer` keep owning the element's position and lifetime.
 */
export function bindYouTubePlayer(api: YouTubeApi, iframe: HTMLIFrameElement, onReady: () => void): YouTubePlayer {
  return new api.Player(iframe, { events: { onReady } });
}

export type { YouTubePlayer };
