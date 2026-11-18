import {
  $, el, button, message, tabCredential, participantUrl, canShareParticipantUrl, request, poll, downloadFile,
  storageGet, storageSet, styleLabels, emptyState, statusPill
} from './common.js';
import { chart } from './charts.js';

const key = tabCredential('admin');
const backupKey = 'fakeslido:deck';
let state;
let previousSessionId;
let selectedId;
let editing;
let busy = false;
const editor = $('editor');
const optionFields = $('option-fields');
const submitEdit = $('edit-form').querySelector('[type="submit"]');

function draft(question) {
  const { questionId, text, type, options, style } = question;
  return { questionId, text, type, options, style };
}

function deckData() {
  return { format: 'fakeslido-deck', version: 1, questions: state.questions.map(draft) };
}

function applyState(next) {
  if (next.sessionId === previousSessionId) return;
  const sameSession = next.sessionId === state?.sessionId;
  if (sameSession && next.revision <= state.revision) return;
  if (state && !sameSession) previousSessionId = state.sessionId;
  const newDeck = next.deckRevision !== state?.deckRevision;
  state = next;
  if (!state.questions.some(question => question.questionId === selectedId)) {
    selectedId = state.questions[0]?.questionId;
  }
  if (newDeck && state.questions.length) storageSet(localStorage, backupKey, JSON.stringify(deckData()));
  else if (newDeck && sameSession) storageSet(localStorage, backupKey, null);
  $('workspace').hidden = false;
  $('copy-link').disabled = false;
  $('open-present').disabled = false;
  updateBackupControls();
  $('add').disabled = state.questions.length >= 50;
  render();
}

function updateBackupControls() {
  const hasBackup = Boolean(storageGet(localStorage, backupKey));
  $('restore').hidden = state.questions.length > 0 || !hasBackup;
  $('clear-backup').hidden = !hasBackup;
}

function render() {
  const metrics = [
    ['質問数', state.questions.length],
    ['受付中', state.questions.filter(question => question.isOpen).length],
    ['結果公開済み', state.questions.filter(question => question.resultsPublished).length]
  ];
  const overview = metrics.map(([label, count]) => el('div', { cls: 'metric' },
    el('span', { text: label }), el('strong', { text: count })));
  $('overview').replaceChildren(...overview);

  const focused = document.activeElement?.dataset.focus;
  $('questions').replaceChildren(...state.questions.map((question, index) => {
    const row = button('', () => {
      selectedId = question.questionId;
      render();
    }, 'question-row');
    row.setAttribute('aria-pressed', String(selectedId === question.questionId));
    row.dataset.focus = 'question-' + question.questionId;
    row.append(el('span', { cls: 'question-index', text: String(index + 1).padStart(2, '0') }),
      el('span', { cls: 'question-row-content' }, el('strong', { text: question.text }),
        el('small', { text: question.results.respondentCount + ' 人が回答' })),
      statusPill(question.isOpen, question.everOpened));
    return row;
  }));
  if (!state.questions.length) {
    $('questions').append(el('p', { cls: 'list-empty muted', text: '質問はまだありません。' }));
    $('detail').replaceChildren(emptyState('最初の質問を作成', '質問を追加するか、保存した質問集を読み込んでください。'));
  } else {
    renderDetail(state.questions.find(question => question.questionId === selectedId));
  }
  if (focused) {
    document.querySelectorAll('[data-focus]').forEach(element => {
      if (element.dataset.focus === focused && !element.disabled) element.focus({ preventScroll: true });
    });
  }
}

function action(label, handler, cls, disabled) {
  const element = button(label, handler, cls, disabled);
  element.dataset.focus = label;
  return element;
}

