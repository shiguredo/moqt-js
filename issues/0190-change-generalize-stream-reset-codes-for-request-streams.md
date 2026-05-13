# Stream Reset コードを全 request stream に一般化し PUBLISH_DONE と整合させる

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で従来 SUBSCRIBE データストリーム向けに定義されていた stream reset コードが
全 request stream に対して一般化され、新しいコードが追加された。
さらに PUBLISH_DONE と reset コード体系が整合化された。
moqt-js のエラーコード定数 / マッピング / RESET_STREAM ハンドリングを更新する。

## draft-18 参照

- draft-ietf-moq-transport-18 §3.3.3 Stream Reset Error Codes
- draft-ietf-moq-transport-18 §10.11 PUBLISH_DONE
- draft-ietf-moq-transport-18 §15.10.3 PUBLISH_DONE Codes
- moq-wg/moq-transport#1606

## 影響範囲

- `src/error.ts` のエラーコード定数
- RESET_STREAM / STOP_SENDING ハンドリング
- PUBLISH_DONE 送受信時のコード変換
