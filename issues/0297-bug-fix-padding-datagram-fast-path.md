# PADDING Datagram fast-path 判定バグを修正する

- Priority: High
- Created: 2026-06-04
- Model: qwen3.7-plus
- Branch: feature/fix-padding-datagram-fast-path
- Polished: 2026-06-04

## 目的

PADDING Datagram (type `0x132B3E29`) の受信時にセッションが `PROTOCOL_VIOLATION` で切断されるバグを修正する。

## 優先度根拠

draft-ietf-moq-transport-18 §11.5.2 は PADDING Datagram の受信について "The receiver MUST discard all data received in a padding datagram" と MUST 要件を規定している。現状の moqt-js は PADDING Datagram を受信するとセッションを切断するため、この MUST 要件に違反する。peer が帯域プローブのために PADDING Datagram を送るだけでセッションが落ちるため、相互接続性に直結する。よって High。

## 現状

`src/session.ts:3625` の `handleIncomingDatagram` は、PADDING Datagram を判定する fast-path で先頭バイトを `0xe4` と比較している。

```typescript
// src/session.ts:3627-3637
// draft-ietf-moq-transport-18 §11.5.2 (Padding Datagrams):
// "The receiver MUST discard the contents of a padding datagram."
// PADDING datagram (0x132b3e29) の 4 バイト varint 先頭バイトは 0xe4。
// data.length < 4 の場合は完全な varint をデコードできないため PADDING ではない。
if (data.length >= 4 && data[0] === 0xe4) {
  const [datagramType] = decodeVarint(data, 0);
  if (Number(datagramType) === 0x132b3e29) {
    // PADDING datagram は破棄して何もしない
    return;
  }
}

const [datagram] = decodeObjectDatagram(data);
```

`0x132B3E29` の正しい varint 先頭バイトは `0xf0` であり、`0xe4` には決して一致しない。そのため fast-path は素通りし、後続の `decodeObjectDatagram(data)` (`src/session.ts:3639`) が PADDING の type を未知の Object Datagram type として扱って `ProtocolViolationError` を throw する。これが `handleIncomingDatagram` 末尾の catch (`src/session.ts:3674-3677`) で捕捉され、`closeWithError(PROTOCOL_VIOLATION)` に至る。

```typescript
// src/session.ts:3674-3677
// ProtocolViolationError は仕様違反のため PROTOCOL_VIOLATION でセッションを閉じる
if (err instanceof ProtocolViolationError) {
  this.closeWithError(new SessionError(err.message, SessionErrorCode.PROTOCOL_VIOLATION));
}
```

## 根拠: varint エンコードの実測

MOQT の可変長整数は QUIC (RFC 9000) の 2 ビット prefix 方式ではなく、draft-ietf-moq-transport-18 §1.4.1 で定義される「先頭 1-bits の数で長さを示す」独自方式である (`src/varint.ts`)。

| Leading Bits | Length | Usable Bits | Range           |
| ------------ | ------ | ----------- | --------------- |
| `1110`       | 4      | 28          | 0 - 268435455   |
| `11110`      | 5      | 35          | 0 - 34359738367 |

`0x132B3E29` = `321601065` は 4 バイトの上限 `2^28 - 1 = 268435455` を超えるため、**5 バイト** varint になる。`src/varint.ts` の `encodeVarint` (case 5: `result[0] = 0xf0 | Number((v >> 32n) & 0x07n)`) で実測すると次の通り。

```
encodeVarint(0x132B3E29) = [0xf0, 0x13, 0x2b, 0x3e, 0x29]  // 5 バイト, 先頭 0xf0
encodeVarint(0x132B3E28) = [0xf0, 0x13, 0x2b, 0x3e, 0x28]  // PADDING Stream も同様
```

先頭バイトのビットパターンで比較すると誤りが明確になる。

- `0xe4` = `1110 0100` -> 先頭 `1110` は **4 バイト** varint を示す (現状コードの誤った前提)
- `0xf0` = `1111 0000` -> 先頭 `11110` が **5 バイト** varint を示す (PADDING の正しい先頭バイト)

つまり現状の `data[0] === 0xe4` と長さ `>= 4` の組み合わせは、PADDING Datagram の実際の符号 (`0xf0` 始まり, 5 バイト) と構造的に一致しない。

## 仕様根拠

draft-ietf-moq-transport-18:

- **§1.4.1 (Variable-Length Integer Encoding)**: 先頭 1-bits の数でエンコード長を決定する MOQT varint の定義。4 バイトは 28 ビット (最大 `0xFFFFFFF`)、5 バイトは 35 ビット。
- **§11.5.1 (Padding Streams)**: `Type (vi64) = 0x132B3E28`。"The receiver MUST discard all data received on a padding stream to prevent exhausting flow control."
- **§11.5.2 (Padding Datagrams)**: `Type (vi64) = 0x132B3E29`。"The receiver MUST discard all data received in a padding datagram."
- **§11.3 (Datagrams)**: Object Datagram の受信処理一般。