function renderDetail(question) {
  const id = question.questionId;
  const inPresentation = state.presentation.questionId === id;
  const index = state.questions.findIndex(item => item.questionId === id);
  const heading = el('div', { cls: 'detail-heading' },
    el('div', { cls: 'pills' }, statusPill(question.isOpen, question.everOpened),
      el('span', { cls: 'pill ' + (question.resultsPublished ? 'pill-purple' : 'pill-muted'),
        text: question.resultsPublished ? '結果公開済み' : '結果非公開' }),
      ...(inPresentation ? [el('span', { cls: 'pill pill-purple', text: '発表に選択済み' })] : [])),
    el('h2', { text: question.text }), el('p', { cls: 'muted',
      text: (question.type === 'single' ? '単一選択' : '複数選択') + ' · ' + styleLabels[question.style] }));
  const controls = el('div', { cls: 'actions detail-actions' },
    action(question.isOpen ? '受付を終了' : '受付を開始して発表',
      () => control(question.isOpen ? 'close' : 'open', id), question.isOpen ? '' : 'primary'),
    action(question.resultsPublished ? '結果を非公開' : '結果を公開',
      () => control(question.resultsPublished ? 'unpublish' : 'publish', id), '', !question.everOpened),
    action('発表する質問に選択', () => control('select', id), '', inPresentation));
  if (inPresentation) {
    controls.append(el('div', { cls: 'segmented', attrs: { role: 'group', 'aria-label': '発表モード' } },
      modeButton('質問モード', 'question'), modeButton('可視化モード', 'results', !question.everOpened)));
  }
  const tally = el('div', { cls: 'tally' }, el('h3', { text: '回答状況' }), chart(question.results, question.style, question.type));
  const tools = el('div', { cls: 'actions question-tools' },
    action('編集', () => showEditor(question), 'compact'),
    action('↑ 上へ', () => moveQuestion(index, -1), 'compact', index === 0),
    action('↓ 下へ', () => moveQuestion(index, 1), 'compact', index === state.questions.length - 1),
    action('票をリセット', () => {
      if (window.confirm('この質問の票をすべてリセットしますか？')) control('reset-votes', id, true);
    }, 'compact'),
    action('質問を削除', () => {
      if (window.confirm('この質問を削除しますか？ この質問の票も消去されます。')) {
        saveDeck(state.questions.filter(item => item.questionId !== id).map(draft), { confirmReset: true });
      }
    }, 'danger-link compact'));
  $('detail').replaceChildren(heading, controls, tally, tools);
}

function modeButton(label, mode, disabled) {
  const element = action(label, () => control(mode === 'results' ? 'show-results' : 'show-question'), 'compact', disabled);
  element.setAttribute('aria-pressed', String(state.presentation.mode === mode));
  return element;
}

async function run(operation, errorTarget = $('notice')) {
  if (busy) return false;
  busy = true;
  try {
    message('', errorTarget);
    await operation();
    return true;
  } catch (error) {
    message(error.message || '操作を完了できませんでした。', errorTarget);
    return false;
  } finally {
    busy = false;
  }
}

function control(actionName, questionId, confirm) {
  return run(async () => {
    applyState(await request('/api/admin/control', key, {
      method: 'POST', data: { action: actionName, questionId, confirm }
    }));
  });
}

function saveDeck(questions, { replace, confirmReset, deckRevision = state.deckRevision, errorTarget } = {}) {
  return run(async () => {
    const data = { questions, deckRevision, replace, confirmReset };
    const send = () => request('/api/admin/deck', key, { method: 'PUT', data });
    let next;
    try {
      next = await send();
    } catch (error) {
      if (error.code !== 'confirm_reset') throw error;
      if (!window.confirm('この操作で対象の質問の票が消去されます。続けますか？')) return;
      data.confirmReset = true;
      next = await send();
    }
    applyState(next);
    if (errorTarget) editor.close();
    if (replace) message('質問集を読み込みました。');
  }, errorTarget);
}

function moveQuestion(index, offset) {
  const questions = state.questions.map(draft);
  const [question] = questions.splice(index, 1);
  questions.splice(index + offset, 0, question);
  saveDeck(questions);
}

async function reloadDeck(raw) {
  try {
    const data = JSON.parse(raw);
    if (data?.format !== 'fakeslido-deck' || data.version !== 1 || !Array.isArray(data.questions)) {
      throw new Error('FakeSlido の質問集 JSON を選んでください。');
    }
    if (state.questions.length && !window.confirm('現在の質問集を置き換えますか？ 受付と公開状態は初期化されます。')) return;
    await saveDeck(data.questions, { replace: true });
  } catch (error) {
    message(error instanceof SyntaxError ? '質問集のJSON形式を確認してください。' : error.message);
  }
}

function syncOptions() {
  const count = optionFields.children.length;
  [...optionFields.children].forEach((row, index) => {
    row.querySelector('span').textContent = String(index + 1);
    row.querySelector('input').setAttribute('aria-label', '選択肢 ' + (index + 1));
    const remove = row.querySelector('button');
    remove.setAttribute('aria-label', '選択肢 ' + (index + 1) + ' を削除');
    remove.disabled = count <= 2;
  });
  $('add-option').disabled = count >= 8;
  updateStyles();
}

