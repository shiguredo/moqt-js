/**
 * MOQT Session Messages Property-Based Tests
 * draft-ietf-moq-transport-17 Section 9.5-9.7
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  type Goaway,
  type RequestError,
  decodeGoawayPayload,
  decodeRequestErrorPayload,
  encodeGoawayPayload,
} from "./session";
import { MessageType } from "./types";
import { encodeVarint } from "../varint";

/**
 * draft-ietf-moq-transport-17 Section 9.5:
 * GOAWAY に Timeout フィールドが追加された。
 * https://github.com/moq-wg/moq-transport/pull/1497
 */
test("Goaway のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 0, maxLength: 200 }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      (newSessionUri, timeout) => {
        const original: Goaway = {
          type: MessageType.GOAWAY,
          newSessionUri,
          timeout,
        };

        const encoded = encodeGoawayPayload(original);
        const decoded = decodeGoawayPayload(encoded);

        assert.equal(decoded.type, MessageType.GOAWAY);
        assert.equal(decoded.newSessionUri, newSessionUri);
        assert.equal(decoded.timeout, timeout);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-17 Section 9.7:
 * REQUEST_ERROR から Request ID が削除された。
 * https://github.com/moq-wg/moq-transport/pull/1499
 *
 * Retry Interval: 再試行までに待つべきミリ秒 + 1
 * - 0: 再試行すべきではない
 * - 1 以上: 再試行可能（1 は即座の再試行を許可）
 */
test("RequestError をデコードできる", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.string({ minLength: 0, maxLength: 200 }),
      (errorCode, retryInterval, reasonPhrase) => {
        const encoder = new TextEncoder();
        const reasonBytes = encoder.encode(reasonPhrase);
        const parts: Uint8Array[] = [];
        parts.push(encodeVarint(errorCode));
        parts.push(encodeVarint(retryInterval));
        parts.push(encodeVarint(BigInt(reasonBytes.length)));
        parts.push(reasonBytes);
        const total = parts.reduce((acc, b) => acc + b.length, 0);
        const buf = new Uint8Array(total);
        let off = 0;
        for (const b of parts) {
          buf.set(b, off);
          off += b.length;
        }
        const decoded: RequestError = decodeRequestErrorPayload(buf);
        assert.equal(decoded.type, MessageType.REQUEST_ERROR);
        assert.equal(decoded.errorCode, errorCode);
        assert.equal(decoded.retryInterval, retryInterval);
        assert.equal(decoded.reasonPhrase, reasonPhrase);
      },
    ),
  );
});
