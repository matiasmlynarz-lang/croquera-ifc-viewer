/**
 * TopHud — Floating top navigation bar for file opening, measurement, and Croquera bridge.
 */

export interface TopHudCallbacks {
  onOpenFile: () => void;
  onToggleMeasure: (active: boolean) => void;
  onEditInCroquera: () => void;
}

export class TopHud {
  public readonly container: HTMLElement;
  private btnMeasure: HTMLButtonElement;
  private isMeasureActive: boolean = false;

  constructor(callbacks: TopHudCallbacks) {
    this.container = document.createElement('header');
    this.container.className = 'top-hud';
    this.container.innerHTML = `
      <div class="app-brand" title="Croquera">
        <svg class="brand-logo" viewBox="0 0 512 512" width="28" height="28" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <mask id="cutout-croquera-logo">
              <rect width="512" height="512" fill="#FFFFFF"/>
              <circle cx="256" cy="256" r="88" fill="#000000"/>
              <rect x="256" y="224" width="256" height="64" fill="#000000"/>
              <circle cx="256" cy="256" r="157.5" fill="none" stroke="#000000" stroke-width="15"/>
              <circle cx="256" cy="256" r="232.5" fill="none" stroke="#000000" stroke-width="15"/>
              <line x1="375" y1="375" x2="445" y2="445" stroke="#000000" stroke-width="15" stroke-linecap="square"/>
            </mask>
          </defs>
          <circle cx="256" cy="256" r="255" fill="#2563EB" mask="url(#cutout-croquera-logo)"/>
        </svg>
      </div>

      <button id="btn-open-file" class="btn-tactile">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
        </svg>
        Open IFC
      </button>

      <div id="search-slot" class="search-container"></div>

      <button id="btn-measure" class="btn-tactile">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M2 12h20M2 7l3 5-3 5M22 7l-3 5 3 5"/>
        </svg>
        Measure
      </button>

      <button id="btn-edit-croquera" class="btn-tactile btn-accent">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
        Edit in Croquera
      </button>
    `;

    const btnOpen = this.container.querySelector('#btn-open-file') as HTMLButtonElement;
    this.btnMeasure = this.container.querySelector('#btn-measure') as HTMLButtonElement;
    const btnEdit = this.container.querySelector('#btn-edit-croquera') as HTMLButtonElement;

    btnOpen.addEventListener('click', () => callbacks.onOpenFile());
    btnEdit.addEventListener('click', () => callbacks.onEditInCroquera());

    this.btnMeasure.addEventListener('click', () => {
      this.isMeasureActive = !this.isMeasureActive;
      this.btnMeasure.classList.toggle('active', this.isMeasureActive);
      callbacks.onToggleMeasure(this.isMeasureActive);
    });
  }

  public setMeasureActive(active: boolean): void {
    this.isMeasureActive = active;
    this.btnMeasure.classList.toggle('active', active);
  }

  public getSearchSlot(): HTMLElement {
    return this.container.querySelector('#search-slot') as HTMLElement;
  }
}
