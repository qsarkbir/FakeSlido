import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type {
  AdminState, DeckInput, ErrorResponse, GraphStyle, Presentation,
  PresentState, PublicQuestion, PublicResults, PublicState, Question, QuestionDefinition,
  ResultsExport, Role, Tally, VoteInput
} from './types.js';

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: ErrorResponse['code']) {
    super(message);
  }
}

// 条件に失敗したときは例外になるため、呼び出し元でも成功時の型に絞り込める。
export function requireValue(condition: unknown, message = '入力内容を確認してください。'): asserts condition {
  if (!condition) throw new ApiError(400, message);
}

export function objectWith(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
  requireValue(Object.keys(value).every(key => keys.includes(key)));
}

export const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const randomToken = (bytes: number) => randomBytes(bytes).toString('base64url');
const textFits = (text: unknown, limit: number): text is string =>
  typeof text === 'string' && text.trim().length > 0 && [...text].length <= limit;

// 配列であることを確認した後も、各要素は個別に検証する。
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function validateQuestion(input: unknown): QuestionDefinition {
  objectWith(input, ['questionId', 'text', 'type', 'options', 'style']);
  const { questionId, text, type, options, style } = input;
  requireValue(questionId === undefined || typeof questionId === 'string' && idPattern.test(questionId));
  requireValue(textFits(text, 200), '質問文は1〜200文字で入力してください。');
  requireValue(type === 'single' || type === 'multiple');
  requireValue(isUnknownArray(options) && options.length >= 2 && options.length <= 8
    && options.every(option => textFits(option, 80)), '選択肢は2〜8個、各1〜80文字で入力してください。');
  const styles: GraphStyle[] = ['horizontal', 'vertical'];
  if (type === 'single' && options.length <= 6) styles.push('donut');
  if (type === 'single' && options.length <= 4) styles.push('stacked');
  const allowedStyle = styles.find(allowed => allowed === style);
  requireValue(allowedStyle !== undefined, '選択肢数と質問形式に対応したグラフを選んでください。');
  return { questionId: questionId ?? randomUUID(), text, type, options, style: allowedStyle };
}

export function aggregate(question: Question): Tally {
  const respondentCount = question.votes.size;
  const counts = question.options.map(() => 0);
  for (const choices of question.votes.values()) {
    for (const choice of choices) counts[choice - 1]++;
  }
  return {
    respondentCount,
    totalSelections: counts.reduce((sum, count) => sum + count, 0),
    options: counts.map((optionVotes, index) => ({
      optionIndex: index + 1,
      optionText: question.options[index],
      optionVotes,
      percentage: respondentCount ? Math.round(1000 * optionVotes / respondentCount) / 10 : 0
    }))
  };
}

// 公開する項目を列挙して、内部データが追加されても公開 API に混ざらないようにする。
function publicQuestion(question: Question): PublicQuestion {
  const { questionId, text, type, options, style, isOpen, resultsPublished, voteRevision } = question;
  return { questionId, text, type, options, style, isOpen, resultsPublished, voteRevision };
}

function changedContent(before: QuestionDefinition, after: QuestionDefinition) {
  return before.text !== after.text || before.type !== after.type
    || before.options.length !== after.options.length
    || before.options.some((option, index) => option !== after.options[index]);
}

export class PollSession {
  // ! はコンストラクターで呼ぶ reset() が、公開前に初期値を入れることを表す。
  sessionId!: string;
  participantCode!: string;
  presentationToken!: string;
  #sessionKey!: Buffer;
  #rateKey!: Buffer;
  private questions!: Map<string, Question>;
  private presentation!: Presentation;
  readonly revision: Record<Role, number>;
  private deckRevision: number;
  private readonly idleMs: number;
  private readonly voteLimit: number;
  private readonly rateTimer: ReturnType<typeof setInterval>;
  #voteRevision = 0;
  #expiry?: ReturnType<typeof setTimeout>;
  #expiresAt = 0;
  #rateCounts = new Map<string, number>();
  #events = new EventEmitter();
  #waiters = 0;

