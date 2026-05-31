# Mandatory-to-Understand な Property/Parameter を拒否する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で Mandatory Track Properties の処理規則が明確化された。
未知の Mandatory Track Property を受信した場合、トラックを処理・転送してはならない。

> When an endpoint receives Track Properties (in PUBLISH, SUBSCRIBE_OK,
> or FETCH_OK messages) containing a Mandatory Track Property type that
> it does not understand, it MUST NOT process or forward that track:
>
> -- draft-ietf-moq-transport-18 §2.5.1 (Mandatory Track Properties)

Mandatory Track Properties は Property Type 0x4000-0x7FFF の範囲で定義される (§2.5.1)。

## 変更内容

### 1. Property デコード時に Mandatory Track Property を判定する (`src/properties.ts`)

- `decodeProperties()` で各 Property Type が Mandatory Track Property 範囲 (0x4000-0x7FFF) かチェックする
- 未知の Mandatory Track Property を受信した場合、§2.5.1 に従い REQUEST_ERROR 等で拒否する
- 既知の Property Type との突合ロジックを実装する
  - `MOQTPropertyId` / `TrackPropertyId` の既知 ID リストに対してチェックする

### 2. Parameter デコード時に未知 Parameter の扱いを確認する (`src/message/parameter.ts`)

- 未知 Parameter の扱いが §10.2 / §2.5 と整合していることを確認する

## 該当ファイル

| ファイル                   | 変更内容                                           |
| -------------------------- | -------------------------------------------------- |
| `src/properties.ts`        | Mandatory Track Property 範囲の検出と拒否ロジック  |
| `src/message/parameter.ts` | 未知 Parameter の扱いを確認する                    |
| `src/session.ts`           | PUBLISH / SUBSCRIBE_OK / FETCH_OK 受信時の拒否処理 |

## テスト

- 未知 Mandatory Track Property 受信時に適切なエラーが返ることを確認する
