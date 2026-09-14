(() => {
  "use strict";

  if (globalThis.CreatorLocalFileAttacher) return;

  const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\)/;
  const operationOwners = new WeakMap();

  function fail(code) {
    return new Error(code);
  }

  function validate(request) {
    if (!Number.isSafeInteger(request?.tabId) || request.tabId <= 0)
      throw fail("invalid-tab");
    const selector = String(request.selector || "").trim();
    if (!selector || selector.length > 500 || selector.includes("\0"))
      throw fail("invalid-selector");
    if (
      request.pickerSelector &&
      (typeof request.pickerSelector !== "string" ||
        request.pickerSelector.length > 500 ||
        request.pickerSelector.includes("\0"))
    )
      throw fail("invalid-picker-selector");
    if (
      request.scope !== undefined &&
      (!Array.isArray(request.scope) ||
        request.scope.length > 8 ||
        request.scope.some(
          (step) =>
            !step ||
            !["shadow", "frame"].includes(step.kind) ||
            typeof step.selector !== "string" ||
            !step.selector.trim() ||
            step.selector.length > 500 ||
            step.selector.includes("\0"),
        ))
    )
      throw fail("invalid-file-scope");
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

  function callbackCall(
    chromeApi,
    owner,
    method,
    args,
    errorCode,
    lifecycle = {},
  ) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let completed = false;
      const timer = setTimeout(
        () => finish(reject, fail(`${errorCode}-timeout`)),
        30_000,
      );
      const finish = (action, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lifecycle.signal?.removeEventListener("abort", abort);
        action(value);
      };
      const abort = () => finish(reject, fail("attachment-cancelled"));
      const complete = (action, value) => {
        if (completed) return;
        completed = true;
        lifecycle.completed?.();
        if (settled) lifecycle.late?.(action === resolve);
        else finish(action, value);
      };
      const callback = (value) => {
        if (chromeApi.runtime?.lastError) {
          complete(reject, fail(errorCode));
          return;
        }
        complete(resolve, value);
      };
      try {
        if (lifecycle.signal?.aborted) {
          complete(reject, fail("attachment-cancelled"));
          return;
        }
        lifecycle.signal?.addEventListener("abort", abort, { once: true });
        const pending = owner[method](...args, callback);
        if (pending?.then) {
          pending.then(
            (value) => complete(resolve, value),
            () => complete(reject, fail(errorCode)),
          );
        }
      } catch {
        complete(reject, fail(errorCode));
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
    return { id: frame.id, loaderId: frame.loaderId, origin };
  }

  async function attach(request, chromeApi = globalThis.chrome) {
    const prepared = validate(request);
    if (!chromeApi?.tabs?.get || !chromeApi?.debugger)
      throw fail("chrome-api-unavailable");
    if (!chromeApi.extension?.isAllowedFileSchemeAccess)
      throw fail("file-access-preflight-unavailable");
    const allowed = await callbackCall(
      chromeApi,
      chromeApi.extension,
      "isAllowedFileSchemeAccess",
      [],
      "file-access-preflight-failed",
    );
    if (!allowed)
      throw fail(
        "file-access-required: Enable Allow access to file URLs in the extension details.",
      );
    if (request.signal?.aborted) throw fail("attachment-cancelled");

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
    let owners = operationOwners.get(chromeApi);
    if (!owners) {
      owners = new Map();
      operationOwners.set(chromeApi, owners);
    }
    if (owners.has(prepared.tabId)) throw fail("attachment-in-progress");
    const owner = {};
    owners.set(prepared.tabId, owner);
    let attachmentPending = true;
    let closing = false;
    let cleanupRunning = false;
    const releaseOwner = () => {
      if (owners.get(prepared.tabId) === owner) owners.delete(prepared.tabId);
      chromeApi.debugger.onDetach?.removeListener(onDetach);
    };
    let attached = false;
    let detached = false;
    const onDetach = (source) => {
      if (source.tabId !== prepared.tabId) return;
      attached = false;
      detached = true;
      if (closing && !cleanupRunning && !attachmentPending) releaseOwner();
    };
    const checkActive = () => {
      if (request.signal?.aborted) throw fail("attachment-cancelled");
      if (detached) throw fail("debugger-detached");
    };
    chromeApi.debugger.onDetach?.addListener(onDetach);
    let operationError = null;
    let detachError = null;
    let result = null;
    let resolvedInput = null;
    let intercepting = false;
    let cleanupChooser = () => {};
    const receiptKey = `__creatorSelection${Date.now()}${Math.random().toString(36).slice(2)}`;
    try {
      await callbackCall(
        chromeApi,
        chromeApi.debugger,
        "attach",
        [target, "1.3"],
        "debugger-attach-failed",
        {
          signal: request.signal,
          completed() {
            attachmentPending = false;
          },
          late(success) {
            if (!success) {
              releaseOwner();
              return;
            }
            if (owners.get(prepared.tabId) !== owner) return;
            // Retain the slot until the debugger actually acknowledges cleanup.
            void callbackCall(
              chromeApi,
              chromeApi.debugger,
              "detach",
              [target],
              "debugger-detach-failed",
              {
                late(success) {
                  if (success) releaseOwner();
                },
              },
            )
              .then(releaseOwner)
              .catch(() => {});
          },
        },
      );
      attached = true;
      checkActive();
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
      let rootNodeId = documentResult?.root?.nodeId;
      const frameBindings = [];
      for (const scope of request.scope || []) {
        const matches = await command(
          chromeApi,
          target,
          "DOM.querySelectorAll",
          {
            nodeId: rootNodeId,
            selector: scope.selector,
          },
        );
        if (matches?.nodeIds?.length !== 1)
          throw fail("file-scope-missing-or-ambiguous");
        const { node } = await command(chromeApi, target, "DOM.describeNode", {
          nodeId: matches.nodeIds[0],
          depth: 1,
          pierce: true,
        });
        if (scope.kind === "shadow") {
          const roots = (node.shadowRoots || []).filter(
            (root) => root.shadowRootType === "open",
          );
          if (roots.length !== 1) throw fail("open-shadow-root-unavailable");
          rootNodeId = roots[0].nodeId;
        } else {
          if (!node.contentDocument?.nodeId || !node.frameId)
            throw fail(
              "frame-scope-unsupported: This frame requires a separately supported debugger session.",
            );
          const tree = await command(
            chromeApi,
            target,
            "Page.getFrameTree",
            {},
          );
          const find = (branch) =>
            branch?.frame?.id === node.frameId
              ? branch.frame
              : (branch?.childFrames || []).map(find).find(Boolean);
          const frame = find(tree.frameTree);
          if (!frame || new URL(frame.url).origin !== attachedFrame.origin)
            throw fail("file-frame-origin-mismatch");
          frameBindings.push({ id: frame.id, loaderId: frame.loaderId });
          rootNodeId = node.contentDocument.nodeId;
        }
      }
      const queryResult = await command(
        chromeApi,
        target,
        "DOM.querySelectorAll",
        {
          nodeId: rootNodeId,
          selector: prepared.selector,
        },
      );
      /** @type {{nodeId?: number, backendNodeId?: number}} */
      let inputNode = { nodeId: queryResult?.nodeIds?.[0] };
      if (
        (queryResult?.nodeIds?.length === 0 ||
          request.activatePicker === true) &&
        request.pickerSelector
      ) {
        if (!chromeApi.debugger.onEvent)
          throw fail("file-chooser-events-unavailable");
        const pickers = await command(
          chromeApi,
          target,
          "DOM.querySelectorAll",
          {
            nodeId: rootNodeId,
            selector: request.pickerSelector,
          },
        );
        if (pickers?.nodeIds?.length !== 1)
          throw fail("media-activation-missing-or-ambiguous");
        const picker = await command(chromeApi, target, "DOM.resolveNode", {
          nodeId: pickers.nodeIds[0],
        });
        if (!picker?.object?.objectId) throw fail("media-activation-missing");
        await command(chromeApi, target, "Page.enable", {});
        let invoked = false;
        const chooser = new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(fail("file-chooser-timeout")),
            30_000,
          );
          const abort = () => reject(fail("attachment-cancelled"));
          const receive = (source, method, event) => {
            if (
              source.tabId !== prepared.tabId ||
              method !== "Page.fileChooserOpened" ||
              !invoked
            )
              return;
            if (
              event.frameId !==
                (frameBindings.at(-1)?.id || attachedFrame.id) ||
              !Number.isSafeInteger(event.backendNodeId)
            )
              reject(fail("file-chooser-frame-mismatch"));
            else resolve(event.backendNodeId);
          };
          chromeApi.debugger.onEvent.addListener(receive);
          request.signal?.addEventListener("abort", abort, { once: true });
          cleanupChooser = () => {
            clearTimeout(timer);
            chromeApi.debugger.onEvent.removeListener(receive);
            request.signal?.removeEventListener("abort", abort);
          };
        });
        // Handle a rejected event even if the activation command itself fails first.
        chooser.catch(() => {});
        await command(chromeApi, target, "Page.setInterceptFileChooserDialog", {
          enabled: true,
        });
        intercepting = true;
        checkActive();
        await request.validatePicker?.();
        checkActive();
        invoked = true;
        const activated = await command(
          chromeApi,
          target,
          "Runtime.callFunctionOn",
          {
            objectId: picker.object.objectId,
            functionDeclaration:
              "function() { if (!this.isConnected || !this.getClientRects().length || this.disabled || this.getAttribute('aria-disabled') === 'true') return false; this.click(); return true; }",
            returnByValue: true,
            userGesture: true,
          },
        );
        if (activated?.result?.value !== true)
          throw fail("media-activation-unavailable");
        inputNode = { backendNodeId: await chooser };
        cleanupChooser();
      } else if (
        !Array.isArray(queryResult?.nodeIds) ||
        queryResult.nodeIds.length !== 1
      ) {
        throw fail(
          queryResult?.nodeIds?.length
            ? "file-control-ambiguous"
            : "file-control-missing",
        );
      }
      checkActive();
      const description = await command(chromeApi, target, "DOM.describeNode", {
        ...inputNode,
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
      if (frameBindings.length) {
        const tree = await command(chromeApi, target, "Page.getFrameTree", {});
        const collect = (branch) => [
          branch.frame,
          ...(branch.childFrames || []).flatMap(collect),
        ];
        const frames = collect(tree.frameTree);
        if (
          frameBindings.some(
            (bound) =>
              !frames.some(
                (frame) =>
                  frame.id === bound.id &&
                  frame.loaderId === bound.loaderId &&
                  new URL(frame.url).origin === attachedFrame.origin,
              ),
          )
        )
          throw fail("file-frame-navigation");
      }
      checkActive();
      const resolved = await command(chromeApi, target, "DOM.resolveNode", {
        ...inputNode,
      });
      if (!resolved?.object?.objectId) throw fail("file-control-invalid");
      resolvedInput = resolved.object.objectId;
      const armed = await command(chromeApi, target, "Runtime.callFunctionOn", {
        objectId: resolvedInput,
        functionDeclaration: `function (key, expected, selector, requireConnected) {
          if ((requireConnected && !this.isConnected) || this.webkitdirectory || this.hasAttribute("directory") || !this.matches(selector)) return false;
          const input = this;
          const receipt = { matched: false };
          const listener = (event) => {
            if (event.target !== input) return;
            const file = input.files && input.files.length === 1 && input.files[0];
            receipt.matched ||= Boolean(file && (!expected || (file.name === expected.name && file.size === expected.size &&
              (typeof expected.lastModified !== "number" || file.lastModified === expected.lastModified))));
          };
          receipt.cleanup = () => { window.removeEventListener("change", listener, true); input.removeEventListener("change", listener, true); };
          this[key] = receipt;
          window.addEventListener("change", listener, true);
          input.addEventListener("change", listener, true);
          return true;
        }`,
        arguments: [
          { value: receiptKey },
          {
            value: request.expected
              ? {
                  name: request.expected.name,
                  size: request.expected.size,
                  lastModified: request.expected.lastModified,
                }
              : null,
          },
          { value: prepared.selector },
          { value: request.requireConnectedInput === true },
        ],
        returnByValue: true,
      });
      if (armed?.result?.value !== true)
        throw fail("file-chooser-control-mismatch");
      checkActive();
      await request.validateBinding?.();
      checkActive();
      mainFrame(
        await command(chromeApi, target, "Page.getFrameTree", {}),
        prepared.allowedOrigins,
        attachedFrame,
      );
      await command(chromeApi, target, "DOM.setFileInputFiles", {
        files: [prepared.filePath],
        ...inputNode,
      });
      const verified = await command(
        chromeApi,
        target,
        "Runtime.callFunctionOn",
        {
          objectId: resolved.object.objectId,
          functionDeclaration: `function (expected, key) {
          const receipt = this[key];
          receipt?.cleanup();
          delete this[key];
          return Boolean(receipt?.matched || (this instanceof HTMLInputElement &&
            this.type === "file" &&
            this.files &&
            this.files.length === 1 && (!expected ||
              (this.files[0].name === expected.name && this.files[0].size === expected.size &&
               (typeof expected.lastModified !== "number" || this.files[0].lastModified === expected.lastModified)))));
        }`,
          arguments: [
            {
              value: request.expected
                ? {
                    name: request.expected.name,
                    size: request.expected.size,
                    lastModified: request.expected.lastModified,
                  }
                : null,
            },
            { value: receiptKey },
          ],
          returnByValue: true,
        },
      );
      if (verified?.result?.value !== true)
        throw fail("file-attachment-unverified");
      checkActive();
      result = Object.freeze({ attached: true });
    } catch (error) {
      operationError =
        error instanceof Error ? error : fail("debugger-command-failed");
    } finally {
      closing = true;
      cleanupRunning = true;
      cleanupChooser();
      if (attached && owners.get(prepared.tabId) === owner) {
        if (intercepting) {
          try {
            await command(
              chromeApi,
              target,
              "Page.setInterceptFileChooserDialog",
              { enabled: false },
            );
          } catch {
            /* Detaching below releases interception if the document vanished. */
          }
        }
        if (attached && resolvedInput && owners.get(prepared.tabId) === owner) {
          try {
            await command(chromeApi, target, "Runtime.callFunctionOn", {
              objectId: resolvedInput,
              functionDeclaration:
                "function(key) { this[key]?.cleanup(); delete this[key]; }",
              arguments: [{ value: receiptKey }],
              returnByValue: true,
            });
          } catch {
            /* Detaching below also releases the debugger object. */
          }
        }
        try {
          if (attached && owners.get(prepared.tabId) === owner) {
            await callbackCall(
              chromeApi,
              chromeApi.debugger,
              "detach",
              [target],
              "debugger-detach-failed",
              {
                late(success) {
                  if (success) releaseOwner();
                },
              },
            );
            attached = false;
          }
        } catch (error) {
          detachError = error;
        }
      }
      cleanupRunning = false;
      if (!attachmentPending && !attached) releaseOwner();
    }
    if (operationError) throw operationError;
    if (detachError) throw detachError;
    return result;
  }

  globalThis.CreatorLocalFileAttacher = Object.freeze({ attach });
})();
