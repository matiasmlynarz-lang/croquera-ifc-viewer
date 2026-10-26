/**
 * SearchFlyout — Instant GUID, UUID, and STEP ID search input with animated flyout.
 */

import type { GuidSearchEngine, SearchMatch } from '@croquera/ifc-viewer';

export interface SearchFlyoutCallbacks {
  onSelectResult: (elementId: string) => void;
}

export class SearchFlyout {
  public readonly container: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly searchFlyout: HTMLElement;
  private readonly searchEngine: GuidSearchEngine;
  private readonly callbacks: SearchFlyoutCallbacks;

  constructor(searchEngine: GuidSearchEngine, callbacks: SearchFlyoutCallbacks) {
    this.searchEngine = searchEngine;
    this.callbacks = callbacks;

    this.container = document.createElement('div');
    this.container.className = 'search-container';
    this.container.innerHTML = `
      <svg class="search-icon" viewBox="0 0 24 24">
        <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
      </svg>
      <input id="search-input" class="search-input" type="text" placeholder="Search GUID, UUID, #STEP, Type..." autocomplete="off" />
      <div id="search-flyout" class="search-results-flyout"></div>
    `;

    this.searchInput = this.container.querySelector('#search-input') as HTMLInputElement;
    this.searchFlyout = this.container.querySelector('#search-flyout') as HTMLElement;

    this.setupListeners();
  }

  private setupListeners(): void {
    this.searchInput.addEventListener('input', () => {
      const query = this.searchInput.value;
      const results = this.searchEngine.search(query, 10);

      if (results.length === 0 || !query.trim()) {
        this.searchFlyout.classList.remove('visible');
        this.searchFlyout.innerHTML = '';
        return;
      }

      this.renderResults(results);
    });

    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const results = this.searchEngine.search(this.searchInput.value, 1);
        if (results.length > 0) {
          this.callbacks.onSelectResult(results[0].id);
          this.searchFlyout.classList.remove('visible');
        }
      } else if (e.key === 'Escape') {
        this.searchFlyout.classList.remove('visible');
      }
    });

    document.addEventListener('click', (e) => {
      if (!this.container.contains(e.target as Node)) {
        this.searchFlyout.classList.remove('visible');
      }
    });
  }

  private renderResults(results: SearchMatch[]): void {
    this.searchFlyout.innerHTML = results
      .map(
        (r) => `
        <div class="search-result-item" data-id="${r.id}">
          <span class="result-name">${r.name || r.ifcType}</span>
          <span class="result-meta">
            <span>${r.ifcType}</span>
            <span>#${r.stepId}</span>
            <span>GUID: ${r.ifcGuid}</span>
          </span>
        </div>
      `
      )
      .join('');

    this.searchFlyout.classList.add('visible');

    this.searchFlyout.querySelectorAll('.search-result-item').forEach((item) => {
      item.addEventListener('click', () => {
        const elId = item.getAttribute('data-id');
        if (elId) {
          this.callbacks.onSelectResult(elId);
          this.searchFlyout.classList.remove('visible');
          this.searchInput.value = '';
        }
      });
    });
  }

  public clear(): void {
    this.searchInput.value = '';
    this.searchFlyout.innerHTML = '';
    this.searchFlyout.classList.remove('visible');
  }
}
