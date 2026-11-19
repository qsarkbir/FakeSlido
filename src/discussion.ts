import { createHmac, randomUUID } from 'node:crypto';
import { ApiError, idPattern, objectWith, requireValue, textFits } from './validation.js';
import type {
  AdminComment, CommentReceipt, DiscussionDefinition, DiscussionSettings, LikeReceipt, PublicComment
} from './types.js';

export const commentsPerTopic = 200;
export const commentsPerSession = 1000;
export const likesPerSession = 100_000;

export function validateDiscussion(input: unknown): DiscussionDefinition {
  objectWith(input, ['questionId', 'type', 'text', 'settings']);
  const { questionId, text, settings, type } = input;
  requireValue(type === 'discussion');
  requireValue(questionId === undefined || typeof questionId === 'string' && idPattern.test(questionId));
  requireValue(textFits(text, 200), 'お題は1〜200文字で入力してください。');
  const options = settings === undefined ? {} : settings;
  objectWith(options, ['moderationMode', 'maxPostsPerToken']);
  const { moderationMode = 'manual', maxPostsPerToken = 3 } = options;
  requireValue(moderationMode === 'manual' || moderationMode === 'instant');
  requireValue(maxPostsPerToken === 1 || maxPostsPerToken === 3 || maxPostsPerToken === 'unlimited');
  return {
    questionId: questionId ?? randomUUID(), type: 'discussion', text, settings: { moderationMode, maxPostsPerToken }
  };
}

interface StoredComment {
  commentId: string;
  body: string;
  sequence: number;
  visibility: CommentReceipt['visibility'];
  presented: boolean;
  author: string;
  submission: string;
  likes: Set<string>;
}

export class Discussion {
  #comments = new Map<string, StoredComment>();
  #sequence = 0;
  #likeCount = 0;
  #key: Buffer;

  constructor(private readonly questionId: string, sessionKey: Buffer) {
    this.#key = sessionKey;
  }

  get size() {
    return this.#comments.size;
  }

  get likeCount() {
    return this.#likeCount;
  }

  #identity(scope: 'author' | 'submission' | 'like', ...parts: string[]) {
    // 用途・お題・コメントを分離し、生のトークンや送信 ID を保管しない。
    return createHmac('sha256', this.#key).update(JSON.stringify(['discussion', scope, this.questionId, ...parts]))
      .digest('base64url');
  }

  post(voterToken: string, submissionId: string, body: string, settings: DiscussionSettings, sessionFull: boolean) {
    const author = this.#identity('author', voterToken);
    const submission = this.#identity('submission', voterToken, submissionId);
    let ownPosts = 0;
    for (const previous of this.#comments.values()) {
      if (previous.author !== author) continue;
      ownPosts++;
      if (previous.submission !== submission) continue;
      if (previous.body !== body) throw new ApiError(409, 'この送信IDは別の本文で使用済みです。');
      return { receipt: { commentId: previous.commentId, visibility: previous.visibility }, added: false };
    }
    if (settings.maxPostsPerToken !== 'unlimited' && ownPosts >= settings.maxPostsPerToken) {
      throw new ApiError(409, 'このお題への投稿上限に達しました。');
    }
    if (sessionFull || this.size >= commentsPerTopic) {
      throw new ApiError(409, 'コメントの受付上限に達しました。');
    }
    const comment: StoredComment = {
      commentId: randomUUID(), body, sequence: ++this.#sequence,
      visibility: settings.moderationMode === 'manual' ? 'pending' : 'published',
      presented: false, author, submission, likes: new Set()
    };
    this.#comments.set(comment.commentId, comment);
    return { receipt: { commentId: comment.commentId, visibility: comment.visibility }, added: true };
  }

  setLike(commentId: string, voterToken: string, liked: boolean, sessionFull: boolean) {
    const comment = this.#comments.get(commentId);
    if (comment?.visibility !== 'published') throw new ApiError(404, '公開中のコメントが見つかりません。');
    if (comment.author === this.#identity('author', voterToken)) throw new ApiError(403, '自分の投稿にはいいねできません。');
    const identity = this.#identity('like', commentId, voterToken);
    const changed = comment.likes.has(identity) !== liked;
    if (changed && liked) {
      if (sessionFull) throw new ApiError(409, 'いいねの受付上限に達しました。');
      comment.likes.add(identity);
      this.#likeCount++;
    } else if (changed) {
      comment.likes.delete(identity);
      this.#likeCount--;
    }
    const receipt: LikeReceipt = { commentId, liked, likes: comment.likes.size };
    return receipt;
  }

  publicComments(voterToken?: string): PublicComment[] {
    const author = voterToken === undefined ? undefined : this.#identity('author', voterToken);
    return [...this.#comments.values()]
      .filter(comment => comment.visibility === 'published')
      .sort((a, b) => b.likes.size - a.likes.size || a.sequence - b.sequence)
      .map(({ commentId, body, presented, likes, author: owner }) => ({
        commentId, body, presented, likes: likes.size, authoredByYou: author === owner,
        likedByYou: voterToken !== undefined && likes.has(this.#identity('like', commentId, voterToken))
      }));
  }

  adminComments(): AdminComment[] {
    return [...this.#comments.values()].map(({ commentId, body, visibility, presented, likes }) =>
      ({ commentId, body, visibility, presented, likes: likes.size }));
  }
}
