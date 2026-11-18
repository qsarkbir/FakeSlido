import {
  $, el, button, message, request, poll, readFragment, storageGet, storageSet, emptyState, statusPill
} from './common.js';
import { chart } from './charts.js';

const storageKey = 'fakeslido:participant';
const lifetime = 24 * 60 * 60 * 1000;
const codePattern = /^[A-Za-z0-9_-]{22}$/;
const voterPattern = /^[A-Za-z0-9_-]{43}$/;

function voterToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function readRecord() {
  try {
    const saved = JSON.parse(storageGet(localStorage, storageKey));
    if (saved && Number.isFinite(saved.expiresAt) && saved.expiresAt > Date.now()
      && codePattern.test(saved.code) && voterPattern.test(saved.voterToken)
      && saved.answers && typeof saved.answers === 'object' && !Array.isArray(saved.answers)) {
      saved.answers = Object.assign(Object.create(null), saved.answers);
      return saved;
    }
  } catch {
    // Outdated or invalid browser data is discarded.
  }
  storageSet(localStorage, storageKey, null);
  return null;
}

const saved = readRecord();
const fragment = readFragment();
const code = fragment || saved?.code;
if (fragment && fragment !== saved?.code) storageSet(localStorage, storageKey, null);
let record = saved?.code === code ? saved : null;
let state;
let selectedId;
let editing = false;
let choices = [];
let sending = false;
let results;
let resultRequest = 0;

function persist() {
  if (!storageSet(localStorage, storageKey, JSON.stringify(record))) {
    message('ブラウザに回答の控えを保存できません。この画面を開いている間は回答を確認できます。');
  }
}

function invalid(text) {
  if (readRecord()?.code === code) storageSet(localStorage, storageKey, null);
  record = null;
  state = null;
  resultRequest++;
  $('question-nav').hidden = true;
  $('ballot').replaceChildren(emptyState('投票に接続できません', text));
}

function ensureRecord(sessionId) {
  const latest = readRecord();
  if (latest?.sessionId === sessionId && latest.code === code
    && (!record || latest.voterToken === record.voterToken || record.expiresAt <= Date.now())) {
    record = latest;
  }
  if (record?.sessionId === sessionId && record.expiresAt > Date.now()) return;
  record = {
    code, sessionId, voterToken: voterToken(), expiresAt: Date.now() + lifetime, answers: Object.create(null)
  };
  persist();
}

function currentQuestion() {
  return state?.questions.find(question => question.questionId === selectedId);
}

function ownAnswer(question) {
  const answer = record?.answers[question.questionId];
  return answer?.voteRevision === question.voteRevision && Array.isArray(answer.choices) ? answer : null;
}

function pruneAnswers() {
  for (const [id, answer] of Object.entries(record.answers)) {
    const question = state.questions.find(item => item.questionId === id);
    if (!question || question.voteRevision !== answer?.voteRevision) delete record.answers[id];
  }
}

async function applyState(next) {
  if (state && next.revision < state.revision) return;
  ensureRecord(next.sessionId);
  const previous = currentQuestion();
  state = next;
  const priorAnswers = Object.keys(record.answers).length;
  pruneAnswers();
  if (Object.keys(record.answers).length !== priorAnswers) persist();
  if (!currentQuestion()) {
    selectedId = next.questions.find(question => question.isOpen)?.questionId ?? next.questions[0]?.questionId;
    editing = false;
    choices = [];
  }
  const question = currentQuestion();
  if (previous && (!question?.isOpen || previous.voteRevision !== question.voteRevision)) {
    editing = false;
    choices = [];
  }
  if (results?.question.questionId !== question?.questionId || !question?.resultsPublished
    || results?.question.voteRevision !== question?.voteRevision) results = null;
  render();
  await updateResults();
}

function selectQuestion(id) {
  selectedId = id;
  editing = false;
  choices = [];
  results = null;
  resultRequest++;
  render();
  updateResults().catch(() => {});
}

function nav() {
  const nav = $('question-nav');
  nav.hidden = !state.questions.length;
  nav.replaceChildren(...state.questions.map((question, index) => {
    const selected = selectedId === question.questionId;
    const item = button('質問 ' + (index + 1) + (ownAnswer(question) ? ' ✓' : ''), () => selectQuestion(question.questionId), 'compact');
    item.setAttribute('aria-current', selected ? 'true' : 'false');
    return item;
  }));
}

function render() {
  if (!state) return;
  nav();
  const panel = $('ballot');
  const question = currentQuestion();
  if (!question) {
    panel.replaceChildren(emptyState('質問の開始をお待ちください', '質問がオープンすると、この画面に表示されます。'));
    return;
  }
  const answer = ownAnswer(question);
  const heading = el('div', { cls: 'ballot-heading' },
    el('div', { cls: 'pills' }, statusPill(question.isOpen),
      el('span', { cls: 'pill pill-muted', text: question.type === 'single' ? '単一選択' : '複数選択' })),
    el('h2', { text: question.text }));
  let content;
  if (answer && question.resultsPublished && !editing) {
    content = el('div', {}, el('h3', { text: '投票結果' }),
      results ? chart(results, question.style, question.type) : el('p', { cls: 'muted', text: '結果を読み込み中…' }),
      receipt(question, answer));
  } else if (answer && !editing || !question.isOpen) {
    content = answer ? receipt(question, answer) : el('p', { cls: 'muted', text: 'この質問の投票受付は終了しました。' });
  } else {
    content = ballotForm(question, answer);
  }
  panel.replaceChildren(heading, content);
}

