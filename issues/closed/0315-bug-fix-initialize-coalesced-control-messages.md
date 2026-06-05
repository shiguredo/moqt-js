# initialize() で SETUP と相乗りした後続制御メッセージが破棄されるのを修正する

- Priority: Medium
- Created: 2026-06-05
- Completed: 2026-06-05
- Model: Opus 4.8
- Branch: feature/fix-initialize-coalesced-control-messages
- Reporter: @voluntas

## 目的

`SessionImpl.initialize()` は SETUP メッセージと同一 read チャンクに後続の完全な制御メッセージ (GOAWAY 等) が相乗りして届いた場合、SETUP しか処理せず後続メッセージを破棄する。これを修正し、相乗りした後続メッセージも正しく処理されるようにする。

## 優先度根拠

`ControlStreamReader.feed` は内部バッファから揃った完全メッセージを「全て」取り出して配列で返し、取り出した分はバッファから削除する。`initialize()` は `messages[0]` (SETUP) しか処理しないため、`messages[1..]` が存在すると恒久的に失われる (`feed` 内部バッファからも削除済みで、後続の `startControlMessageLoop` でも再取得できない)。

SETUP 直後に別の制御メッセージが来ること自体は稀だが、QUIC / TCP のバッチングで複数の制御メッセージが 1 つの read チャンクに集約されるのは正常系である。失われるのが GOAWAY のようなセッション制御メッセージの場合、クライアントが移行指示を取りこぼす。発生頻度は低いが取りこぼしの影響が制御フローに及ぶため Medium。

なお旧コード (#0299 以前) も `messages[0]` のみ処理していた既存挙動であり、#0299 (断片化耐性) のレビューで検出した。#0299 のスコープ外のため別 issue とした。

## 現状

`src/session.ts:1201` で `const msg = messages[0]` として最初のメッセージのみを SETUP として処理する。

```typescript
// src/session.ts:1201-1210
const msg = messages[0];
if (msg.type !== MessageType.SETUP) {
  throw new SessionError(`Expected SETUP, got ${msg.type}`, SessionErrorCode.PROTOCOL_VIOLATION);
}

// SETUP をデコードしてバリデーションする
const decodedSetup = decodeSetupPayload(msg.payload);
// ...
// バックグラウンドで制御メッセージの読み取りを開始
this.startControlMessageLoop();
```

`messages` は #0299 の feed ループで `this.controlReader.feed(...)` の戻り値。SETUP と同一チャンクに後続の完全メッセージが含まれると `messages.length > 1` になりうるが、`messages[1..]` は参照されない。`startControlMessageLoop` (`src/session.ts:3232` 付近) は新たな `read()` から `this.controlReader.feed` するが、相乗りメッセージは既に内部バッファから削除済みのため復元できない。

## 仕様根拠

draft-ietf-moq-transport-18:

- **§10.3 (SETUP)**: SETUP は制御ストリーム上の最初の制御メッセージ。後続メッセージはストリーム上に続けて流れる。
- **§3.3 (Control Streams)**: 制御ストリーム上のメッセージは順序通りに処理されなければならない。

## 設計方針

`initialize()` で SETUP (`messages[0]`) を処理した後、`messages[1..]` を通常の制御メッセージ処理経路に流す。

候補:

1. `startControlMessageLoop` を開始する前に、`messages.slice(1)` を `handleControlMessage` (制御メッセージ処理の本体) に順次渡す。
2. `startControlMessageLoop` が処理対象とする初期メッセージ列を受け取れるようにし、相乗り分を先頭に積んで開始する。

いずれの案でも、SETUP のバリデーション (AUTHORITY / PATH 禁止チェック等) は `messages[0]` に対して従来通り行い、`messages[1..]` は SETUP 確立後の通常メッセージとして処理する順序を守ること。

`handleControlMessage` 相当の処理関数の所在と再利用可能性を確認した上で実装する。

## 完了条件

- SETUP と同一 read チャンクに相乗りした後続制御メッセージが破棄されず処理される
- SETUP のバリデーション順序 (SETUP 確立 -> 後続メッセージ処理) が守られている
- 相乗りメッセージの処理を検証する単体テスト (モック禁止下で可能な範囲、または `ControlStreamReader.feed` が複数メッセージを返す純粋挙動の pin) が追加されている
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリを追記する

## 解決方法

設計方針の候補 1 を採用した。`initialize()` で SETUP (`messages[0]`) を検証・確立 (decode / AUTHORITY / PATH チェック) した後、`startControlMessageLoop` を開始する前に `messages[1..]` を `this.handleControlMessage` へ順次流すループを追加した。

```typescript
for (let i = 1; i < messages.length; i++) {
  this.handleControlMessage(messages[i].type, messages[i].payload);
}
```

`handleControlMessage(type, payload)` は `startControlMessageLoop` が各メッセージに対して行う処理と同一であり、相乗りメッセージが通常の制御メッセージと同じ扱い (GOAWAY 処理、禁止メッセージの PROTOCOL_VIOLATION 等) を受ける。

- 順序: SETUP 確立 -> emitDebug -> `messages[1..]` 処理 -> `startControlMessageLoop` 開始。相乗りメッセージは同期ループで処理され、`startControlMessageLoop` が読む新規データより確実に先に処理される。
- 二重処理なし: `messages[1..]` は initialize の `feed` が返したもので `controlReader` 内部バッファから削除済み。`startControlMessageLoop` は同じ `controlReader` に新規 read 分のみ feed するため二重処理されない。
- closeWithError 相互作用: 相乗りメッセージが `closeWithError` を呼んでも `close()` 冒頭の closed ガードで二重 close は防がれる。同一バッチ内の後続処理を止めない点は `startControlMessageLoop` の for ループと同じ既存挙動。

### テスト

`initialize()` 本体は WebTransport 依存かつモック禁止のため E2E 対象とした。本修正が依存する純粋挙動 (`ControlStreamReader.feed` が相乗りチャンクから複数メッセージを順序通り返す) を直接 pin する単体テストを `src/controlStream.test.ts` に追加した。SETUP (type 0x2f00 = varint `0xaf,0x00`) と後続メッセージを 1 チャンクで供給し、feed が 2 メッセージを順序通り返すことを検証する。

### CHANGES.md

`[FIX]` エントリを追記した。
