/**
 * StatusHud — Bottom status bar indicating streaming progress, element count, and system state.
 */

export class StatusHud {
  public readonly container: HTMLElement;
  private readonly statusDot: HTMLElement;
  private readonly statusText: HTMLElement;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'status-hud';
    this.container.innerHTML = `
      <div id="status-dot" class="status-dot"></div>
      <span id="status-text">Ready. Open or drag & drop an IFC model.</span>
    `;

    this.statusDot = this.container.querySelector('#status-dot') as HTMLElement;
    this.statusText = this.container.querySelector('#status-text') as HTMLElement;
  }

  public setLoading(message: string): void {
    this.statusDot.classList.add('loading');
    this.statusText.textContent = message;
  }

  public setReady(message: string): void {
    this.statusDot.classList.remove('loading');
    this.statusText.textContent = message;
  }

  public setError(message: string): void {
    this.statusDot.classList.remove('loading');
    this.statusText.textContent = message;
  }
}
