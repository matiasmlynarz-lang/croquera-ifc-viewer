/**
 * PropertiesCard — Contextual floating card for element metadata and lazy Property Sets.
 */

import { MaterialManager, type RenderedElementRecord } from '@croquera/ifc-viewer';

export interface PropertiesCardCallbacks {
  onClose: () => void;
  onRequestPsets?: (stepId: number) => Promise<Record<string, Record<string, any>>>;
}

export class PropertiesCard {
  public readonly container: HTMLElement;
  private readonly cardTitle: HTMLElement;
  private readonly cardBody: HTMLElement;
  private readonly callbacks: PropertiesCardCallbacks;

  constructor(callbacks: PropertiesCardCallbacks) {
    this.callbacks = callbacks;

    this.container = document.createElement('div');
    this.container.id = 'properties-card';
    this.container.className = 'properties-card';
    this.container.innerHTML = `
      <div class="card-header">
        <span id="card-title" class="card-title">Element Properties</span>
        <button id="card-close" class="card-close">&times;</button>
      </div>
      <div id="card-body" class="card-body"></div>
    `;

    this.cardTitle = this.container.querySelector('#card-title') as HTMLElement;
    this.cardBody = this.container.querySelector('#card-body') as HTMLElement;
    const cardClose = this.container.querySelector('#card-close') as HTMLButtonElement;

    cardClose.addEventListener('click', () => {
      this.hide();
      this.callbacks.onClose();
    });
  }

  private currentStepId: number | null = null;

  public show(el: RenderedElementRecord | null): void {
    if (!el) {
      this.hide();
      return;
    }

    this.currentStepId = el.stepId;
    this.cardTitle.textContent = el.groupName || el.name || el.ifcType;

    const displayGuid = el.groupId || el.id;

    const matName = el.materialId
      ? (MaterialManager.getInstance().getMaterialName(el.materialId) || el.materialId)
      : 'Default Clay';

    let html = `
      <div class="prop-row">
        <span class="prop-label">IFC Type</span>
        <span class="prop-value">${el.ifcType}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">GUID</span>
        <span class="prop-value" style="font-size: 10px;">${displayGuid}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">STEP ID</span>
        <span class="prop-value">#${el.stepId}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">Material</span>
        <span class="prop-value">${matName}</span>
      </div>
    `;

    if (el.groupName && el.name && el.name !== el.groupName) {
      html += `
        <div class="prop-row">
          <span class="prop-label">Sub-element</span>
          <span class="prop-value">${el.name}</span>
        </div>
      `;
    }

    if (el.storeyId) {
      html += `
        <div class="prop-row">
          <span class="prop-label">Storey</span>
          <span class="prop-value">${el.storeyId}</span>
        </div>
      `;
    }

    const psets = el.psets;
    if (psets && Object.keys(psets).length > 0) {
      html += this.renderPsetsHtml(psets);
      this.cardBody.innerHTML = html;
      this.container.classList.add('visible');
    } else if (this.callbacks.onRequestPsets && el.stepId > 0) {
      html += `<div id="psets-loading-placeholder" class="psets-section"><span class="prop-value" style="font-style: italic;">Resolving properties...</span></div>`;
      this.cardBody.innerHTML = html;
      this.container.classList.add('visible');

      const requestedStepId = el.stepId;
      this.callbacks.onRequestPsets(requestedStepId).then((resolved) => {
        if (this.currentStepId === requestedStepId && resolved && Object.keys(resolved).length > 0) {
          el.psets = resolved;
          const placeholder = this.cardBody.querySelector('#psets-loading-placeholder');
          if (placeholder) {
            placeholder.outerHTML = this.renderPsetsHtml(resolved);
          }
        } else if (this.currentStepId === requestedStepId) {
          const placeholder = this.cardBody.querySelector('#psets-loading-placeholder');
          if (placeholder) {
            placeholder.remove();
          }
        }
      }).catch(() => {
        const placeholder = this.cardBody.querySelector('#psets-loading-placeholder');
        if (placeholder) {
          placeholder.remove();
        }
      });
    } else {
      this.cardBody.innerHTML = html;
      this.container.classList.add('visible');
    }
  }

  private renderPsetsHtml(psets: Record<string, Record<string, any>>): string {
    let html = `<div class="psets-section">`;
    for (const [psetName, props] of Object.entries(psets)) {
      html += `<div class="pset-title">${psetName}</div>`;
      for (const [propKey, propVal] of Object.entries(props)) {
        const valStr =
          typeof propVal === 'object' && propVal !== null && 'value' in propVal
            ? String(propVal.value)
            : String(propVal);
        html += `
          <div class="prop-row">
            <span class="prop-label">${propKey}</span>
            <span class="prop-value">${valStr}</span>
          </div>
        `;
      }
    }
    html += `</div>`;
    return html;
  }

  public hide(): void {
    this.currentStepId = null;
    this.container.classList.remove('visible');
  }
}
