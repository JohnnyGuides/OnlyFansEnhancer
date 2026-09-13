(() => {
  "use strict";
  const MESSAGE_TYPES = new Set([
    "GET_CREATOR_SETTINGS",
    "SYNC_CREATOR_TOOLS",
    "OFENHANCER_APP_REQUEST",
    "PROBE_CREATOR_UPLOAD_TARGETS",
    "PREPARE_CREATOR_UPLOAD",
    "START_CREATOR_UPLOAD",
    "RETRY_CREATOR_UPLOAD_PLATFORM",
    "PREPARE_CREATOR_SOCIAL_DISTRIBUTION",
    "START_CREATOR_SOCIAL_DISTRIBUTION",
    "RESUME_CREATOR_SOCIAL_DISTRIBUTION",
    "ASSOCIATE_CREATOR_SOCIAL_CATALOGUE",
    "ASSOCIATE_CREATOR_UPLOAD_CATALOGUE",
    "PREPARE_CREATOR_REDDIT_LINKS",
  ]);
  const SETTINGS = new Set([
    "creatorToolkitV1",
    "creatorToolkitV2",
    "creatorToolkitActionLogV1",
    "creatorSocialSubredditSelectionV1",
    "creatorUploadSheetBridgeV1",
  ]);
  const storageKey = (key) => SETTINGS.has(key);
  const UUID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  function create({ chrome, handleMessage, bindPort, unbindPort, attachFile }) {
    const ports = new Map();
    const events = [];
    const replies = [];
    let nativePort = null;
    let stopped = false;
    let timer;
    let browserId;
    let watchdog;
    let generation = 0;
    let connecting = false;
    let started = false;
    function queue(list, item) {
      // Three bytes per UTF-16 code unit is a conservative UTF-8 upper bound.
      if (
        list.length >= 256 ||
        (JSON.stringify(events).length +
          JSON.stringify(replies).length +
          JSON.stringify(item).length) *
          3 >
          512 * 1024
      ) {
        nativePort?.disconnect();
        throw new Error(
          "The desktop upload connection could not keep up. Reconnect before continuing.",
        );
      }
      list.push(item);
    }
    function emit(item) {
      queue(events, item);
    }
    function portFor(portId) {
      if (!UUID.test(portId || "")) throw new Error("invalid-upload-port");
      if (!ports.has(portId)) {
        if (ports.size >= 16) throw new Error("too-many-upload-windows");
        const port = {
          name: "creator-upload-console",
          desktop: true,
          postMessage(message) {
            if (ports.get(portId) !== port)
              throw new Error("The upload port disconnected.");
            emit({ portId, message });
          },
          disconnect() {
            if (!ports.delete(portId)) return;
            unbindPort(port);
            emit({
              portId,
              disconnected: true,
              error: "The browser upload connection was interrupted.",
            });
          },
        };
        ports.set(portId, port);
      }
      return ports.get(portId);
    }
    async function execute(command) {
      if (
        !command ||
        Array.isArray(command) ||
        JSON.stringify(command).length > 200_000
      )
        throw new Error("invalid-upload-command");
      if (command.kind === "message") {
        if (!MESSAGE_TYPES.has(command.message?.type))
          throw new Error("unsupported-upload-message");
        return new Promise((resolve, reject) => {
          try {
            const handled = handleMessage(
              command.message,
              { id: chrome.runtime.id },
              resolve,
            );
            if (handled === false)
              reject(
                new Error("The browser did not handle the upload request."),
              );
            else if (handled?.then) handled.then(resolve, reject);
          } catch (error) {
            reject(error);
          }
        });
      }
      if (command.kind === "storageGet") {
        const keys =
          typeof command.keys === "string" ? [command.keys] : command.keys;
        if (
          !Array.isArray(keys) ||
          !keys.length ||
          keys.length > 20 ||
          keys.some((key) => !storageKey(key))
        )
          throw new Error("unsupported-upload-settings");
        return chrome.storage.local.get(keys);
      }
      if (command.kind === "storageSet") {
        if (
          !command.values ||
          Array.isArray(command.values) ||
          Object.keys(command.values).some((key) => !storageKey(key)) ||
          JSON.stringify(command.values).length > 100_000
        )
          throw new Error("unsupported-upload-settings");
        await chrome.storage.local.set(command.values);
        return {};
      }
      if (command.kind === "permissions")
        return {
          granted: await chrome.permissions.contains(command.permissions),
        };
      if (command.kind === "port") {
        if (
          !["bind-session", "bind-social-session", "file-response"].includes(
            command.message?.type,
          )
        )
          throw new Error("unsupported-upload-port-message");
        if (
          command.message.type === "file-response" &&
          !ports.has(command.portId)
        )
          throw new Error("The upload port disconnected.");
        await bindPort(portFor(command.portId), command.message);
        return {};
      }
      if (command.kind === "disconnect") {
        ports.get(command.portId)?.disconnect();
        return {};
      }
      if (command.kind === "file") return attachFile(command, ports);
      throw new Error("unsupported-upload-command");
    }
    async function connect() {
      if (stopped || connecting || nativePort) return;
      connecting = true;
      try {
        const stored = await chrome.storage.session.get("ofenhancerBrowserId");
        browserId = UUID.test(stored.ofenhancerBrowserId || "")
          ? stored.ofenhancerBrowserId
          : crypto.randomUUID();
        await chrome.storage.session.set({ ofenhancerBrowserId: browserId });
        if (stopped) return;
        const connectionId = crypto.randomUUID();
        const thisGeneration = ++generation;
        const port = chrome.runtime.connectNative(
          "com.johnnyguides.ofenhancer",
        );
        nativePort = port;
        const commands = new Map();
        let inFlight;
        let setupGeneration = null;
        function lost() {
          void chrome.runtime.lastError;
          if (nativePort !== port) return;
          nativePort = null;
          generation++;
          clearTimeout(timer);
          clearTimeout(watchdog);
          // Prior attachment requests may already have been acted on. Never replay them.
          events.length = 0;
          replies.length = 0;
          emit({
            uploadConnectionLost:
              "The browser upload connection was interrupted. Review progress before continuing.",
          });
          for (const current of [...ports.values()]) current.disconnect();
          if (!stopped) timer = setTimeout(connect, 5000);
        }
        function exchange() {
          if (nativePort !== port || stopped) return;
          inFlight = crypto.randomUUID();
          try {
            port.postMessage({
              protocolVersion: 1,
              requestId: inFlight,
              operation: "browserExchange",
              payload: {
                browserId,
                connectionId,
                extensionId: chrome.runtime.id,
                setupGeneration,
                replies: replies.splice(0, 64),
                events: events.splice(0, 64),
              },
            });
            watchdog = setTimeout(() => {
              lost();
              port.disconnect();
            }, 10000);
          } catch {
            lost();
            port.disconnect();
          }
        }
        port.onMessage.addListener((response) => {
          if (nativePort !== port || thisGeneration !== generation) return;
          if (
            !inFlight ||
            response?.requestId !== inFlight ||
            response.ok !== true ||
            !Array.isArray(response.result?.commands) ||
            response.result.commands.length > 64 ||
            response.result.connectionId !== connectionId
          ) {
            lost();
            port.disconnect();
            return;
          }
          inFlight = null;
          setupGeneration = response.result.setupGeneration || null;
          clearTimeout(watchdog);
          for (const item of response.result.commands) {
            if (!UUID.test(item.id || "")) {
              lost();
              port.disconnect();
              return;
            }
            if (commands.has(item.id)) {
              if (commands.get(item.id)) queue(replies, commands.get(item.id));
              continue;
            }
            if (commands.size >= 4096) {
              lost();
              port.disconnect();
              return;
            }
            commands.set(item.id, null);
            void execute(item.command)
              .then(
                (result) => ({ id: item.id, result: result ?? {} }),
                (error) => ({
                  id: item.id,
                  error: String(error.message || error).slice(0, 500),
                }),
              )
              .then((reply) => {
                if (nativePort !== port || thisGeneration !== generation)
                  return;
                commands.set(item.id, reply);
                queue(replies, reply);
              })
              .catch(() => {
                lost();
                port.disconnect();
              });
          }
          timer = setTimeout(exchange, 500);
        });
        port.onDisconnect.addListener(lost);
        exchange();
      } catch {
        if (!stopped) timer = setTimeout(connect, 5000);
      } finally {
        connecting = false;
      }
    }
    const storageListener = (changes, area) => {
      if (area !== "local" || stopped) return;
      const filtered = Object.fromEntries(
        Object.entries(changes).filter(([key]) => SETTINGS.has(key)),
      );
      if (Object.keys(filtered).length) emit({ storageChanges: filtered });
    };
    return {
      execute,
      start() {
        if (started) return;
        started = true;
        chrome.storage.onChanged?.addListener(storageListener);
        return connect();
      },
      stop() {
        stopped = true;
        clearTimeout(timer);
        clearTimeout(watchdog);
        chrome.storage.onChanged?.removeListener(storageListener);
        for (const port of [...ports.values()]) port.disconnect();
        nativePort?.disconnect();
      },
    };
  }
  globalThis.CreatorDesktopUploadRuntime = Object.freeze({ create });
})();
