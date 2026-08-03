/**
 * PaintingGame.js — 'Paint the Badger', a little colouring activity found on
 * the desk in Neptune's Nook. A flat, storybook line-drawing of a badger in a
 * forest is shown as a full-screen modal (much like Veggie Tac Toe's overlay);
 * the player picks a colour from a ROYGBIV + white + black palette and taps
 * each region to fill it. Once every region is coloured, they can frame it —
 * that counts as "completing a painting".
 *
 * The Game freezes the run clock while this plays and drives a bird's-eye
 * camera over the nook. No points are scored; it's purely for the joy of it
 * (and the 'More Lines Than Mondrian' trophy).
 */

// The palette: the seven colours of the rainbow, plus white and black.
const PALETTE = [
  { name: 'Red', hex: '#e23b3b' },
  { name: 'Orange', hex: '#f08a2e' },
  { name: 'Yellow', hex: '#f5d340' },
  { name: 'Green', hex: '#46b45a' },
  { name: 'Blue', hex: '#3f76c4' },
  { name: 'Indigo', hex: '#4b3fa0' },
  { name: 'Violet', hex: '#8e4fc4' },
  { name: 'White', hex: '#ffffff' },
  { name: 'Black', hex: '#1e1a1a' }
];

const PAPER = '#f4efe6'; // the blank, unpainted "paper" colour
const SVGNS = 'http://www.w3.org/2000/svg';

export class PaintingGame {
  /**
   * @param {(result: 'complete'|'abandon') => void} onFinish
   */
  constructor(onFinish) {
    this.onFinish = onFinish;
    this.state = 'play';
    this.selected = PALETTE[0].hex;
    this._painted = new Set();
    this._regions = [];

    // --- full-screen dimmed modal --------------------------------------
    this.overlay = document.createElement('div');
    this.overlay.className = 'painting-overlay';

    const card = document.createElement('div');
    card.className = 'painting-card';
    this.overlay.appendChild(card);

    const title = document.createElement('div');
    title.className = 'painting-title';
    title.textContent = 'Paint the Badger';
    card.appendChild(title);

    this.status = document.createElement('div');
    this.status.className = 'painting-status';
    card.appendChild(this.status);

    // The picture itself.
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'painting-canvas');
    svg.setAttribute('viewBox', '0 0 400 300');
    card.appendChild(svg);
    this._buildPicture(svg);

    // The colour palette.
    const palette = document.createElement('div');
    palette.className = 'painting-palette';
    this._swatches = [];
    for (const c of PALETTE) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'painting-swatch';
      sw.style.background = c.hex;
      sw.title = c.name;
      sw.setAttribute('aria-label', c.name);
      sw.addEventListener('click', () => this._selectColour(c.hex, sw));
      palette.appendChild(sw);
      this._swatches.push(sw);
    }
    card.appendChild(palette);
    this._selectColour(PALETTE[0].hex, this._swatches[0]);

    // Frame-it / quit.
    const actions = document.createElement('div');
    actions.className = 'painting-actions';
    this.doneBtn = document.createElement('button');
    this.doneBtn.type = 'button';
    this.doneBtn.className = 'painting-done';
    this.doneBtn.textContent = '🖼️ Frame it!';
    this.doneBtn.disabled = true;
    this.doneBtn.addEventListener('click', () => {
      if (this.state === 'play' && this._painted.size >= this._regions.length) {
        this.state = 'done';
        this.onFinish('complete');
      }
    });
    const quitBtn = document.createElement('button');
    quitBtn.type = 'button';
    quitBtn.className = 'painting-quit';
    quitBtn.textContent = 'Leave it';
    quitBtn.addEventListener('click', () => this.abandon());
    actions.appendChild(this.doneBtn);
    actions.appendChild(quitBtn);
    card.appendChild(actions);

    document.body.appendChild(this.overlay);
    this._updateStatus();
  }

  _selectColour(hex, swatch) {
    this.selected = hex;
    for (const s of this._swatches) s.classList.toggle('selected', s === swatch);
  }

  /** A colourable region: a shape that fills with the chosen colour on tap. */
  _region(svg, tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    el.setAttribute('fill', PAPER);
    el.setAttribute('stroke', '#2a2320');
    el.setAttribute('stroke-width', '2.4');
    el.setAttribute('stroke-linejoin', 'round');
    el.classList.add('paint-region');
    el.addEventListener('click', () => {
      if (this.state !== 'play') return;
      el.setAttribute('fill', this.selected);
      this._painted.add(el);
      this._updateStatus();
    });
    svg.appendChild(el);
    this._regions.push(el);
    return el;
  }

  /** Decoration that isn't coloured in (eyes, etc.). */
  _decor(svg, tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    el.setAttribute('pointer-events', 'none');
    svg.appendChild(el);
    return el;
  }

  /** A storybook badger sitting in a moonlit forest, built from regions. */
  _buildPicture(svg) {
    // Sky and ground.
    this._region(svg, 'rect', { x: 0, y: 0, width: 400, height: 208 });
    this._region(svg, 'path', { d: 'M0 208 Q 200 178 400 208 L400 300 L0 300 Z' });
    // Moon.
    this._region(svg, 'circle', { cx: 332, cy: 54, r: 30 });
    // Two trees (foliage + trunk each).
    this._region(svg, 'polygon', { points: '20,158 92,158 56,60' });
    this._region(svg, 'rect', { x: 48, y: 156, width: 16, height: 58 });
    this._region(svg, 'polygon', { points: '312,168 380,168 346,82' });
    this._region(svg, 'rect', { x: 338, y: 166, width: 15, height: 48 });
    // Badger: body, head, ears, snout, two face stripes.
    this._region(svg, 'ellipse', { cx: 200, cy: 214, rx: 72, ry: 46 });
    this._region(svg, 'circle', { cx: 200, cy: 150, r: 44 });
    this._region(svg, 'circle', { cx: 170, cy: 116, r: 14 });
    this._region(svg, 'circle', { cx: 230, cy: 116, r: 14 });
    this._region(svg, 'ellipse', { cx: 200, cy: 172, rx: 18, ry: 20 });
    this._region(svg, 'polygon', { points: '178,116 192,118 190,178 176,176' });
    this._region(svg, 'polygon', { points: '222,116 208,118 210,178 224,176' });
    // Two little eyes (not coloured in).
    this._decor(svg, 'circle', { cx: 184, cy: 150, r: 4.5, fill: '#2a2320' });
    this._decor(svg, 'circle', { cx: 216, cy: 150, r: 4.5, fill: '#2a2320' });
    // A nose on the snout.
    this._decor(svg, 'ellipse', { cx: 200, cy: 164, rx: 5.5, ry: 4, fill: '#2a2320' });
  }

  _updateStatus() {
    const left = this._regions.length - this._painted.size;
    if (left > 0) {
      this.status.textContent = `Tap each part to colour it — ${left} to go`;
      this.doneBtn.disabled = true;
    } else {
      this.status.textContent = 'Beautiful! Frame it to finish.';
      this.doneBtn.disabled = false;
    }
  }

  // Kept for parity with the other mini-games; nothing per-frame to do.
  update() {}

  abandon() {
    if (this.state === 'done') return;
    this.state = 'done';
    this.onFinish('abandon');
  }

  dispose() {
    if (this.overlay && this.overlay.parentNode) this.overlay.parentNode.removeChild(this.overlay);
    this.overlay = null;
    this._regions = null;
    this._swatches = null;
  }
}
