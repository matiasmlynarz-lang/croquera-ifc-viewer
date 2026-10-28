/**
 * PropertiesCard — Contextual draggable floating cards for element metadata and lazy Property Sets.
 *
 * Supports:
 * - Multiple simultaneous open cards across selections.
 * - Draggable header with window boundary clamping.
 * - Persistent until explicit close button ('x') click.
 * - One-click GUID copying to clipboard with visual feedback.
 */

import { MaterialManager, type RenderedElementRecord } from '@croquera/ifc-viewer';

export interface PropertiesCardCallbacks {
  onClose?: () => void;
  onRequestPsets?: (stepId: number) => Promise<Record<string, Record<string, any>>>;
}

let highestZIndex = 100;

export class SinglePropertyCard {
  public readonly elementKey: string;
  public readonly container: HTMLElement;
  private readonly header: HTMLElement;
  private readonly cardTitle: HTMLElement;
  private readonly cardBody: HTMLElement;
  private currentStepId: number | null = null;
  private readonly callbacks: PropertiesCardCallbacks;
  private readonly onCloseRequest: (card: SinglePropertyCard) => void;

  constructor(
    elementKey: string,
    el: RenderedElementRecord,
    index: number,
    callbacks: PropertiesCardCallbacks,
    onCloseRequest: (card: SinglePropertyCard) => void
  ) {
    this.elementKey = elementKey;
    this.callbacks = callbacks;
    this.onCloseRequest = onCloseRequest;

    this.container = document.createElement('div');
    this.container.className = 'properties-card visible';
    this.container.dataset.elementKey = elementKey;
    this.bringToFront();

    this.container.innerHTML = `
      <div class="card-header">
        <span class="card-title">Element Properties</span>
        <button class="card-close" title="Cerrar">&times;</button>
      </div>
      <div class="card-body"></div>
    `;

    this.header = this.container.querySelector('.card-header') as HTMLElement;
    this.cardTitle = this.container.querySelector('.card-title') as HTMLElement;
    this.cardBody = this.container.querySelector('.card-body') as HTMLElement;
    const cardClose = this.container.querySelector('.card-close') as HTMLButtonElement;

    cardClose.addEventListener('click', (e) => {
      e.stopPropagation();
      this.destroy();
      this.onCloseRequest(this);
    });

    this.container.addEventListener('mousedown', () => {
      this.bringToFront();
    });

    this.setupDraggable();
    this.setInitialPosition(index);
    this.populate(el);
  }

  public bringToFront(): void {
    highestZIndex++;
    this.container.style.zIndex = `${highestZIndex}`;
  }

  public highlight(): void {
    this.bringToFront();
    this.container.classList.remove('highlight');
    // Forzar reflujo DOM para reiniciar animación
    void this.container.offsetWidth;
    this.container.classList.add('highlight');
    setTimeout(() => {
      this.container.classList.remove('highlight');
    }, 1200);
  }

  private setInitialPosition(index: number): void {
    const cardWidth = 320;
    const cardHeight = 360;
    const cascadeOffset = (index % 8) * 26;

    // Posicionamiento en cascada en la zona inferior-derecha por defecto
    const targetRight = 24 + cascadeOffset;
    const targetBottom = 24 + cascadeOffset;

    const initialLeft = Math.max(16, window.innerWidth - cardWidth - targetRight);
    const initialTop = Math.max(70, window.innerHeight - cardHeight - targetBottom);

    this.container.style.left = `${initialLeft}px`;
    this.container.style.top = `${initialTop}px`;
    this.container.style.right = 'auto';
    this.container.style.bottom = 'auto';
  }

  private setupDraggable(): void {
    let isDragging = false;
    let startMouseX = 0;
    let startMouseY = 0;
    let startCardLeft = 0;
    let startCardTop = 0;

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      e.preventDefault();
      const dx = e.clientX - startMouseX;
      const dy = e.clientY - startMouseY;

      const cardRect = this.container.getBoundingClientRect();
      const maxLeft = Math.max(10, window.innerWidth - cardRect.width - 10);
      const maxTop = Math.max(10, window.innerHeight - cardRect.height - 10);

      const nextLeft = Math.max(10, Math.min(maxLeft, startCardLeft + dx));
      const nextTop = Math.max(10, Math.min(maxTop, startCardTop + dy));

      this.container.style.left = `${nextLeft}px`;
      this.container.style.top = `${nextTop}px`;
    };

    const onMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      this.header.classList.remove('is-dragging');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    this.header.addEventListener('mousedown', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.card-close') || (e.target as HTMLElement).closest('button')) {
        return;
      }
      e.preventDefault();
      isDragging = true;
      this.bringToFront();

      const rect = this.container.getBoundingClientRect();
      startMouseX = e.clientX;
      startMouseY = e.clientY;
      startCardLeft = rect.left;
      startCardTop = rect.top;

