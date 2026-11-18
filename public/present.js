import {
  $, el, message, tabCredential, participantUrl, canShareParticipantUrl, poll, storageSet, emptyState, statusPill
} from './common.js';
import { chart, svgElement } from './charts.js';

const token = tabCredential('present');
let previousCode;

function join(code) {
  if (previousCode === code) return;
  previousCode = code;
  const url = participantUrl(code);
  $('join-link').href = url;
  if (!canShareParticipantUrl) {
    $('join-link').textContent = 'この端末で参加画面を開く ↗';
    $('local-join-help').hidden = false;
    return;
  }
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
  svg.append(svgElement('path', { d: modules.join(''), fill: '#172134' }));
  $('qr').replaceChildren(svg);
  $('qr-help').hidden = false;
}

function render(state) {
  join(state.participantCode);
  $('stage').hidden = false;
  const { question } = state;
  if (!question) {
    $('stage-main').replaceChildren(emptyState('投票の開始をお待ちください', '質問が始まったら、ここに表示されます。'));
    return;
  }
  const heading = el('div', { cls: 'stage-heading' },
    el('div', { cls: 'pills' }, statusPill(question.isOpen),
      el('span', { cls: 'pill pill-muted', text: question.type === 'single' ? '単一選択' : '複数選択' })),
    el('h1', { text: question.text }));
  if (state.mode === 'results') {
    $('stage-main').replaceChildren(heading, chart(question.results, question.style, question.type));
    return;
  }
  $('stage-main').replaceChildren(heading,
    el('ol', { cls: 'stage-options' }, ...question.options.map((option, index) => el('li', {},
      el('span', { cls: 'question-index', text: index + 1 }), el('span', { text: option })))),
    el('p', { cls: 'chart-summary', text: question.respondentCount + ' 人が回答' }));
}

poll('/api/present/state', token, { interval: 0, onState: render, onInvalid: text => {
  storageSet(sessionStorage, 'fakeslido:present', null);
  $('stage').hidden = true;
  $('stage-main').replaceChildren();
  $('qr').replaceChildren();
  $('join-link').removeAttribute('href');
  message(text);
} });
