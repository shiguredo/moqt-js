/**
 * resetSubscriberState の Property-Based Tests
 *
 * Subscriber を止めたときに接続設定の入力を有効に戻すか (settingsDisabled) を、止める
 * インスタンス、他の Subscriber、Publisher の状態の任意の組み合わせで確かめる。
 *
 * - 止めたインスタンス自身は、確立を待っていても数えない
 * - 他の Subscriber のどれかが購読の確立を待っているか、Publisher が配信を始めている途中
 *   (connect を待っていて pubSession がまだ無い) なら、入力は無効のまま残す
 * - どれも接続設定を使っていなければ、入力を有効に戻す
 *
 * 確立済みの購読と配信 (subscriber.value / pubSession が null でない) は生成しない。
 * Node では Session の実物を作れず、Fake (FakeSubscriber / FakeSession) に頼るテストを増やさない
 * ため。確立済みの状態は、確立を待っている途中と同じ「使っている」の OR の項である。
 * 確立済みの Subscriber を止めたときに自身を数えないことは、次の単体テストが固定する。
 * 「resetSubscriberState resets every state signal to initial value」
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { resetSubscriberState } from "./useSubscriber";
import { createSubscriberInstance, subscriberInstances } from "../signals/subscriber";
import * as pub from "../signals/publisher";
import { settingsDisabled } from "../signals/connectionSettings";

// 止めるインスタンスが購読の確立を待っていたか
const stoppingStartingArbitrary = fc.boolean();
// 他の Subscriber が購読の確立を待っているか (Subscriber ごと。0 個も含む)
const othersStartingArbitrary = fc.array(fc.boolean(), { maxLength: 4 });
// Publisher が配信を始めている途中か
const publisherStartingArbitrary = fc.boolean();

test("resetSubscriberState: 他の Subscriber か Publisher が開始の途中なら settingsDisabled を保ち、どれも開始の途中でなければ戻す", () => {
  fc.assert(
    fc.property(
      stoppingStartingArbitrary,
      othersStartingArbitrary,
      publisherStartingArbitrary,
      (stoppingStarting, othersStarting, publisherStarting) => {
        const stopping = createSubscriberInstance("stopping-subscriber");
        stopping.isStarting.value = stoppingStarting;
        const others = othersStarting.map((starting, index) => {
          const other = createSubscriberInstance(`other-subscriber-${index}`);
          other.isStarting.value = starting;
          return other;
        });
        subscriberInstances.value = new Map(
          [stopping, ...others].map((instance) => [instance.id, instance]),
        );
        pub.pubSession.value = null;
        pub.isStarting.value = publisherStarting;
        // 誰かが開始したときに無効にした状態から止める
        settingsDisabled.value = true;

        try {
          resetSubscriberState(stopping, {
            video: { current: Promise.resolve() },
            audio: { current: Promise.resolve() },
          });

          // 止めたインスタンスの待ちは終わる
          assert.isFalse(stopping.isStarting.value);
          // 他の Subscriber と Publisher のどれかが使っている間だけ、入力は無効のまま残る
          const stillUsed = othersStarting.some(Boolean) || publisherStarting;
          assert.equal(settingsDisabled.value, stillUsed);
        } finally {
          subscriberInstances.value = new Map();
          pub.isStarting.value = false;
          settingsDisabled.value = false;
        }
      },
    ),
  );
});
