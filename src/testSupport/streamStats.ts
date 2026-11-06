/**
 * 受信統計の計数だけを行う実装
 *
 * processFetchObjects / processSubgroupObjects に渡して配送統計を観測する。
 * 配送可否には影響しない。
 */
export interface CountingStreamStats {
  readonly objectsReceived: number;
  readonly bytesReceived: number;
  incrementObjectsReceived(subscribePath: boolean): void;
  incrementBytesReceived(subscribePath: boolean, bytes: number): void;
}

/** 計数だけを行う統計を作る */
export function createCountingStreamStats(): CountingStreamStats {
  let objectsReceived = 0;
  let bytesReceived = 0;
  return {
    get objectsReceived(): number {
      return objectsReceived;
    },
    get bytesReceived(): number {
      return bytesReceived;
    },
    incrementObjectsReceived: (_subscribePath: boolean): void => {
      objectsReceived++;
    },
    incrementBytesReceived: (_subscribePath: boolean, bytes: number): void => {
      bytesReceived += bytes;
    },
  };
}
