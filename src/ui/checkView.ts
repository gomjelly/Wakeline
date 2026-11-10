// 카메라 점검 화면. 프로젝터로 멀리서 봐도 읽히도록 글자를 크게 쓴다.

import type { CheckResult, CheckState } from '../check/cameraCheck';

const ICON: Record<CheckState, string> = { pass: '✓', warn: '!', fail: '✕', pending: '…' };

export class CheckView {
  private list: HTMLUListElement;
  private guidance: HTMLDivElement;
  private dots: HTMLDivElement;
  private banner: HTMLDivElement;
  private lastKey = '';

  constructor(root: HTMLElement) {
    this.list = root.querySelector('#checkList')!;
    this.guidance = root.querySelector('#checkGuidance')!;
    this.dots = root.querySelector('#checkDots')!;
    this.banner = root.querySelector('#checkBanner')!;
  }

  render(r: CheckResult): void {
    // 바뀐 게 없으면 DOM을 다시 그리지 않는다.
    const key = JSON.stringify([r.items.map((i) => [i.state, i.detail]), r.guidance, r.strokeCount, r.ready]);
    if (key === this.lastKey) return;
    this.lastKey = key;

    this.list.innerHTML = '';
    for (const item of r.items) {
      const li = document.createElement('li');
      li.className = `check-item ${item.state}`;
      li.innerHTML = `<span class="icon"></span><span class="label"></span><span class="detail"></span>`;
      li.querySelector('.icon')!.textContent = ICON[item.state];
      li.querySelector('.label')!.textContent = item.label + (item.required ? '' : ' (권장)');
      li.querySelector('.detail')!.textContent = item.detail;
      this.list.appendChild(li);
    }

    this.guidance.textContent = r.guidance;
    this.guidance.className = `check-guidance ${r.ready ? 'ready' : ''}`;

    this.dots.innerHTML = '';
    for (let i = 0; i < r.strokesNeeded; i++) {
      const d = document.createElement('span');
      d.className = `stroke-dot ${i < r.strokeCount ? 'on' : ''}`;
      this.dots.appendChild(d);
    }

    this.banner.hidden = !r.ready;
  }
}
