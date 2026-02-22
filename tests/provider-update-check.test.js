const {
  checkProviderUpdate,
  ProviderUpdateCheckError
} = require("../lib/provider-update-check");

function createJsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

describe("provider update check", () => {
  test("reports update-available when upstream commit is newer than installed commit", async () => {
    const installed = "0123456789abcdef0123456789abcdef01234567";
    const latestDic = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const latestAff = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const fetchImpl = jest.fn(async (url) => {
      const requestUrl = String(url || "");
      if (requestUrl.includes("path=en%2Fen_US.dic")) {
        return createJsonResponse(200, [
          {
            sha: latestDic,
            commit: { committer: { date: "2026-02-20T10:00:00.000Z" } }
          }
        ]);
      }
      if (requestUrl.includes("path=en%2Fen_US.aff")) {
        return createJsonResponse(200, [
          {
            sha: latestAff,
            commit: { committer: { date: "2026-02-21T10:00:00.000Z" } }
          }
        ]);
      }
      return createJsonResponse(404, {});
    });

    const result = await checkProviderUpdate({
      variant: "en-US",
      currentCommit: installed,
      fetchImpl
    });

    expect(result.status).toBe("update-available");
    expect(result.currentCommit).toBe(installed);
    expect(result.latestCommit).toBe(latestAff);
    expect(result.latestByPath.dic.commit).toBe(latestDic);
    expect(result.latestByPath.aff.commit).toBe(latestAff);
  });

  test("reports up-to-date when installed commit matches upstream latest commit", async () => {
    const installed = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const fetchImpl = jest.fn(async () =>
      createJsonResponse(200, [
        {
          sha: installed,
          commit: { committer: { date: "2026-02-20T10:00:00.000Z" } }
        }
      ])
    );

    const result = await checkProviderUpdate({
      variant: "en-US",
      currentCommit: installed,
      fetchImpl
    });

    expect(result.status).toBe("up-to-date");
    expect(result.latestCommit).toBe(installed);
  });

  test("reports unknown when no installed commit is provided", async () => {
    const latest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const fetchImpl = jest.fn(async () =>
      createJsonResponse(200, [
        {
          sha: latest,
          commit: { committer: { date: "2026-02-20T10:00:00.000Z" } }
        }
      ])
    );

    const result = await checkProviderUpdate({
      variant: "en-US",
      currentCommit: null,
      fetchImpl
    });

    expect(result.status).toBe("unknown");
    expect(result.currentCommit).toBeNull();
    expect(result.latestCommit).toBe(latest);
  });

  test("throws a rate-limited error when upstream responds with 429", async () => {
    const fetchImpl = jest.fn(async () => createJsonResponse(429, { message: "rate limit" }));

    await expect(
      checkProviderUpdate({
        variant: "en-US",
        currentCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        fetchImpl
      })
    ).rejects.toMatchObject({
      name: "ProviderUpdateCheckError",
      code: "UPSTREAM_RATE_LIMITED"
    });
  });

  test("throws invalid-response error when upstream returns no commit rows", async () => {
    const fetchImpl = jest.fn(async () => createJsonResponse(200, []));

    await expect(
      checkProviderUpdate({
        variant: "en-US",
        currentCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        fetchImpl
      })
    ).rejects.toMatchObject({
      name: "ProviderUpdateCheckError",
      code: "UPSTREAM_RESPONSE_INVALID"
    });
  });

  test("rejects unsupported variants", async () => {
    await expect(
      checkProviderUpdate({
        variant: "es-ES",
        currentCommit: null,
        fetchImpl: async () => createJsonResponse(200, [])
      })
    ).rejects.toMatchObject({
      name: "ProviderUpdateCheckError",
      code: "UNSUPPORTED_VARIANT"
    });
  });

  test("exports typed error class", () => {
    const err = new ProviderUpdateCheckError("X", "msg");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ProviderUpdateCheckError");
  });
});
