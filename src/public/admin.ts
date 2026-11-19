import {
  $, el, button, message, tabCredential, participantUrl, canShareParticipantUrl, request, poll, downloadFile,
  storageGet, storageSet, styleLabels, emptyState, statusPill, errorMessage, isRecord, RequestError
} from './common.js';
import { chart } from './charts.js';
import type { ExportFormat } from './common.js';
import type { AdminState, ControlInput, GraphStyle, Presentation, QuestionDefinition } from '../types.js';

const key = tabCredential('admin');
const backupKey = 'fakeslido:deck';
let state: AdminState | undefined;
let previousSessionId: string | undefined;
let selectedId: string | undefined;
let editing: { id: string | undefined; deckRevision: number } | undefined;
let busy = false;
const editor = $('editor', HTMLDialogElement);
const optionFields = $('option-fields');
const editForm = $('edit-form', HTMLFormElement);
const submitEdit = editForm.querySelector('button[type="submit"]');
if (!(submitEdit instanceof HTMLButtonElement)) throw new Error('質問を保存するボタンが見つかりません。');
const questionText = $('question-text', HTMLTextAreaElement);
const questionType = $('question-type', HTMLSelectElement);
const questionStyle = $('question-style', HTMLSelectElement);
const copyLink = $('copy-link', HTMLButtonElement);
const openPresent = $('open-present', HTMLButtonElement);
const importInput = $('import', HTMLInputElement);
const eraseDialog = $('erase-dialog', HTMLDialogElement);
const eraseConfirm = $('erase-confirm', HTMLButtonElement);
const eraseCancel = $('erase-cancel', HTMLButtonElement);
const eraseError = $('erase-error');
const eraseDownloads = { csv: $('erase-csv', HTMLButtonElement), json: $('erase-json', HTMLButtonElement) };
let eraseTarget: string | null = null;
let erasePending: 'erase' | 'export' | undefined;

// 編集用のオブジェクトには回答数や公開状態を含めない。質問集 JSON の項目を保つ。
function draft(question: QuestionDefinition): QuestionDefinition {
  const { questionId, text, type, options, style } = question;
  return { questionId, text, type, options, style };
}

function deckData() {
  return { format: 'fakeslido-deck', version: 1, questions: currentState().questions.map(draft) };
}

function currentState(): AdminState {
  if (!state) throw new Error('運営画面の状態を取得できませんでした。');
  return state;
}

function applyState(next: AdminState) {
  if (next.sessionId === previousSessionId) return;
  const sameSession = state && next.sessionId === state.sessionId;
  if (state && sameSession && next.revision <= state.revision) return;
  if (state && !sameSession) previousSessionId = state.sessionId;
  const newDeck = next.deckRevision !== state?.deckRevision;
  state = next;
  if (!state.questions.some(question => question.questionId === selectedId)) {
    selectedId = state.questions[0]?.questionId;
  }
  if (newDeck && state.questions.length) storageSet(localStorage, backupKey, JSON.stringify(deckData()));
  else if (newDeck && sameSession) storageSet(localStorage, backupKey, null);
  $('workspace').hidden = false;
  copyLink.disabled = false;
  openPresent.disabled = false;
  updateBackupControls();
  $('add', HTMLButtonElement).disabled = state.questions.length >= 50;
  updateEraseDialog(next);
  render();
}

function updateBackupControls() {
  const hasBackup = Boolean(storageGet(localStorage, backupKey));
  $('restore').hidden = currentState().questions.length > 0 || !hasBackup;
  $('clear-backup').hidden = !hasBackup;
}

