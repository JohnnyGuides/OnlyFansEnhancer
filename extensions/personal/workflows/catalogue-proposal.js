(() => {
  "use strict";

  if (globalThis.CreatorCatalogueProposal) return;

  const contract = globalThis.CreatorCatalogueContract;
  if (!contract) throw new Error("CreatorCatalogueContract is unavailable.");

  const LINK_FIELDS = Object.freeze({
    pornhub: "pornhubLink",
    onlyfans: "onlyfansLink",
    fansly: "fanslyLink",
    manyvids: "manyvidsLink",
  });
  const PLATFORM_ORDER = Object.freeze([
    "pornhub",
    "onlyfans",
    "fansly",
    "manyvids",
  ]);

  function clean(value) {
    return String(value == null ? "" : value).trim();
  }

  function platformLabel(platform) {
    return {
      pornhub: "Pornhub",
      onlyfans: "OnlyFans",
      fansly: "Fansly",
      manyvids: "ManyVids",
    }[platform];
  }

  function positiveEpisode(value) {
    const text = clean(value);
    return /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : null;
  }

  function hintedEpisode(draft) {
    const text = contract.normalizedText(
      `${clean(draft.filename)} ${clean(draft.title)}`,
    );
    const match = text.match(/\b(?:ep|episode)\s*0*(\d+)\b/);
    return match && Number(match[1]) > 0 ? Number(match[1]) : null;
  }

  function rowMetrics(draft, row) {
    const draftValues = [draft.filename, draft.title].filter(clean);
    const rowValues = [row.title, row.id].filter(clean);
    let similarity = 0;
    let exact = false;
    for (const draftValue of draftValues) {
      for (const rowValue of rowValues) {
        similarity = Math.max(
          similarity,
          contract.similarity(draftValue, rowValue),
        );
        exact ||=
          contract.normalizedText(draftValue) ===
          contract.normalizedText(rowValue);
      }
    }
    const descriptionSimilarity = contract.similarity(
      draft.description,
      row.description,
    );
    const episode = positiveEpisode(row.episode);
    const episodeMatch = episode !== null && hintedEpisode(draft) === episode;
    const arc = contract.normalizedText(row.seasonArc);
    const draftText = contract.normalizedText(
      `${clean(draft.filename)} ${clean(draft.title)}`,
    );
    const arcMatch = arc.length >= 3 && draftText.includes(arc);
    const score = Math.min(
      100,
      Math.round(
        similarity * 80 +
          descriptionSimilarity * 10 +
          (exact ? 10 : 0) +
          (episodeMatch ? 5 : 0) +
          (arcMatch ? 5 : 0),
      ),
    );
    const reasons = [];
    if (exact) reasons.push("Exact normalized title or ID");
    else if (similarity > 0) reasons.push("Filename/title words overlap");
    if (episodeMatch) reasons.push(`Episode ${episode}`);
    if (arcMatch) reasons.push(`Series ${clean(row.seasonArc)}`);
    return { score, similarity, reasons };
  }

  function rankRows(draft, rows) {
    return (Array.isArray(rows) ? rows : [])
      .filter((row) => clean(row.title) || clean(row.id))
      .map((row) => ({ ...row, ...rowMetrics(draft || {}, row) }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.similarity - left.similarity ||
          Number(right.row) - Number(left.row),
      );
  }

  function inferTargets(row, executablePlatforms = []) {
    const recommended = PLATFORM_ORDER.filter(
      (platform) =>
        !clean(row?.[LINK_FIELDS[platform]]) &&
        row?.publicationState?.[platform] !== "review",
    );
    const pending = new Set(recommended);
    return {
      executable: [...new Set(executablePlatforms)].filter(
        (platform) =>
          Object.hasOwn(LINK_FIELDS, platform) && pending.has(platform),
      ),
      recommended,
      alreadyLinked: PLATFORM_ORDER.filter(
        (platform) => !pending.has(platform),
      ),
    };
  }

  function findPredecessor(row, rows) {
    const arc = contract.normalizedText(row?.seasonArc);
    const episode = positiveEpisode(row?.episode);
    if (!arc || episode === null) return null;
    return (
      (Array.isArray(rows) ? rows : [])
        .filter(
          (candidate) =>
            contract.normalizedText(candidate.seasonArc) === arc &&
            positiveEpisode(candidate.episode) !== null &&
            positiveEpisode(candidate.episode) < episode,
        )
        .sort(
          (left, right) =>
            positiveEpisode(right.episode) - positiveEpisode(left.episode) ||
            Number(right.row) - Number(left.row),
        )[0] || null
    );
  }

  function fridayDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(value))) return null;
    const result = new Date(`${value}T15:00:00.000Z`);
    return !Number.isNaN(result.getTime()) && result.getUTCDay() === 5
      ? result
      : null;
  }

  function nextFriday(now) {
    const current = new Date(now);
    const result = new Date(current);
    result.setUTCHours(15, 0, 0, 0);
    result.setUTCDate(result.getUTCDate() + ((5 - result.getUTCDay() + 7) % 7));
    if (result <= current) result.setUTCDate(result.getUTCDate() + 7);
    return result;
  }

  function dateValue(date) {
    return date.toISOString().slice(0, 10);
  }

  function proposeSchedule({
    now = new Date(),
    row,
    predecessor,
    platform,
    queueEvidence,
  }) {
    const label = platformLabel(platform);
    let candidate = nextFriday(now);
    const evidence = [];
    const catalogueDate = fridayDate(row?.releaseDate);
    if (catalogueDate && catalogueDate > candidate) {
      candidate = catalogueDate;
      evidence.push(
        `Catalogue date sets the earliest slot: ${dateValue(candidate)}`,
      );
    }
    if (queueEvidence?.verified !== true) {
      return {
        verified: false,
        releaseDate: dateValue(candidate),
        scheduledIso: candidate.toISOString(),
        evidence: [`${label} queue is not verified`],
      };
    }

    const predecessorSchedule = predecessor
      ? (queueEvidence.scheduled || []).find(
          (item) => Number(item.catalogueRow) === Number(predecessor.row),
        )
      : null;
    const predecessorDate = fridayDate(predecessorSchedule?.releaseDate);
    if (predecessorDate) {
      predecessorDate.setUTCDate(predecessorDate.getUTCDate() + 7);
      if (predecessorDate > candidate) candidate = predecessorDate;
      evidence.push(
        `Previous episode sets the earliest slot: ${dateValue(candidate)}`,
      );
    }

    const occupied = new Set(queueEvidence.occupiedFridays || []);
    while (occupied.has(dateValue(candidate))) {
      evidence.push(
        `${label} already has an upload on ${dateValue(candidate)}`,
      );
      candidate.setUTCDate(candidate.getUTCDate() + 7);
    }
    return {
      verified: true,
      releaseDate: dateValue(candidate),
      scheduledIso: candidate.toISOString(),
      evidence,
    };
  }

  function synchronizeExecutableSchedules(
    schedules,
    executablePlatforms,
    queueByPlatform,
  ) {
    if (
      executablePlatforms.length < 2 ||
      executablePlatforms.some((platform) => !schedules[platform]?.verified)
    ) {
      return;
    }
    let common = executablePlatforms
      .map((platform) => new Date(schedules[platform].scheduledIso))
      .sort((left, right) => right.getTime() - left.getTime())[0];
    const occupied = new Set(
      executablePlatforms.flatMap(
        (platform) => queueByPlatform[platform]?.occupiedFridays || [],
      ),
    );
    while (occupied.has(dateValue(common))) {
      common.setUTCDate(common.getUTCDate() + 7);
    }
    const releaseDate = dateValue(common);
    for (const platform of executablePlatforms) {
      const schedule = schedules[platform];
      schedules[platform] = {
        ...schedule,
        releaseDate,
        scheduledIso: common.toISOString(),
        evidence:
          schedule.releaseDate === releaseDate
            ? schedule.evidence
            : [
                ...schedule.evidence,
                `Selected platforms share the first verified free Friday: ${releaseDate}`,
              ],
      };
    }
  }

  function buildNewCandidate(draft, snapshot) {
    const empty = snapshot?.emptyRow;
    if (!empty || !Number.isInteger(Number(empty.row))) {
      throw new Error("No empty catalogue row is available.");
    }
    const used = new Set((snapshot.rows || []).map((row) => clean(row.id)));
    const base = contract.slugify(draft?.title);
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    return {
      row: Number(empty.row),
      id,
      releaseDate: clean(draft?.releaseDate),
      title: clean(draft?.title),
      description: clean(draft?.description),
      seasonArc: "",
      episode: "",
      pornhubLink: "",
      onlyfansLink: "",
      fanslyLink: "",
      manyvidsLink: "",
      fingerprint: clean(empty.fingerprint),
    };
  }

  function emptyResult(status, alternatives) {
    return {
      status,
      candidate: null,
      alternatives,
      reasons: [],
      predecessor: null,
      targets: { executable: [], recommended: [], alreadyLinked: [] },
      schedules: {},
    };
  }

  function build({
    draft = {},
    snapshot = null,
    selectedRow = null,
    now = new Date(),
    executablePlatforms = [],
    queueByPlatform = {},
  } = {}) {
    if (snapshot?.status !== "snapshot") {
      throw new Error("Catalogue snapshot is unavailable.");
    }
    const ranked = rankRows(draft, snapshot.rows);
    let candidate;
    if (selectedRow === "new") {
      candidate = buildNewCandidate(draft, snapshot);
    } else if (
      selectedRow !== null &&
      selectedRow !== "" &&
      Number.isInteger(Number(selectedRow))
    ) {
      candidate = snapshot.rows.find(
        (row) => Number(row.row) === Number(selectedRow),
      );
    } else {
      const first = ranked[0];
      const lead = first ? first.similarity - (ranked[1]?.similarity || 0) : 0;
      if (
        !first ||
        first.score < 75 ||
        first.similarity < 0.75 ||
        lead < 0.15
      ) {
        return emptyResult("needs-selection", ranked);
      }
      candidate = snapshot.rows.find(
        (row) => Number(row.row) === Number(first.row),
      );
    }
    if (!candidate) return emptyResult("needs-selection", ranked);

    const targets = inferTargets(candidate, executablePlatforms);
    const predecessor = findPredecessor(candidate, snapshot.rows);
    const schedules = Object.fromEntries(
      targets.recommended.map((platform) => [
        platform,
        proposeSchedule({
          now,
          row: candidate,
          predecessor,
          platform,
          queueEvidence: queueByPlatform[platform],
        }),
      ]),
    );
    synchronizeExecutableSchedules(
      schedules,
      targets.executable,
      queueByPlatform,
    );
    const rankedCandidate = ranked.find(
      (item) => Number(item.row) === Number(candidate.row),
    );
    const result = {
      status: "ready",
      candidate,
      alternatives: ranked,
      reasons: rankedCandidate?.reasons || ["Explicit catalogue selection"],
      predecessor,
      targets,
      schedules,
    };
    if (!targets.recommended.length) result.status = "nothing-pending";
    else if (!targets.executable.length) result.status = "not-executable";
    else if (
      targets.executable.some((platform) => !schedules[platform]?.verified)
    ) {
      result.status = "needs-queue-evidence";
    }
    return result;
  }

  globalThis.CreatorCatalogueProposal = Object.freeze({
    build,
    buildNewCandidate,
    findPredecessor,
    inferTargets,
    proposeSchedule,
    rankRows,
  });
})();
