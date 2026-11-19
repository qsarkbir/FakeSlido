import { svgElement } from './charts.js';

interface QrCode {
  addData(text: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, column: number): boolean;
}

// 同梱スクリプトが Window に追加する関数のうち、利用する操作だけを宣言する。
declare global {
  interface Window {
    qrcode(type: 0, correction: 'M'): QrCode;
  }
}

export function participantQr(url: string) {
  const qr = window.qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const size = qr.getModuleCount();
  const svg = svgElement('svg', { viewBox: '-4 -4 ' + (size + 8) + ' ' + (size + 8),
    role: 'img', 'aria-label': '参加URLのQRコード' });
  svg.append(svgElement('rect', { x: -4, y: -4, width: size + 8, height: size + 8, fill: '#fff' }));
  const modules = [];
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      if (qr.isDark(row, column)) modules.push('M' + column + ' ' + row + 'h1v1h-1z');
    }
  }
  if (!modules.length) throw new Error('QRコードを生成できませんでした。');
  svg.append(svgElement('path', { d: modules.join(''), fill: '#172134' }));
  return svg;
}
