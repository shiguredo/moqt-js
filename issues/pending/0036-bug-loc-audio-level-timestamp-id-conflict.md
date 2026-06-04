# LOC draft-ietf-moq-loc-02 の AUDIO_LEVEL と TIMESTAMP の ID 衝突

## 概要

draft-ietf-moq-loc-02 において、TIMESTAMP (Section 2.3.1.1) と AUDIO_LEVEL (Section 2.3.3.1) の Property ID が衝突している。

## 仕様上のバグ

これは draft-ietf-moq-loc-02 の仕様上のバグである。

### 衝突している ID

| プロパティ  | ID     | 仕様箇所        | IANA 登録状況                                                   |
| ----------- | ------ | --------------- | --------------------------------------------------------------- |
| TIMESTAMP   | `0x06` | Section 2.3.1.1 | Section 6.1 IANA テーブルに登録済み                             |
| AUDIO_LEVEL | `6`    | Section 2.3.3.1 | 未登録 ("IANA, please assign from the MOQ Properties Registry") |

`0x06` = 10 進数 `6` であるため、同一の ID を指している。
両方とも MOQ Properties Registry に属するため、同一レジストリ内での ID 衝突となる。

### 原因

draft-ietf-moq-loc-01 では Capture Timestamp の ID は `2` だった。
draft-02 で Timestamp に改名し ID を `0x06` に変更した際、Audio Level の仮 ID `6` との衝突が見落とされたと思われる。

### 根拠

IANA テーブル (Section 6.1) に TIMESTAMP (`0x06`) と TIMESCALE (`0x08`) のみが登録されている。
Audio Level の "ID: 6 (IANA, please assign)" は仮の値であり、IANA による正式割り当てがされていない。
正式登録済みの TIMESTAMP が優先される。

## 現在の対応

- IANA テーブルに正式登録されている TIMESTAMP (0x06) を優先
- デコードループでは ID `0x06` を常に TIMESTAMP として処理
- Audio Level の encode/decode 関数はスタンドアロンで提供するが、デコードループでは使用しない
- 利用者向けドキュメント (README / docs) にこの制約 (AUDIO_LEVEL は ID 衝突のためデコードループで TIMESTAMP として扱われ自動デコードされない) を記載する。LOC の利用者向けドキュメントを追加する際に含める (旧 #0308 を統合)

## 解決条件

- draft-ietf-moq-loc の次のリビジョンで AUDIO_LEVEL に衝突しない ID が割り当てられること
- IANA による正式な ID 割り当て後にコードを更新すること

## 参考

- refs/moq/draft-ietf-moq-loc-02.txt Section 2.3.1.1 (Timestamp)
- refs/moq/draft-ietf-moq-loc-02.txt Section 2.3.3.1 (Audio Level)
- refs/moq/draft-ietf-moq-loc-02.txt Section 6.1 (IANA Table)

## pending 理由

draft-ietf-moq-loc-02 の仕様バグ。AUDIO_LEVEL に対する IANA からの正式な ID 割り当てを待つ必要があり、moqt-js 側では対応できない。次のリビジョンで衝突しない ID が割り当てられた後に対応する。

## 状況確認 (2026-04-29)

- `refs/moq/` 配下の LOC ドラフトは依然として `draft-ietf-moq-loc-02.txt` のみ。`-03` 以降は未取得。
- `src/loc.ts:24-43` で `TIMESTAMP: 0x06n` と `AUDIO_LEVEL: 6n` が共存する暫定状態を維持。デコードループ (`src/loc.ts:284-373`) も TIMESTAMP / TIMESCALE のみ処理し、AUDIO_LEVEL は ID `0x06` での突き合わせ対象外という方針のまま。
- 仕様側 (IANA への AUDIO_LEVEL ID 割り当て、または LOC ドラフト改訂) に動きがない以上、moqt-js 側で取れるアクションはなく、pending 維持で変更なし。