function updateStyles(preferred = $('question-style').value) {
  const single = $('question-type').value === 'single';
  const count = optionFields.children.length;
  const choices = ['horizontal', 'vertical'];
  if (single && count <= 6) choices.push('donut');
  if (single && count <= 4) choices.push('stacked');
  $('question-style').replaceChildren(...choices.map(value =>
    el('option', { text: styleLabels[value], attrs: { value } })));
  $('question-style').value = choices.includes(preferred) ? preferred : 'horizontal';
}

function addOption(value = '') {
  const input = el('input', { attrs: { type: 'text', required: '', placeholder: '選択肢を入力' } });
  input.value = value;
  const row = el('div', { cls: 'option-field' }, el('span'), input,
    button('×', () => { row.remove(); syncOptions(); }, 'icon'));
  optionFields.append(row);
  return input;
}

function showEditor(question) {
  editing = { id: question?.questionId, deckRevision: state.deckRevision };
  $('editor-title').textContent = question ? '質問を編集' : '質問を追加';
  $('question-text').value = question?.text ?? '';
  $('question-type').value = question?.type ?? 'single';
  optionFields.replaceChildren();
  (question?.options ?? ['', '']).forEach(addOption);
  syncOptions();
  updateStyles(question?.style);
  message('', $('edit-error'));
  editor.showModal();
}

$('edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  const question = {
    questionId: editing.id ?? crypto.randomUUID(), text: $('question-text').value, type: $('question-type').value,
    options: [...optionFields.querySelectorAll('input')].map(input => input.value),
    style: $('question-style').value
  };
  const questions = state.questions.map(item => item.questionId === editing.id ? question : draft(item));
  if (!editing.id) questions.push(question);
  submitEdit.disabled = true;
  await saveDeck(questions, { deckRevision: editing.deckRevision, errorTarget: $('edit-error') });
  submitEdit.disabled = false;
  if (!editor.open) {
    selectedId = question.questionId;
    render();
  }
});
$('question-type').addEventListener('change', () => updateStyles());
$('add-option').addEventListener('click', () => { const input = addOption(); syncOptions(); input.focus(); });
$('cancel-edit').addEventListener('click', () => editor.close());
$('cancel-edit-footer').addEventListener('click', () => editor.close());
$('add').addEventListener('click', () => showEditor());
$('restore').addEventListener('click', () => reloadDeck(storageGet(localStorage, backupKey)));
$('clear-backup').addEventListener('click', () => {
  if (window.confirm('このブラウザの質問集の控えを削除しますか？')) {
    if (!storageSet(localStorage, backupKey, null)) return message('控えを削除できませんでした。');
    updateBackupControls();
    message('このブラウザの控えを削除しました。');
  }
});
$('import').addEventListener('change', async event => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  if (file.size > 256 * 1024) return message('質問集は256KBまで読み込めます。');
  try { await reloadDeck(await file.text()); }
  catch { message('質問集を読み込めませんでした。'); }
});
$('deck-download').addEventListener('click', () => {
  downloadFile('fakeslido-deck.json', new Blob([JSON.stringify(deckData(), null, 2)], { type: 'application/json' }));
});
for (const format of ['csv', 'json']) {
  $(format + '-download').addEventListener('click', () => run(async () => {
    const blob = await request('/api/admin/export?format=' + format, key, { download: true });
    downloadFile('fakeslido-results.' + format, blob);
  }));
}
$('erase').addEventListener('click', () => {
  if (window.confirm('サーバー上の質問・票をすべて消去しますか？ 現在の参加URLと発表URLは無効になります。')) {
    control('erase', undefined, true);
  }
});
if (!canShareParticipantUrl) $('copy-link').textContent = 'この端末用の参加URLをコピー';
$('copy-link').addEventListener('click', () => run(async () => {
  await navigator.clipboard.writeText(participantUrl(state.participantCode));
  message(canShareParticipantUrl ? '参加URLをコピーしました。'
    : 'この端末用の参加URLをコピーしました。別端末からの参加には、HTTPSで公開したURLを使ってください。');
}));
$('open-present').addEventListener('click', () => {
  window.open('/present#' + state.presentationToken, '_blank', 'noopener,noreferrer');
});

poll('/api/admin/state', key, { interval: 0, onState: applyState, onInvalid: text => {
  storageSet(sessionStorage, 'fakeslido:admin', null);
  $('workspace').hidden = true;
  $('copy-link').disabled = true;
  $('open-present').disabled = true;
  message(text);
} });
