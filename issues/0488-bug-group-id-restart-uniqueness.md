# 同一 track の再 publish で Group ID が 0 に戻り MSF §6.1 に反する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-group-id-restart
- Polished: 2026-09-06

## 目的

MSF §6.1 は再起動時に新しい開始 Group ID が同一 track の過去の全 Group ID を上回る MUST を定める (継続セッション内は `SHOULD +1`、時刻方式は `One approach` の例示)。新規インスタンス生成で同一 track を再 publish すると 0 から採番し直し、購読側の継続性が壊れる。gap 通知 (Prior Group ID Gap Extension の `SHOULD`) は本 issue の対象外とする。

## 現状

- `src/createMediaPublisher.ts` は音声・映像とも Group ID フィールド初期値が 0 である。初回送信値は非対称で、音声は 0 を送信し、映像は最初のキーフレームで加算してから送信するため 1 になり Group 0 が未使用である。
- `src/msf.ts` の `createInitialGroupId` (Unix epoch ミリ秒起点、`bigint` 返却) がテスト以外で未使用である。再起動は新規インスタンス生成を指す (同一インスタンスの `stop` → `start` はカウンタをリセットしないため 0 に戻らない)。

## 設計方針

1. 初期値に `Number(createInitialGroupId())` を使う (`Date.now()` は `MAX_SAFE_INTEGER` に収まるため変換可能。Publisher 側の `number` 型は変えない)。同一プロセス内の前回値を下回らないよう `Math.max(前回 + 1)` ガードを付ける。プロセス跨ぎは壁時計に委ねる。
2. 初回送信値を初期値 `T` に統一する。音声は現状どおり初回 `T` 送信とし、映像は初回 key での加算を抑止して初回 `T` 送信とする (2 回目以降 key で加算)。

## 完了条件

- 新規インスタンス生成 (同一 track) の開始 Group ID が前回送信最大値を上回ること (初期値生成の単体テスト。時刻依存は注入または固定で検証する)。
- 音声・映像とも初回送信値が初期値 `T` であること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-msf-01 §6.1
