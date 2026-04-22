# LOC draft-ietf-moq-loc-02 の AUDIO_LEVEL と TIMESTAMP の ID 衝突

## Pending の理由

本 issue は draft-ietf-moq-loc-02 の仕様上のバグであり、moqt-js 側のコード変更では解決できない外部依存である。
解決には draft-ietf-moq-loc の次リビジョンで AUDIO_LEVEL に衝突しない ID が割り当てられ、IANA により正式登録されることが必要である。
現状の暫定対応（TIMESTAMP 0x06 を優先、Audio Level はデコードループから除外）は既にコードへ反映済みであり、仕様側の更新後にコードを追従させる。

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

## 解決条件

- draft-ietf-moq-loc の次のリビジョンで AUDIO_LEVEL に衝突しない ID が割り当てられること
- IANA による正式な ID 割り当て後にコードを更新すること

## 参考

- refs/moq/draft-ietf-moq-loc-02.txt Section 2.3.1.1 (Timestamp)
- refs/moq/draft-ietf-moq-loc-02.txt Section 2.3.3.1 (Audio Level)
- refs/moq/draft-ietf-moq-loc-02.txt Section 6.1 (IANA Table)
