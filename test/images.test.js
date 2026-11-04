import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { downloadImages } from "../src/images.js";

test("下载图片解密后存到本地，返回路径", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsb-images-"));
  const client = {
    async downloadFile(url, aeskey) {
      assert.equal(url, "https://example.com/img1");
      assert.equal(aeskey, "key1");
      return { buffer: Buffer.from("fake-jpeg"), filename: "a.png" };
    },
  };

  const paths = await downloadImages({
    client,
    images: [{ url: "https://example.com/img1", aeskey: "key1" }],
    dir,
    msgid: "m1",
  });

  assert.equal(paths.length, 1);
  assert.equal(await readFile(paths[0], "utf8"), "fake-jpeg");
  assert.match(paths[0], /m1-1\.png$/);
});

test("超过大小限制的图片拒绝落盘", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsb-images-"));
  const client = {
    async downloadFile() {
      return { buffer: Buffer.alloc(2048), filename: "big.jpg" };
    },
  };

  await assert.rejects(
    downloadImages({ client, images: [{ url: "https://example.com/big" }], dir, msgid: "m2", maxBytes: 1024 }),
    /大小限制/,
  );
});

test("非常见后缀一律按 .jpg 落盘，多张图片按序号命名", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsb-images-"));
  const client = {
    async downloadFile() {
      return { buffer: Buffer.from("x"), filename: "evil.sh" };
    },
  };

  const paths = await downloadImages({
    client,
    images: [{ url: "https://example.com/1" }, { url: "https://example.com/2" }],
    dir,
    msgid: "m/3",
  });

  assert.match(paths[0], /m_3-1\.jpg$/);
  assert.match(paths[1], /m_3-2\.jpg$/);
});
