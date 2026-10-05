(() => {
  "use strict";

  if (globalThis.CreatorSocialDistributionOrchestrator) return;

  const COMPLETE = "sheet-complete";
  const TERMINAL = new Set(["failed", "blocked"]);

  function canonicalPaidResult(platform, value) {
    try {
      const url = new URL(String(value || "").trim());
      if (url.username || url.password || url.port || url.search || url.hash) {
        return "";
      }
      if (platform === "onlyfans") {
        const match = url.pathname.match(/^\/(\d+)(?:\/johnny_guides)?\/?$/);
        return url.origin === "https://onlyfans.com" && match
          ? `https://onlyfans.com/${match[1]}/johnny_guides`
          : "";
      }
      if (platform === "fansly") {
        const match = url.pathname.match(/^\/post\/(\d+)\/?$/);
        return url.origin === "https://fansly.com" && match
          ? `https://fansly.com/post/${match[1]}`
          : "";
      }
      const match = url.pathname.match(/^\/Video\/(\d+)\/?$/i);
      return platform === "manyvids" &&
        url.origin === "https://www.manyvids.com" &&
        match
        ? `https://www.manyvids.com/Video/${match[1]}`
        : "";
    } catch {
      return "";
    }
  }

  function cleanError(error) {
    return String(error?.message || error || "Distribution step failed.")
      .trim()
      .slice(0, 500);
  }

  function platformFor(jobId) {
    if (jobId === "x" || jobId === "redgifs") return jobId;
    if (jobId.startsWith("reddit:")) return "reddit";
    throw new Error("Unknown social distribution job.");
  }

  function targetFor(plan, jobId) {
    if (!jobId.startsWith("reddit:")) return null;
    return (
      plan.targets.reddit.find(
        (target) => target.subreddit.toLowerCase() === jobId.slice(7),
      ) || null
    );
  }

  function assertSheetResult(result, label) {
    if (
      !new Set(["updated", "idempotent", "recorded-local"]).has(result?.status)
    ) {
      throw new Error(`${label} returned ${result?.status || "no status"}.`);
    }
    return result;
  }

  function create({
    store,
    catalogueClient,
    adapterFor,
    resolvePaidLink = null,
    now = Date.now,
  }) {
    if (!store || !catalogueClient || typeof adapterFor !== "function") {
      throw new Error("Social distribution dependencies are unavailable.");
    }
    const executions = new Map();

    function serialize(sessionId, run) {
      const prior = executions.get(sessionId) || Promise.resolve();
      const current = prior.catch(() => {}).then(run);
      executions.set(sessionId, current);
      return current.finally(() => {
        if (executions.get(sessionId) === current) executions.delete(sessionId);
      });
    }

    async function paidDependencyUrl(plan) {
      const dependency = plan.paidLinkDependency;
      if (!dependency) return plan.paidUrl || "";
      if (typeof resolvePaidLink !== "function") return "";
      const result = await resolvePaidLink(dependency);
      if (!result) return "";
      if (
        result.platform !== dependency.platform ||
        result.uploadSessionId !== dependency.uploadSessionId
      ) {
        throw new Error("The paid upload result does not match this plan.");
      }
      const url = canonicalPaidResult(dependency.platform, result.postUrl);
      if (!url) throw new Error("The paid upload result URL is invalid.");
      return url;
    }

    async function capture(session, jobId, dependencyUrl) {
      const adapter = adapterFor(jobId);
      const result = await adapter.captureResult({
        dependencyUrl,
        paidUrl: dependencyUrl,
        jobId,
        mode: session.plan.mode,
        plan: session.plan,
        target: targetFor(session.plan, jobId),
        allowReplySubmit:
          jobId !== "x" || session.jobs[jobId].replySubmitAttempted !== true,
        async beforeReplyCommit(main) {
          if (jobId !== "x") {
            throw new Error("Only X can arm a first reply.");
          }
          const next = await store.checkpoint(session.id, jobId, {
            stage: "submit-attempted",
            resultId: main.resultId,
            resultUrl: main.resultUrl,
            replySubmitAttempted: true,
            updatedAt: now(),
          });
          return {
            armed: next.jobs[jobId].replySubmitAttempted === true,
          };
        },
      });
      if (!result) return null;
      if (result.status === "reply-prepared") {
        return store.checkpoint(session.id, jobId, {
          resultId: result.resultId,
          resultUrl: result.resultUrl,
          updatedAt: now(),
          error: "",
        });
      }
      return store.checkpoint(session.id, jobId, {
        stage: "result-captured",
        capturedAt: now(),
        resultId: result.resultId,
        resultUrl: result.resultUrl,
        ...(jobId === "x"
          ? {
              replyResultId: result.replyResultId,
              replyResultUrl: result.replyResultUrl,
            }
          : {}),
        updatedAt: now(),
        error: "",
      });
    }

    function frozenEvents(session, jobId, job, catalogue) {
      const event = (eventJobId, resultId, resultUrl, extra = {}) => ({
        eventId: "published",
        runId: session.id,
        jobId: eventJobId,
        platform: platformFor(jobId),
        catalogueRow: catalogue.row,
        catalogueId: catalogue.id,
        resultId,
        resultUrl,
        ...extra,
        status: "published",
        recordedAt: job.capturedAt,
      });
      return {
        main: event(jobId, job.resultId, job.resultUrl),
        ...(jobId === "x" && job.replyResultId && job.replyResultUrl
          ? {
              reply: event("x:reply", job.replyResultId, job.replyResultUrl, {
                parentResultId: job.resultId,
              }),
            }
          : {}),
      };
    }

    async function appendResult(session, jobId, currentFingerprint) {
      const catalogue = session.catalogueAssociation || session.plan.catalogue;
      if (!catalogue) return { session, fingerprint: currentFingerprint };
      let job = session.jobs[jobId];
      if (!job.ledgerEvents) {
        if (!job.capturedAt) {
          throw new Error(
            "This captured result has no recorded capture time. Review it before recording.",
          );
        }
        session = await store.checkpoint(session.id, jobId, {
          ledgerEvents: frozenEvents(session, jobId, job, catalogue),
        });
        job = session.jobs[jobId];
      }

      async function record(part, run) {
        if (job.appended?.[part]) return;
        const response = assertSheetResult(await run(), `${part} append`);
        const remote =
          response.googleSynced !== false &&
          response.status !== "recorded-local";
        session = await store.checkpoint(session.id, jobId, {
          appended: { [part]: remote ? "remote" : "local" },
        });
        job = session.jobs[jobId];
        return response;
      }

      await record("main", () =>
        catalogueClient.appendDistributionLedger(job.ledgerEvents.main),
      );
      if (job.ledgerEvents.reply) {
        await record("reply", () =>
          catalogueClient.appendDistributionLedger(job.ledgerEvents.reply),
        );
      }

      let fingerprint = currentFingerprint;
      const compactAction =
        jobId === "x"
          ? () =>
              catalogueClient.appendTwitterTeaser({
                row: catalogue.row,
                id: catalogue.id,
                fingerprint: currentFingerprint,
                statusUrl: job.resultUrl,
              })
          : jobId.startsWith("reddit:")
            ? () =>
                catalogueClient.appendRedditPost({
                  row: catalogue.row,
                  id: catalogue.id,
                  fingerprint: currentFingerprint,
                  redditUrl: job.resultUrl,
                })
            : null;
      if (compactAction) {
        const compact = await record("compact", compactAction);
        fingerprint = compact?.fingerprint || currentFingerprint;
      }
      const required = ["main", ...(job.ledgerEvents.reply ? ["reply"] : [])];
      if (compactAction) required.push("compact");
      const next = await store.checkpoint(session.id, jobId, {
        stage: COMPLETE,
        googleSynced: required.every(
          (part) => job.appended?.[part] === "remote",
        ),
        error: "",
        updatedAt: now(),
      });
      return { fingerprint, session: next };
    }

    async function recoverFingerprint(session) {
      const catalogue = session.catalogueAssociation || session.plan.catalogue;
      if (!catalogue) return "";
      let fingerprint = catalogue.fingerprint;
      for (const [jobId, job] of Object.entries(session.jobs)) {
        if (job.stage !== COMPLETE) continue;
        let result;
        if (jobId === "x") {
          result = await catalogueClient.appendTwitterTeaser({
            row: catalogue.row,
            id: catalogue.id,
            fingerprint,
            statusUrl: job.resultUrl,
          });
        } else if (jobId.startsWith("reddit:")) {
          result = await catalogueClient.appendRedditPost({
            row: catalogue.row,
            id: catalogue.id,
            fingerprint,
            redditUrl: job.resultUrl,
          });
        }
        if (result) {
          assertSheetResult(result, "Catalogue checkpoint recovery");
          fingerprint = result.fingerprint || fingerprint;
        }
      }
      return fingerprint;
    }

    async function fail(session, jobId, error, uncertain = false) {
      return store.checkpoint(session.id, jobId, {
        stage: uncertain ? "posted-link-unresolved" : "failed",
        error: cleanError(error),
        updatedAt: now(),
      });
    }

    async function runJob(
      sessionId,
      jobId,
      dependencyUrl,
      fingerprint,
      prepareOnly = false,
    ) {
      let session = await store.load(sessionId);
      let job = session.jobs[jobId];
      if (!job || job.stage === COMPLETE || TERMINAL.has(job.stage)) {
        return { fingerprint, session };
      }

      if (
        job.stage === "submit-attempted" ||
        job.stage === "posted-link-unresolved"
      ) {
        try {
          session = (await capture(session, jobId, dependencyUrl)) || session;
        } catch (error) {
          if (job.stage === "submit-attempted") {
            session = await fail(session, jobId, error, true);
          }
          return { fingerprint, session };
        }
        job = session.jobs[jobId];
        if (job.stage !== "result-captured") {
          if (
            jobId === "x" &&
            job.replyDueAt &&
            job.resultUrl &&
            !job.replySubmitAttempted
          )
            return { fingerprint, session };
          if (job.stage === "submit-attempted") {
            session = await fail(
              session,
              jobId,
              "The public result could not be resolved.",
              true,
            );
          }
          return { fingerprint, session };
        }
      }

      if (job.stage === "planned") {
        try {
          const adapter = adapterFor(jobId);
          const preparedResult = await adapter.prepare({
            dependencyUrl,
            jobId,
            mode: session.plan.mode,
            plan: session.plan,
            target: targetFor(session.plan, jobId),
          });
          session = await store.checkpoint(sessionId, jobId, {
            stage: "prepared",
            ...(jobId === "x" &&
            preparedResult?.preparedCaptionSha256 !== undefined
              ? {
                  preparedComposerSha256: preparedResult.preparedCaptionSha256,
                }
              : {}),
            error: "",
            updatedAt: now(),
          });
        } catch (error) {
          return {
            fingerprint,
            session: await fail(session, jobId, error, false),
          };
        }
        job = session.jobs[jobId];
        if (prepareOnly) return { fingerprint, session };
      }

      if (job.stage === "prepared") {
        if (jobId === "x" && session.plan.xOptions?.scheduledUtc) {
          if (job.scheduleAttempted || session.plan.mode === "manual") {
            // A future schedule is not a public result. Capture only when a live
            // canonical post is independently observed, and never re-click Schedule.
            try {
              session =
                (await capture(session, jobId, dependencyUrl)) || session;
            } catch {
              return { fingerprint, session };
            }
            if (session.jobs[jobId].stage === "result-captured")
              return appendResult(session, jobId, fingerprint);
            return { fingerprint, session };
          } else {
            session = await store.checkpoint(sessionId, jobId, {
              scheduleAttempted: true,
              scheduleState: "unresolved",
              updatedAt: now(),
            });
            try {
              const receipt = await adapterFor(jobId).submit({
                dependencyUrl,
                jobId,
                mode: session.plan.mode,
                plan: session.plan,
                target: targetFor(session.plan, jobId),
                async beforeCommit() {
                  const armed = await store.load(sessionId);
                  return {
                    armed:
                      armed?.jobs?.x?.scheduleAttempted === true &&
                      armed.jobs.x.scheduleState === "unresolved",
                  };
                },
              });
              if (receipt?.status === "scheduled")
                session = await store.checkpoint(sessionId, jobId, {
                  scheduleState: "confirmed",
                  updatedAt: now(),
                });
            } catch (error) {
              session = await store.checkpoint(sessionId, jobId, {
                error: cleanError(error),
                updatedAt: now(),
              });
            }
            return { fingerprint, session };
          }
        }
        if (session.plan.mode === "manual") {
          try {
            session = (await capture(session, jobId, dependencyUrl)) || session;
          } catch {
            return { fingerprint, session };
          }
          if (session.jobs[jobId].stage === "prepared") {
            return { fingerprint, session };
          }
        } else {
          if (
            jobId === "x" &&
            !/^[0-9a-f]{64}$/.test(String(job.preparedComposerSha256 ?? ""))
          ) {
            return {
              fingerprint,
              session: await fail(
                session,
                jobId,
                "The prepared X caption was not recorded. Prepare the draft again.",
                false,
              ),
            };
          }
          session = await store.checkpoint(sessionId, jobId, {
            stage: "submit-attempted",
            updatedAt: now(),
          });
          try {
            await adapterFor(jobId).submit({
              dependencyUrl,
              jobId,
              mode: session.plan.mode,
              plan: session.plan,
              target: targetFor(session.plan, jobId),
              async beforeCommit() {
                const armed = await store.load(sessionId);
                return {
                  armed:
                    armed?.jobs?.[jobId]?.stage === "submit-attempted" &&
                    armed.jobs[jobId].submitAttempted === true,
                };
              },
            });
          } catch (error) {
            return {
              fingerprint,
              session: await fail(session, jobId, error, true),
            };
          }
          try {
            session = (await capture(session, jobId, dependencyUrl)) || session;
          } catch (error) {
            return {
              fingerprint,
              session: await fail(session, jobId, error, true),
            };
          }
          if (session.jobs[jobId].stage !== "result-captured") {
            if (jobId === "x" && session.jobs[jobId].replyDueAt)
              return { fingerprint, session };
            return {
              fingerprint,
              session: await fail(
                session,
                jobId,
                "The public result could not be resolved.",
                true,
              ),
            };
          }
        }
      }

      session = await store.load(sessionId);
      if (session.jobs[jobId].stage === "result-captured") {
        try {
          return await appendResult(session, jobId, fingerprint);
        } catch (error) {
          return {
            fingerprint,
            session: await store.checkpoint(sessionId, jobId, {
              stage: "result-captured",
              error: cleanError(error),
              updatedAt: now(),
            }),
          };
        }
      }
      return { fingerprint, session };
    }

    async function prepareUnlocked(sessionId) {
      let session = await store.load(sessionId);
      if (!session) throw new Error("Distribution session was not found.");
      let fingerprint = await recoverFingerprint(session);
      for (const jobId of ["x", "redgifs"]) {
        if (session.jobs[jobId]?.stage !== "planned") continue;
        const result = await runJob(sessionId, jobId, "", fingerprint, true);
        session = result.session;
        fingerprint = result.fingerprint;
      }
      return store.load(sessionId);
    }

    function prepareSocialDistribution(sessionId) {
      return serialize(sessionId, () => prepareUnlocked(sessionId));
    }

    async function resumeUnlocked(sessionId) {
      let session = await store.load(sessionId);
      if (!session) throw new Error("Distribution session was not found.");
      let fingerprint = await recoverFingerprint(session);

      if (session.jobs.x) {
        let dependencyUrl = "";
        let dependencyError = "";
        try {
          dependencyUrl = await paidDependencyUrl(session.plan);
        } catch (error) {
          dependencyError = cleanError(error);
        }
        if (!dependencyUrl) {
          if (session.jobs.x.stage === "planned") {
            session = await store.checkpoint(sessionId, "x", {
              stage: "blocked",
              error:
                dependencyError ||
                "Waiting for the confirmed paid upload result.",
              updatedAt: now(),
            });
          }
        } else {
          if (session.jobs.x.stage === "blocked") {
            await store.unblock(sessionId, "x");
          }
          const result = await runJob(
            sessionId,
            "x",
            dependencyUrl,
            fingerprint,
          );
          session = result.session;
          fingerprint = result.fingerprint;
        }
      }
      if (session.jobs.redgifs) {
        const result = await runJob(sessionId, "redgifs", "", fingerprint);
        fingerprint = result.fingerprint;
      }

      session = await store.load(sessionId);
      const redgifs = session.jobs.redgifs;
      const dependencyUrl = redgifs?.resultUrl || "";
      const redditJobs = Object.keys(session.jobs).filter((jobId) =>
        jobId.startsWith("reddit:"),
      );
      if (!dependencyUrl) {
        if (redgifs && redgifs.stage !== "prepared") {
          for (const jobId of redditJobs) {
            if (session.jobs[jobId].stage === "planned") {
              session = await store.checkpoint(sessionId, jobId, {
                stage: "blocked",
                error: "Redgifs did not produce a confirmed public URL.",
                updatedAt: now(),
              });
            }
          }
        }
        return store.load(sessionId);
      }

      for (const jobId of redditJobs) {
        session = await store.load(sessionId);
        if (session.jobs[jobId].stage === "blocked") {
          await store.unblock(sessionId, jobId);
        }
        const result = await runJob(
          sessionId,
          jobId,
          dependencyUrl,
          fingerprint,
        );
        fingerprint = result.fingerprint;
      }
      return store.load(sessionId);
    }

    function resumeSocialDistribution(sessionId) {
      return serialize(sessionId, () => resumeUnlocked(sessionId));
    }

    async function retrySocialDestination(previousId, jobId, nextPlan) {
      const previous = await store.load(previousId);
      if (!previous || !previous.jobs[jobId]) {
        throw new Error("The previous distribution destination was not found.");
      }
      if (
        nextPlan?.id === previousId ||
        Number(nextPlan?.authorization?.at) <=
          Number(previous.plan.authorization.at) ||
        nextPlan?.authorization?.sha256 === previous.plan.authorization.sha256
      ) {
        throw new Error("Retry requires a new authorization and session.");
      }
      if (
        nextPlan?.catalogue?.row !== previous.plan.catalogue?.row ||
        nextPlan?.catalogue?.id !== previous.plan.catalogue?.id ||
        nextPlan?.socialFile?.sha256 !== previous.plan.socialFile.sha256
      ) {
        throw new Error(
          "Retry must preserve the exact catalogue and teaser pairing.",
        );
      }
      await store.create(nextPlan);
      return serialize(nextPlan.id, () => resumeUnlocked(nextPlan.id));
    }

    function associateCatalogue(sessionId, catalogue) {
      return serialize(sessionId, async () => {
        let session = await store.associateCatalogue(sessionId, catalogue);
        let fingerprint = await recoverFingerprint(session);
        let appendError = null;
        let appendFailed = false;
        for (const [jobId, job] of Object.entries(session.jobs)) {
          if (job.stage !== "result-captured") continue;
          try {
            const result = await appendResult(session, jobId, fingerprint);
            session = result.session;
            fingerprint = result.fingerprint;
          } catch (error) {
            if (!appendFailed) appendError = error;
            appendFailed = true;
            session = await store.load(sessionId);
          }
        }
        if (appendFailed) throw appendError;
        return session;
      });
    }

    return Object.freeze({
      associateCatalogue,
      prepareSocialDistribution,
      resumeSocialDistribution,
      retrySocialDestination,
      startSocialDistribution: resumeSocialDistribution,
    });
  }

  globalThis.CreatorSocialDistributionOrchestrator = Object.freeze({ create });
})();
