import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { Preferences } from '@capacitor/preferences';

/**
 * Everything that differs between the browser and the native shells.
 * Capacitor plugins have web implementations, so one code path serves all platforms.
 */
export const isNative = Capacitor.isNativePlatform();

export const Haptic = {
  Light: 'light',
  Medium: 'medium',
  Heavy: 'heavy',
  Success: 'success',
  /** a long, unmistakable buzz when vibration is switched on in the settings */
  Confirm: 'confirm',
} as const;
export type Haptic = (typeof Haptic)[keyof typeof Haptic];

let hapticsEnabled = true;

export function setHapticsEnabled(enabled: boolean): void {
  hapticsEnabled = enabled;
}

let fullscreenWanted = false;

/**
 * Hides or shows the phone's system bars. Browsers enter fullscreen only from a tap,
 * so a launch with the setting on enters at the first tap, as does a return after the bars were swiped away.
 */
export function setFullscreen(on: boolean): void {
  fullscreenWanted = on;
  syncFullscreen();
}

/**
 * The fullscreen API, even in the installed app: Chrome on Android runs 120 Hz screens at full rate only here.
 * A manifest with `display: fullscreen` hides the exit hint but drops to 60 Hz (Helio G99, Chrome 158).
 */
function syncFullscreen(): void {
  // Unsupported (iOS Safari, some WebViews) or refused without a tap: rejections are ignored.
  if (fullscreenWanted && !document.fullscreenElement && document.fullscreenEnabled) {
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
  }
  if (!fullscreenWanted && document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
}

// pointerup, not pointerdown: a touch grants the tap permission only on release.
document.addEventListener('pointerup', syncFullscreen, { capture: true });

/** Browser vibration per kind, in ms (vibrate, pause, vibrate…): the same timings as the native feel. */
const VIBRATION: Record<Haptic, number[]> = {
  [Haptic.Light]: [20],
  [Haptic.Medium]: [43],
  [Haptic.Heavy]: [61],
  [Haptic.Success]: [35, 65, 21],
  [Haptic.Confirm]: [250],
};

export function haptic(kind: Haptic): void {
  if (hapticsEnabled) vibrate(kind);
}

function vibrate(kind: Haptic): void {
  if (!isNative) {
    // A browser may refuse (no API, no tap yet): vibration is a nicety.
    if ('vibrate' in navigator) navigator.vibrate(VIBRATION[kind]);
    return;
  }
  // Vibration is a nicety, so native failures are ignored.
  const done =
    kind === Haptic.Confirm
      ? Haptics.vibrate({ duration: VIBRATION[kind][0] })
      : kind === Haptic.Success
        ? Haptics.notification({ type: NotificationType.Success })
        : Haptics.impact({ style: kind === Haptic.Light ? ImpactStyle.Light : kind === Haptic.Medium ? ImpactStyle.Medium : ImpactStyle.Heavy });
  done.catch(() => undefined);
}

export async function loadJson<T>(key: string): Promise<T | null> {
  const { value } = await Preferences.get({ key });
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function saveText(key: string, value: string): Promise<void> {
  await Preferences.set({ key, value });
}

/** Android hardware back button. */
export function onBackButton(handler: () => void): void {
  if (isNative) void App.addListener('backButton', handler);
}

export function exitApp(): void {
  if (isNative) void App.exitApp();
}

/** App went to background (tab hidden, app switched). */
export function onHidden(handler: () => void): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') handler();
  });
}

export function onVisible(handler: () => void): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') handler();
  });
}
