// ユニオン型で、認証や表示に使える文字列を明示する。
export type Role = 'admin' | 'public' | 'present';
export type Transport = 'local' | 'cloudflare' | 'https-proxy';
export type QuestionType = 'single' | 'multiple';
export type GraphStyle = 'horizontal' | 'vertical' | 'donut' | 'stacked';

export interface QuestionDraft {
  questionId?: string;
  text: string;
  type: QuestionType;
  options: string[];
  style: GraphStyle;
}

export interface QuestionDefinition extends QuestionDraft {
  questionId: string;
}

export interface PublicQuestion extends QuestionDefinition {
  isOpen: boolean;
  resultsPublished: boolean;
  voteRevision: number;
}

// votes のキーは質問ごとの仮名。票の Map は運営・参加・発表のどの API にも含めない。
export interface Question extends PublicQuestion {
  everOpened: boolean;
  votes: Map<string, number[]>;
}

export interface OptionResult {
  optionIndex: number;
  optionText: string;
  optionVotes: number;
  percentage: number;
}

export interface Tally {
  respondentCount: number;
  totalSelections: number;
  options: OptionResult[];
}

export interface Presentation {
  questionId: string | null;
  mode: 'question' | 'results';
}

// 受理する JSON の型。受信直後は unknown として扱い、値はサーバーで検証する。
export interface VoteInput {
  questionId: string;
  voterToken: string;
  choices: number | number[];
  voteRevision: number;
}

export interface DeckInput {
  questions: QuestionDraft[];
  deckRevision: number;
  replace?: boolean;
  confirmReset?: boolean;
}

export type ControlInput =
  | { action: 'erase'; questionId?: never; confirm: true; sessionId: string }
  | { action: 'extend-expiry'; questionId?: never; confirm?: never; sessionId: string }
  | { action: 'advance'; questionId: string; sessionId: string; deckRevision: number }
  | { action: 'show-results' | 'show-question'; questionId?: never; confirm?: boolean }
  | { action: 'open' | 'select' | 'close' | 'publish' | 'unpublish'; questionId: string; confirm?: boolean }
  | { action: 'reset-votes'; questionId: string; confirm: true };

interface StateBase {
  sessionId: string;
  revision: number;
}

export interface PublicState extends StateBase {
  questions: PublicQuestion[];
}

export interface PresentState extends StateBase {
  participantCode: string;
  mode: Presentation['mode'];
  question: (PublicQuestion & { respondentCount: number; results?: Tally }) | null;
}

export interface AdminState extends StateBase {
  expiresAt: number;
  serverTime: number;
  deckRevision: number;
  participantCode: string;
  presentationToken: string;
  presentation: Presentation;
  questions: (PublicQuestion & { everOpened: boolean; results: Tally })[];
}

export interface PreflightStatus {
  origin: string;
  transport: Transport;
  sessionId: string;
  participantCode: string;
  presentationToken: string;
}

export interface PublicResults extends Tally {
  sessionId: string;
  question: PublicQuestion;
}

export interface VoteReceipt {
  sessionId: string;
  voteRevision: number;
}

export interface ResultsExport {
  format: 'fakeslido-results';
  version: 1;
  sessionId: string;
  exportedAt: string;
  questions: (Tally & {
    questionId: string;
    questionOrder: number;
    questionText: string;
    questionType: QuestionType;
  })[];
}

export interface ErrorResponse {
  error: string;
  code?: 'deck_changed' | 'confirm_reset' | 'vote_closed' | 'vote_changed' | 'vote_full';
}
