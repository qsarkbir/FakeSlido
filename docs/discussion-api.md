# コメント API の開発メモ

P3-1 の結合テストは `createApp({ ..., discussionEnabled: true })` でコメント API を有効にします。通常の `npm start` では、コメント API と質問集の `discussion` 形式は無効です。一般公開は、審査と削除を含む受入テストを実施し、運営者が手動で確認したあとに判断します。

## お題の設定

`PUT /api/admin/deck` の `questions` に、選択式の質問と一緒に次の形式を指定できます。

```json
{
  "questionId": "discussion-1",
  "text": "次回扱ってほしいテーマは？",
  "type": "discussion",
  "settings": { "moderationMode": "manual", "maxPostsPerToken": 3 }
}
```

`settings` の既定値は事前審査と1トークンあたり3件です。即時公開には `instant` を指定します。投稿数制限は `1`、`3`、`"unlimited"` から選べます。審査方式の変更は以後の投稿に適用されます。お題本文を変更すると `discussionRevision` が進み、古い画面からの書き込みは HTTP 409 で拒否されます。通常の受付操作はお題にも利用できます。

テスト用に機能を有効化すると、運営・参加状態 API に `discussions` が追加されます。運営用の `questionOrder` は質問集内の位置です。参加側は一度でも開いた質問とお題の中での位置を返します。

## 投稿といいね

| API | 認証 | 入力 |
| --- | --- | --- |
| `GET /api/public/comments` | 参加コード | クエリに `questionId`。任意の `X-PochiPoll-Voter` ヘッダーで自分の投稿・いいねを判定 |
| `POST /api/public/comments` | 参加コード | JSON に `sessionId`、`questionId`、`discussionRevision`、`voterToken`、`clientSubmissionId`、`body` |
| `POST /api/public/likes` | 参加コード | JSON に `sessionId`、`questionId`、`discussionRevision`、`voterToken`、`commentId`、真偽値の `liked` |
| `GET /api/admin/comments` | 管理キー | クエリに `questionId` |

投稿はプレーンテキストで300 Unicode コードポイントまでです。再送では同じ送信 ID と本文を使います。受付中に同じ投稿を再送すると、同じコメント ID が返ります。いいねは `liked: true` で設定し、`liked: false` で取り消します。同じ操作を再送しても件数は増減しません。

参加者一覧には公開済みのコメントだけが、いいね数の降順、同数なら投稿順で並びます。受付停止後も公開済みコメントを取得できます。投票・投稿・いいねの短期レート制限は操作ごとに適用し、コメントは1お題200件、1セッション1,000件まで保持します。いいねは1セッション10万件までです。

生の参加者トークンや内部の匿名識別子は応答に含めません。投票集計の CSV と JSON は選択式の結果を返します。P3-1 の API 検証は `npm test` で実行できます。
