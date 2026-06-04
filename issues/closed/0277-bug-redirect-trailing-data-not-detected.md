# decodeRequestErrorPayload の Redirect 後続データ未検出

- Priority: High
- Created: 2026-06-03
- Completed: 2026-06-04
- Model: deepseek-v4 Pro
- Branch: feature/fix-redirect-trailing-data
- Polished: 2026-06-04

## 目的

`decodeRequestErrorPayload` で Redirect をデコードする際に `decodeRedirect` の消費バイト数が無視されており、Redirect の後ろに不正な追加データがあっても検出されないバグを修正する。

## 優先度根拠

- 悪意あるサーバーや実装バグのあるリレーサーバーが Redirect の後に余計なデータを付与した場合に検出できず、プロトコル違反を見逃す
- 後続データを読み飛ばすことで、後続の CONTROL_MESSAGE のフレーミングがずれ、誤ったメッセージ解釈につながる可能性がある

## 現状

`src/message/session.ts` line 381:

```typescript
redirect = decodeRedirect(data, offset)[0];
```

`decodeRedirect` の第二戻り値（消費バイト数）が取得されておらず、`offset` が進まないため、Redirect 構造の後ろに余分なデータが存在しても検出されない。

`decodeRedirect` のシグネチャ（line 128）:

```typescript
export function decodeRedirect(data: Uint8Array, offset: number): [Redirect, number];
//                                                                       ^^^^^^^^^^^^^^
//                                                                       第二戻り値 = 消費バイト数
```

## 仕様根拠

draft-ietf-moq-transport-18:

- **§10 (Control Messages)**: Control Message は `Message Type (vi64) + Message Length (16) + Message Payload (..)` の形式で構成される。各メッセージタイプが Message Payload 内のフィールド形式を定義する
- **§10.6.1 (Redirect Structure)**: Redirect の構造は `Connect URI Length (vi64) + Connect URI (..) + Track Namespace (..) + Track Name Length (vi64) + Track Name (..)`
- **§10.6.2 (REQUEST_ERROR Message Format)**: REQUEST_ERROR のペイロードフィールドは `Error Code (vi64) + Retry Interval (vi64) + Error Reason (Reason Phrase) + [Redirect (Redirect)]` であり、Redirect が最後のフィールドである（存在する場合）
- **§3.5 (Termination)**: PROTOCOL_VIOLATION (0x3) の定義 — "The remote endpoint performed an action that was disallowed by the specification." Message Format で定義されたフィールド以外のデータがペイロードに含まれていることは、仕様で許容されていない

参考 URL: https://www.ietf.org/archive/id/draft-ietf-moq-transport-18.html#section-10.6.2

## 設計方針

`decodeRequestErrorPayload` 内部で `decodeRedirect` の消費バイト数を取得し、Redirect デコード後の trailing data の有無を検証する。

**理由**: 呼び出し側（合計 8 箇所）での修正に比べ、1 箇所の修正で全呼び出し元を保護でき、将来の呼び出し追加時にも同種バグの再発を防げる。

参考: `src/message/authorizationToken.ts` の `decodeAuthorizationToken` は同様に `offset !== data.length` で trailing data を検出する既存パターンを持つ。

## 変更内容

### src/message/session.ts

`decodeRequestErrorPayload` 関数の line 381 を以下のように修正する:

```typescript
// 変更前:
redirect = decodeRedirect(data, offset)[0];

// 変更後:
const [decodedRedirect, redirectSize] = decodeRedirect(data, offset);
redirect = decodedRedirect;
offset += redirectSize;
if (offset !== data.length) {
  throw new ProtocolViolationError(
    `trailing data after Redirect in REQUEST_ERROR: expected ${data.length} bytes, consumed ${offset}`,
  );
}
```

## 変更対象ファイル

- `src/message/session.ts`: `decodeRequestErrorPayload` 関数を修正
- `src/message/session.prop.ts`: 後続データ検出テストを追加
- `CHANGES.md`: `[FIX]` エントリを追記

## 影響範囲

`decodeRequestErrorPayload` の呼び出し元は全 8 箇所。修正は関数内部のみのため、呼び出し元の変更は不要。

| ファイル              | 行   | コンテキスト                          |
| --------------------- | ---- | ------------------------------------- |
| `src/session.ts`      | 1889 | `startNamespaceStreamLoop`            |
| `src/session.ts`      | 2101 | `startTracksStreamLoop`               |
| `src/session.ts`      | 2372 | `startNamespacePublicationStreamLoop` |
| `src/session/bidi.ts` | 301  | `bidiReadPublishResponse`             |
| `src/session/bidi.ts` | 420  | `bidiReadSubscribeResponse`           |
| `src/session/bidi.ts` | 521  | `bidiReadFetchResponse`               |
| `src/session/bidi.ts` | 576  | `bidiReadTrackStatusResponse`         |
| `src/session/bidi.ts` | 641  | `bidiReadRequestStreamMessages`       |

