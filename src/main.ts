import '@/ui/styles.css';
import { GameApp } from '@/app/app';
import { isNative } from '@/platform/platform';
import { startPerf, trackBoot } from '@/telemetry/perf';
import { startTelemetry } from '@/telemetry/telemetry';
import { Scene } from '@/view/scene';

startTelemetry();
startPerf();

const root = document.getElementById('app')!;
const canvas = root.querySelector<HTMLCanvasElement>('#board')!;
const scene = await Scene.create(canvas);
const sceneAt = performance.now();
await new GameApp(root, scene, canvas).init();
trackBoot(sceneAt);

// Offline support for the web build; native shells already ship the files.
if (import.meta.env.PROD && !isNative && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('./sw.js');
}