  constructor({ idleMs, voteLimit }: { idleMs: number; voteLimit: number }) {
    this.idleMs = idleMs;
    this.voteLimit = voteLimit;
    const initialRevision = randomInt(2 ** 40);
    this.revision = { admin: initialRevision, public: initialRevision, present: initialRevision };
    this.deckRevision = initialRevision;
    this.#events.setMaxListeners(0);
    this.reset();
    this.rateTimer = setInterval(() => this.#resetRateLimit(), 60_000).unref();
  }

  dispose() {
    clearTimeout(this.#expiry);
    clearInterval(this.rateTimer);
    this.#events.emit('admin');
    this.#events.emit('present');
  }

  #resetRateLimit() {
    this.#rateKey = randomBytes(32);
    this.#rateCounts.clear();
  }

  reset() {
    this.sessionId = randomUUID();
    this.participantCode = randomToken(16);
    this.presentationToken = randomToken(32);
    this.#sessionKey = randomBytes(32);
    this.#voteRevision = 0;
    this.#resetRateLimit();
    this.questions = new Map();
    this.presentation = { questionId: null, mode: 'question' };
    this.deckRevision++;
    this.touch();
    this.#notify('admin', 'public', 'present');
  }

  touch() {
    clearTimeout(this.#expiry);
    this.#expiresAt = Date.now() + this.idleMs;
    this.#expiry = setTimeout(() => this.reset(), this.idleMs).unref();
  }

  #notify(...roles: Role[]) {
    for (const role of roles) {
      this.revision[role]++;
      this.#events.emit(role);
    }
  }

  wait(role: 'admin' | 'present', response: ServerResponse, timeout: number): Promise<void> {
    if (this.#waiters >= 64) {
      throw new ApiError(429, '接続が混み合っています。');
    }
    this.#waiters++;
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        this.#events.off(role, finish);
        response.off('close', finish);
        this.#waiters--;
        resolve();
      };
      const timer = setTimeout(finish, timeout);
      this.#events.once(role, finish);
      response.once('close', finish);
    });
  }

  #rateLimit(ip: string) {
    const identifier = createHmac('sha256', this.#rateKey).update(ip).digest('base64url');
    const count = this.#rateCounts.get(identifier) ?? 0;
    if (count >= this.voteLimit || (!count && this.#rateCounts.size >= 10_000)) {
      throw new ApiError(429, 'しばらく待ってから再試行してください。');
    }
    this.#rateCounts.set(identifier, count + 1);
  }

  #presentationQuestion() {
    const { questionId } = this.presentation;
    return questionId === null ? undefined : this.questions.get(questionId);
  }

  state(role: Role): AdminState | PublicState | PresentState {
    const base = { revision: this.revision[role], sessionId: this.sessionId };
    if (role === 'public') {
      return {
        ...base,
        questions: [...this.questions.values()].filter(q => q.everOpened).map(publicQuestion)
      } satisfies PublicState;
    }
    if (role === 'present') {
      const question = this.#presentationQuestion();
      const visible = question?.everOpened ? question : null;
      const tallyVisible = this.presentation.mode === 'results' && visible?.resultsPublished;
      return {
        ...base,
        participantCode: this.participantCode,
        mode: tallyVisible ? 'results' : 'question',
        question: visible ? {
          ...publicQuestion(visible),
          respondentCount: visible.votes.size,
          ...(tallyVisible && { results: aggregate(visible) })
        } : null
      } satisfies PresentState;
    }
    return {
      ...base,
      expiresAt: this.#expiresAt,
      serverTime: Date.now(),
      deckRevision: this.deckRevision,
      participantCode: this.participantCode,
      presentationToken: this.presentationToken,
      presentation: this.presentation,
      questions: [...this.questions.values()].map(question => ({
        ...publicQuestion(question), everOpened: question.everOpened, results: aggregate(question)
      }))
    } satisfies AdminState;
  }

  question(id: unknown): Question {
    requireValue(typeof id === 'string' && idPattern.test(id));
    const question = this.questions.get(id);
    if (!question) throw new ApiError(404, '質問が見つかりません。');
    return question;
  }

  results(id: unknown): PublicResults {
    requireValue(typeof id === 'string' && idPattern.test(id));
    const question = this.questions.get(id);
    if (!question?.resultsPublished) throw new ApiError(404, '公開済みの結果がありません。');
    return { sessionId: this.sessionId, question: publicQuestion(question), ...aggregate(question) };
  }

  vote(input: unknown, ip: string): number {
    this.#rateLimit(ip);
    objectWith(input, ['questionId', 'voterToken', 'choices', 'voteRevision'] satisfies (keyof VoteInput)[]);
    const { voterToken, voteRevision } = input;
    requireValue(typeof voterToken === 'string' && tokenPattern.test(voterToken));
    requireValue(typeof voteRevision === 'number' && Number.isSafeInteger(voteRevision) && voteRevision > 0);
    const question = this.question(input.questionId);
    if (!question.isOpen) throw new ApiError(409, 'この質問の受付は終了しています。');
    if (question.voteRevision !== voteRevision) {
      throw new ApiError(409, '質問が更新されました。もう一度選択してください。');
    }
    const choices = question.type === 'single' ? [input.choices] : input.choices;
    requireValue(isUnknownArray(choices) && choices.length >= 1 && choices.length <= question.options.length
      && new Set(choices).size === choices.length
      && choices.every((choice): choice is number => typeof choice === 'number'
        && Number.isInteger(choice) && choice >= 1 && choice <= question.options.length),
    '有効な選択肢を指定してください。');
    const pseudonym = createHmac('sha256', this.#sessionKey)
      .update(voterToken).update(question.questionId).digest('base64url');
    const oldChoices = question.votes.get(pseudonym);
    if (!oldChoices && question.votes.size >= 5000) throw new ApiError(409, '回答者数の上限に達しました。');
    choices.sort((a, b) => a - b);
    if (oldChoices?.length === choices.length && oldChoices.every((choice, index) => choice === choices[index])) {
      return voteRevision;
    }
    question.votes.set(pseudonym, choices);
    const roles: Role[] = ['admin'];
    if (question.resultsPublished) roles.push('public');
    if (this.presentation.questionId === question.questionId
      && (!oldChoices || this.presentation.mode === 'results')) roles.push('present');
    this.#notify(...roles);
    return voteRevision;
  }

  saveDeck(input: unknown) {
    objectWith(input, ['questions', 'deckRevision', 'replace', 'confirmReset'] satisfies (keyof DeckInput)[]);
    requireValue(isUnknownArray(input.questions) && input.questions.length <= 50, '質問は50問までです。');
    requireValue(input.replace === undefined || typeof input.replace === 'boolean');
    requireValue(input.confirmReset === undefined || typeof input.confirmReset === 'boolean');
    requireValue(Number.isSafeInteger(input.deckRevision));
    if (input.deckRevision !== this.deckRevision) {
      throw new ApiError(409, '質問集が更新されました。最新の内容を確認してください。', 'deck_changed');
    }
    const validated = input.questions.map(validateQuestion);
    requireValue(new Set(validated.map(question => question.questionId)).size === validated.length, '質問IDが重複しています。');
    const incoming = new Map(validated.map(question => [question.questionId, question]));
    const affected = [...this.questions.values()].filter(question => {
      const draft = incoming.get(question.questionId);
      return question.votes.size && (input.replace || !draft || changedContent(question, draft));
    });
    if (affected.length && !input.confirmReset) {
      throw new ApiError(409, '回答済みの票を消去する操作です。', 'confirm_reset');
    }
    this.questions = new Map(validated.map(draft => {
      const previous = input.replace ? undefined : this.questions.get(draft.questionId);
      const reset = !previous || changedContent(previous, draft);
      return [draft.questionId, {
        ...previous,
        ...draft,
        everOpened: previous?.everOpened ?? false,
        isOpen: previous?.isOpen ?? false,
        resultsPublished: previous?.resultsPublished ?? false,
        voteRevision: reset ? ++this.#voteRevision : previous.voteRevision,
        votes: reset ? new Map() : previous.votes
      }];
    }));
    if (input.replace || !this.#presentationQuestion()) {
      this.presentation = { questionId: null, mode: 'question' };
    }
    this.deckRevision++;
    this.touch();
    this.#notify('admin', 'public', 'present');
  }

  requireSession(sessionId: string) {
    if (sessionId !== this.sessionId) throw new ApiError(409, 'セッションが更新されました。');
  }

  control(input: unknown) {
    objectWith(input, ['action', 'questionId', 'confirm', 'sessionId', 'deckRevision']);
    const { action, questionId, confirm, sessionId, deckRevision } = input;
    requireValue(confirm === undefined || typeof confirm === 'boolean');
    if (action !== 'advance') requireValue(deckRevision === undefined);
    if (action === 'erase') {
      requireValue(questionId === undefined && confirm === true, '全データ消去には確認が必要です。');
      requireValue(typeof sessionId === 'string' && sessionId.length > 0, '消去するセッションを確認してください。');
      // 受信開始時のセッションに加え、運営者が画面で確認したセッションも照合する。
      this.requireSession(sessionId);
      this.reset();
      return;
    }
    if (action === 'extend-expiry') {
      requireValue(questionId === undefined && confirm === undefined);
      requireValue(typeof sessionId === 'string' && sessionId.length > 0);
      this.requireSession(sessionId);
      this.touch();
      this.#notify('admin');
      return;
    }
    if (action === 'advance') {
      requireValue(confirm === undefined && typeof sessionId === 'string' && sessionId.length > 0);
      requireValue(typeof questionId === 'string' && idPattern.test(questionId) && Number.isSafeInteger(deckRevision));
      this.requireSession(sessionId);
      if (deckRevision !== this.deckRevision) {
        throw new ApiError(409, '質問集が更新されました。最新の内容を確認してください。', 'deck_changed');
      }
      this.#advance(questionId);
    } else if (action === 'show-results' || action === 'show-question') {
      requireValue(sessionId === undefined && questionId === undefined);
      const question = this.#presentationQuestion();
      if (action === 'show-results') {
        requireValue(question?.everOpened, '発表する質問を一度オープンしてください。');
        question.resultsPublished = true;
      }
      this.presentation.mode = action === 'show-results' ? 'results' : 'question';
    } else {
      requireValue(sessionId === undefined);
      this.#controlQuestion(action, this.question(questionId), confirm);
    }
    this.touch();
    this.#notify('admin', 'public', 'present');
  }

  #advance(questionId: string) {
    const current = this.#presentationQuestion();
    if (!current || current.questionId !== questionId) {
      throw new ApiError(409, '発表対象が切り替わりました。最新の内容を確認してください。');
    }
    const ordered = [...this.questions.values()];
    const next = ordered[ordered.indexOf(current) + 1];
    if (!next) throw new ApiError(409, 'これが最後の質問です。');
    // 状態を変える前に対象を確定し、受付と発表を更新してから一度だけ通知する。
    this.#controlQuestion('close', current, undefined);
    this.#controlQuestion('open', next, undefined);
  }

  #controlQuestion(action: unknown, question: Question, confirm: boolean | undefined) {
    const selected = this.presentation.questionId === question.questionId;
    switch (action) {
      case 'open':
      case 'select':
        if (action === 'open') {
          question.isOpen = true;
          question.everOpened = true;
        }
        if (!selected) this.presentation = { questionId: question.questionId, mode: 'question' };
        break;
      case 'close':
        question.isOpen = false;
        break;
      case 'publish':
        requireValue(question.everOpened, '質問を一度オープンしてください。');
        question.resultsPublished = true;
        break;
      case 'unpublish':
        question.resultsPublished = false;
        if (selected) this.presentation.mode = 'question';
        break;
      case 'reset-votes':
        requireValue(confirm === true, '票のリセットには確認が必要です。');
        question.votes.clear();
        question.voteRevision = ++this.#voteRevision;
        break;
      default:
        requireValue(false, '操作を確認してください。');
    }
  }

  exportResults(): ResultsExport {
    this.touch();
    this.#notify('admin');
    return {
      format: 'fakeslido-results',
      version: 1,
      sessionId: this.sessionId,
      exportedAt: new Date().toISOString(),
      questions: [...this.questions.values()].map((question, index) => ({
        questionId: question.questionId,
        questionOrder: index + 1,
        questionText: question.text,
        questionType: question.type,
        ...aggregate(question)
      }))
    };
  }
}
