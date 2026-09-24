export const SCREEN_BITRATES = { '720-30': 6, '720-60': 10, '1080-30': 12, '1080-60': 20 };
export function normalizeQuality(value = {}) {
  return { height: value.height === 1080 ? 1080 : 720, fps: value.fps === 60 ? 60 : 30,
    bitrate: [4, 6, 8, 12, 16, 20, 30].includes(value.bitrate) ? value.bitrate : 0 };
}
export function screenBitrate(settings) {
  return (settings.bitrate || SCREEN_BITRATES[settings.height + '-' + settings.fps]) * 1_000_000;
}