function render() {
  const state = currentState();
  const metrics: [string, number][] = [
    ['質問数', state.questions.length],
    ['受付中', state.questions.filter(question => question.isOpen).length],
    ['結果公開済み', state.questions.filter(question => question.resultsPublished).length]
  ];
  const overview = metrics.map(([label, count]) => el('div', { cls: 'metric' },
    el('span', { text: label }), el('strong', { text: count })));
  $('overview').replaceChildren(...overview);

  const active = document.activeElement;
  const focused = active instanceof HTMLElement ? active.dataset.focus : undefined;
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
    const selected = state.questions.find(question => question.questionId === selectedId);
    if (selected) renderDetail(selected);
  }
  if (focused) {
    document.querySelectorAll('[data-focus]').forEach(element => {
      if (element instanceof HTMLButtonElement && element.dataset.focus === focused && !element.disabled) {
        element.focus({ preventScroll: true });
      }
    });
  }
}

function action(label: string, handler: (event: MouseEvent) => void, cls?: string, disabled?: boolean) {
  const element = button(label, handler, cls, disabled);
  element.dataset.focus = label;
  return element;
}

function renderDetail(question: AdminState['questions'][number]) {
  const state = currentState();
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
      () => control({ action: question.isOpen ? 'close' : 'open', questionId: id }), question.isOpen ? '' : 'primary'),
    action(question.resultsPublished ? '結果を非公開' : '結果を公開',
      () => control({ action: question.resultsPublished ? 'unpublish' : 'publish', questionId: id }),
      '', !question.everOpened),
    action('発表する質問に選択', () => control({ action: 'select', questionId: id }), '', inPresentation));
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
      if (window.confirm('この質問の票をすべてリセットしますか？')) {
        control({ action: 'reset-votes', questionId: id, confirm: true });
      }
    }, 'compact'),
    action('質問を削除', () => {
      if (window.confirm('この質問を削除しますか？ この質問の票も消去されます。')) {
        saveDeck(currentState().questions.filter(item => item.questionId !== id).map(draft), { confirmReset: true });
      }
    }, 'danger-link compact'));
  $('detail').replaceChildren(heading, controls, tally, tools);
}

function modeButton(label: string, mode: Presentation['mode'], disabled?: boolean) {
  const element = action(label, () => control({ action: mode === 'results' ? 'show-results' : 'show-question' }),
    'compact', disabled);
  element.setAttribute('aria-pressed', String(currentState().presentation.mode === mode));
  return element;
}

async function run(operation: () => Promise<void>, errorTarget = $('notice')) {
  if (busy) return false;
  busy = true;
  try {
    message('', errorTarget);
    await operation();
    return true;
  } catch (error) {
    message(errorMessage(error, '操作を完了できませんでした。'), errorTarget);
    return false;
  } finally {
    busy = false;
  }
}

function control(data: ControlInput) {
  return run(async () => {
    applyState(await request('/api/admin/control', key, {
      method: 'POST', data
    }));
  });
}

interface SaveOptions {
  replace?: boolean;
  confirmReset?: boolean;
  deckRevision?: number;
  errorTarget?: HTMLElement;
}

function saveDeck(questions: unknown[], {
  replace, confirmReset, deckRevision = currentState().deckRevision, errorTarget
}: SaveOptions = {}) {
  return run(async () => {
    const data = { questions, deckRevision, replace, confirmReset };
    const send = () => request('/api/admin/deck', key, { method: 'PUT', data });
    let next;
    try {
      next = await send();
    } catch (error) {
      if (!(error instanceof RequestError) || error.code !== 'confirm_reset') throw error;
      if (!window.confirm('この操作で対象の質問の票が消去されます。続けますか？')) return;
      data.confirmReset = true;
      next = await send();
    }
    applyState(next);
    if (errorTarget) editor.close();
    if (replace) message('質問集を読み込みました。');
  }, errorTarget);
}

function moveQuestion(index: number, offset: number) {
  const questions = currentState().questions.map(draft);
  const [question] = questions.splice(index, 1);
  questions.splice(index + offset, 0, question);
  saveDeck(questions);
}

