/**
 * DropOverlay.ts — Fullscreen drag and drop overlay for IFC/STEP files.
 */

export interface DropOverlayCallbacks {
  onFileDropped: (file: File) => void;
}

export class DropOverlay {
  public readonly container: HTMLElement;
  private readonly callbacks: DropOverlayCallbacks;
  private dragCounter: number = 0;

  constructor(callbacks: DropOverlayCallbacks) {
    this.callbacks = callbacks;

    this.container = document.createElement('div');
    this.container.id = 'drop-overlay';
    this.container.className = 'drop-overlay';
    this.container.innerHTML = `
      <div class="drop-box">
        Drop IFC model here to stream & visualize
      </div>
    `;

    this.setupListeners();
  }

  private setupListeners(): void {
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      this.dragCounter++;
      this.container.classList.add('active');
    });

    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!this.container.classList.contains('active')) {
        this.container.classList.add('active');
      }
    });

    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      this.dragCounter--;
      if (this.dragCounter <= 0) {
        this.dragCounter = 0;
        this.container.classList.remove('active');
      }
    });

    window.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dragCounter = 0;
      this.container.classList.remove('active');

      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        if (file.name.toLowerCase().endsWith('.ifc') || file.name.toLowerCase().endsWith('.step')) {
          this.callbacks.onFileDropped(file);
        }
      }
    });
  }

  public hide(): void {
    this.dragCounter = 0;
    this.container.classList.remove('active');
  }
}
