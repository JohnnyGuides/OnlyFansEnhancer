(function (global) {
  "use strict";
  function mount({
    dialog,
    heading,
    date,
    request,
    getContext,
    getFrame,
    busy,
    loadFile,
    status,
  }) {
    const bar = document.createElement("div");
    bar.className = "xt-render-handoff";
    bar.hidden = true;
    const project = document.createElement("select");
    project.setAttribute("aria-label", "Vegas project");
    const button = (text, run) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "xt-action";
      item.textContent = text;
      item.addEventListener(
        "click",
        () =>
          void run().catch((error) => {
            status.textContent = error.message;
          }),
      );
      return item;
    };
    const edit = button("Edit in Vegas", () =>
      prepare(project.value ? "openTeaserProject" : "createTeaserProject"),
    );
    const browse = button("Choose project…", () =>
      prepare("chooseTeaserProject"),
    );
    const name = document.createElement("span");
    name.className = "xt-render-name";
    const copyName = button("Copy name", async () => {
      await navigator.clipboard.writeText(meta.renderName);
    });
    const folder = button("Copy folder", async () => {
      await navigator.clipboard.writeText(meta.renderFolder);
    });
    const state = document.createElement("span");
    state.className = "xt-render-state";
    state.setAttribute("role", "status");
    const review = button("Use updated render", async () => {
      allowUpdate = true;
      await poll();
    });
    review.hidden = true;
    bar.append(project, edit, browse, name, copyName, folder, state, review);
    heading.after(bar);
    let meta = {},
      key = "",
      generation = 0,
      timer,
      active = false,
      delivered = "",
      awaiting = 0,
      allowUpdate = false,
      pending = false,
      locked = false;
    const isBusy = () => busy() || locked;
    const send = (type, extra = {}) =>
      getFrame()?.contentWindow.postMessage(
        { type: `ofenhancer:teaser-${type}`, date, episodeKey: key, ...extra },
        location.origin,
      );
    function render() {
      project.replaceChildren();
      const projects = [...(meta.projects || [])];
      if (
        meta.projectName &&
        !projects.some((item) => item.name === meta.projectName)
      )
        projects.unshift({ name: meta.projectName });
      const placeholder = new Option("New from template", "");
      project.add(placeholder);
      for (const item of projects)
        project.add(new Option(item.name, item.name));
      project.value =
        meta.projectName ||
        (projects.length === 1 && projects[0].suggested
          ? projects[0].name
          : "");
      edit.textContent = project.value
        ? "Edit in Vegas"
        : "Create from template";
      edit.disabled = isBusy() || (!project.value && !meta.templateAvailable);
      project.disabled = browse.disabled = isBusy();
      name.textContent = meta.renderName || "";
      name.title = meta.renderPath || "";
      copyName.hidden = folder.hidden = !meta.renderName;
    }
    project.addEventListener("change", () => {
      edit.textContent = project.value
        ? "Edit in Vegas"
        : "Create from template";
      edit.disabled = isBusy() || (!project.value && !meta.templateAvailable);
    });
    async function prepare(op) {
      if (!key || isBusy() || pending) return;
      const epoch = generation;
      pending = true;
      edit.disabled = browse.disabled = true;
      try {
        const result = await request(op, {
          episodeKey: key,
          date,
          ...(project.value &&
          project.value !== meta.projectName &&
          op === "openTeaserProject"
            ? { projectName: project.value }
            : {}),
        });
        if (epoch !== generation || result.cancelled) return;
        meta = result;
        allowUpdate = true;
        render();
        state.textContent = "Waiting for render";
        send("render-waiting");
        schedule();
      } finally {
        pending = false;
        browse.disabled = false;
        render();
      }
    }
    function schedule() {
      clearTimeout(timer);
      if (active && meta.renderName)
        timer = setTimeout(() => void poll(), 2000);
    }
    async function poll() {
      if (!active || !dialog.isConnected || pending || Date.now() < awaiting) {
        schedule();
        return;
      }
      const epoch = generation,
        frame = getFrame();
      pending = true;
      try {
        const result = await request("checkTeaserRender", {
          episodeKey: key,
          date,
        });
        if (epoch !== generation || frame !== getFrame()) return;
        if (result.status !== "ready") {
          state.textContent =
            result.status === "rendering" ? "Rendering…" : "Waiting for render";
          return;
        }
        if (result.clip.sha256 === delivered) {
          state.textContent = "Render up to date";
          return;
        }
        if (isBusy() || !allowUpdate) {
          state.textContent = "New render available";
          review.hidden = false;
          review.disabled = isBusy();
          return;
        }
        const file = await loadFile(
          result.clip,
          () => epoch === generation && frame === getFrame() && !isBusy(),
        );
        if (epoch !== generation || frame !== getFrame() || isBusy()) return;
        awaiting = Date.now() + 15000;
        state.textContent = "Checking preview…";
        review.hidden = true;
        send("render-file", {
          file,
          clipId: result.clip.clipId,
          renderHash: result.clip.sha256,
        });
      } catch (error) {
        if (epoch === generation) state.textContent = error.message;
      } finally {
        if (epoch === generation) {
          pending = false;
          schedule();
        }
      }
    }
    return {
      async setEpisode(episodeKey, enabled = true) {
        ++generation;
        clearTimeout(timer);
        key = episodeKey;
        active = enabled && Boolean(key);
        bar.hidden = !active;
        meta = {};
        awaiting = 0;
        locked = Boolean(getContext()?.draft?.sessionId);
        pending = false;
        review.hidden = true;
        if (!active) return;
        const epoch = generation;
        delivered = getContext()?.draft?.renderHash || "";
        allowUpdate = getContext()?.draft?.renderPending === true && !isBusy();
        state.textContent = "";
        render();
        try {
          const result = await request("getTeaserEdit", {
            episodeKey: key,
            date,
          });
          if (epoch !== generation) return;
          meta = result;
          render();
          schedule();
        } catch (error) {
          if (epoch === generation) state.textContent = error.message;
        }
      },
      receive(data) {
        if (data.type === "ofenhancer:teaser-render-lock") {
          locked = data.locked === true;
          render();
        }
        if (data.type === "ofenhancer:teaser-render-manual") {
          allowUpdate = false;
          delivered = "";
        }
        if (data.type === "ofenhancer:teaser-render-attached") {
          awaiting = 0;
          if (getContext()?.draft)
            getContext().draft.renderHash = data.renderHash;
          delivered = data.renderHash;
          state.textContent = "Render updated";
        }
        if (data.type === "ofenhancer:teaser-render-review") {
          awaiting = 0;
          delivered = "";
          allowUpdate = false;
          state.textContent = "Review updated render";
          review.hidden = false;
        }
      },
      refresh() {
        render();
      },
      close() {
        active = false;
        ++generation;
        clearTimeout(timer);
        bar.hidden = true;
      },
    };
  }
  global.OFEnhancerTeaserRenderHandoff = Object.freeze({ mount });
})(globalThis);
