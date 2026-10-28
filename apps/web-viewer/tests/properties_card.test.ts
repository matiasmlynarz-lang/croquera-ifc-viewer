// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PropertiesCard } from '../src/ui/PropertiesCard';
import type { RenderedElementRecord } from '@croquera/ifc-viewer';

describe('PropertiesCard — Multi-card flotante y arrastrable', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const dummyElement1: RenderedElementRecord = {
    id: 'guid-1111-2222',
    name: 'Muro Hormigon 20cm',
    ifcType: 'IfcWall',
    stepId: 101,
    materialId: 'mat_concrete',
    batchMeshIndex: 0,
    instanceIndex: 0,
    aabb: { min: [0, 0, 0], max: [1, 2, 3] },
  };

  const dummyElement2: RenderedElementRecord = {
    id: 'guid-3333-4444',
    name: 'Ventana Termopanel',
    ifcType: 'IfcWindow',
    stepId: 202,
    materialId: 'mat_glass',
    batchMeshIndex: 0,
    instanceIndex: 1,
    aabb: { min: [2, 0, 0], max: [3, 2, 1] },
  };

  it('permite tener varias tarjetas abiertas a la vez para distintos elementos', () => {
    const cardManager = new PropertiesCard({});
    document.body.appendChild(cardManager.container);

    cardManager.show(dummyElement1);
    cardManager.show(dummyElement2);

    expect(cardManager.getOpenCount()).toBe(2);
    const cards = cardManager.container.querySelectorAll('.properties-card');
    expect(cards.length).toBe(2);

    const title1 = cards[0].querySelector('.card-title')?.textContent;
    const title2 = cards[1].querySelector('.card-title')?.textContent;
    expect(title1).toBe('Muro Hormigon 20cm');
    expect(title2).toBe('Ventana Termopanel');
  });

  it('no duplica la tarjeta si el elemento ya está abierto y la resalta', () => {
    const cardManager = new PropertiesCard({});
    document.body.appendChild(cardManager.container);

    cardManager.show(dummyElement1);
    expect(cardManager.getOpenCount()).toBe(1);

    // Volver a seleccionar el mismo elemento
    cardManager.show(dummyElement1);
    expect(cardManager.getOpenCount()).toBe(1);
    const cards = cardManager.container.querySelectorAll('.properties-card');
    expect(cards.length).toBe(1);
    expect(cards[0].classList.contains('highlight')).toBe(true);
  });

  it('cierra únicamente la tarjeta en cuya x se presiona', () => {
    const cardManager = new PropertiesCard({});
    document.body.appendChild(cardManager.container);

    cardManager.show(dummyElement1);
    cardManager.show(dummyElement2);
    expect(cardManager.getOpenCount()).toBe(2);

    const cards = cardManager.container.querySelectorAll('.properties-card');
    const closeBtn1 = cards[0].querySelector('.card-close') as HTMLButtonElement;
    expect(closeBtn1).toBeDefined();

    // Presionar la X de la primera tarjeta
    closeBtn1.click();

    expect(cardManager.getOpenCount()).toBe(1);
    const remainingCards = cardManager.container.querySelectorAll('.properties-card');
    expect(remainingCards.length).toBe(1);
    expect(remainingCards[0].querySelector('.card-title')?.textContent).toBe('Ventana Termopanel');
  });

  it('incluye botón para copiar el GUID al portapapeles con feedback visual', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    const cardManager = new PropertiesCard({});
    document.body.appendChild(cardManager.container);

    cardManager.show(dummyElement1);

    const card = cardManager.container.querySelector('.properties-card')!;
    const guidValue = card.querySelector('.prop-guid-value')?.textContent;
    expect(guidValue).toBe('guid-1111-2222');

    const copyBtn = card.querySelector('.btn-copy-guid') as HTMLButtonElement;
    expect(copyBtn).toBeDefined();

    copyBtn.click();
    await Promise.resolve();

    expect(writeTextMock).toHaveBeenCalledWith('guid-1111-2222');
    expect(copyBtn.classList.contains('copied')).toBe(true);
  });

  it('cada tarjeta configura cabecera arrastrable con cursor grab', () => {
    const cardManager = new PropertiesCard({});
    document.body.appendChild(cardManager.container);

    cardManager.show(dummyElement1);

    const card = cardManager.container.querySelector('.properties-card') as HTMLElement;
    const header = card.querySelector('.card-header') as HTMLElement;
    expect(header).toBeDefined();

    // Mousedown en header activa clase de arrastre
    header.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100 }));
    expect(header.classList.contains('is-dragging')).toBe(true);

    // Mouseup finaliza arrastre
    document.dispatchEvent(new MouseEvent('mouseup'));
    expect(header.classList.contains('is-dragging')).toBe(false);
  });

  it('closeAll() cierra y elimina todas las tarjetas abiertas', () => {
    const cardManager = new PropertiesCard({});
    document.body.appendChild(cardManager.container);

    cardManager.show(dummyElement1);
    cardManager.show(dummyElement2);
    expect(cardManager.getOpenCount()).toBe(2);

    cardManager.closeAll();
    expect(cardManager.getOpenCount()).toBe(0);
    expect(cardManager.container.querySelectorAll('.properties-card').length).toBe(0);
  });
});
