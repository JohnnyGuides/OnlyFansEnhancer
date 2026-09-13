(() => {
  "use strict";

  if (globalThis.CreatorLocalFileAttacher) return;

  const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\)/;

  function fail(code) {
    return new Error(code);
  }

  function validate(request) {
    if (!Number.isSafeInteger(request?.tabId) || request.tabId <= 0)
      throw fail("invalid-tab");
    const selector = String(request.selector || "").trim();
    if (!selector || selector.length > 500 || selector.includes("\0"))
      throw fail("invalid-selector");
    const filePath = String(request.filePath || "");
    if (
      !WINDOWS_ABSOLUTE_PATH.test(filePath) ||
      filePath.length > 32_767 ||
      /[\0\r\n]/.test(filePath)
    ) {
      throw fail("invalid-file-path");
    }
    if (
      !Array.isArray(request.allowedOrigins) ||
      request.allowedOrigins.length < 1 ||
      request.allowedOrigins.length > 32
    ) {
      throw fail("invalid-origins");
    }
    const allowedOrigins = request.allowedOrigins.map((value) => {
      const candidate = String(value || "");
      try {
        const url = new URL(candidate);
        if (
          url.origin !== candidate ||
          !new Set(["http:", "https:"]).has(url.protocol)
        ) {
          throw fail("invalid-origins");
        }
      } catch {
        throw fail("invalid-origins");
      }
      return candidate;
    });
    return { tabId: request.tabId, selector, filePath, allowedOrigins };
  }

  function callbackCall(chromeApi, owner, method, args, errorCode) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action, value) => {
        if (settled) return;
        settled = true;
        action(value);
      };
      const callback = (value) => {
        if (chromeApi.runtime?.lastError) {
          finish(reject, fail(errorCode));
          return;
        }
        finish(resolve, value);
      };
      try {
        const pending = owner[method](...args, callback);
        if (pending?.then) {
          pending.then(
            (value) => finish(resolve, value),
            () => finish(reject, fail(errorCode)),
          );
        }
      } catch {
        finish(reject, fail(errorCode));
      }
    });
  }

  async function command(chromeApi, target, method, parameters) {
    return callbackCall(
      chromeApi,
      chromeApi.debugger,
      "sendCommand",
      [target, method, parameters],
      "debugger-command-failed",
    );
  }

  function attributeMap(attributes) {
    const result = new Map();
    for (let index = 0; index < attributes.length; index += 2) {
      result.set(
        String(attributes[index] || "").toLowerCase(),
        attributes[index + 1],
      );
    }
    return result;
  }

  function mainFrame(frameTree, allowedOrigins, expectedFrame) {
    const frame = frameTree?.frameTree?.frame;
    let origin;
    try {
      origin = new URL(frame?.url || "").origin;
    } catch {
      throw fail("origin-not-allowed");
    }
    if (
      !allowedOrigins.includes(origin) ||
      !frame?.id ||
      !frame?.loaderId ||
      (expectedFrame &&
        (frame.id !== expectedFrame.id ||
          frame.loaderId !== expectedFrame.loaderId))
    ) {
      throw fail("origin-not-allowed");
    }
    return { id: frame.id, loaderId: frame.loaderId };
  }

  async function attach(request, chromeApi = globalThis.chrome) {
    const prepared = validate(request);
    if (!chromeApi?.tabs?.get || !chromeApi?.debugger)
      throw fail("chrome-api-unavailable");

    let tab;
    try {
      tab = await chromeApi.tabs.get(prepared.tabId);
    } catch {
      throw fail("tab-unavailable");
    }
    if (tab?.url) {
      let origin;
      try {
        origin = new URL(tab.url).origin;
      } catch {
        throw fail("origin-not-allowed");
      }
      if (!prepared.allowedOrigins.includes(origin))
        throw fail("origin-not-allowed");
    }

    const target = { tabId: prepared.tabId };
    let attached = false;
    let operationError = null;
    let detachError = null;
    let result = null;
    try {
      await callbackCall(
        chromeApi,
        chromeApi.debugger,
        "attach",
        [target, "1.3"],
        "debugger-attach-failed",
      );
      attached = true;
      const attachedFrame = mainFrame(
        await command(chromeApi, target, "Page.getFrameTree", {}),
        prepared.allowedOrigins,
      );
      const documentResult = await command(
        chromeApi,
        target,
        "DOM.getDocument",
        {
          depth: 0,
          pierce: true,
        },
      );
      const queryResult = await command(
        chromeApi,
        target,
        "DOM.querySelectorAll",
        {
          nodeId: documentResult?.root?.nodeId,
          selector: prepared.selector,
        },
      );
      if (
        !Array.isArray(queryResult?.nodeIds) ||
        queryResult.nodeIds.length !== 1
      ) {
        throw fail(
          queryResult?.nodeIds?.length
            ? "file-control-ambiguous"
            : "file-control-missing",
        );
      }
      const nodeId = queryResult.nodeIds[0];
      const description = await command(chromeApi, target, "DOM.describeNode", {
        nodeId,
      });
      const attributes = attributeMap(description?.node?.attributes || []);
      if (
        String(description?.node?.localName || "").toLowerCase() !== "input" ||
        String(attributes.get("type") || "").toLowerCase() !== "file"
      ) {
        throw fail("file-control-invalid");
      }
      mainFrame(
        await command(chromeApi, target, "Page.getFrameTree", {}),
        prepared.allowedOrigins,
        attachedFrame,
      );
      await command(chromeApi, target, "DOM.setFileInputFiles", {
        files: [prepared.filePath],
        nodeId,
      });
      const resolved = await command(chromeApi, target, "DOM.resolveNode", {
        nodeId,
      });
      if (!resolved?.object?.objectId) throw fail("file-control-invalid");
      const verified = await command(
        chromeApi,
        target,
        "Runtime.callFunctionOn",
        {
          objectId: resolved.object.objectId,
          functionDeclaration: `function () {
          return this instanceof HTMLInputElement &&
            this.type === "file" &&
            this.files &&
            this.files.length === 1;
        }`,
          returnByValue: true,
        },
      );
      if (verified?.result?.value !== true)
        throw fail("file-attachment-unverified");
      result = Object.freeze({ attached: true });
    } catch (error) {
      operationError =
        error instanceof Error ? error : fail("debugger-command-failed");
    } finally {
      if (attached) {
        try {
          await callbackCall(
            chromeApi,
            chromeApi.debugger,
            "detach",
            [target],
            "debugger-detach-failed",
          );
        } catch (error) {
          detachError = error;
        }
      }
    }
    if (operationError) throw operationError;
    if (detachError) throw detachError;
    return result;
  }

  globalThis.CreatorLocalFileAttacher = Object.freeze({ attach });
})();
