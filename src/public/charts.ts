import { el } from './common.js';
import type { GraphStyle, QuestionType, Tally } from '../types.js';

const palette = ['#5047e5', '#00857d', '#c45519', '#b63272', '#2371b7', '#7e5835', '#68798a', '#68662a'];
const namespace = 'http://www.w3.org/2000/svg';

type SvgAttributes = Record<string, string | number>;

export function svgElement<Tag extends keyof SVGElementTagNameMap>(tag: Tag, attributes: SvgAttributes) {
  const element = document.createElementNS(namespace, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

function bar(width: number, color: string, vertical: boolean) {
  const svg = svgElement('svg', {
    viewBox: vertical ? '0 0 48 120' : '0 0 1000 16',
    preserveAspectRatio: 'none', 'aria-hidden': 'true'
  });
  svg.append(svgElement('rect', { width: vertical ? 48 : 1000, height: vertical ? 120 : 16, rx: 5, fill: '#ebedf7' }));
  if (width > 0) {
    svg.append(svgElement('rect', vertical ? {
      y: 120 - 1.2 * width, width: 48, height: 1.2 * width, rx: 5, fill: color
    } : { width: width * 10, height: 16, rx: 5, fill: color }));
  }
  return svg;
}

function segmented(results: Tally, donut: boolean) {
  const svg = svgElement('svg', {
    viewBox: donut ? '0 0 140 140' : '0 0 1000 32',
    preserveAspectRatio: donut ? 'xMidYMid meet' : 'none', 'aria-hidden': 'true'
  });
  const track: SvgAttributes = donut ? { cx: 70, cy: 70, r: 53, fill: 'none', stroke: '#ebedf7', 'stroke-width': 26 }
    : { width: 1000, height: 32, fill: '#ebedf7' };
  const tag = donut ? 'circle' : 'rect';
  svg.append(svgElement(tag, track));
  let offset = 0;
  for (const [index, option] of results.options.entries()) {
    if (!option.optionVotes) continue;
    const share = option.optionVotes / results.respondentCount;
    const color = palette[index];
    svg.append(svgElement(tag, donut ? {
      ...track, stroke: color, pathLength: 1, 'stroke-dasharray': share + ' ' + (1 - share),
      'stroke-dashoffset': -offset, transform: 'rotate(-90 70 70)'
    } : { x: offset * 1000, width: share * 1000, height: 32, fill: color }));
    offset += share;
  }
  return svg;
}

export function chart(results: Tally, style: GraphStyle, type: QuestionType) {
  const vertical = style === 'vertical';
  const container = el('div', { cls: 'chart chart-' + style });
  container.append(el('p', { cls: 'chart-summary', text: results.respondentCount + ' 人が回答'
    + (type === 'multiple' ? ' · 合計 ' + results.totalSelections + ' 件の選択' : '') }));
  if (style === 'donut' || style === 'stacked') container.append(segmented(results, style === 'donut'));
  const list = el('ol', { cls: 'chart-list' });
  for (const [index, option] of results.options.entries()) {
    const color = palette[index];
    const swatch = svgElement('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' });
    swatch.append(svgElement('rect', { width: 12, height: 12, rx: 3, fill: color }));
    const label = el('span', { cls: 'chart-label' }, swatch, el('span', { text: option.optionText }));
    const count = el('span', { cls: 'chart-count', text: option.optionVotes + ' 票 · ' + option.percentage.toFixed(1) + '%' });
    const row = el('li', { cls: 'chart-row' }, el('div', { cls: 'chart-meta' }, label, count));
    if (style === 'horizontal' || vertical) row.append(bar(option.percentage, color, vertical));
    list.append(row);
  }
  container.append(list);
  if (type === 'multiple') container.append(el('p', { cls: 'muted chart-note', text: '割合の分母は回答者数です。' }));
  return container;
}