## エッジケース

| ケース                                                                     | 期待動作                                                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 後続データが 1 バイトだけある                                              | `ProtocolViolationError`                                                                                                                                     |
| 後続データが 10,000 バイトある                                             | `ProtocolViolationError`                                                                                                                                     |
| 後続データがない（正常系）                                                 | 正常にデコード                                                                                                                                               |
| Error Code != REDIRECT で trailing data                                    | `ProtocolViolationError`（既存の非 REDIRECT + 残データ分岐で検出、エラーメッセージは "unexpected redirect" となるが実害はない）                              |
| Redirect の varint が読めるがフィールド実データが不足（意味的 truncation） | `decodeRedirect` 内で `data.slice` が短い配列を返しサイレント成功する可能性がある。完全な truncation 検出は `decodeRedirect` 側の責務であり本 issue の範囲外 |

## テスト方針

`src/message/session.prop.ts` に PBT テストを追加する。fast-check を使用。テスト名とコメントは日本語で書くこと。

### 新規追加テスト

1. **後続データあり（本 issue の核心）**: 正常な REQUEST_ERROR + Redirect を `encodeRequestErrorPayload` でエンコードし、その後ろに `fc.uint8Array({ minLength: 1 })` で生成した任意の後続バイト列を `concat` で連結 → `ProtocolViolationError`
2. **後続データなし（正常系確認）**: 正常な REQUEST_ERROR + Redirect をエンコードし、その後ろに空バイト列を連結したデータ → 正常デコード

既存のラウンドトリップテストは encode 直後の出力をそのまま decode するため trailing data は常に 0 であり、修正後も PASS する。

モックやスタブは利用しないこと。

## 後方互換の影響

- 従来許容されていた trailing data 付き REQUEST_ERROR を拒否するようになる
- これは仕様への準拠を厳格化する修正であり、正しい挙動
- クライアント専用ライブラリとして受信メッセージのバリデーションを強化する

## 完了条件

- `decodeRedirect` の消費バイト数が取得され、trailing data がある場合に `ProtocolViolationError` が throw される
- `src/message/session.prop.ts` に後続データ検出の PBT テストが追加されている
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリを追記する

## 解決方法

`decodeRequestErrorPayload`（`src/message/session.ts`）で `decodeRedirect` の第二戻り値（消費バイト数）を取得して `offset` を進め、`offset !== data.length` の場合に `ProtocolViolationError` を throw するよう修正した。これにより Redirect の後ろに後続データがある REQUEST_ERROR、および Redirect の長さフィールドが残バイトを超える消費過多のケースの両方を検出する。

仕様根拠は draft-ietf-moq-transport-18 Section 10 の "If the length does not match the length of the Message Payload, the receiver MUST close the session with a PROTOCOL_VIOLATION" を直接の根拠としてコメントに英語で記載した。

`src/message/session.prop.ts` に後続データ検出の PBT テストを追加した。後続データが無い正常系は既存の「REQUEST_ERROR with Redirect のラウンドトリップ」テストが担保するため、別途追加していない。

なお呼び出し元 8 箇所で throw された `ProtocolViolationError` を PROTOCOL_VIOLATION でセッションクローズに連動させる対応は、本 issue のスコープ外であり issue 0298 で扱う（握り潰しは develop 由来の既存構造であり、本修正が新たに導入した問題ではない）。

### 触ったファイル

- `src/message/session.ts`: `decodeRequestErrorPayload` に trailing data 検出を追加
- `src/message/session.prop.ts`: 後続データ検出の PBT テストを追加
- `CHANGES.md`: `[FIX]` エントリを追記

## 備考

### 同一関数内の Error 型不整合（本 issue では対応しない）

`decodeRequestErrorPayload` の Reason Phrase 長超過（line 362）は `throw new Error(...)` を使用しているが、同一関数内の Redirect 関連違反（line 377）は `ProtocolViolationError` を使用している。Reason Phrase 超過も仕様違反（draft-ietf-moq-transport-18 §10.6.2 で最大 1,024 バイトと規定）であるため、`ProtocolViolationError` にすべきだが、本 issue の修正範囲外とする。

### decodeGoawayPayload の trailing data チェック不足（本 issue では対応しない）

`decodeGoawayPayload`（`src/message/session.ts:225`）でも、末尾の Request ID フィールドをデコードした後の `offset` と `data.length` の比較が行われていない。Request ID 後の trailing data があっても検出されない同種の問題があるが、本 issue の修正範囲外とする。別途 issue を作成して対応する。
