# GOAWAY タイムアウトの setTimeout 32-bit オーバーフローに対応する

- Priority: Medium
- Created: 2026-06-04
- Model: qwen3.7-plus
- Branch: feature/fix-settimeout-overflow
- Polished: 2026-06-04

## 目的

GOAWAY タイムアウトとして `setTimeout` に渡す遅延値が 32-bit 符号付き整数の上限 (`2^31 - 1` ms) を超えないようにクランプする。

## 優先度根拠

WHATWG HTML 仕様および主要ブラウザの `setTimeout` は、遅延が `2^31 - 1` ms (約 24.8 日) を超えると 0 に丸めて即座に発火する。GOAWAY タイムアウトに巨大な値が渡るとタイマーが即発火し、意図した猶予時間を待たずにセッションが即座にクローズされる誤動作になる。再現条件は限定的 (巨大な timeout 値) だが、受信 GOAWAY の値はピア由来で制御できないため、防御的プログラミングとして対応する。直接の不具合ではないため Medium。

## 現状

`bigint` のタイムアウト値を `Number()` 変換して `setTimeout` に渡している箇所が 2 つある。

```typescript
// src/session.ts:2509-2517 (goaway() 内: クライアントが GOAWAY を送信したとき)
if (goawayTimeout > 0n) {
  this.goawayTimeoutId = setTimeout(() => {
    if (this.sessionState === "connected") {
      this.closeWithError(
        new SessionError("GOAWAY timeout expired", SessionErrorCode.GOAWAY_TIMEOUT),
      );
    }
  }, Number(goawayTimeout));
}
```

```typescript
// src/session.ts:3384-3393 (handleGoaway() 内: GOAWAY を受信したとき)
if (msg.timeout > 0n) {
  this.goawayTimeoutId = setTimeout(() => {
    if (this.sessionState === "connected") {
      void this.close();
      this.transport.close({ ... });
    }
  }, Number(msg.timeout));
}
```

`goawayTimeout` (ローカル API 引数) も `msg.timeout` (受信した GOAWAY の値) も `bigint` であり、`2^31 - 1` を超える値を `Number()` 変換して `setTimeout` に渡すとオーバーフロー (即発火) する。

## 仕様根拠

- **draft-ietf-moq-transport-18 §3.6 (Migration)**: "The sender SHOULD close the session with GOAWAY_TIMEOUT after the indicated timeout if there are still open subscriptions or fetches on a connection."
- WHATWG HTML 仕様 (Timers): `setTimeout` の `timeout` 引数が `2^31 - 1` を超える場合は 0 にクランプされる。

参考 URL: https://www.ietf.org/archive/id/draft-ietf-moq-transport-18.html#section-3.6

## 設計方針

`bigint` のタイムアウトを `setTimeout` に渡す際、`2^31 - 1` (`2147483647`) でクランプする純粋ヘルパを用意し、両箇所で使う。純粋関数にすることで単体テスト可能にする (`src/session/params.ts` の純粋関数群と同じ方針)。

```typescript
// src/session/params.ts などに追加
const MAX_SETTIMEOUT_DELAY = 2147483647; // 2^31 - 1

/**
 * bigint のタイムアウト (ms) を setTimeout に安全に渡せる値にクランプする
 * 2^31 - 1 を超える遅延は環境によって即発火するため上限で抑える
 */
export function clampTimeoutMs(timeout: bigint): number {
  return Math.min(Number(timeout), MAX_SETTIMEOUT_DELAY);
}
```

呼び出し側は `Number(goawayTimeout)` / `Number(msg.timeout)` を `clampTimeoutMs(goawayTimeout)` / `clampTimeoutMs(msg.timeout)` に置き換える。

## 変更対象ファイル

- `src/session/params.ts`: `clampTimeoutMs` を追加する
- `src/session.ts`: 2 箇所の `Number(...)` を `clampTimeoutMs(...)` に置き換える
- `src/session/params.test.ts` (または対応する PBT): `clampTimeoutMs` のテストを追加する
- 機能変更がないため `CHANGES.md` への追記は不要 (防御的な内部修正)

## エッジケース

| 入力 timeout                  | 期待される setTimeout 遅延                |
| ----------------------------- | ----------------------------------------- |
| `0n`                          | タイマーを設定しない (既存の `> 0n` 分岐) |
| `1000n` (通常値)              | `1000` (変化なし)                         |
| `2147483647n` (上限ちょうど)  | `2147483647`                              |
| `2147483648n` (上限 +1)       | `2147483647` にクランプ                   |
| `2n ** 62n` (varint 上限近傍) | `2147483647` にクランプ                   |

## テスト方針

- `clampTimeoutMs` は純粋関数なので `src/session/params.test.ts` で直接テストする
- 通常値はそのまま、上限超過はクランプされることを検証する
- Vitest の test / assert を使用し、テストメッセージは日本語で書く。モックやスタブは利用しない

## 後方互換の影響

- `2^31 - 1` 以下の通常のタイムアウト値の挙動は変わらない
- 公開 API に変更はない

## 完了条件

- 2 箇所の GOAWAY タイムアウトが `2^31 - 1` でクランプされる
- クランプ処理が純粋関数として単体テストされている
- 通常値の挙動が変わらないことが確認される
- 既存の全テストが PASS する
