# initialize() の制御ストリーム読み取りを断片化耐性にする

- Priority: High
- Created: 2026-06-04
- Completed: 2026-06-05
- Model: qwen3.7-plus
- Branch: feature/fix-initialize-fragmentation
- Polished: 2026-06-04

## 目的

セッション初期化で受信する制御ストリーム (サーバーからの単方向ストリーム) の先頭ストリームタイプ varint と、それに続く SETUP メッセージ本体が、複数チャンクに分割されて届いても揃うまで読み続けて正しく初期化できるようにする。

## 優先度根拠

MOQT は WebTransport 上で動作し、ストリームの `read()` はチャンク境界を保証しない。現状の `initialize()` は読み取りが 1 回または 2 回で済む前提になっており、断片化に弱い。

1. ストリームタイプ varint (`0x2F00`, 2 バイト) が最初の `read()` で 1 バイトしか届かないと `decodeVarint` が `IncompleteDataError` を throw し、未捕捉のまま初期化が失敗する。
2. SETUP ペイロードが 3 チャンク以上に分割されると、1 回限りの追加読み取りでは揃わず `SessionError("No SETUP received")` で失敗する。

どちらもセッション確立そのものが失敗するため High。(本 issue は旧 #0299 (ストリームタイプ varint) と旧 #0300 (SETUP 断片化) を統合したもの。両者は `initialize()` の同一読み取り区間を対象とし、別々に実装すると conflict するため 1 つにまとめた。)

## 現状

`src/session.ts:1147-1182` の制御ストリーム読み取りは次の構造になっている。

### 問題 1: ストリームタイプ varint の断片化

```typescript
// src/session.ts:1147-1162
const reader = incomingStream.getReader();
const { value, done } = await reader.read();
reader.releaseLock();

if (done || !value) {
  throw new SessionError("Connection closed before SETUP", SessionErrorCode.NO_ERROR);
}

// ストリームタイプを読み取る
const [streamType, streamTypeConsumed] = decodeVarint(value, 0); // ← 1 バイトだと IncompleteDataError
if (Number(streamType) !== MessageType.SETUP) {
  throw new SessionError(
    `expected control stream type 0x2F00, got 0x${streamType.toString(16)}`,
    SessionErrorCode.PROTOCOL_VIOLATION,
  );
}
```

`decodeVarint` (`src/varint.ts:205-206`) は先頭バイトが示す長さ分のデータが無いと `IncompleteDataError` を throw する。`0x2F00` の varint は 2 バイト (先頭バイト `0xAF` = `10101111`、先頭 `10` で 2 バイト) なので、`value` が 1 バイトだとデコードに失敗する。

### 問題 2: SETUP メッセージ本体の断片化

```typescript
// src/session.ts:1164-1182
const remaining = value.slice(streamTypeConsumed);
let messages = remaining.length > 0 ? this.controlReader.feed(remaining) : [];

// SETUP メッセージがまだ届いていない場合は追加で読み取る (1 回限り)
if (messages.length === 0) {
  const setupReader = incomingStream.getReader();
  const { value: setupValue, done: setupDone } = await setupReader.read();
  setupReader.releaseLock();
  if (setupDone || !setupValue) {
    throw new SessionError("Connection closed before SETUP", SessionErrorCode.NO_ERROR);
  }
  messages = this.controlReader.feed(setupValue);
}

if (messages.length === 0) {
  throw new SessionError("No SETUP received", SessionErrorCode.PROTOCOL_VIOLATION);
}
```

追加読み取りが 1 回限りのため、SETUP がストリームタイプ + 前半 + 後半のように 3 チャンク以上に分割されると揃わず `"No SETUP received"` で失敗する。

なお `ControlStreamReader.feed` (`src/controlStream.ts:30`) は供給データを内部バッファに蓄積し、揃ったメッセージだけを返す。複数回 `feed` を呼べば部分データは保持される。

## 仕様根拠

draft-ietf-moq-transport-18:

- **§3.4 (Unidirectional Stream Types)**: "All unidirectional MOQT streams start with a variable-length integer indicating the type of the stream." 制御ストリームのタイプは Table 3 で `0x2F00`。
- **§1.4.1 (Variable-Length Integer Encoding)**: 先頭 1-bits の数で長さを示す MOQT varint。`0x2F00` は 2 バイト。
- **§10.3 (SETUP)**: SETUP メッセージのフォーマット。制御メッセージはストリーム上でバイト列として送られ、トランスポート層では任意の境界で分割されうる。

参考 URL: https://www.ietf.org/archive/id/draft-ietf-moq-transport-18.html#section-3.4

## 設計方針

`reader` を 1 つ保持し、(1) ストリームタイプ varint を読み切る -> (2) 最初の制御メッセージ (SETUP) が揃うまで feed を繰り返す、という一連のループに作り替える。`IncompleteDataError` は `src/session.ts:20` で既に import 済み、バイト連結は `src/session/stream.ts:203` の `concatChunks` を利用する。

```typescript
const reader = incomingStream.getReader();

// (1) ストリームタイプ varint を読み切るまで read + 連結を繰り返す
let buffer = new Uint8Array(0);
let streamType: bigint;
let streamTypeConsumed: number;
for (;;) {
  const { value, done } = await reader.read();
  if (done || !value) {
    throw new SessionError(
      "Connection closed before control stream type",
      SessionErrorCode.NO_ERROR,
    );
  }
  buffer = concatChunks([buffer, value]);
  try {
    [streamType, streamTypeConsumed] = decodeVarint(buffer, 0);
    break;
  } catch (error) {
    if (!(error instanceof IncompleteDataError)) {
      throw error;
    }
    // varint がまだ揃っていない。次の read() で続きを読む
  }
}

if (Number(streamType) !== MessageType.SETUP) {
  throw new SessionError(
    `expected control stream type 0x2F00, got 0x${streamType.toString(16)}`,
    SessionErrorCode.PROTOCOL_VIOLATION,
  );
}

// (2) SETUP メッセージが揃うまで read + feed を繰り返す
let messages = this.controlReader.feed(buffer.slice(streamTypeConsumed));
while (messages.length === 0) {
  const { value: chunk, done } = await reader.read();
  if (done || !chunk) {
    throw new SessionError("Connection closed before SETUP", SessionErrorCode.NO_ERROR);
  }
  messages = this.controlReader.feed(chunk);
}
```

これにより、1 回限りの追加読み取り (`setupReader` の再取得を含む) と `"No SETUP received"` 分岐は不要になり削除する。

## 変更対象ファイル

- `src/session.ts`: `initialize()` の制御ストリーム読み取りを上記ループに置き換える
- `CHANGES.md`: `[FIX]` エントリを追記する

## エッジケース

| ケース                                                   | 期待動作                                          |
| -------------------------------------------------------- | ------------------------------------------------- |
| ストリームタイプが 2 バイト以上で最初に届く              | 即座に `decodeVarint` 成功 (既存と同じ)           |
| ストリームタイプが 1 バイトずつ届く                      | 追加 `read()` で連結して `decodeVarint` 成功      |
| SETUP が最初のチャンクに収まっている                     | 追加読み取りなしで成功 (既存と同じ)               |
| SETUP が 2 チャンクに分割                                | 1 回の追加 `read()` で成功 (既存と同じ)           |
| SETUP が 3 チャンク以上に分割                            | 揃うまで `read()` を繰り返して成功 (本修正で改善) |
| ストリームタイプ / SETUP が揃う前に接続が閉じた (`done`) | 接続切断エラーを throw                            |
| ストリームタイプが `0x2F00` 以外                         | `PROTOCOL_VIOLATION` (既存と同じ)                 |

## テスト方針

`initialize()` は WebTransport の単方向ストリームに依存するため、断片化を伴うセッション初期化フローの検証は E2E テスト (Playwright) の対象とする。モック禁止制約下では単体テスト不可能。

本修正の前提となる純粋な挙動は単体テストで pin できる。

- `decodeVarint` が必要バイト不足時に `IncompleteDataError` を throw すること (`src/varint.test.ts`)
- `ControlStreamReader.feed` が部分データを蓄積し、複数回の `feed` で最終的にメッセージを返すこと (`src/controlStream.test.ts`)

Vitest の test / assert を使用し、テストメッセージは日本語で書く。モックやスタブは利用しない。

## 後方互換の影響

- 受信時の読み取り堅牢化のみで、公開 API に変更はない

## 完了条件

- ストリームタイプ varint と SETUP メッセージが断片化して届いてもセッション初期化が成功する
- ストリームタイプ varint は `IncompleteDataError` を catch して追加読み取りでリトライし、それ以外のエラーは再 throw する
- SETUP は揃うまで `read()` と `feed()` を繰り返す
- 接続が先に閉じた場合は接続切断エラーになる
- 1 回限りの追加読み取りと `"No SETUP received"` 分岐が削除されている
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリを追記する

## 解決方法

設計方針通り、`initialize()` の制御ストリーム読み取りを reader を 1 つ保持する一連のループに作り替えた。

### src/session.ts

`incomingStream.getReader()` で取得した reader 1 つを `try` で囲み、`finally` で必ず `releaseLock` する構造にした。`finally` での解放は、後続の `startControlMessageLoop` が同一ストリームを `getReader()` で再取得するために必須である（設計方針のスニペットには欠けていたため補った）。

1. ストリームタイプ varint を読み切るまで `read` + `concatChunks` で連結を繰り返す。`decodeVarint` が `IncompleteDataError` を throw する間はリトライし、それ以外のエラーは再 throw する。
2. ストリームタイプが SETUP (`0x2F00`) 以外なら `PROTOCOL_VIOLATION` で閉じる。
3. SETUP メッセージが揃うまで `read` + `this.controlReader.feed` を繰り返す。

1 回限りの追加読み取り（`setupReader` の再取得）と `"No SETUP received"` 分岐を削除した。`type ControlMessage` を import し、`messages` を `try` 外で型注釈付き宣言した。

### CHANGES.md

`[FIX]` エントリを追記した。

### 設計判断: DoS ガードは追加しない

review-diff-code で「varint / SETUP が揃わないまま peer がデータを送り続ける DoS」「空チャンクの無限ループ」の懸念が挙がったが、追加ガードは入れなかった。理由は次の通り。

- ストリームタイプ varint は最大 9 バイトで構造的に bounded（`buffer.length >= 9` なら `decodeVarint` は必ず成功するため無制限成長しない）。
- SETUP 本体は SETUP の Length フィールドで bounded（`feed` が宣言長まで待つだけで無制限成長しない）。peer がデータを送らなければ `read()` がブロックするのみで CPU スピンにはならない。
- `read()` が `done=false` で長さ 0 の `Uint8Array` を返し続けるケースは WebTransport の標準実装では発生しない。

過剰な防御は YAGNI のため避け、断片化耐性という本 issue のスコープに限定した。

### スコープ外として別 issue 化する事項

SETUP と同一 read チャンクに後続の完全な制御メッセージ（GOAWAY 等）が相乗りした場合、`feed` が `[SETUP, 後続]` を返すが `messages[0]`（SETUP）しか処理されず後続が破棄される。これは旧コードからの既存挙動で本 issue のスコープ（断片化耐性）外のため、別 issue で対応する。