async function reloadDeck(raw: string | null) {
  try {
    const data: unknown = JSON.parse(raw ?? 'null');
    if (!isRecord(data) || data.format !== 'fakeslido-deck' || data.version !== 1 || !Array.isArray(data.questions)) {
      throw new Error('FakeSlido の質問集 JSON を選んでください。');
    }
    // 旧形式の入れ物を確認し、個々の質問は既存のサーバー検証に委ねる。
    if (currentState().questions.length && !window.confirm('現在の質問集を置き換えますか？ 受付と公開状態は初期化されます。')) return;
    await saveDeck(data.questions, { replace: true });
  } catch (error) {
    message(error instanceof SyntaxError ? '質問集のJSON形式を確認してください。'
      : errorMessage(error, '質問集を読み込めませんでした。'));
  }
}

function syncOptions() {
  const count = optionFields.children.length;
  [...optionFields.children].forEach((row, index) => {
    const number = row.querySelector('span');
    if (number) number.textContent = String(index + 1);
    row.querySelector('input')?.setAttribute('aria-label', '選択肢 ' + (index + 1));
    const remove = row.querySelector('button');
    if (remove) {
      remove.setAttribute('aria-label', '選択肢 ' + (index + 1) + ' を削除');
      remove.disabled = count <= 2;
    }
  });
  $('add-option', HTMLButtonElement).disabled = count >= 8;
  updateStyles();
}

function updateStyles(preferred = questionStyle.value) {
  const single = questionType.value === 'single';
  const count = optionFields.children.length;
  const choices: GraphStyle[] = ['horizontal', 'vertical'];
  if (single && count <= 6) choices.push('donut');
  if (single && count <= 4) choices.push('stacked');
  questionStyle.replaceChildren(...choices.map(value =>
    el('option', { text: styleLabels[value], attrs: { value } })));
  questionStyle.value = choices.some(style => style === preferred) ? preferred : 'horizontal';
}

function addOption(value = '') {
  const input = el('input', { attrs: { type: 'text', required: '', placeholder: '選択肢を入力' } });
  input.value = value;
  const row = el('div', { cls: 'option-field' }, el('span'), input,
    button('×', () => { row.remove(); syncOptions(); }, 'icon'));
  optionFields.append(row);
  return input;
}

function showEditor(question?: QuestionDefinition) {
  editing = { id: question?.questionId, deckRevision: currentState().deckRevision };
  $('editor-title').textContent = question ? '質問を編集' : '質問を追加';
  questionText.value = question?.text ?? '';
  questionType.value = question?.type ?? 'single';
  optionFields.replaceChildren();
  (question?.options ?? ['', '']).forEach(addOption);
  syncOptions();
  updateStyles(question?.style);
  message('', $('edit-error'));
  editor.showModal();
}

function isGraphStyle(value: string): value is GraphStyle {
  return Object.hasOwn(styleLabels, value);
}

editForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!editing) return;
  const type = questionType.value;
  const style = questionStyle.value;
  if ((type !== 'single' && type !== 'multiple') || !isGraphStyle(style)) {
    return message('回答形式とグラフを選んでください。', $('edit-error'));
  }
  const { id, deckRevision } = editing;
  const question: QuestionDefinition = {
    questionId: id ?? crypto.randomUUID(), text: questionText.value, type,
    options: [...optionFields.querySelectorAll('input')].map(input => input.value),
    style
  };
  const questions = currentState().questions.map(item => item.questionId === id ? question : draft(item));
  if (!id) questions.push(question);
  submitEdit.disabled = true;
  await saveDeck(questions, { deckRevision, errorTarget: $('edit-error') });
  submitEdit.disabled = false;
  if (!editor.open) {
    selectedId = question.questionId;
    render();
  }
});
questionType.addEventListener('change', () => updateStyles());
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
importInput.addEventListener('change', async () => {
  const file = importInput.files?.[0];
  importInput.value = '';
  if (!file) return;
  if (file.size > 256 * 1024) return message('質問集は256KBまで読み込めます。');
  try { await reloadDeck(await file.text()); }
  catch { message('質問集を読み込めませんでした。'); }
});
$('deck-download').addEventListener('click', () => {
  downloadFile('fakeslido-deck.json', new Blob([JSON.stringify(deckData(), null, 2)], { type: 'application/json' }));
});

