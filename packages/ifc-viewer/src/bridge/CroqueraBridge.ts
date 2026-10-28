/**
 * CroqueraBridge — Zero-copy bridge to launch and edit the model in Croquera.
 *
 * Implements a resilient postMessage + BroadcastChannel handshake transferring
 * the IFC ArrayBuffer without re-uploading to any remote cloud server.
 */

export interface CroqueraBridgeOptions {
  croqueraUrl?: string;
}

export class CroqueraBridge {
  private static readonly DEFAULT_CROQUERA_URL = 'https://www.vivemejor.cl/croquera';
  private static readonly BRIDGE_CHANNEL_NAME = 'croquera_ifc_bridge';
  private readonly targetUrl: string;

  private currentBuffer: ArrayBuffer | null = null;
  private currentFile: File | null = null;
  private currentFilename: string = 'model.ifc';

  constructor(options: CroqueraBridgeOptions = {}) {
    this.targetUrl = options.croqueraUrl || CroqueraBridge.resolveDefaultTargetUrl();
  }

  private static resolveDefaultTargetUrl(): string {
    if (typeof window !== 'undefined' && window.location) {
      const { protocol, hostname, origin } = window.location;
      if (hostname === 'vivemejor.cl' || hostname === 'www.vivemejor.cl') {
        return `${origin}/croquera`;
      }
      if (hostname === 'croquera.com' || hostname === 'www.croquera.com') {
        return origin;
      }
      if (protocol.startsWith('http') && (hostname === 'localhost' || hostname === '127.0.0.1')) {
        return CroqueraBridge.DEFAULT_CROQUERA_URL;
      }
    }
    return CroqueraBridge.DEFAULT_CROQUERA_URL;
  }

  /**
   * Registers the loaded IFC file (or buffer) and filename in memory.
   * Clones raw ArrayBuffers so Web Worker transferables cannot detach the bridge copy.
   */
  public setFile(fileOrBuffer: File | ArrayBuffer, filename?: string): void {
    if (typeof File !== 'undefined' && fileOrBuffer instanceof File) {
      this.currentFile = fileOrBuffer;
      this.currentFilename = fileOrBuffer.name;
      this.currentBuffer = null;
    } else if (fileOrBuffer instanceof ArrayBuffer) {
      this.currentBuffer = fileOrBuffer.slice(0);
      this.currentFilename = filename || 'model.ifc';
      this.currentFile = null;
    }
  }

  /**
   * Returns true if an IFC file is ready for transmission.
   */
  public hasFile(): boolean {
    return this.currentFile !== null || (this.currentBuffer !== null && this.currentBuffer.byteLength > 0);
  }

  /**
   * Launches Croquera in a new tab and streams the IFC model buffer upon ready handshake.
   */
  public async editInCroquera(): Promise<void> {
    if (!this.hasFile()) {
      alert('No IFC model is currently loaded.');
      return;
    }

    const baseUrl = this.targetUrl.replace(/\/+$/, '');
    const appUrl = `${baseUrl}/?source=ifc-viewer&filename=${encodeURIComponent(this.currentFilename)}`;

    let bufferPromise: Promise<ArrayBuffer>;
    if (this.currentBuffer && this.currentBuffer.byteLength > 0) {
      bufferPromise = Promise.resolve(this.currentBuffer);
    } else if (this.currentFile) {
      bufferPromise = this.currentFile.arrayBuffer().then((buf) => {
        this.currentBuffer = buf;
        return buf;
      });
    } else {
      alert('No IFC model is currently loaded.');
      return;
    }

    let acknowledged = false;
    let retryTimer: ReturnType<typeof setInterval> | null = null;
    let channel: BroadcastChannel | null = null;

    const cleanup = () => {
      acknowledged = true;
      window.removeEventListener('message', onMessage);
      if (retryTimer !== null) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
      if (channel) {
        try {
          channel.close();
        } catch {
          // Ignored
        }
        channel = null;
      }
    };

    const dispatchBuffer = async () => {
      if (acknowledged) return;
      try {
        const resolvedBuffer = await bufferPromise;
        if (acknowledged || !resolvedBuffer || resolvedBuffer.byteLength === 0) return;

        const payload = {
          type: 'IMPORT_IFC_BUFFER',
          filename: this.currentFilename,
          buffer: resolvedBuffer.slice(0),
        };

        if (targetWin && !targetWin.closed) {
          try {
            targetWin.postMessage(payload, '*');
          } catch {
            // Ignored
          }
          try {
            for (let i = 0; i < targetWin.frames.length; i++) {
              targetWin.frames[i]?.postMessage(payload, '*');
            }
          } catch {
            // Ignored
          }
        }

        if (channel) {
          try {
            channel.postMessage(payload);
          } catch {
            // Ignored
          }
        }
      } catch {
        // Ignored
      }
    };

    const onMessage = (event: MessageEvent): void => {
      if (!event.data || typeof event.data !== 'object') return;
      if (event.data.type === 'CROQUERA_READY_FOR_IMPORT') {
        void dispatchBuffer();
      } else if (event.data.type === 'CROQUERA_IMPORT_ACK') {
        cleanup();
      }
    };

    window.addEventListener('message', onMessage);

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel(CroqueraBridge.BRIDGE_CHANNEL_NAME);
        channel.onmessage = onMessage;
      } catch {
        channel = null;
      }
    }

    const targetWin = window.open(appUrl, '_blank');
    if (!targetWin) {
      cleanup();
      alert('Could not open Croquera. Please allow popups for this site.');
      return;
    }

    let attempts = 0;
    retryTimer = setInterval(() => {
      attempts++;
      if (acknowledged || (targetWin && targetWin.closed) || attempts > 20) {
        cleanup();
        return;
      }
      void dispatchBuffer();
    }, 800);
  }
}
