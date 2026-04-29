# Subgroup Header の予約値で PROTOCOL_VIOLATION を発生させていない

Created: 2026-04-29
Completed: 2026-04-29
Model: Opus 4.7

## 概要

`src/session.ts` のストリーム種別判定 (line 3567-3569) で SUBGROUP_HEADER のレンジを `0x10..0x1F` および `0x30..0x3F` 全体としているため、仕様で予約された無効値 `0x16, 0x17, 0x1E, 0x1F, 0x36, 0x37, 0x3E, 0x3F` も受理してしまう。後段の `decodeSubgroupHeader` がエラーを投げても、line 3602 付近の `catch` 節で握り潰してストリーム処理を継続するため、仕様が要求する PROTOCOL_VIOLATION でのセッション切断が発生しない。

## 根拠

draft-ietf-moq-transport-17 Section 10.4.2 (`refs/moq/draft-ietf-moq-transport-17.txt:4799-4809`):

> The following Type values are invalid. If an endpoint receives a stream header with any of these Type values, it MUST close the session with a PROTOCOL_VIOLATION:
>
> - Type values with SUBGROUP_ID_MODE set to 0b11: 0x16, 0x17, 0x1E, 0x1F, 0x36, 0x37, 0x3E, 0x3F. This mode is reserved for future use.
> - Type values that do not match the form 0b00X1XXXX (i.e., Type values outside the ranges 0x10..0x1F and 0x30..0x3F, or values where bit 4 is not set).

draft-ietf-moq-transport-17 Section 3.4 では未知のストリーム種別についてもセッションを PROTOCOL_VIOLATION で閉じることが要求されている。

## 該当コード

- ストリーム種別判定: `src/session.ts:3567-3569`

  ```typescript
  } else if (
    (streamTypeNum >= 0x10 && streamTypeNum <= 0x1f) ||
    (streamTypeNum >= 0x30 && streamTypeNum <= 0x3f)
  ) {
  ```

- ヘッダーパース失敗の握り潰し: `src/session.ts:3602` 付近

  ```typescript
  } catch {
    // ヘッダーのパースに失敗した場合、データが不足している可能性
    // 次のチャンクを待つ
    if (done) break;
    continue;
  }
  ```

  `decodeSubgroupHeader` / `decodeFetchHeader` は「データ不足」と「プロトコル違反 (予約値、不正フォーマット)」の両方で例外を投げるが、現状はどちらも同一の catch 節で扱われ、プロトコル違反を検出できない。stream `done=true` 時の単なる `break` も Section 10.4 の "SHOULD be closed with a PROTOCOL_VIOLATION" を取りこぼす。

## 影響

- 攻撃者または不具合のある peer が予約値の SUBGROUP_HEADER を送ってきても、session が閉じられずに silent fail する。
- Section 10.4.2 の "MUST close the session with a PROTOCOL_VIOLATION" 違反。
- 不完全なストリームが FIN で終わった場合の検出も困難。

## 修正方針

- ストリーム種別判定で有効値のみを許可する。具体的には `streamTypeNum` を `0x10..0x15`, `0x18..0x1D`, `0x30..0x35`, `0x38..0x3D` のいずれかに含まれる場合のみ Subgroup として処理し、それ以外で `0x10..0x1F` / `0x30..0x3F` の範囲に入るものは PROTOCOL_VIOLATION で session を閉じる。
- `decodeSubgroupHeader` / `decodeFetchHeader` が投げる例外を「データ不足」と「プロトコル違反」で区別する。データ不足は専用のセンチネル (例: `IncompleteHeaderError`) を使い、それ以外は protocol violation として上位に伝播させる。
- ストリーム処理ループで protocol violation を捕捉したら `closeWithError(PROTOCOL_VIOLATION, message)` を呼んで session を切断する。

## テスト追加方針

- `src/dataStream.test.ts` に予約値 (`0x16`, `0x17`, `0x1E`, `0x1F`, `0x36`, `0x37`, `0x3E`, `0x3F`) を `decodeSubgroupHeader` に渡したときに識別可能なエラー (例: `ProtocolViolationError`) が投げられることを検証するテストを追加する。
- データ不足 (バッファに途中まで書き込み) のテストで「データ不足」用センチネルが投げられることも確認する。

## 補足

レビュー指摘 #35 と #38 を受けて起票。両者は「Subgroup ヘッダーの種別判定とエラー伝播」という同一責務に属するため 1 件にまとめる。

## 解決方法

- `src/session.ts` の `handleIncomingStream` で、ストリームタイプが Subgroup の範囲 (0x10..0x1F または 0x30..0x3F) に含まれる場合に、SUBGROUP_ID_MODE = 0b11 を表すビットパターン (`(streamTypeNum & 0x06) === 0x06`) を事前検証し、予約値 (0x16, 0x17, 0x1E, 0x1F, 0x36, 0x37, 0x3E, 0x3F) を受信したら `closeWithError(PROTOCOL_VIOLATION)` でセッションを閉じるようにした。
- `src/dataStream.test.ts` に `decodeSubgroupHeader` が予約値で `SUBGROUP_ID_MODE 0b11 is reserved` を、bit 4 が立っていない値で `does not match form 0b00X1XXXX` を投げることを検証するテストを追加した。
- decode 関数の例外分類 (データ不足とプロトコル違反の区別) は #0109 で対応する。