function receipt(question, answer) {
  const optionList = el('ul', { cls: 'answer-list' },
    ...answer.choices.map(index => el('li', { text: question.options[index - 1] })));
  return el('div', { cls: 'receipt' },
    el('p', { cls: 'receipt-label', text: '✓ 回答済み' }), el('h3', { text: 'あなたの回答' }), optionList,
    ...(question.isOpen ? [button('回答を変更', () => {
      choices = [...answer.choices];
      editing = true;
      render();
    }, 'compact', sending)] : []));
}

function ballotForm(question, answer) {
  const multiple = question.type === 'multiple';
  const form = el('form', { cls: 'vote-form' });
  const submit = el('button', { cls: 'primary', text: answer ? '変更を保存' : '投票する', attrs: { type: 'submit' } });
  submit.disabled = sending || !choices.length;
  const fields = el('fieldset', {}, el('legend', { cls: 'muted', text: multiple ? '当てはまる選択肢を選んでください。' : '選択肢を1つ選んでください。' }));
  for (const [index, text] of question.options.entries()) {
    const value = index + 1;
    const input = el('input', { attrs: { type: multiple ? 'checkbox' : 'radio', name: 'option', value } });
    input.checked = choices.includes(value);
    input.disabled = sending;
    input.addEventListener('change', () => {
      choices = multiple
        ? [...form.querySelectorAll('input:checked')].map(element => Number(element.value))
        : [value];
      submit.disabled = !choices.length;
    });
    fields.append(el('label', { cls: 'ballot-option' }, input, el('span', { text })));
  }
  form.append(fields, el('div', { cls: 'actions' }, submit,
    ...(editing ? [button('キャンセル', () => { editing = false; choices = []; render(); }, '', sending)] : [])));
  form.addEventListener('submit', event => {
    event.preventDefault();
    vote(question);
  });
  return form;
}

async function vote(question) {
  if (sending || !choices.length) return;
  ensureRecord(state.sessionId);
  sending = true;
  const submitted = [...choices];
  const voter = record.voterToken;
  message('');
  render();
  try {
    const response = await request('/api/public/vote', code, {
      method: 'POST', data: {
        questionId: question.questionId, voterToken: voter, voteRevision: question.voteRevision,
        choices: question.type === 'single' ? submitted[0] : submitted
      }
    });
    if (state?.sessionId === response.sessionId && record?.voterToken === voter
      && state.questions.find(item => item.questionId === question.questionId)?.voteRevision === response.voteRevision) {
      ensureRecord(response.sessionId);
      if (record.voterToken === voter) {
        record.answers[question.questionId] = { voteRevision: response.voteRevision, choices: submitted };
        persist();
      }
    }
    if (selectedId === question.questionId) {
      editing = false;
      choices = [];
    }
    if (state) updateResults().catch(() => {});
  } catch (error) {
    if (error.status === 410) invalid(error.message);
    else message(error.status === 429 ? '投票が混み合っています。少し待ってから、再度送信してください。' : error.message);
  } finally {
    sending = false;
    render();
  }
}

async function updateResults() {
  const question = currentQuestion();
  if (!record || !question?.resultsPublished || !ownAnswer(question) || editing) return;
  const index = ++resultRequest;
  try {
    const data = await request('/api/public/results?questionId=' + encodeURIComponent(question.questionId), code);
    const current = currentQuestion();
    if (index !== resultRequest || state?.sessionId !== data.sessionId || !current?.resultsPublished
      || current.questionId !== data.question.questionId || current.voteRevision !== data.question.voteRevision) return;
    results = data;
    render();
  } catch (error) {
    if (index !== resultRequest) return;
    if (error.status === 404) {
      results = null;
      render();
    }
    throw error;
  }
}

window.addEventListener('storage', event => {
  if (event.key !== storageKey || !state) return;
  const latest = readRecord();
  if (latest?.code !== code || latest.sessionId !== state.sessionId || latest.voterToken !== record?.voterToken) return;
  record = latest;
  pruneAnswers();
  render();
  updateResults().catch(() => {});
});

$('ballot').replaceChildren(emptyState('投票に接続中', '質問を読み込んでいます。'));
poll('/api/public/state', codePattern.test(code ?? '') ? code : null, {
  interval: 2500,
  onState: applyState,
  onUnchanged: () => {
    if (record && record.expiresAt <= Date.now()) {
      ensureRecord(state.sessionId);
      editing = false;
      choices = [];
      results = null;
      render();
    }
  },
  onInvalid: invalid
});
