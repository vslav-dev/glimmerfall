import '@/ui/styles.css';
import { GameApp } from '@/app/app';
import { isNative } from '@/platform/platform';
import { startTelemetry } from '@/telemetry/telemetry';
import { Scene } from '@/view/scene';

startTelemetry();

const root = document.getElementById('app')!;
const canvas = root.querySelector<HTMLCanvasElement>('#board')!;
const scene = await Scene.create(canvas);
await new GameApp(root, scene, canvas).init();

// Offline support for the web build; native shells already ship the files.
if (import.meta.env.PROD && !isNative && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('./sw.js');
}
