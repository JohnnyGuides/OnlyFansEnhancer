"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { webcrypto } = require("node:crypto");

function load(name, globals) {
  const context = vm.createContext(globals);
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, "../../shared/identity-mask", name),
      "utf8",
    ),
    context,
  );
  return context;
}

test("page and worker crops agree, preserve face selection, imported IDs and bitmap cleanup", async () => {
  let closed = 0;
  const bitmap = { width: 640, height: 480, close: () => closed++ };
  const draws = [];
  class Canvas {
    constructor(width, height) {
      Object.assign(this, { width, height });
    }
    getContext() {
      return {
        drawImage: (...args) => draws.push(args),
        getImageData: () => ({
          data: Uint8ClampedArray.from(
            { length: this.width * this.height * 4 },
            (_, i) => i % 251,
          ),
        }),
      };
    }
    toDataURL(type, quality) {
      assert.equal(type, "image/webp");
      assert.equal(quality, 0.8);
      assert.equal(this.width, 96);
      assert.equal(this.height, 96);
      return "data:image/webp;base64,fixture";
    }
  }
  const globals = {
    OffscreenCanvas: Canvas,
    crypto: webcrypto,
    createImageBitmap: async () => bitmap,
    FaceDetector: class {
      async detect() {
        return [
          { boundingBox: { x: 0, y: 0, width: 30, height: 30 } },
          { boundingBox: { x: 300, y: 100, width: 100, height: 50 } },
        ];
      }
    },
  };
  const worker = load("avatar-crop.js", globals).FanAvatarCrop;
  const page = load("avatar-crop.js", {
    ...globals,
    document: { createElement: () => new Canvas() },
  }).FanAvatarCrop;
  assert.equal(
    JSON.stringify(page.smartCrop(bitmap)),
    JSON.stringify(worker.smartCrop(bitmap)),
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(await page.nativeFaceCrop(bitmap))),
    { x: 232.5, y: 13.5, side: 235, detection: "face" },
  );
  const result = await page.cropImportedImage({
    arrayBuffer: async () => new TextEncoder().encode("abc").buffer,
  });
  assert.equal(result.id, "ba7816bf8f01cfea414140de5dae2223");
  assert.equal(result.detection, "face");
  assert.deepEqual(
    draws.at(-1).slice(1),
    [232.5, 13.5, 235, 235, 0, 0, 96, 96],
  );
  assert.equal(closed, 1);
  const fallback = load("avatar-crop.js", {
    ...globals,
    FaceDetector: class {
      async detect() {
        throw new Error("Unavailable");
      }
    },
  }).FanAvatarCrop;
  assert.equal(await fallback.nativeFaceCrop(bitmap), null);
});

test("shared messaging preserves transport errors, worker refusals and successful responses", async () => {
  let response = { ok: true, settings: { enabled: true } };
  const runtime = { sendMessage: (_message, callback) => callback(response) };
  const send = load("runtime.js", {
    chrome: { runtime },
  }).FanIdentityMaskSendMessage;
  assert.equal(await send({ type: "GET_SETTINGS" }), response);
  response = { ok: false, error: "Refused" };
  await assert.rejects(send({}), /Refused/);
  runtime.lastError = { message: "Disconnected" };
  await assert.rejects(send({}), /Disconnected/);
});
