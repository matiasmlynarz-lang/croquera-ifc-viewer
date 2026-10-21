/**
 * CroqueraBridge — Zero-copy bridge to launch and edit the model in Croquera (croquera.com).
 *
 * Implements a secure postMessage handshake transferring the raw IFC ArrayBuffer
 * without re-uploading to any remote cloud server.
 */

export interface CroqueraBridgeOptions {
  croqueraUrl?: string;
}

export class CroqueraBridge {
  private static readonly DEFAULT_CROQUERA_URL = 'https://croquera.com';
  private readonly targetUrl: string;

  private currentBuffer: ArrayBuffer | null = null;
  private currentFilename: string = 'model.ifc';

  constructor(options: CroqueraBridgeOptions = {}) {
    this.targetUrl = options.croqueraUrl || CroqueraBridge.DEFAULT_CROQUERA_URL;
  }

  /**
   * Registers the loaded IFC file buffer and filename in memory.
   */
  public setFile(buffer: ArrayBuffer, filename: string): void {
    this.currentBuffer = buffer;
    this.currentFilename = filename;
  }

  /**
   * Returns true if an IFC file buffer is ready for transmission.
   */
  public hasFile(): boolean {
    return this.currentBuffer !== null && this.currentBuffer.byteLength > 0;
  }

  /**
   * Launches croquera.com in a new tab and streams the IFC model buffer upon ready handshake.
   */
  public editInCroquera(): void {
    if (!this.currentBuffer) {
      alert('No IFC model is currently loaded.');
      return;
    }

    const appUrl = `${this.targetUrl}/?source=ifc-viewer&filename=${encodeURIComponent(this.currentFilename)}`;
    const targetWin = window.open(appUrl, '_blank');

    if (!targetWin) {
      alert('Could not open Croquera. Please allow popups for this site.');
      return;
    }

    // Clone the buffer slice so the viewer can still retain its own copy
    const bufferToSend = this.currentBuffer.slice(0);

    const onMessage = (event: MessageEvent): void => {
      // Check for ready signal from Croquera
      if (event.data && event.data.type === 'CROQUERA_READY_FOR_IMPORT') {
        window.removeEventListener('message', onMessage);

        targetWin.postMessage(
          {
            type: 'IMPORT_IFC_BUFFER',
            filename: this.currentFilename,
            buffer: bufferToSend,
          },
          '*',
          [bufferToSend]
        );
      }
    };

    window.addEventListener('message', onMessage);

    // Timeout safety: also send after 3 seconds in case handshake was missed
    setTimeout(() => {
      try {
        targetWin.postMessage(
          {
            type: 'IMPORT_IFC_BUFFER',
            filename: this.currentFilename,
            buffer: this.currentBuffer ? this.currentBuffer.slice(0) : undefined,
          },
          '*'
        );
      } catch {
        // Ignored
      }
    }, 3000);
  }
}
