# devtools で Forward State を可視化する

Created: 2026-03-29
Model: Opus 4.6

## 概要

devtools の Publisher パネルで Forward State (Subscriber の有無) を表示していない。

## RFC 根拠

draft-ietf-moq-transport-17 Section 5.1 Subscriptions:

> All Established subscriptions have a Forward State which is either 0 or 1. The publisher does not send Objects if the Forward State is 0, and does send them if the Forward State is 1. The initiator of the subscription sets the initial Forward State in either PUBLISH or SUBSCRIBE. The subscriber can send PUBLISH_OK or REQUEST_UPDATE to update the Forward State. Control messages, such as PUBLISH_DONE (Section 9.13) are sent regardless of the forward state.

> A publisher MUST save the Largest Location communicated in SUBSCRIBE_OK, PUBLISH or REQUEST_OK (in response to a REQUEST_UPDATE) that changes the Forward State from 0 to 1. This value is called the Joining Location and can be used in a Joining FETCH (see Section 9.14.2) while the subscription is in the Established state.

Forward State はサブスクリプションの重要な状態であり、Publisher がオブジェクト送信を制御するために使用する。ライブラリは `PublishCallbacks.onForwardStateChange` コールバックと `Publisher.forwardState` プロパティを提供しているが、devtools はこれを一切使用していない。

デバッグツールとして Forward State の状態変化を可視化することは、プロトコルの動作確認において有用である。

## 該当箇所

- `devtools/src/hooks/usePublisher.ts`: `onForwardStateChange` コールバック未使用
- `devtools/src/components/PublisherPanel.tsx`: Forward State の表示なし

## 修正方針

Publisher パネルに Forward State の現在値を表示し、状態変化時にリアルタイムで更新する。
