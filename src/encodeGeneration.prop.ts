/**
 * 符号化の出力を送るかの判定の Property-Based Tests
 *
 * 配信を止めた時点で開いている Subgroup を閉じるため、止める前に依頼した出力は送らない
 * (draft-ietf-moq-transport-22 §11.3.2)。依頼と停止が任意の順で起き、出力の到着順も
 * 保証されない状況で、最後に依頼した世代の出力だけを送ることを確かめる。
 * 個別の境界 (記録が無い出力、同じ timestamp の上書き) は encodeGeneration.test.ts が固定する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  advanceEncodeGeneration,
  recordEncodeGeneration,
  shouldSendEncodedChunk,
  type EncodeState,
} from "./encodeGeneration";

/** 符号化の依頼と送信の停止 */
type Step = { readonly kind: "encode"; readonly timestamp: number } | { readonly kind: "stop" };

test("shouldSendEncodedChunk: 停止を挟んでも、最後に依頼した世代の出力だけを送る", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.oneof(
          {
            weight: 4,
            arbitrary: fc.record({
              kind: fc.constant("encode" as const),
              timestamp: fc.integer({ min: 0, max: 3 }),
            }),
          },
          { weight: 1, arbitrary: fc.constant({ kind: "stop" as const }) },
        ),
        { minLength: 1, maxLength: 12 },
      ),
      (steps: Step[]) => {
        const state: EncodeState = { generation: 0, records: new Map() };
        /** 依頼した出力 (到着順は保証されないため、記録から選ばれる) */
        const requested: { timestamp: number; generation: number }[] = [];
        for (const step of steps) {
          if (step.kind === "encode") {
            recordEncodeGeneration(state.records, state.generation, step.timestamp);
            requested.push({ timestamp: step.timestamp, generation: state.generation });
          } else {
            advanceEncodeGeneration(state);
          }
        }

        // 出力は依頼の逆順でも届き得る。同じ timestamp の出力は高々 1 つ届く
        const timestamps = [...new Set(requested.map((item) => item.timestamp))];
        const sent: number[] = [];
        for (const timestamp of timestamps.slice().reverse()) {
          if (shouldSendEncodedChunk(state.records, state.generation, timestamp)) {
            sent.push(timestamp);
          }
        }

        // 送るのは、その timestamp に最後に記録した世代が現在の世代と一致する出力だけである
        const expected = timestamps.filter((timestamp) => {
          // その timestamp を最後に依頼した時点の世代 (依頼の順に並んでいる)
          const last = requested.reduce<{ timestamp: number; generation: number } | undefined>(
            (found, item) => (item.timestamp === timestamp ? item : found),
            undefined,
          );
          return last !== undefined && last.generation === state.generation;
        });
        const compare = (left: number, right: number): number => left - right;
        assert.deepEqual(
          sent.slice().sort(compare),
          expected.slice().sort(compare),
          "送る出力の組が違う",
        );
        // 同じ出力を 2 度送らない (取り出した記録は残らない)
        assert.strictEqual(state.records.size, 0, "取り出していない記録が残っている");
      },
    ),
  );
});