      this.container.style.left = `${startCardLeft}px`;
      this.container.style.top = `${startCardTop}px`;
      this.container.style.right = 'auto';
      this.container.style.bottom = 'auto';

      this.header.classList.add('is-dragging');
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  public populate(el: RenderedElementRecord): void {
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
      <div class="prop-row prop-row-guid">
        <span class="prop-label">GUID</span>
        <div class="prop-guid-container">
          <span class="prop-value prop-guid-value" title="${displayGuid}">${displayGuid}</span>
          <button type="button" class="btn-copy-guid" title="Copiar GUID" aria-label="Copiar GUID">
            <svg class="icon-copy" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <svg class="icon-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display: none;">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </button>
        </div>
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
      this.bindCopyAction(displayGuid);
    } else if (this.callbacks.onRequestPsets && el.stepId > 0) {
      html += `<div id="psets-loading-placeholder" class="psets-section"><span class="prop-value" style="font-style: italic;">Resolving properties...</span></div>`;
      this.cardBody.innerHTML = html;
      this.bindCopyAction(displayGuid);

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
      this.bindCopyAction(displayGuid);
    }
  }

  private bindCopyAction(guidText: string): void {
    const copyBtn = this.cardBody.querySelector('.btn-copy-guid') as HTMLButtonElement | null;
    if (!copyBtn) return;

    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      let ok = false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(guidText);
          ok = true;
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        // Fallback para entornos donde Clipboard API esté restringido
        const ta = document.createElement('textarea');
        ta.value = guidText;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try {
          ok = document.execCommand('copy');
        } catch {
          ok = false;
        }
        document.body.removeChild(ta);
      }

      if (ok) {
        copyBtn.classList.add('copied');
        const iconCopy = copyBtn.querySelector('.icon-copy') as HTMLElement | null;
        const iconCheck = copyBtn.querySelector('.icon-check') as HTMLElement | null;
        if (iconCopy) iconCopy.style.display = 'none';
        if (iconCheck) iconCheck.style.display = 'inline-block';
        copyBtn.setAttribute('title', '¡Copiado!');

        setTimeout(() => {
          copyBtn.classList.remove('copied');
          if (iconCopy) iconCopy.style.display = 'inline-block';
          if (iconCheck) iconCheck.style.display = 'none';
          copyBtn.setAttribute('title', 'Copiar GUID');
        }, 1500);
      }
    });
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

  public destroy(): void {
    this.currentStepId = null;
    this.container.remove();
  }
}

export class PropertiesCard {
  public readonly container: HTMLElement;
  private readonly callbacks: PropertiesCardCallbacks;
  private openCards: Map<string, SinglePropertyCard> = new Map();
  private openCounter = 0;

  constructor(callbacks: PropertiesCardCallbacks) {
    this.callbacks = callbacks;

    this.container = document.createElement('div');
    this.container.id = 'properties-cards-root';
    this.container.className = 'properties-cards-root';
  }

  /**
   * Muestra o añade una tarjeta para el elemento seleccionado.
   * Si ya existe una tarjeta abierta para este elemento, la trae al frente y la resalta.
   */
  public show(el: RenderedElementRecord | null): void {
    if (!el) return;

    const elementKey = el.stepId > 0 ? `step_${el.stepId}` : `guid_${el.groupId || el.id}`;

    const existingCard = this.openCards.get(elementKey);
    if (existingCard) {
      existingCard.highlight();
      existingCard.populate(el);
      return;
    }

    const card = new SinglePropertyCard(
      elementKey,
      el,
      this.openCounter++,
      this.callbacks,
      (closedCard) => {
        this.openCards.delete(closedCard.elementKey);
        if (this.openCards.size === 0) {
          this.callbacks.onClose?.();
        }
      }
    );

    this.openCards.set(elementKey, card);
    this.container.appendChild(card.container);
  }

  /**
   * Cierra una tarjeta específica por clave, o si no se especifica, no hace nada (las tarjetas
   * permanecen abiertas hasta que el usuario hace clic en su 'x').
   */
  public hide(elementKey?: string): void {
    if (elementKey) {
      const card = this.openCards.get(elementKey);
      if (card) {
        card.destroy();
        this.openCards.delete(elementKey);
      }
    }
  }

  /**
   * Cierra y limpia todas las tarjetas abiertas (usado al cargar un nuevo archivo o limpiar escena).
   */
  public closeAll(): void {
    for (const card of this.openCards.values()) {
      card.destroy();
    }
    this.openCards.clear();
    this.openCounter = 0;
  }

  /**
   * Retorna la cantidad de tarjetas actualmente abiertas.
   */
  public getOpenCount(): number {
    return this.openCards.size;
  }
}