function updateEraseDialog(next: AdminState) {
  if (!eraseDialog.open) return;
  // 複数選択でも、選んだ選択肢の数ではなく質問ごとの回答者数を足す。
  const counts = next.questions.map(question => question.results.respondentCount);
  const total = counts.reduce((sum, count) => sum + count, 0);
  $('erase-questions').textContent = String(counts.length);
  $('erase-answered').textContent = String(counts.filter(count => count > 0).length);
  $('erase-responses').textContent = String(total);
  $('erase-exports').hidden = total === 0;
  const changed = eraseTarget !== next.sessionId;
  $('erase-session-changed').hidden = !changed;
  eraseConfirm.disabled = changed || erasePending !== undefined;
  eraseConfirm.textContent = erasePending === 'erase' ? '消去中…' : '消去する';
  eraseCancel.disabled = erasePending === 'erase';
  for (const button of Object.values(eraseDownloads)) button.disabled = eraseConfirm.disabled;
}

async function saveResults(format: ExportFormat, sessionId?: string) {
  const path = sessionId === undefined ? `/api/admin/export?format=${format}` as const
    : `/api/admin/export?format=${format}&sessionId=${encodeURIComponent(sessionId)}` as const;
  const blob = await request(path, key, { download: true });
  if (sessionId === undefined || (eraseDialog.open && state?.sessionId === sessionId)) {
    downloadFile('fakeslido-results.' + format, blob);
  }
}

async function withEraseTarget(
  kind: 'erase' | 'export', operation: (sessionId: string) => Promise<void>
) {
  const sessionId = eraseTarget;
  if (!sessionId || !state || state.sessionId !== sessionId || !eraseDialog.open || busy) return;
  erasePending = kind;
  updateEraseDialog(state);
  try {
    await run(async () => {
      try {
        await operation(sessionId);
      } catch (error) {
        if (!(error instanceof RequestError) || error.status !== 409) throw error;
        // ポーリングより先に競合を受信した場合も、古い確認を再利用させない。
        eraseTarget = null;
      }
    }, eraseError);
  } finally {
    erasePending = undefined;
    updateEraseDialog(currentState());
  }
}

for (const format of ['csv', 'json'] as const) {
  $(format + '-download').addEventListener('click', () => run(() => saveResults(format)));
  eraseDownloads[format].addEventListener('click', () => withEraseTarget('export', id => saveResults(format, id)));
}
$('erase').addEventListener('click', () => {
  if (!state || busy || eraseDialog.open) return;
  eraseTarget = state.sessionId;
  message('', eraseError);
  eraseDialog.showModal();
  updateEraseDialog(state);
});
eraseCancel.addEventListener('click', () => eraseDialog.close());
eraseDialog.addEventListener('cancel', event => {
  if (erasePending === 'erase') event.preventDefault();
});
eraseConfirm.addEventListener('click', () => withEraseTarget('erase', async sessionId => {
  const next = await request('/api/admin/control', key, {
    method: 'POST', data: { action: 'erase', confirm: true, sessionId }
  });
  eraseDialog.close();
  applyState(next);
}));
if (!canShareParticipantUrl) copyLink.textContent = 'この端末用の参加URLをコピー';
copyLink.addEventListener('click', () => run(async () => {
  await navigator.clipboard.writeText(participantUrl(currentState().participantCode));
  message(canShareParticipantUrl ? '参加URLをコピーしました。'
    : 'この端末用の参加URLをコピーしました。別端末からの参加には、HTTPSで公開したURLを使ってください。');
}));
openPresent.addEventListener('click', () => {
  window.open('/present#' + currentState().presentationToken, '_blank', 'noopener,noreferrer');
});

poll('/api/admin/state', key, { interval: 0, onState: applyState, onInvalid: text => {
  storageSet(sessionStorage, 'fakeslido:admin', null);
  $('workspace').hidden = true;
  copyLink.disabled = true;
  openPresent.disabled = true;
  eraseDialog.close();
  message(text);
} });
