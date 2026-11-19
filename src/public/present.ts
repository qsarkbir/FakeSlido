import {
  $, el, message, tabCredential, participantUrl, canShareParticipantUrl, poll, storageSet, emptyState, statusPill
} from './common.js';
import { chart } from './charts.js';
import { participantQr } from './qr.js';
import { discussionStage } from './present-discussion.js';
import type { PresentState } from '../types.js';

const token = tabCredential('present');
const joinLink = $('join-link', HTMLAnchorElement);
let previousCode: string | undefined;
const discussions = discussionStage($('stage-main'));

function join(code: string) {
  if (previousCode === code) return;
  previousCode = code;
  const url = participantUrl(code);
  joinLink.href = url;
  if (!canShareParticipantUrl) {
    joinLink.textContent = 'この端末で参加画面を開く ↗';
    $('local-join-help').hidden = false;
    return;
  }
  $('qr').replaceChildren(participantQr(url));
  $('qr-help').hidden = false;
}

function render(state: PresentState) {
  join(state.participantCode);
  $('stage').hidden = false;
  if (state.discussion) {
    discussions.render(state.discussion, state.sessionId);
    return;
  }
  discussions.reset();
  const { question } = state;
  if (!question) {
    $('stage-main').replaceChildren(emptyState('投票の開始をお待ちください', '質問が始まったら、ここに表示されます。'));
    return;
  }
  const heading = el('div', { cls: 'stage-heading' },
    el('div', { cls: 'pills' }, statusPill(question.isOpen),
      el('span', { cls: 'pill pill-muted', text: question.type === 'single' ? '単一選択' : '複数選択' })),
    el('h1', { text: question.text }));
  if (state.mode === 'results' && question.results) {
    $('stage-main').replaceChildren(heading, chart(question.results, question.style, question.type));
    return;
  }
  $('stage-main').replaceChildren(heading,
    el('ol', { cls: 'stage-options' }, ...question.options.map((option, index) => el('li', {},
      el('span', { cls: 'question-index', text: index + 1 }), el('span', { text: option })))),
    el('p', { cls: 'chart-summary', text: question.respondentCount + ' 人が回答' }));
}

poll('/api/present/state', token, { interval: 0, onState: render, onConnection: connection => {
  if (connection === 'reconnecting') {
    discussions.reset();
    $('stage-main').replaceChildren(emptyState('再接続しています', '最新の公開状態を確認するまで表示を停止します。'));
  }
}, onInvalid: text => {
  storageSet(sessionStorage, 'fakeslido:present', null);
  $('stage').hidden = true;
  discussions.reset();
  $('qr').replaceChildren();
  joinLink.removeAttribute('href');
  message(text);
} });
