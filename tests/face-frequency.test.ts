import assert from "node:assert/strict";
import test from "node:test";
import { clusterFaceDescriptors } from "../packages/worker/src/facereel.ts";

function descriptor(...values: number[]): Float32Array {
  return new Float32Array(values);
}

test("dominant face frequency counts distinct photos rather than duplicate faces", () => {
  const clusters = clusterFaceDescriptors([
    { imageId: "photo-1", descriptor: descriptor(0, 0) },
    { imageId: "photo-2", descriptor: descriptor(0.05, 0.02) },
    { imageId: "photo-3", descriptor: descriptor(0.08, 0.03) },
    { imageId: "photo-4", descriptor: descriptor(1, 1) },
    { imageId: "photo-5", descriptor: descriptor(1.04, 1.02) },
    { imageId: "photo-5", descriptor: descriptor(1.03, 1.01) },
  ], 0.2);

  const byFrequency = [...clusters].sort((a, b) => b.imageIds.size - a.imageIds.size);
  assert.equal(byFrequency.length, 2);
  assert.deepEqual([...byFrequency[0]!.imageIds], ["photo-1", "photo-2", "photo-3"]);
  assert.equal(byFrequency[0]!.imageIds.size, 3);
  assert.equal(byFrequency[1]!.imageIds.size, 2);
});

test("faces outside the match threshold remain separate clusters", () => {
  const clusters = clusterFaceDescriptors([
    { imageId: "photo-1", descriptor: descriptor(0, 0, 0) },
    { imageId: "photo-2", descriptor: descriptor(0.1, 0.1, 0.1) },
    { imageId: "photo-3", descriptor: descriptor(0.8, 0.8, 0.8) },
  ], 0.3);

  assert.equal(clusters.length, 2);
  assert.equal(Math.max(...clusters.map((cluster) => cluster.imageIds.size)), 2);
});
