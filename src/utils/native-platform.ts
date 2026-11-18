import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { bytesToBase64 } from '../portability/portability-engine';

export function isNativeCapacitorApp(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export async function exportFileCrossPlatform(params: {
  fileName: string;
  mimeType: string;
  data: string | Uint8Array;
  shareTitle?: string;
}): Promise<{ method: 'capacitor_share' | 'browser_download' }> {
  const bytes =
    typeof params.data === 'string'
      ? new TextEncoder().encode(params.data)
      : params.data;

  if (isNativeCapacitorApp()) {
    const safeName = params.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const base64Data = bytesToBase64(bytes);
    const written = await Filesystem.writeFile({
      path: safeName,
      data: base64Data,
      directory: Directory.Cache,
    });
    await Share.share({
      title: params.shareTitle || safeName,
      url: written.uri,
      dialogTitle: params.shareTitle || 'Export Wise-Spliter File',
    });
    return { method: 'capacitor_share' };
  }

  const blob = new Blob([new Uint8Array(bytes)], {
    type: params.mimeType,
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = params.fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
  return { method: 'browser_download' };
}

export function launchExternalUriCrossPlatform(uri: string): boolean {
  if (!uri || typeof window === 'undefined') return false;
  if (
    isNativeCapacitorApp() ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '')
  ) {
    window.location.href = uri;
    return true;
  }
  return false;
}

export function registerNativeBackButtonHandler(
  onBack: () => boolean
): () => void {
  if (!isNativeCapacitorApp()) {
    return () => {};
  }
  let disposed = false;
  let removeFn: (() => void) | null = null;
  void CapacitorApp.addListener('backButton', ({ canGoBack }) => {
    const handled = onBack();
    if (!handled) {
      if (canGoBack && typeof window !== 'undefined') {
        window.history.back();
      } else {
        void CapacitorApp.minimizeApp();
      }
    }
  }).then((handle) => {
    if (disposed) {
      void handle.remove();
      return;
    }
    removeFn = () => {
      void handle.remove();
    };
  });

  return () => {
    disposed = true;
    if (removeFn) removeFn();
  };
}