参考 URL: https://www.ietf.org/archive/id/draft-ietf-moq-transport-18.html#section-11.5.2

なお現状コードのコメントは spec を "discard the contents of a padding datagram" と引用しているが、正しい原文は "discard all data received in a padding datagram" である。コメントの引用文も修正する。

## 設計方針

### 推奨案: varint デコードで type を判定する (magic byte を廃止)

PADDING **Stream** の受信経路 (`src/session.ts:3826`) は magic byte を使わず、`decodeVarint` で type をデコードして `=== 0x132b3e28` を判定している。Datagram 経路も同じ方式に揃えることで、先頭バイトのハードコードに起因する本バグの再発を構造的に防ぐ。

```typescript
// data 先頭の varint type を読み、PADDING Datagram (0x132B3E29) なら discard する
if (data.length > 0) {
  const [datagramType] = decodeVarint(data, 0);
  if (Number(datagramType) === 0x132b3e29) {
    // §11.5.2: "The receiver MUST discard all data received in a padding datagram"
    return;
  }
}
```

`decodeVarint` は必要バイト数が不足すると `IncompleteDataError` を throw するが、これは `handleIncomingDatagram` 末尾の catch で `ProtocolViolationError` 以外として握られ、セッションは閉じない (debug 通知のみ)。正常な Object Datagram の先頭は 1 バイト varint の小さな type であり、`decodeVarint` は 1 バイトで成功して `0x132b3e29` と一致しないため通常処理へ進む。

### 代替案 (最小修正): magic byte を正しい値に直す

fast-path を残す場合でも、先頭バイトを `0xf0`、長さチェックを `data.length >= 5` に修正すれば動作する。ただし `0xf0` 始まりの 5 バイト varint は PADDING 以外にも存在しうるため、先頭バイト判定は必要十分条件ではなく、後続の `decodeVarint` による二次チェック (既存) が引き続き必須となる。pre-filter の存在意義が薄いため、推奨案 (magic byte 廃止) を優先する。

いずれの案でも、現状コードのコメント (「4 バイト varint 先頭バイトは 0xe4」など) は誤りなので削除・修正する。

## 変更対象ファイル

- `src/session.ts`: `handleIncomingDatagram` の PADDING fast-path 判定とコメントを修正する
- `CHANGES.md`: `[FIX]` エントリを追記する

## エッジケース

| ケース                                                 | 期待動作                                                                                                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PADDING Datagram (`f0 13 2b 3e 29` + 任意の 0 埋め)    | discard してセッションは継続                                                                                                                                                  |
| PADDING Datagram で type のみ (payload なし, 5 バイト) | discard                                                                                                                                                                       |
| 通常の Object Datagram (先頭が小さい 1 バイト type)    | 既存通りデコードして配信                                                                                                                                                      |
| 先頭が `0xf0` だが 5 バイト未満の不完全な datagram     | `decodeVarint` が `IncompleteDataError` を throw -> 末尾 catch で discard (セッションは閉じない)                                                                              |
| `0x132B3E28` (PADDING Stream type) を datagram で受信  | PADDING ではないため通常処理 (Object Datagram として未知 type -> `ProtocolViolationError`)。Stream type を datagram で送るのは送信側の誤りであり、仕様上 discard 対象ではない |

## テスト方針

`handleIncomingDatagram` は private かつ WebTransport の datagram 受信に依存するため、discard 動作そのものの検証は E2E テスト (Playwright) の対象とする。`src/session.ts` のフローはモック禁止制約下で単体テスト不可能。

回帰防止として、fast-path で参照する定数の正しさを純粋関数レベルで pin する単体テストを `src/varint.test.ts` に追加する。

- `varintSize(0x132B3E29) === 5` を検証する
- `encodeVarint(0x132B3E29)[0] === 0xf0` を検証する (誤った `0xe4` への先祖返りを検出する)

Vitest の test / assert を使用し、テストメッセージは日本語で書く。モックやスタブは利用しない。

## 後方互換の影響

- 受信挙動の修正のみで、公開 API に変更はない
- これまで PADDING Datagram 受信で誤ってセッションを切断していたのが、仕様通り discard されるようになる

## 完了条件

- PADDING Datagram を受信してもセッションが切断されず、データが discard される
- PADDING fast-path の判定が varint デコード (または正しい先頭バイト `0xf0` + 長さ `>= 5`) に修正されている
- 誤ったコメントと不正確な spec 引用文が修正されている
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリを追記する
